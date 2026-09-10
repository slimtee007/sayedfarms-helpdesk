const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = 5000;
const JWT_SECRET = 'supersecretkey123';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Create HTTP Server & initialize Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Socket.IO event listeners for real-time live chat
io.on('connection', (socket) => {
  console.log('Client connected to socket:', socket.id);

  socket.on('send_message', (data) => {
    // Broadcast to all connected clients including the sender
    io.emit('receive_message', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const db = new sqlite3.Database('./helpdesk.db', (err) => {
  if (err) console.error('Database opening error:', err);
  else console.log('Connected to SQLite Database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    description TEXT,
    category TEXT,
    priority TEXT,
    status TEXT DEFAULT 'Open',
    created_by TEXT,
    created_by_name TEXT,
    assigned_to TEXT DEFAULT 'Unassigned',
    image TEXT
  )`, () => {
    db.run(`ALTER TABLE tickets ADD COLUMN image TEXT`, () => {});
  });

  db.run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    category TEXT,
    serial_number TEXT UNIQUE,
    assigned_to TEXT DEFAULT 'Unassigned',
    status TEXT DEFAULT 'In Stock'
  )`);
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      [name, email, hashedPassword, role || 'user'],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already exists' });
          return res.status(500).json({ error: err.message });
        }
        const user = { id: this.lastID, name, email, role: role || 'user' };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, user });
      }
    );
  } catch (err) {
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

// Get Users or Agents
app.get('/api/users', authenticateToken, (req, res) => {
  if (req.user.role === 'agent') {
    db.all(`SELECT id, name, email, role FROM users ORDER BY id DESC`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } else {
    db.all(`SELECT id, name, email, role FROM users WHERE role = 'agent' ORDER BY name ASC`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

app.delete('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'agent') return res.status(403).json({ error: 'Unauthorized' });
  db.run(`DELETE FROM users WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'User deleted successfully' });
  });
});

// Tickets endpoints
app.get('/api/tickets', authenticateToken, (req, res) => {
  if (req.user.role === 'agent') {
    db.all(`SELECT * FROM tickets ORDER BY id DESC`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } else {
    db.all(`SELECT * FROM tickets WHERE created_by = ? ORDER BY id DESC`, [req.user.email], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

app.post('/api/tickets', authenticateToken, (req, res) => {
  const { title, description, category, priority, assigned_to, image } = req.body;
  const initialStatus = (assigned_to && assigned_to !== 'Unassigned') ? 'In Progress' : 'Open';

  db.run(
    `INSERT INTO tickets (title, description, category, priority, status, created_by, created_by_name, assigned_to, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, description, category, priority, initialStatus, req.user.email, req.user.name, assigned_to || 'Unassigned', image || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, title, description, category, priority, status: initialStatus, created_by: req.user.email, created_by_name: req.user.name, assigned_to: assigned_to || 'Unassigned', image });
    }
  );
});

app.patch('/api/tickets/:id', authenticateToken, (req, res) => {
  const { status, assigned_to } = req.body;
  const updates = [];
  const params = [];

  if (status) { updates.push('status = ?'); params.push(status); }
  if (assigned_to !== undefined) { updates.push('assigned_to = ?'); params.push(assigned_to); }
  params.push(req.params.id);

  db.run(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Ticket updated successfully' });
  });
});

// Inventory endpoints
app.get('/api/inventory', authenticateToken, (req, res) => {
  if (req.user.role !== 'agent') return res.status(403).json({ error: 'Unauthorized' });
  db.all(`SELECT * FROM inventory ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/inventory', authenticateToken, (req, res) => {
  if (req.user.role !== 'agent') return res.status(403).json({ error: 'Unauthorized' });
  const { name, category, serial_number, assigned_to, status } = req.body;

  db.run(
    `INSERT INTO inventory (name, category, serial_number, assigned_to, status) VALUES (?, ?, ?, ?, ?)`,
    [name, category, serial_number, assigned_to || 'Unassigned', status || 'In Stock'],
    function (err) {
      if (err) return res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Serial number already exists' : err.message });
      res.json({ id: this.lastID, name, category, serial_number, assigned_to: assigned_to || 'Unassigned', status: status || 'In Stock' });
    }
  );
});

app.patch('/api/inventory/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'agent') return res.status(403).json({ error: 'Unauthorized' });
  const { assigned_to, status } = req.body;
  const updates = [];
  const params = [];

  if (assigned_to !== undefined) { updates.push('assigned_to = ?'); params.push(assigned_to); }
  if (status) { updates.push('status = ?'); params.push(status); }
  params.push(req.params.id);

  db.run(`UPDATE inventory SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Asset updated successfully' });
  });
});

app.delete('/api/inventory/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'agent') return res.status(403).json({ error: 'Unauthorized' });
  db.run(`DELETE FROM inventory WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Asset deleted' });
  });
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

server.listen(PORT, () => {
  console.log(`Auth & IT Helpdesk Backend with Live Chat running on port ${PORT}`);
});