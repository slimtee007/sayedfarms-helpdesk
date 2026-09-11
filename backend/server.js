require('dotenv').config(); // <-- MUST BE AT THE VERY TOP
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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

// Default initial data if db.json does not exist
const initialData = {
  users: [
    { id: '1', name: 'IT Admin', email: 'admin@sayedfarm.com', role: 'agent', password: 'password123' },
    { id: '2', name: 'Employee User', email: 'user@sayedfarm.com', role: 'user', password: 'password123' }
  ],
  tickets: [
    {
      id: '101',
      title: 'Get IT help',
      description: 'Printer configuration assistance needed in the main office.',
      category: 'Hardware',
      priority: 'Medium',
      status: 'Open',
      assigned_to: 'Unassigned',
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
    return initialData;
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return initialData;
  }
};

const db = loadData();
let users = db.users || [];
let tickets = db.tickets || [];
let inventory = db.inventory || [];

// Save state to disk
const saveData = () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users, tickets, inventory }, null, 2));
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
  const user = users.find((u) => u.email === email);
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

app.post('/api/auth/signup', (req, res) => {
  const { name, email, password, role } = req.body;
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const newUser = { id: Date.now().toString(), name, email, password, role: role || 'user' };
  users.push(newUser);
  saveData();
  res.json({ token: 'mock-jwt-token-' + newUser.id, user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  res.json({ token: 'mock-jwt-token-' + user.id, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// Step 1: Generate and Send Password Reset OTP
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, email.trim().toLowerCase(), 'reset');
});

// Resend Password Reset OTP
app.post('/api/auth/resend-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, email.trim().toLowerCase(), 'resend');
});

// Step 2: Verify OTP and Reset Password
app.post('/api/auth/reset-password', (req, res) => {
  const { email, otp, password } = req.body;
  if (!email || !otp || !password) {
    return res.status(400).json({ error: 'Email, verification code and new password are required' });
  }
  const key = email.trim().toLowerCase();
  const user = users.find(u => u.email === key);
  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }

  const record = otpStore[key];
  if (!record || record.otp !== otp || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }

  user.password = password;
  delete otpStore[email];
  saveData();

  res.json({ success: true, message: 'Password updated successfully' });
});

app.get('/api/users', (req, res) => {
  res.json(users.map(({ password, ...u }) => u));
});

app.delete('/api/users/:id', (req, res) => {
  users = users.filter(u => u.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

app.get('/api/tickets', (req, res) => {
  res.json(tickets);
});

app.post('/api/tickets', (req, res) => {
  const { title, description, category, priority, assigned_to, image } = req.body;
  const newTicket = {
    id: Date.now().toString(),
    title,
    description,
    category,
    priority: priority || 'Medium',
    status: 'Open',
    assigned_to: assigned_to || 'Unassigned',
    created_by_name: 'User',
    image: image || ''
  };
  tickets.unshift(newTicket);
  saveData();
  res.json(newTicket);
});

app.patch('/api/tickets/:id', (req, res) => {
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  Object.assign(ticket, req.body);
  saveData();
  res.json(ticket);
});

app.get('/api/inventory', (req, res) => {
  res.json(inventory);
});

app.post('/api/inventory', (req, res) => {
  const { name, category, serial_number, assigned_to, status } = req.body;
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

app.patch('/api/inventory/:id', (req, res) => {
  const item = inventory.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  Object.assign(item, req.body);
  saveData();
  res.json(item);
});

app.delete('/api/inventory/:id', (req, res) => {
  inventory = inventory.filter(i => i.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

io.on('connection', (socket) => {
  socket.on('send_message', (data) => {
    io.emit('receive_message', data);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});