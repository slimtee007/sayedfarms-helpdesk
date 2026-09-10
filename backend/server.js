require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

const DATA_FILE = path.join(__dirname, 'db.json');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (IS_PRODUCTION) {
    throw new Error('JWT_SECRET must be configured in production');
  }

  console.warn('JWT_SECRET is not configured; using a temporary development secret.');
  return crypto.randomBytes(32).toString('hex');
})();

// A new installation starts without privileged accounts. Provisioning an agent
// should be handled separately instead of allowing public users to self-promote.
const initialData = {
  users: [],
  tickets: [],
  inventory: []
};

const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('Could not parse db.json:', error);
    return initialData;
  }
};

const db = loadData();
let users = Array.isArray(db.users) ? db.users : [];
let tickets = Array.isArray(db.tickets) ? db.tickets : [];
let inventory = Array.isArray(db.inventory) ? db.inventory : [];

const saveData = () => {
  const temporaryFile = `${DATA_FILE}.tmp`;
  const serialized = JSON.stringify({ users, tickets, inventory }, null, 2);
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
const TICKET_STATUSES = new Set(['Open', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled']);
const INVENTORY_STATUSES = new Set(['In Stock', 'Assigned', 'Under Maintenance', 'Decommissioned']);

const isPasswordHash = (password) => typeof password === 'string' && PASSWORD_HASH_PATTERN.test(password);
const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : '';
const isNonEmptyString = (value, maxLength = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const publicUser = ({ password, ...user }) => user;

const signToken = (user) => jwt.sign(
  { sub: user.id },
  JWT_SECRET,
  { expiresIn: JWT_EXPIRES_IN }
);

const findUserByEmail = (email) => users.find((user) => user.email === email);
const findUserById = (id) => users.find((user) => user.id === id);

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

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!isNonEmptyString(name, 120) || !normalizedEmail || !isNonEmptyString(password, 200)) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
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
    // Public signup can only create employee accounts.
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
  const { email, password } = req.body || {};
  const user = findUserByEmail(normalizeEmail(email));

  if (!user || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  let validPassword = false;
  if (isPasswordHash(user.password)) {
    validPassword = await bcrypt.compare(password, user.password);
  } else {
    // One-time compatibility path for legacy db.json records. Successful
    // logins are upgraded immediately so plaintext is not retained at rest.
    validPassword = user.password === password;
    if (validPassword) {
      user.password = await bcrypt.hash(password, 12);
      saveData();
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

// Step 1: Generate and send password reset OTP.
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = findUserByEmail(email);

  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  otpStore.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });

  try {
    if (process.env.SMTP_HOST && !process.env.SMTP_HOST.includes('example')) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'support@sayedfarms.com',
        to: email,
        subject: 'Password Reset OTP - Help Desk',
        text: `Your One-Time Password (OTP) for password reset is: ${otp}. It is valid for 10 minutes.`,
        html: `<p>Your One-Time Password (OTP) for password reset is: <b>${otp}</b>.</p><p>It is valid for 10 minutes.</p>`
      });
    } else {
      console.warn('SMTP is not configured; password reset email was not sent.');
    }

    return res.json({ success: true, message: 'OTP generated successfully.' });
  } catch (error) {
    console.error('Email send error:', error);
    return res.status(500).json({ error: 'Failed to send OTP email' });
  }
});

app.post('/api/auth/resend-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = findUserByEmail(email);

  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  otpStore.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });

  try {
    if (process.env.SMTP_HOST && !process.env.SMTP_HOST.includes('example')) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'support@sayedfarms.com',
        to: email,
        subject: 'New Password Reset OTP - Help Desk',
        text: `Your new One-Time Password (OTP) is: ${otp}. It is valid for 10 minutes.`,
        html: `<p>Your new One-Time Password (OTP) is: <b>${otp}</b>.</p>`
      });
    } else {
      console.warn('SMTP is not configured; password reset email was not sent.');
    }

    return res.json({ success: true, message: 'A new OTP code has been generated.' });
  } catch (error) {
    console.error('Email resend error:', error);
    return res.status(500).json({ error: 'Failed to send new OTP' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { otp, password } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  const user = findUserByEmail(email);
  const record = otpStore.get(email);

  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }

  if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }

  if (!isNonEmptyString(password, 200) || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  user.password = await bcrypt.hash(password, 12);
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
  const { title, description, category, priority, assigned_to } = req.body || {};

  if (!isNonEmptyString(title, 200) || !isNonEmptyString(description, 5000)) {
    return res.status(400).json({ error: 'Title and description are required' });
  }

  const assignee = resolveAssignee(assigned_to);
  if (assignee === null) {
    return res.status(400).json({ error: 'Assigned user must be an agent' });
  }

  const newTicket = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: description.trim(),
    category: isNonEmptyString(category, 80) ? category.trim() : 'General',
    priority: isNonEmptyString(priority, 30) ? priority.trim() : 'Medium',
    status: 'Open',
    assigned_to: assignee,
    created_by: req.user.id,
    created_by_name: req.user.name,
    image: typeof req.body.image === 'string' ? req.body.image : ''
  };

  tickets.unshift(newTicket);
  saveData();
  return res.status(201).json(newTicket);
});

