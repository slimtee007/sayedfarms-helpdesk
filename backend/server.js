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

// Monotonic id generator (#18). Date.now() primary keys collided under
// concurrent writes: 6 simultaneous signups produced the same id, and
// Array.filter then deleted every matching row. We suffix a counter that
// always advances within the millisecond so ids are unique even under load.
let idCounter = 0;
const genId = (prefix) => {
  idCounter = (idCounter + 1) % 1000000;
  return `${prefix || ''}${Date.now()}-${idCounter}`;
};

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
    id: genId('admin-'),
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
    id: genId('msg-'),
    sender: sender === 'agent' ? 'agent' : 'user',
    senderName: senderName || (sender === 'agent' ? 'IT Agent' : 'Employee'),
    text: String(text).trim(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  ticket.messages.push(message);
  saveData();
  return { ticket, message };
};

// True when `user` may see/post in a ticket.
const canAccessTicket = (user, ticketId) => {
  if (!user) return false;
  if (user.role === 'agent') return true;
  const ticket = tickets.find((t) => t.id === String(ticketId));
  return !!ticket && ticket.created_by === user.id;
};

// Verify the Bearer token and attach the CURRENT user record.
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

// ------------------------------------------------------------------
// Rate limiting (#7) — tiny in-memory sliding window, zero new deps.
// Blunts brute-force on login/OTP endpoints; production can put a real
// reverse-proxy limiter in front. Configurable via RATE_LIMIT_* env.
// ------------------------------------------------------------------
const rateBuckets = new Map();
const rateLimit = (opts) => {
  const { windowMs, max, keyFn, message } = {
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyFn: (req) => req.ip,
    message: 'Too many requests. Please slow down and try again in a few minutes.',
    ...opts,
  };
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = rateBuckets.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now };
      rateBuckets.set(key, entry);
    }
    entry.count += 1;
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    const resetSec = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
    res.set('X-RateLimit-Reset', String(resetSec));
    if (entry.count > max) {
      return res.status(429).json({ error: message, retryAfter: resetSec });
    }
    next();
  };
};
// GC old buckets so an attacker can't fill memory forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of rateBuckets) if (v.start < cutoff) rateBuckets.delete(k);
}, 60 * 1000).unref?.();

