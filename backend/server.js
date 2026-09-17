require('dotenv').config(); // <-- MUST BE AT THE VERY TOP
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production';

// JWT signing secret. Refuse to boot in production without one; in dev fall
// back to a random per-boot secret (sessions die on restart) rather than a
// hard-coded value that could ever ship.
let JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (!JWT_SECRET) {
  if (isProduction) {
    console.error('[FATAL] JWT_SECRET is not set. Refusing to start in production without a signing secret.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[WARN] JWT_SECRET is not set — using a random secret generated for this boot.');
  console.warn('       All sessions will be invalidated when the server restarts. Set JWT_SECRET in backend/.env.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// CORS allow-list (comma-separated). Auth uses Bearer tokens rather than
// cookies, so there are no ambient credentials for a foreign origin to ride
// on — but production should still lock this to the real frontend origin(s).
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
if (CORS_ORIGIN === '*' && isProduction) {
  console.warn('[WARN] CORS_ORIGIN allows every origin in production. Set CORS_ORIGIN in backend/.env.');
}
const corsOrigin = CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

const DATA_FILE = path.join(__dirname, 'db.json');

// Default initial data if db.json does not exist. db.json is git-ignored and
// local to each machine — the admin account below is created on first boot
// (see the ensure-admin block) so a fresh checkout can sign in.
const initialData = {
  users: [],
  tickets: [
    {
      id: '101',
      title: 'Get IT help',
      description: 'Printer configuration assistance needed in the main office.',
      category: 'Hardware',
      priority: 'Medium',
      status: 'Open',
      assigned_to: 'Unassigned',
      created_by: null,
      created_by_name: 'Employee User',
      image: ''
    }
  ],
  inventory: [
    { id: '1', name: 'MacBook Pro 16 M2', category: 'Laptop', serial_number: 'SN-8942-X1', assigned_to: 'Unassigned', status: 'In Stock' }
  ]
};

// Load persistent data from JSON file
const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
    return JSON.parse(JSON.stringify(initialData));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(initialData));
  }
};

const db = loadData();
let users = db.users || [];
let tickets = db.tickets || [];
let inventory = db.inventory || [];

// Normalize emails (trim + lowercase) so casing or stray whitespace
// can never block sign-in or create duplicate accounts.
const normalizeEmail = (email) => (email || '').trim().toLowerCase();

// Save state to disk
const saveData = () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users, tickets, inventory }, null, 2));
};

// ------------------------------------------------------------------
// Auth helpers
// ------------------------------------------------------------------
const BCRYPT_ROUNDS = 10;
const isBcryptHash = (value) => typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
// Never serialize the password hash to clients.
const safeUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// Databases created before auth hardening store plaintext passwords — hash
// them in place on boot so every credential at rest is a bcrypt hash.
let passwordsMigrated = false;
users.forEach((u) => {
  if (u.password && !isBcryptHash(u.password)) {
    u.password = bcrypt.hashSync(String(u.password), BCRYPT_ROUNDS);
    passwordsMigrated = true;
  }
});
if (passwordsMigrated) {
  saveData();
  console.log('[INIT] Migrated plaintext passwords to bcrypt hashes.');
}

