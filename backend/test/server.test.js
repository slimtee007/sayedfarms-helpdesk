const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { io: connectSocket } = require('socket.io-client');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-helpdesk-'));
const dataFile = path.join(tempDirectory, 'db.json');

const fixture = {
  users: [
    {
      id: 'user-1',
      name: 'Employee User',
      email: 'user@example.com',
      password: bcrypt.hashSync('employee-password', 12),
      role: 'user',
      must_reset_password: false
    },
    {
      id: 'agent-1',
      name: 'IT Agent',
      email: 'agent@example.com',
      password: bcrypt.hashSync('agent-password', 12),
      role: 'agent',
      must_reset_password: false
    },
    {
      id: 'other-user',
      name: 'Other User',
      email: 'other@example.com',
      password: bcrypt.hashSync('other-password', 12),
      role: 'user',
      must_reset_password: false
    }
  ],
  tickets: [],
  inventory: [],
  messages: []
};

fs.writeFileSync(dataFile, JSON.stringify(fixture, null, 2));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-integration-tests';
process.env.HELPDESK_DATA_FILE = dataFile;
process.env.FRONTEND_ORIGINS = 'http://localhost:5173';

const { app, server, io: socketServer } = require('../server');
const api = request(app);
let employeeToken;
let agentToken;
let employeeTicketId;

test('rejects protected requests without a token', async () => {
  const response = await api.get('/api/users');
  assert.equal(response.status, 401);
});

test('logs in with a bcrypt password and returns a JWT', async () => {
  const response = await api
    .post('/api/auth/login')
    .send({ email: 'user@example.com', password: 'employee-password' });

  assert.equal(response.status, 200);
  assert.match(response.body.token, /^ey/);
  assert.equal(response.body.user.role, 'user');
  employeeToken = response.body.token;
});

test('public signup cannot self-promote to agent', async () => {
  const response = await api
    .post('/api/auth/signup')
    .send({
      name: 'New Employee',
      email: 'new@example.com',
      password: 'new-password',
      role: 'agent'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.user.role, 'user');
});

test('validates ticket input and records its owner', async () => {
  const invalidResponse = await api
    .post('/api/tickets')
    .set('Authorization', `Bearer ${employeeToken}`)
    .send({ title: 'Incomplete ticket' });
  assert.equal(invalidResponse.status, 400);

  const response = await api
    .post('/api/tickets')
    .set('Authorization', `Bearer ${employeeToken}`)
    .send({
      title: 'Cannot connect to VPN',
      description: 'The VPN client fails to connect from the office.',
      category: 'Network',
      priority: 'High'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.created_by, 'user-1');
  employeeTicketId = response.body.id;
});

test('employees see only their tickets and cannot access inventory', async () => {
  const ticketsResponse = await api
    .get('/api/tickets')
    .set('Authorization', `Bearer ${employeeToken}`);
  assert.equal(ticketsResponse.status, 200);
  assert.equal(ticketsResponse.body.length, 1);
  assert.equal(ticketsResponse.body[0].created_by, 'user-1');

  const inventoryResponse = await api
    .get('/api/inventory')
    .set('Authorization', `Bearer ${employeeToken}`);
  assert.equal(inventoryResponse.status, 403);
});

test('agent permissions allow ticket and inventory administration', async () => {
  const loginResponse = await api
    .post('/api/auth/login')
    .send({ email: 'agent@example.com', password: 'agent-password' });
  assert.equal(loginResponse.status, 200);
  agentToken = loginResponse.body.token;

  const ticketResponse = await api
    .get('/api/tickets')
    .set('Authorization', `Bearer ${agentToken}`);
  assert.equal(ticketResponse.status, 200);
  assert.equal(ticketResponse.body.some((ticket) => ticket.id === employeeTicketId), true);

  const inventoryResponse = await api
    .get('/api/inventory')
    .set('Authorization', `Bearer ${agentToken}`);
  assert.equal(inventoryResponse.status, 200);
});

test('employees cannot modify another user ticket', async () => {
  const otherLogin = await api
    .post('/api/auth/login')
    .send({ email: 'other@example.com', password: 'other-password' });
  assert.equal(otherLogin.status, 200);

  const response = await api
    .patch(`/api/tickets/${employeeTicketId}`)
    .set('Authorization', `Bearer ${otherLogin.body.token}`)
    .send({ status: 'Cancelled' });
  assert.equal(response.status, 403);
});

test('ticket chat is authenticated and scoped to the ticket room', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const employeeSocket = connectSocket(url, { auth: { token: employeeToken }, transports: ['websocket'] });
  const agentSocket = connectSocket(url, { auth: { token: agentToken }, transports: ['websocket'] });

  await Promise.all([
    new Promise((resolve, reject) => {
      employeeSocket.once('connect', resolve);
      employeeSocket.once('connect_error', reject);
    }),
    new Promise((resolve, reject) => {
      agentSocket.once('connect', resolve);
      agentSocket.once('connect_error', reject);
    })
  ]);

  const employeeHistory = new Promise((resolve) => employeeSocket.once('chat_history', resolve));
  const agentHistory = new Promise((resolve) => agentSocket.once('chat_history', resolve));
  employeeSocket.emit('join_ticket_chat', { ticketId: employeeTicketId });
  agentSocket.emit('join_ticket_chat', { ticketId: employeeTicketId });
  assert.equal((await employeeHistory).ticketId, employeeTicketId);
  assert.equal((await agentHistory).ticketId, employeeTicketId);

  const receivedMessage = new Promise((resolve) => agentSocket.once('receive_message', resolve));
  employeeSocket.emit('send_message', { ticketId: employeeTicketId, text: 'Please check this connection.' });
  const message = await receivedMessage;
  assert.equal(message.ticketId, employeeTicketId);
  assert.equal(message.sender, 'user');

  employeeSocket.disconnect();
  agentSocket.disconnect();
  await new Promise((resolve) => socketServer.close(resolve));
});

test.after(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});