// Login + password-reset endpoints get TIGHT limits (keyed by IP+email so one
// IP can't brute-force the whole userbase, and one email can't be hammered).
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip}:${normalizeEmail(req.body && req.body.email)}`,
  message: 'Too many sign-in / reset attempts for this account. Try again in a few minutes.',
});
const sensitiveRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many sensitive actions from this address. Try again later.',
});
const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests. Slow down.',
});

// ------------------------------------------------------------------
// Mass-assignment protection (#8): pick only allowed fields from req.body.
// id/role/password/created_by/messages/etc. can never be overwritten by a
// PATCH/POST no matter what the client sends.
// ------------------------------------------------------------------
const pick = (body, fields) => {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
};
const requireStrings = (obj, fields) => {
  for (const f of fields) {
    if (!obj || typeof obj[f] !== 'string' || !obj[f].trim()) return f;
  }
  return null;
};

// Validators for #15 input validation
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TICKET_STATUS = new Set(['Open', 'In Progress', 'Resolved', 'Cancelled']);
const VALID_TICKET_PRIORITY = new Set(['Low', 'Medium', 'High', 'Urgent']);
const VALID_TICKET_CATEGORY = new Set(['Hardware', 'Software', 'Network', 'Account', 'Other']);
const VALID_USER_ROLE = new Set(['agent', 'user']);
const VALID_INVENTORY_STATUS = new Set(['In Stock', 'Assigned', 'In Repair', 'Retired']);

const { sendOtpEmail, isSmtpConfigured } = require('./utils/sendEmail');

const otpStore = {};

if (!isSmtpConfigured()) {
  console.warn('\n[WARN] SMTP is NOT configured (backend/.env). Password reset emails will NOT be sent.');
  console.warn('       Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in backend/.env and restart the server.');
  console.warn('       Until then, reset codes are only printed to this terminal / shown in the app (dev mode).\n');
}

/**
 * Generates an OTP for `email` and delivers it.
 *
 * #10 account-enumeration fix: when SMTP is configured, we return the same
 * generic success response whether the email exists or not, so an attacker
 * cannot probe the user directory. OTP is only generated/sent when real.
 */
const generateAndSendOtp = async (res, email, kind) => {
  const key = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === key);

  const genericSuccess = () =>
    res.json({ success: true, emailSent: true, message: 'If an account matches that email, a verification code has been sent.' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  if (user) otpStore[key] = { otp, expiresAt };

  if (!isSmtpConfigured()) {
    if (!user) {
      return res.status(400).json({ error: 'If this email exists, a code would be sent. (Dev: address not found.)' });
    }
    console.log(`\n========================================\n [DEV ${kind.toUpperCase()} OTP CODE for ${key}]: ${otp}\n========================================\n`);
    if (isProduction) {
      return res.status(500).json({
        error: 'Email delivery is not configured on this server. Please contact the administrator.',
        emailSent: false,
      });
    }
    return res.json({
      success: true,
      emailSent: false,
      devOtp: otp,
      message: 'Email delivery is not configured on the server; use the development code shown on screen.',
    });
  }

  if (!user) return genericSuccess();

  try {
    await sendOtpEmail(key, otp, kind);
    return genericSuccess();
  } catch (err) {
    console.error(`[${kind.toUpperCase()}] Email send error:`, err && err.message ? err.message : err);
    console.log(`\n========================================\n [DEV FALLBACK OTP CODE for ${key}]: ${otp}\n========================================\n`);
    return res.status(500).json({
      error: 'Failed to send the verification email. Please try again or contact the administrator.',
      emailSent: false,
    });
  }
};

app.post('/api/auth/signup', writeRateLimit, async (req, res) => {
  try {
    const body = pick(req.body, ['name', 'email', 'password']);
    const cleanName = String(body.name || '').trim();
    const cleanEmail = normalizeEmail(body.email);
    if (!cleanName) return res.status(400).json({ error: 'Full name is required' });
    if (cleanName.length > 100) return res.status(400).json({ error: 'Name is too long (max 100 characters)' });
    if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (typeof body.password !== 'string' || body.password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (body.password.length > 200) return res.status(400).json({ error: 'Password is too long' });
    if (users.some((u) => normalizeEmail(u.email) === cleanEmail)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    // Any `role` sent by the client is deliberately ignored (#6).
    const newUser = {
      id: genId('user-'),
      name: cleanName,
      email: cleanEmail,
      password: await bcrypt.hash(body.password, BCRYPT_ROUNDS),
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

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email', 'password']);
  const user = users.find((u) => normalizeEmail(u.email) === normalizeEmail(body.email));
  const ok = user && typeof body.password === 'string' && await bcrypt.compare(body.password, user.password || '');
  if (!ok) {
    // Same message for unknown email and bad password — prevents enumeration.
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.post('/api/auth/forgot-password', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email']);
  if (!body.email || !normalizeEmail(body.email)) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, normalizeEmail(body.email), 'reset');
});

app.post('/api/auth/resend-otp', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email']);
  if (!body.email || !normalizeEmail(body.email)) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, normalizeEmail(body.email), 'resend');
});

app.post('/api/auth/reset-password', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email', 'otp', 'password']);
  if (!body.email || body.otp === undefined || body.otp === null || body.otp === '' || !body.password) {
    return res.status(400).json({ error: 'Email, verification code and new password are required' });
  }
  const key = normalizeEmail(body.email);
  const user = users.find((u) => normalizeEmail(u.email) === key);
  if (!user) return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  const record = otpStore[key];
  if (!record || String(record.otp) !== String(body.otp) || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }
  if (typeof body.password !== 'string' || body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }
  user.password = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  delete otpStore[key];
  saveData();
  res.json({ success: true, message: 'Password updated successfully' });
});

app.get('/api/users', requireAgent, (req, res) => {
  res.json(users.map(({ password, ...u }) => u));
});

app.get('/api/agents', requireAuth, (req, res) => {
  res.json(users.filter((u) => u.role === 'agent').map((u) => ({ id: u.id, name: u.name })));
});

app.delete('/api/users/:id', requireAgent, sensitiveRateLimit, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if (target.role === 'agent' && users.filter((u) => u.role === 'agent').length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last IT agent account' });
  }
  // Re-home assignments keyed by id OR name (#17 partial extension).
  tickets.forEach((t) => {
    if (t.assigned_to === target.id || t.assigned_to === target.name) t.assigned_to = 'Unassigned';
  });
  inventory.forEach((i) => {
    if (i.assigned_to === target.id || i.assigned_to === target.name) {
      i.assigned_to = 'Unassigned';
      if (i.status === 'Assigned') i.status = 'In Stock';
    }
  });
  users = users.filter((u) => u.id !== target.id);
  saveData();
  res.json({ success: true });
});

app.patch('/api/users/:id', requireAgent, writeRateLimit, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // #8: explicit field allow-list — id/email/password can never be rewritten.
  const body = pick(req.body, ['role', 'name']);
  if (body.role !== undefined) {
    if (!VALID_USER_ROLE.has(body.role)) {
      return res.status(400).json({ error: 'Role must be either "agent" or "user"' });
    }
    if (target.id === req.user.id && body.role !== target.role) {
      return res.status(403).json({ error: 'You cannot change your own role' });
    }
    if (target.role === 'agent' && body.role === 'user' && users.filter((u) => u.role === 'agent').length <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last IT agent account' });
    }
    target.role = body.role;
  }
  if (body.name !== undefined) {
    const trimmed = String(body.name).trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    if (trimmed.length > 100) return res.status(400).json({ error: 'Name is too long' });
    target.name = trimmed;
  }
  saveData();
  res.json(safeUser(target));
});

app.get('/api/tickets', requireAuth, (req, res) => {
  if (req.user.role === 'agent') return res.json(tickets);
  res.json(tickets.filter((t) => t.created_by === req.user.id));
});

app.post('/api/tickets', requireAuth, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['title', 'description', 'category', 'priority', 'assigned_to', 'image']);
  if (!String(body.title || '').trim() || !String(body.description || '').trim()) {
    return res.status(400).json({ error: 'Title and description are required' });
  }
  if (String(body.title).trim().length > 200) {
    return res.status(400).json({ error: 'Title is too long (max 200 characters)' });
  }
  const category = body.category && VALID_TICKET_CATEGORY.has(body.category) ? body.category : 'Hardware';
  const priority = body.priority && VALID_TICKET_PRIORITY.has(body.priority) ? body.priority : 'Medium';
  // Employees can't assign tickets to arbitrary people (#8): only agents may.
  const assignedTo = req.user.role === 'agent' && body.assigned_to ? String(body.assigned_to) : 'Unassigned';
  const image = typeof body.image === 'string' && body.image.length < 2_000_000 ? body.image : '';
  const newTicket = {
    id: genId('ticket-'),
    title: String(body.title).trim(),
    description: String(body.description).trim(),
    category,
    priority,
    status: 'Open',
    assigned_to: assignedTo,
    created_by: req.user.id,
    created_by_name: req.user.name,
    image,
    messages: [],
    created_at: new Date().toISOString(),
  };
  tickets.unshift(newTicket);
  saveData();
  res.json(newTicket);
});

app.patch('/api/tickets/:id', requireAuth, writeRateLimit, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'agent') {
    if (ticket.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only update your own requests' });
    }
    // #8: strict allow-list for employees — only {status:'Cancelled'}.
    const body = pick(req.body, ['status']);
    if (Object.keys(body).length !== 1 || body.status !== 'Cancelled') {
      return res.status(403).json({ error: 'You can only cancel your own requests' });
    }
    ticket.status = 'Cancelled';
    saveData();
    return res.json(ticket);
  }
  // #8 mass-assignment fix: explicit allow-list for agents — id/created_by/
  // created_by_name/messages/created_at can never be overwritten from PATCH.
  const body = pick(req.body, ['title', 'description', 'category', 'priority', 'status', 'assigned_to', 'image']);
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) return res.status(400).json({ error: 'Title cannot be empty' });
    if (t.length > 200) return res.status(400).json({ error: 'Title is too long' });
    ticket.title = t;
  }
  if (body.description !== undefined) {
    const d = String(body.description).trim();
    if (!d) return res.status(400).json({ error: 'Description cannot be empty' });
    ticket.description = d;
  }
  if (body.category !== undefined) {
    if (!VALID_TICKET_CATEGORY.has(body.category)) {
      return res.status(400).json({ error: `Category must be one of: ${[...VALID_TICKET_CATEGORY].join(', ')}` });
    }
    ticket.category = body.category;
  }
  if (body.priority !== undefined) {
    if (!VALID_TICKET_PRIORITY.has(body.priority)) {
      return res.status(400).json({ error: `Priority must be one of: ${[...VALID_TICKET_PRIORITY].join(', ')}` });
    }
    ticket.priority = body.priority;
  }
  if (body.status !== undefined) {
    if (!VALID_TICKET_STATUS.has(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${[...VALID_TICKET_STATUS].join(', ')}` });
    }
    ticket.status = body.status;
  }
  if (body.assigned_to !== undefined) {
    ticket.assigned_to = String(body.assigned_to || 'Unassigned');
  }
  if (body.image !== undefined) {
    ticket.image = typeof body.image === 'string' ? body.image : '';
  }
  saveData();
  res.json(ticket);
});