// Ensure at least one agent account exists so the console is never
// unmanageable. Unlike the old seed, this only fires when NO agent exists —
// deliberately deleting an admin while other agents remain will not resurrect
// it. Override the fallback credentials with ADMIN_EMAIL / ADMIN_PASSWORD.
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || 'admin@sayedfarms.com');
if (!users.some((u) => u.role === 'agent')) {
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';
  users.push({
    id: `admin-${Date.now().toString()}`,
    name: 'IT Admin',
    email: ADMIN_EMAIL,
    role: 'agent',
    password: bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS),
  });
  saveData();
  console.log(`[INIT] No agent account found — created ${ADMIN_EMAIL}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[WARN] Using the default admin password. Set ADMIN_PASSWORD in backend/.env (and change it after first sign-in).');
  }
}

// Backfill per-ticket chat history for tickets created before it existed, plus
// ownership for tickets created before reporter identity was stamped (#14).
// Ownership is matched by reporter name where possible; unmatched legacy
// tickets stay visible to agents only.
let ticketsMigrated = false;
tickets.forEach((t) => {
  if (!Array.isArray(t.messages)) {
    t.messages = [];
    ticketsMigrated = true;
  }
  if (t.created_by === undefined) {
    const owner = t.created_by_name
      ? users.find((u) => u.name && u.name.toLowerCase() === String(t.created_by_name).toLowerCase())
      : null;
    t.created_by = owner ? owner.id : null;
    ticketsMigrated = true;
  }
});
if (ticketsMigrated) saveData();

// Append a chat message to a ticket (shared by the REST endpoint and sockets).
const appendTicketMessage = (ticketId, sender, senderName, text) => {
  const ticket = tickets.find((t) => t.id === String(ticketId));
  if (!ticket || !text || !String(text).trim()) return null;
  if (!Array.isArray(ticket.messages)) ticket.messages = [];
  const message = {
    id: Date.now().toString() + Math.floor(Math.random() * 1000).toString(),
    sender: sender === 'agent' ? 'agent' : 'user',
    senderName: senderName || (sender === 'agent' ? 'IT Agent' : 'Employee'),
    text: String(text).trim(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  ticket.messages.push(message);
  saveData();
  return { ticket, message };
};

// True when `user` (a socket or request identity) may see/post in a ticket.
const canAccessTicket = (user, ticketId) => {
  if (!user) return false;
  if (user.role === 'agent') return true;
  const ticket = tickets.find((t) => t.id === String(ticketId));
  return !!ticket && ticket.created_by === user.id;
};

// Verify the Bearer token and attach the CURRENT user record (so role changes
// and deletions take effect immediately, not at token expiry).
const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }
  let payload;
  try {
    payload = jwt.verify(match[1].trim(), JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
  const user = users.find((u) => u.id === payload.id);
  if (!user) {
    return res.status(401).json({ error: 'Account no longer exists. Please sign in again.' });
  }
  req.user = user;
  next();
};

const requireAgent = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'This action requires an IT agent account.' });
    }
    next();
  });
};

const { sendOtpEmail, isSmtpConfigured } = require('./utils/sendEmail');

const otpStore = {};

if (!isSmtpConfigured()) {
  console.warn('\n[WARN] SMTP is NOT configured (backend/.env). Password reset emails will NOT be sent.');
  console.warn('       Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in backend/.env and restart the server.');
  console.warn('       Until then, reset codes are only printed to this terminal / shown in the app (dev mode).\n');
}

/**
 * Generates an OTP for `email` and delivers it.
 * Response contract:
 *  - { success: true, emailSent: true }                     -> email really went out
 *  - { success: true, emailSent: false, devOtp }            -> SMTP not configured (dev mode only)
 *  - 500 { emailSent: false, error }                        -> SMTP configured but sending failed
 */
const generateAndSendOtp = async (res, email, kind) => {
  const user = users.find((u) => normalizeEmail(u.email) === normalizeEmail(email));
  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  otpStore[email] = { otp, expiresAt };

  if (!isSmtpConfigured()) {
    console.log(`\n========================================\n [DEV ${kind.toUpperCase()} OTP CODE for ${email}]: ${otp}\n========================================\n`);
    if (process.env.NODE_ENV === 'production') {
      // Never leak the OTP to the client in production.
      return res.status(500).json({
        error: 'Email delivery is not configured on this server. Please contact the administrator.',
        emailSent: false,
      });
    }
    return res.json({
      success: true,
      emailSent: false,
      devOtp: otp,
      message: 'Email delivery is not configured on the server, so no email was sent. Use the development code shown on screen.',
    });
  }

  try {
    await sendOtpEmail(email, otp, kind);
    return res.json({ success: true, emailSent: true, message: 'Verification code sent to your email address.' });
  } catch (err) {
    console.error(`[${kind.toUpperCase()}] Email send error:`, err && err.message ? err.message : err);
    console.log(`\n========================================\n [DEV FALLBACK OTP CODE for ${email}]: ${otp}\n========================================\n`);
    return res.status(500).json({
      error: 'Failed to send the verification email. Please try again or contact the administrator.',
      emailSent: false,
    });
  }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanEmail = normalizeEmail(email);
    if (!cleanName) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (users.some((u) => normalizeEmail(u.email) === cleanEmail)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    // NOTE: any `role` sent by the client is deliberately ignored — every
    // public signup is an employee account. Agents are promoted by an existing
    // agent from the console (#6).
    const newUser = {
      id: Date.now().toString(),
      name: cleanName,
      email: cleanEmail,
      password: await bcrypt.hash(password, BCRYPT_ROUNDS),
      role: 'user',
    };
    users.push(newUser);
    saveData();
    res.json({ token: signToken(newUser), user: safeUser(newUser) });
  } catch (err) {
    console.error('[signup] error:', err);
    res.status(500).json({ error: 'Could not create the account. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = users.find((u) => normalizeEmail(u.email) === normalizeEmail(email));
  const ok = user && typeof password === 'string' && await bcrypt.compare(password, user.password || '');
  if (!ok) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: safeUser(user) });
});

// Step 1: Generate and Send Password Reset OTP
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, normalizeEmail(email), 'reset');
});

// Resend Password Reset OTP
app.post('/api/auth/resend-otp', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, normalizeEmail(email), 'resend');
});

// Step 2: Verify OTP and Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, password } = req.body || {};
  if (!email || otp === undefined || otp === null || otp === '' || !password) {
    return res.status(400).json({ error: 'Email, verification code and new password are required' });
  }
  const key = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === key);
  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }

  const record = otpStore[key];
  // Compare as strings so a JSON-number code is accepted, not rejected.
  if (!record || String(record.otp) !== String(otp) || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
  delete otpStore[key];
  saveData();

  res.json({ success: true, message: 'Password updated successfully' });
});

// User directory — agents only. Employees get the trimmed agent picker below.
app.get('/api/users', requireAgent, (req, res) => {
  res.json(users.map(({ password, ...u }) => u));
});

// Agent picker for the employee portal's "direct request" dropdown: names only,
// no emails or password hashes, so employees can address an agent without
// being able to enumerate the user directory.
app.get('/api/agents', requireAuth, (req, res) => {
  res.json(users.filter((u) => u.role === 'agent').map((u) => ({ id: u.id, name: u.name })));
});

app.delete('/api/users/:id', requireAgent, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if (target.role === 'agent' && users.filter((u) => u.role === 'agent').length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last IT agent account' });
  }
  // Re-home anything assigned to the deleted user so queues don't strand
  // tickets/assets against a name that no longer exists (#17, partial).
  tickets.forEach((t) => {
    if (t.assigned_to === target.name) t.assigned_to = 'Unassigned';
  });
  inventory.forEach((i) => {
    if (i.assigned_to === target.name) {
      i.assigned_to = 'Unassigned';
      if (i.status === 'Assigned') i.status = 'In Stock';
    }
  });
  users = users.filter((u) => u.id !== target.id);
  saveData();
  res.json({ success: true });
});

// Update a user's role (agent <-> user) and/or display name.
// Used by the admin dashboard's User Management screen.
app.patch('/api/users/:id', requireAgent, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role, name } = req.body || {};
  if (role !== undefined) {
    if (role !== 'agent' && role !== 'user') {
      return res.status(400).json({ error: 'Role must be either "agent" or "user"' });
    }
    if (target.id === req.user.id && role !== target.role) {
      return res.status(403).json({ error: 'You cannot change your own role' });
    }
    if (target.role === 'agent' && role === 'user' && users.filter((u) => u.role === 'agent').length <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last IT agent account' });
    }
    target.role = role;
  }
  if (name !== undefined && String(name).trim()) {
    target.name = String(name).trim();
  }
  saveData();
  res.json(safeUser(target));
});

// Agents see every ticket; employees see only their own (#13).
app.get('/api/tickets', requireAuth, (req, res) => {
  if (req.user.role === 'agent') return res.json(tickets);
  res.json(tickets.filter((t) => t.created_by === req.user.id));
});

app.post('/api/tickets', requireAuth, (req, res) => {
  const { title, description, category, priority, assigned_to, image } = req.body || {};
  if (!String(title || '').trim() || !String(description || '').trim()) {
    return res.status(400).json({ error: 'Title and description are required' });
  }
  const newTicket = {
    id: Date.now().toString(),
    title: String(title).trim(),
    description: String(description).trim(),
    category: category || 'Hardware',
    priority: priority || 'Medium',
    status: 'Open',
    assigned_to: assigned_to || 'Unassigned',
    // Reporter identity comes from the verified session, never the client (#14).
    created_by: req.user.id,
    created_by_name: req.user.name,
    image: image || '',
    messages: []
  };
  tickets.unshift(newTicket);
  saveData();
  res.json(newTicket);
});

app.patch('/api/tickets/:id', requireAuth, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'agent') {
    // Employees may only cancel their own requests — nothing else.
    if (ticket.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only update your own requests' });
    }
    const body = req.body || {};
    if (Object.keys(body).length !== 1 || body.status !== 'Cancelled') {
      return res.status(403).json({ error: 'You can only cancel your own requests' });
    }
    ticket.status = 'Cancelled';
    saveData();
    return res.json(ticket);
  }
  // Agents: identity/history fields can never be overwritten from the client
  // (the full per-field allow-list lands with #8).
  const { id, created_by, created_by_name, messages, ...updates } = req.body || {};
  Object.assign(ticket, updates);
  saveData();
  res.json(ticket);
});

// Post a per-ticket chat message (employee <-> assigned agent).
// History is persisted on the ticket and broadcast to the ticket room.
// Only the reporter and agents may post; sender identity comes from the
// verified session so nobody can post as "Fake IT Admin".
app.post('/api/tickets/:id/messages', requireAuth, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'agent' && ticket.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only chat on your own requests' });
  }
  const { text } = req.body || {};
  const result = appendTicketMessage(
    ticket.id,
    req.user.role === 'agent' ? 'agent' : 'user',
    req.user.name,
    text
  );
  if (!result) {
    return res.status(400).json({ error: 'Message text is required' });
  }
  io.to(`ticket_${result.ticket.id}`).emit('receive_ticket_message', {
    ticketId: result.ticket.id,
    message: result.message,
  });
  res.json(result.message);
});

app.get('/api/inventory', requireAgent, (req, res) => {
  res.json(inventory);
});

app.post('/api/inventory', requireAgent, (req, res) => {
  const { name, category, serial_number, assigned_to, status } = req.body || {};
  const newItem = {
    id: Date.now().toString(),
    name,
    category,
    serial_number,
    assigned_to: assigned_to || 'Unassigned',
    status: status || 'In Stock'
  };
  inventory.unshift(newItem);
  saveData();
  res.json(newItem);
});

app.patch('/api/inventory/:id', requireAgent, (req, res) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  const { id, ...updates } = req.body || {};
  Object.assign(item, updates);
  saveData();
  res.json(item);
});

app.delete('/api/inventory/:id', requireAgent, (req, res) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  inventory = inventory.filter((i) => i.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

// Attach the verified session user to each socket (null when no/invalid token
// was supplied). Emits from unauthenticated sockets are ignored below.
io.use((socket, next) => {
  socket.user = null;
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (typeof token === 'string' && token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = users.find((u) => u.id === payload.id);
      if (user) socket.user = { id: user.id, name: user.name, role: user.role };
    } catch (err) {
      // Stays unauthenticated — handlers below will ignore its emits.
    }
  }
  next();
});

io.on('connection', (socket) => {
  socket.on('send_message', (data) => {
    if (!socket.user) return;
    if (!data || typeof data !== 'object' || !String(data.text || '').trim()) return;
    // Sender identity comes from the verified session, never the client.
    io.emit('receive_message', {
      sender: socket.user.role === 'agent' ? 'agent' : 'user',
      senderName: socket.user.name,
      text: String(data.text).trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });

  // Per-ticket chat rooms: ticket_<id>
  socket.on('join_ticket', (ticketId) => {
    if (ticketId === undefined || ticketId === null) return;
    if (!canAccessTicket(socket.user, ticketId)) return;
    socket.join(`ticket_${ticketId}`);
  });
  socket.on('leave_ticket', (ticketId) => {
    if (ticketId === undefined || ticketId === null) return;
    socket.leave(`ticket_${ticketId}`);
  });
  socket.on('send_ticket_message', (data) => {
    // A null / non-object payload used to throw here and take the whole
    // process down (no error middleware, no uncaughtException handler).
    if (!data || typeof data !== 'object') return;
    if (!canAccessTicket(socket.user, data.ticketId)) return;
    const result = appendTicketMessage(
      data.ticketId,
      socket.user.role === 'agent' ? 'agent' : 'user',
      socket.user.name,
      data.text
    );
    if (!result) return;
    io.to(`ticket_${result.ticket.id}`).emit('receive_ticket_message', {
      ticketId: result.ticket.id,
      message: result.message,
    });
  });
});

// Last line of defence: log loudly instead of letting one bad event kill the
// whole helpdesk for every connected user.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection (server kept alive):', reason);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
