// backend/server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const JWT_SECRET = 'super-secret-helpdesk-key-2026';

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  // Users Table
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user'
  )`);

  // Tickets Table
  db.run(`CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    description TEXT,
    category TEXT,
    priority TEXT DEFAULT 'Low',
    status TEXT DEFAULT 'Open',
    created_by INTEGER,
    created_by_name TEXT,
    assigned_to TEXT DEFAULT 'Unassigned',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id)
  )`);

  // Seed default IT Agent account (Email: agent@it.com | Password: password123)
  const agentPass = bcrypt.hashSync('password123', 10);
  db.run(`INSERT INTO users (name, email, password, role) VALUES ('Tech Agent', 'agent@it.com', ?, 'agent')`, [agentPass]);
});

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// --- AUTH ROUTES ---

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, role } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const userRole = role === 'agent' ? 'agent' : 'user';

  db.run(
    `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
    [name, email, hashedPassword, userRole],
    function (err) {
      if (err) return res.status(400).json({ error: 'Email already exists' });
      const token = jwt.sign({ id: this.lastID, name, email, role: userRole }, JWT_SECRET);
      res.json({ token, user: { id: this.lastID, name, email, role: userRole } });
    }
  );
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(403).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

// --- TICKET ROUTES ---

// Get tickets (Filtered by User vs Agent)
app.get('/api/tickets', authenticateToken, (req, res) => {
  if (req.user.role === 'agent') {
    db.all(`SELECT * FROM tickets ORDER BY created_at DESC`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } else {
    db.all(`SELECT * FROM tickets WHERE created_by = ? ORDER BY created_at DESC`, [req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

// Create ticket (User portal)
app.post('/api/tickets', authenticateToken, (req, res) => {
  const { title, description, category, priority } = req.body;
  db.run(
    `INSERT INTO tickets (title, description, category, priority, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)`,
    [title, description, category, priority || 'Low', req.user.id, req.user.name],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, title, status: 'Open' });
    }
  );
});

// Agent actions: Update ticket status or assignee
app.patch('/api/tickets/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'agent') {
    return res.status(403).json({ error: 'Only IT Agents can update ticket statuses' });
  }

  const { status, assigned_to } = req.body;
  db.run(
    `UPDATE tickets SET status = COALESCE(?, status), assigned_to = COALESCE(?, assigned_to) WHERE id = ?`,
    [status, assigned_to, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ updated: this.changes });
    }
  );
});

app.listen(5000, () => console.log('Auth & IT Helpdesk Backend running on port 5000'));