app.post('/api/tickets/:id/messages', requireAuth, writeRateLimit, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'agent' && ticket.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only chat on your own requests' });
  }
  const body = pick(req.body, ['text']);
  const result = appendTicketMessage(
    ticket.id,
    req.user.role === 'agent' ? 'agent' : 'user',
    req.user.name,
    body.text
  );
  if (!result) return res.status(400).json({ error: 'Message text is required' });
  io.to(`ticket_${result.ticket.id}`).emit('receive_ticket_message', {
    ticketId: result.ticket.id,
    message: result.message,
  });
  res.json(result.message);
});

app.get('/api/inventory', requireAgent, (req, res) => {
  res.json(inventory);
});

app.post('/api/inventory', requireAgent, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['name', 'category', 'serial_number', 'assigned_to', 'status']);
  const missing = requireStrings(body, ['name', 'category', 'serial_number']);
  if (missing) return res.status(400).json({ error: `${missing} is required` });
  const serial = String(body.serial_number).trim();
  if (inventory.some((i) => String(i.serial_number).toLowerCase() === serial.toLowerCase())) {
    return res.status(400).json({ error: 'An asset with this serial number already exists' });
  }
  const status = body.status && VALID_INVENTORY_STATUS.has(body.status) ? body.status : 'In Stock';
  const newItem = {
    id: genId('asset-'),
    name: String(body.name).trim(),
    category: String(body.category).trim(),
    serial_number: serial,
    assigned_to: body.assigned_to ? String(body.assigned_to) : 'Unassigned',
    status,
  };
  inventory.unshift(newItem);
  saveData();
  res.json(newItem);
});

