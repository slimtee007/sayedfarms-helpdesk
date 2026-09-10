require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const DATA_FILE = process.env.HELPDESK_DATA_FILE || path.join(__dirname, 'db.json');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (IS_PRODUCTION) {
    throw new Error('JWT_SECRET must be configured in production');
  }

  console.warn('JWT_SECRET is not configured; using a temporary development secret.');
  return crypto.randomBytes(32).toString('hex');
})();

const configuredOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (IS_PRODUCTION && configuredOrigins.length === 0) {
  throw new Error('FRONTEND_ORIGINS must be configured in production');
}

const allowedOrigins = new Set(configuredOrigins.length > 0
  ? configuredOrigins
  : ['http://localhost:5173', 'http://127.0.0.1:5173']);

const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    // Non-browser clients and same-origin requests may omit Origin.
    if (!origin || allowedOrigins.has(origin) || (!IS_PRODUCTION && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
};

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many password reset attempts. Please try again later.' }
});

app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/forgot-password', passwordResetLimiter);
app.use('/api/auth/resend-otp', passwordResetLimiter);
app.use('/api/auth/reset-password', passwordResetLimiter);

const initialData = {
  users: [],
  tickets: [],
  inventory: [],
  messages: []
};

const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), { mode: 0o600 });
    return initialData;
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('Could not parse helpdesk data file:', error);
    return initialData;
  }
};

const db = loadData();
let users = Array.isArray(db.users) ? db.users : [];
let tickets = Array.isArray(db.tickets) ? db.tickets : [];
let inventory = Array.isArray(db.inventory) ? db.inventory : [];
let messages = Array.isArray(db.messages) ? db.messages : [];

const saveData = () => {
  const temporaryFile = `${DATA_FILE}.tmp`;
  const serialized = JSON.stringify({ users, tickets, inventory, messages }, null, 2);
  fs.writeFileSync(temporaryFile, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
};

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || 'your-email@example.com',
    pass: process.env.SMTP_PASS || 'your-email-password'
  }
});