app.patch('/api/tickets/:id', authenticateToken, (req, res) => {
  const ticket = tickets.find((candidate) => candidate.id === req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  if (req.user.role !== 'agent' && ticket.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You may only update your own tickets' });
  }

  const updates = {};
  if (req.body.status !== undefined) {
    if (!TICKET_STATUSES.has(req.body.status)) {
      return res.status(400).json({ error: 'Invalid ticket status' });
    }
    if (req.user.role !== 'agent' && req.body.status !== 'Cancelled') {
      return res.status(403).json({ error: 'Employees may only cancel their tickets' });
    }
    updates.status = req.body.status;
  }

  if (req.body.assigned_to !== undefined) {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'Only agents may assign tickets' });
    }
    const assignee = resolveAssignee(req.body.assigned_to);
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

app.get('/api/inventory', authenticateToken, requireAgent, (req, res) => {
  return res.json(inventory);
});

app.post('/api/inventory', authenticateToken, requireAgent, (req, res) => {
  const { name, category, serial_number, assigned_to, status } = req.body || {};

  if (!isNonEmptyString(name, 200) || !isNonEmptyString(serial_number, 120)) {
    return res.status(400).json({ error: 'Asset name and serial number are required' });
  }

  if (inventory.some((item) => item.serial_number === serial_number.trim())) {
    return res.status(400).json({ error: 'Serial number already exists' });
  }

  const assignee = resolveUserName(assigned_to);
  if (assignee === null) {
    return res.status(400).json({ error: 'Assigned user was not found' });
  }

  const assetStatus = status || 'In Stock';
  if (!INVENTORY_STATUSES.has(assetStatus)) {
    return res.status(400).json({ error: 'Invalid asset status' });
  }

  const newItem = {
    id: crypto.randomUUID(),
    name: name.trim(),
    category: isNonEmptyString(category, 80) ? category.trim() : 'Other',
    serial_number: serial_number.trim(),
    assigned_to: assignee,
    status: assetStatus
  };

  inventory.unshift(newItem);
  saveData();
  return res.status(201).json(newItem);
});

app.patch('/api/inventory/:id', authenticateToken, requireAgent, (req, res) => {
  const item = inventory.find((candidate) => candidate.id === req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  const updates = {};
  if (req.body.assigned_to !== undefined) {
    const assignee = resolveUserName(req.body.assigned_to);
    if (assignee === null) {
      return res.status(400).json({ error: 'Assigned user was not found' });
    }
    updates.assigned_to = assignee;
  }

  if (req.body.status !== undefined) {
    if (!INVENTORY_STATUSES.has(req.body.status)) {
      return res.status(400).json({ error: 'Invalid asset status' });
    }
    updates.status = req.body.status;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid asset changes supplied' });
  }

  Object.assign(item, updates);
  saveData();
  return res.json(item);
});

app.delete('/api/inventory/:id', authenticateToken, requireAgent, (req, res) => {
  const itemExists = inventory.some((item) => item.id === req.params.id);
  if (!itemExists) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  inventory = inventory.filter((item) => item.id !== req.params.id);
  saveData();
  return res.json({ success: true });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) {
      return next(new Error('Account is no longer available'));
    }
    socket.user = publicUser(user);
    return next();
  } catch (error) {
    return next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  socket.on('send_message', (data) => {
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 2000) return;

    io.emit('receive_message', {
      sender: socket.user.role === 'agent' ? 'agent' : 'user',
      senderName: socket.user.name,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });
});

const PORT = Number(process.env.PORT || 5000);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