app.patch('/api/inventory/:id', requireAgent, writeRateLimit, (req, res) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  // #8 mass-assignment fix: explicit allow-list — id can never be overwritten.
  const body = pick(req.body, ['name', 'category', 'serial_number', 'assigned_to', 'status']);
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
    item.name = n;
  }
  if (body.category !== undefined) item.category = String(body.category).trim();
  if (body.serial_number !== undefined) {
    const s = String(body.serial_number).trim();
    if (!s) return res.status(400).json({ error: 'Serial number cannot be empty' });
    if (s.toLowerCase() !== String(item.serial_number).toLowerCase()
        && inventory.some((i) => i.id !== item.id && String(i.serial_number).toLowerCase() === s.toLowerCase())) {
      return res.status(400).json({ error: 'An asset with this serial number already exists' });
    }
    item.serial_number = s;
  }
  if (body.status !== undefined) {
    if (!VALID_INVENTORY_STATUS.has(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${[...VALID_INVENTORY_STATUS].join(', ')}` });
    }
    item.status = body.status;
    if (body.status !== 'Assigned') item.assigned_to = 'Unassigned';
  }
  if (body.assigned_to !== undefined) {
    item.assigned_to = body.assigned_to ? String(body.assigned_to) : 'Unassigned';
  }
  saveData();
  res.json(item);
});

app.delete('/api/inventory/:id', requireAgent, sensitiveRateLimit, (req, res) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  inventory = inventory.filter((i) => i.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

// 404 JSON handler for any unmatched /api route (#24).
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.path}` });
});

// Error middleware — never leak stack traces, always send JSON.
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// Attach the verified session user to each socket.
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
  // Per-socket message rate-limit (#7) so one client can't spam everyone.
  let socketMsgCount = 0;
  let socketMsgWindow = Date.now();
  const socketAllowed = () => {
    const now = Date.now();
    if (now - socketMsgWindow > 10_000) { socketMsgWindow = now; socketMsgCount = 0; }
    socketMsgCount += 1;
    return socketMsgCount <= 20; // 20 messages / 10s per socket
  };

  socket.on('send_message', (data) => {
    if (!socket.user) return;
    if (!socketAllowed()) return;
    if (!data || typeof data !== 'object' || !String(data.text || '').trim()) return;
    if (String(data.text).length > 2000) return;
    io.emit('receive_message', {
      id: genId('msg-'),
      sender: socket.user.role === 'agent' ? 'agent' : 'user',
      senderName: socket.user.name,
      text: String(data.text).trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });

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
    if (!data || typeof data !== 'object') return;
    if (!socket.user) return;
    if (!socketAllowed()) return;
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