const otpStore = new Map();
const PASSWORD_HASH_PATTERN = /^\$2[aby]\$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RESET_FLAG = 'must_reset_password';
const TICKET_STATUSES = new Set(['Open', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled']);
const TICKET_CATEGORIES = new Set(['Hardware', 'Software', 'Network', 'Access/Security', 'General']);
const TICKET_PRIORITIES = new Set(['Low', 'Medium', 'High']);
const INVENTORY_STATUSES = new Set(['In Stock', 'Assigned', 'Under Maintenance', 'Decommissioned']);
const INVENTORY_CATEGORIES = new Set(['Laptop', 'Desktop', 'Monitor', 'Peripherals', 'Network Equipment', 'Other']);

const isPasswordHash = (password) => typeof password === 'string' && PASSWORD_HASH_PATTERN.test(password);
const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : '';
const isNonEmptyString = (value, maxLength = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicUser = ({ password, [PASSWORD_RESET_FLAG]: _mustResetPassword, ...user }) => user;
const findUserByEmail = (email) => users.find((user) => user.email === email);
const findUserById = (id) => users.find((user) => user.id === id);
const ticketRoom = (ticketId) => `ticket:${ticketId}`;

const signToken = (user) => jwt.sign(
  { sub: user.id },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRES_IN }
);

const authenticateToken = (req, res, next) => {
  const authorization = req.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);

    if (!user) {
      return res.status(401).json({ error: 'Account is no longer available' });
    }

    // Resolve the current user from the server-side store so role changes and
    // account deletion take effect immediately instead of trusting token claims.
    req.user = publicUser(user);
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireAgent = (req, res, next) => {
  if (req.user?.role !== 'agent') {
    return res.status(403).json({ error: 'Agent access required' });
  }
  return next();
};

const resolveAssignee = (assignedTo) => {
  if (assignedTo === undefined || assignedTo === null || assignedTo === '' || assignedTo === 'Unassigned') {
    return 'Unassigned';
  }

  const agent = users.find((user) => user.role === 'agent' && user.name === assignedTo);
  return agent ? agent.name : null;
};

const resolveUserName = (assignedTo) => {
  if (assignedTo === undefined || assignedTo === null || assignedTo === '' || assignedTo === 'Unassigned') {
    return 'Unassigned';
  }

  const user = users.find((candidate) => candidate.name === assignedTo);
  return user ? user.name : null;
};

const isAllowedTicket = (user, ticket) => user.role === 'agent' || ticket.created_by === user.id;

const migrateLegacyPasswords = () => {
  let changed = false;
  for (const user of users) {
    if (!Object.prototype.hasOwnProperty.call(user, PASSWORD_RESET_FLAG)) {
      // Existing accounts are treated as compromised until their owners set a
      // fresh password through the verified reset flow.
      user.password = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
      user[PASSWORD_RESET_FLAG] = true;
      changed = true;
    }
  }
  if (changed) saveData();
};

const hashOtp = (otp) => crypto.createHash('sha256').update(otp).digest('hex');
const otpMatches = (storedHash, otp) => {
  if (typeof otp !== 'string' || typeof storedHash !== 'string') return false;
  const candidate = Buffer.from(hashOtp(otp), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
};

const sendPasswordResetEmail = async (email, otp, subject) => {
  if (!process.env.SMTP_HOST || process.env.SMTP_HOST.includes('example')) {
    throw new Error('SMTP is not configured');
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'support@sayedfarms.com',
    to: email,
    subject,
    text: `Your One-Time Password (OTP) for password reset is: ${otp}. It is valid for 10 minutes.`,
    html: `<p>Your One-Time Password (OTP) for password reset is: <b>${otp}</b>.</p><p>It is valid for 10 minutes.</p>`
  });
};

app.post('/api/auth/signup', async (req, res) => {
  const body = req.body || {};
  const { name, email, password } = body;
  const normalizedEmail = normalizeEmail(email);

  if (!isNonEmptyString(name, 120) || !EMAIL_PATTERN.test(normalizedEmail) || !isNonEmptyString(password, 200)) {
    return res.status(400).json({ error: 'A valid name, email, and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  if (findUserByEmail(normalizedEmail)) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const newUser = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    password: await bcrypt.hash(password, 12),
    [PASSWORD_RESET_FLAG]: false,
    role: 'user'
  };

  users.push(newUser);
  saveData();

  return res.status(201).json({
    token: signToken(newUser),
    user: publicUser(newUser)
  });
});

app.post('/api/auth/login', async (req, res) => {
  const body = req.body || {};
  const { email, password } = body;
  const user = findUserByEmail(normalizeEmail(email));

  if (!user || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  if (user[PASSWORD_RESET_FLAG]) {
    return res.status(403).json({
      error: 'Password reset required before signing in',
      code: 'PASSWORD_RESET_REQUIRED'
    });
  }

  let validPassword = false;
  if (isPasswordHash(user.password)) {
    validPassword = await bcrypt.compare(password, user.password);
  } else {
    // Legacy records are upgraded and blocked until their password is reset.
    validPassword = user.password === password;
    if (validPassword) {
      user.password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      user[PASSWORD_RESET_FLAG] = true;
      saveData();
      return res.status(403).json({
        error: 'Password reset required before signing in',
        code: 'PASSWORD_RESET_REQUIRED'
      });
    }
  }

  if (!validPassword) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  return res.json({
    token: signToken(user),
    user: publicUser(user)
  });
});

// Password reset requests intentionally use a generic response for unknown
// addresses to avoid revealing which emails have accounts.
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = findUserByEmail(email);

  if (!user) {
    return res.status(202).json({ success: true, message: 'If the account exists, a reset code will be sent.' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  try {
    await sendPasswordResetEmail(email, otp, 'Password Reset OTP - Help Desk');
    otpStore.set(email, { hash: hashOtp(otp), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
    return res.status(202).json({ success: true, message: 'If the account exists, a reset code will be sent.' });
  } catch (error) {
    console.error('Password reset email error:', error.message);
    return res.status(202).json({ success: true, message: 'If the account exists, a reset code will be sent.' });
  }
});

app.post('/api/auth/resend-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = findUserByEmail(email);

  if (!user) {
    return res.status(202).json({ success: true, message: 'If the account exists, a reset code will be sent.' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  try {
    await sendPasswordResetEmail(email, otp, 'New Password Reset OTP - Help Desk');
    otpStore.set(email, { hash: hashOtp(otp), expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
    return res.status(202).json({ success: true, message: 'If the account exists, a reset code will be sent.' });
  } catch (error) {
    console.error('Password reset email error:', error.message);
    return res.status(202).json({ success: true, message: 'If the account exists, a reset code will be sent.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const user = findUserByEmail(email);
  const record = otpStore.get(email);

  if (!user || !record || Date.now() > record.expiresAt || record.attempts >= 5) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }

  record.attempts += 1;
  if (!otpMatches(record.hash, body.otp)) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }

  if (!isNonEmptyString(body.password, 200) || body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  user.password = await bcrypt.hash(body.password, 12);
  user[PASSWORD_RESET_FLAG] = false;
  otpStore.delete(email);
  saveData();

  return res.json({ success: true, message: 'Password updated successfully' });
});

app.get('/api/users', authenticateToken, (req, res) => {
  const visibleUsers = req.user.role === 'agent'
    ? users
    : users.filter((user) => user.role === 'agent');

  return res.json(visibleUsers.map(publicUser));
});

app.delete('/api/users/:id', authenticateToken, requireAgent, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  const userExists = users.some((user) => user.id === req.params.id);
  if (!userExists) {
    return res.status(404).json({ error: 'User not found' });
  }

  users = users.filter((user) => user.id !== req.params.id);
  saveData();
  return res.json({ success: true });
});

app.get('/api/tickets', authenticateToken, (req, res) => {
  const visibleTickets = req.user.role === 'agent'
    ? tickets
    : tickets.filter((ticket) => ticket.created_by === req.user.id);

  return res.json(visibleTickets);
});

app.post('/api/tickets', authenticateToken, (req, res) => {
  const body = req.body || {};
  const { title, description, category, priority, assigned_to: assignedTo } = body;

  if (!isNonEmptyString(title, 200) || !isNonEmptyString(description, 5000)) {
    return res.status(400).json({ error: 'Title and description are required' });
  }
  if (!TICKET_CATEGORIES.has(category) || !TICKET_PRIORITIES.has(priority)) {
    return res.status(400).json({ error: 'Invalid ticket category or priority' });
  }
  if (body.image !== undefined && (typeof body.image !== 'string' || body.image.length > 1500000 || (body.image && !body.image.startsWith('data:image/')))) {
    return res.status(400).json({ error: 'Invalid or oversized image attachment' });
  }

  const assignee = resolveAssignee(assignedTo);
  if (assignee === null) {
    return res.status(400).json({ error: 'Assigned user must be an agent' });
  }

  const newTicket = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: description.trim(),
    category,
    priority,
    status: 'Open',
    assigned_to: assignee,
    created_by: req.user.id,
    created_by_name: req.user.name,
    image: body.image || ''
  };

  tickets.unshift(newTicket);
  saveData();
  return res.status(201).json(newTicket);
});

app.patch('/api/tickets/:id', authenticateToken, (req, res) => {
  const body = req.body || {};
  if (!isObject(body)) {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  const ticket = tickets.find((candidate) => candidate.id === req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }
  if (!isAllowedTicket(req.user, ticket)) {
    return res.status(403).json({ error: 'You may only update your own tickets' });
  }

  const updates = {};
  if (body.status !== undefined) {
    if (!TICKET_STATUSES.has(body.status)) {
      return res.status(400).json({ error: 'Invalid ticket status' });
    }
    if (req.user.role !== 'agent' && body.status !== 'Cancelled') {
      return res.status(403).json({ error: 'Employees may only cancel their tickets' });
    }
    updates.status = body.status;
  }

  if (body.assigned_to !== undefined) {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'Only agents may assign tickets' });
    }
    const assignee = resolveAssignee(body.assigned_to);
    if (assignee === null) {
      return res.status(400).json({ error: 'Assigned user must be an agent' });
    }
    updates.assigned_to = assignee;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid ticket changes supplied' });
  }

  Object.assign(ticket, updates);
  saveData();
  return res.json(ticket);
});

app.get('/api/inventory', authenticateToken, requireAgent, (req, res) => res.json(inventory));

app.post('/api/inventory', authenticateToken, requireAgent, (req, res) => {
  const body = req.body || {};
  const { name, category, serial_number: serialNumber, assigned_to: assignedTo, status } = body;

  if (!isNonEmptyString(name, 200) || !isNonEmptyString(serialNumber, 120)) {
    return res.status(400).json({ error: 'Asset name and serial number are required' });
  }
  if (!INVENTORY_CATEGORIES.has(category) || !INVENTORY_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid asset category or status' });
  }
  if (inventory.some((item) => item.serial_number === serialNumber.trim())) {
    return res.status(400).json({ error: 'Serial number already exists' });
  }

  const assignee = resolveUserName(assignedTo);
  if (assignee === null) {
    return res.status(400).json({ error: 'Assigned user was not found' });
  }

  const newItem = {
    id: crypto.randomUUID(),
    name: name.trim(),
    category,
    serial_number: serialNumber.trim(),
    assigned_to: assignee,
    status
  };

  inventory.unshift(newItem);
  saveData();
  return res.status(201).json(newItem);
});

app.patch('/api/inventory/:id', authenticateToken, requireAgent, (req, res) => {
  const body = req.body || {};
  if (!isObject(body)) {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  const item = inventory.find((candidate) => candidate.id === req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  const updates = {};
  if (body.assigned_to !== undefined) {
    const assignee = resolveUserName(body.assigned_to);
    if (assignee === null) {
      return res.status(400).json({ error: 'Assigned user was not found' });
    }
    updates.assigned_to = assignee;
  }
  if (body.status !== undefined) {
    if (!INVENTORY_STATUSES.has(body.status)) {
      return res.status(400).json({ error: 'Invalid asset status' });
    }
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid asset changes supplied' });
  }

  Object.assign(item, updates);
  saveData();
  return res.json(item);
});

app.delete('/api/inventory/:id', authenticateToken, requireAgent, (req, res) => {
  if (!inventory.some((item) => item.id === req.params.id)) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  inventory = inventory.filter((item) => item.id !== req.params.id);
  saveData();
  return res.json({ success: true });
});

const canAccessTicketChat = (user, ticket) => Boolean(ticket && (user.role === 'agent' || ticket.created_by === user.id));

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return next(new Error('Account is no longer available'));
    socket.user = publicUser(user);
    return next();
  } catch (error) {
    return next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  socket.on('join_ticket_chat', (data = {}) => {
    const ticketId = data && data.ticketId;
    if (typeof ticketId !== 'string' || ticketId.length > 100) {
      return socket.emit('chat_error', { error: 'Invalid ticket' });
    }

    const ticket = tickets.find((candidate) => candidate.id === ticketId);
    if (!canAccessTicketChat(socket.user, ticket)) {
      return socket.emit('chat_error', { error: 'You may only access chats for permitted tickets' });
    }

    if (socket.data.ticketId) socket.leave(ticketRoom(socket.data.ticketId));
    socket.join(ticketRoom(ticketId));
    socket.data.ticketId = ticketId;
    return socket.emit('chat_history', {
      ticketId,
      messages: messages.filter((message) => message.ticketId === ticketId)
    });
  });

  socket.on('send_message', (data = {}) => {
    const safeData = data && typeof data === 'object' ? data : {};
    const ticketId = typeof safeData.ticketId === 'string' ? safeData.ticketId : socket.data.ticketId;
    const text = typeof safeData.text === 'string' ? safeData.text.trim() : '';
    const ticket = tickets.find((candidate) => candidate.id === ticketId);

    if (!ticketId || socket.data.ticketId !== ticketId || !canAccessTicketChat(socket.user, ticket)) {
      return socket.emit('chat_error', { error: 'Join a permitted ticket chat before sending messages' });
    }
    if (!text || text.length > 2000) {
      return socket.emit('chat_error', { error: 'Message must contain 1 to 2000 characters' });
    }
    if (socket.data.lastMessageAt && Date.now() - socket.data.lastMessageAt < 750) {
      return socket.emit('chat_error', { error: 'Please wait before sending another message' });
    }

    socket.data.lastMessageAt = Date.now();
    const message = {
      id: crypto.randomUUID(),
      ticketId,
      sender: socket.user.role === 'agent' ? 'agent' : 'user',
      senderName: socket.user.name,
      text,
      time: new Date().toISOString()
    };

    messages.push(message);
    if (messages.length > 10000) messages = messages.slice(-10000);
    saveData();
    return io.to(ticketRoom(ticketId)).emit('receive_message', message);
  });
});

const provisionBootstrapAgent = async () => {
  const { BOOTSTRAP_AGENT_EMAIL, BOOTSTRAP_AGENT_NAME, BOOTSTRAP_AGENT_PASSWORD } = process.env;
  if (!BOOTSTRAP_AGENT_EMAIL && !BOOTSTRAP_AGENT_NAME && !BOOTSTRAP_AGENT_PASSWORD) return;
  if (!BOOTSTRAP_AGENT_EMAIL || !BOOTSTRAP_AGENT_NAME || !BOOTSTRAP_AGENT_PASSWORD) {
    throw new Error('BOOTSTRAP_AGENT_EMAIL, BOOTSTRAP_AGENT_NAME, and BOOTSTRAP_AGENT_PASSWORD must be provided together');
  }
  if (BOOTSTRAP_AGENT_PASSWORD.length < 8) {
    throw new Error('BOOTSTRAP_AGENT_PASSWORD must be at least 8 characters');
  }

  const email = normalizeEmail(BOOTSTRAP_AGENT_EMAIL);
  if (!EMAIL_PATTERN.test(email)) throw new Error('BOOTSTRAP_AGENT_EMAIL is invalid');
  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'agent') throw new Error('Bootstrap agent email belongs to a non-agent account');
    return;
  }

  users.push({
    id: crypto.randomUUID(),
    name: BOOTSTRAP_AGENT_NAME.trim(),
    email,
    password: await bcrypt.hash(BOOTSTRAP_AGENT_PASSWORD, 12),
    [PASSWORD_RESET_FLAG]: false,
    role: 'agent'
  });
  saveData();
};

const startServer = async () => {
  migrateLegacyPasswords();
  await provisionBootstrapAgent();
  const port = Number(process.env.PORT || 5000);
  return server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Could not start server:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, server, io, startServer };
