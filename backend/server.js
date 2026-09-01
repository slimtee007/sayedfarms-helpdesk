const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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

let users = [
  { id: '1', name: 'IT Admin', email: 'admin@sayedfarm.com', role: 'agent', password: 'password123' },
  { id: '2', name: 'Employee User', email: 'user@sayedfarm.com', role: 'user', password: 'password123' }
];

let tickets = [
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
];

let inventory = [
  { id: '1', name: 'MacBook Pro 16 M2', category: 'Laptop', serial_number: 'SN-8942-X1', assigned_to: 'Unassigned', status: 'In Stock' }
];

app.post('/api/auth/signup', (req, res) => {
  const { name, email, password, role } = req.body;
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const newUser = { id: Date.now().toString(), name, email, password, role: role || 'user' };
  users.push(newUser);
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

app.post('/api/auth/reset-password', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user) {
    return res.status(404).json({ error: 'Email address not found in the system' });
  }
  user.password = password;
  res.json({ success: true, message: 'Password updated successfully' });
});

app.get('/api/users', (req, res) => {
  res.json(users.map(({ password, ...u }) => u));
});

app.delete('/api/users/:id', (req, res) => {
  users = users.filter(u => u.id !== req.params.id);
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
  res.json(newTicket);
});

app.patch('/api/tickets/:id', (req, res) => {
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  Object.assign(ticket, req.body);
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
  res.json(newItem);
});

app.patch('/api/inventory/:id', (req, res) => {
  const item = inventory.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  Object.assign(item, req.body);
  res.json(item);
});

app.delete('/api/inventory/:id', (req, res) => {
  inventory = inventory.filter(i => i.id !== req.params.id);
  res.json({ success: true });
});

io.on('connection', (socket) => {
  socket.on('send_message', (data) => {
    io.emit('receive_message', data);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});