/**
 * API regression tests for the SayedFarms Helpdesk backend.
 *
 * These cover the bugs that shipped because nothing tested the UI's promises
 * against the API's behaviour (see BUG-REPORT #32–#34):
 *   - statuses the console offers must be accepted, not 400'd
 *   - statuses must never be silently rewritten to a different value
 *   - assignments are keyed by user id, survive renames, and follow deletes
 *   - "Direct Request to Agent" actually assigns the chosen agent
 *   - password-reset codes survive a server restart (#24)
 *
 * Run with:  npm test      (node --test, no extra dependencies)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const ADMIN_EMAIL = 'admin@sayedfarms.test';
const ADMIN_PASSWORD = 'AdminPass!2345';

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** Boot the real server against a scratch db.json and wait until it listens. */
const startServer = async (dataFile, port, extraEnv = {}) => {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_FILE: dataFile,
      JWT_SECRET: 'test-secret-not-for-production',
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      // Deliberately no SMTP_* — the server then returns the dev OTP so the
      // reset flow is testable end-to-end.
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      // The suite drives the whole API from 127.0.0.1; scale the limiter up so
      // tests don't trip each other's buckets. The limiter itself is covered
      // separately, with scaling off.
      RATE_LIMIT_SCALE: '100',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early (${proc.exitCode}):\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${base}/api/meta/enums`);
      // 401 is a fine answer — it proves the listener is up.
      if (res.status === 401 || res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    logs,
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', resolve);
        proc.kill('SIGKILL');
      }),
  };
};

const api = (base) => {
  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, body: json };
  };
  return {
    get: (url, opts) => call('GET', url, opts),
    post: (url, opts) => call('POST', url, opts),
    patch: (url, opts) => call('PATCH', url, opts),
    delete: (url, opts) => call('DELETE', url, opts),
  };
};

const login = async (client, email, password) => {
  const res = await client.post('/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
};

// ---------------------------------------------------------------------------
// Shared fixture: one server for the whole suite.
// ---------------------------------------------------------------------------
let tmpDir;
let dbFile;
let server;
let client;
let admin;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-test-'));
  dbFile = path.join(tmpDir, 'db.json');
  server = await startServer(dbFile, await freePort());
  client = api(server.base);
  admin = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD);
});

test.after(async () => {
  if (server) await server.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const newTicket = (body = {}) =>
  client.post('/api/tickets', {
    token: admin.token,
    body: { title: 'Test ticket', description: 'created by the API test suite', ...body },
  });

// ---------------------------------------------------------------------------
// #32 — every ticket status the Agent Console offers must be accepted.
// ---------------------------------------------------------------------------
test('GET /api/meta/enums is authenticated and lists the accepted values', async () => {
  const anon = await client.get('/api/meta/enums');
  assert.equal(anon.status, 401, 'enums should not be readable without a session');

  const res = await client.get('/api/meta/enums', { token: admin.token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.ticketStatus));
  // The two values that used to 400.
  assert.ok(res.body.ticketStatus.includes('Pending'), '"Pending" must be accepted');
  assert.ok(res.body.ticketStatus.includes('Closed'), '"Closed" must be accepted');
  assert.ok(res.body.inventoryStatus.includes('Under Maintenance'));
  assert.ok(res.body.inventoryStatus.includes('Decommissioned'));
});

test('every published ticket status can actually be set on a ticket (#32)', async () => {
  const enums = (await client.get('/api/meta/enums', { token: admin.token })).body;
  const created = await newTicket();
  assert.equal(created.status, 200);
  const id = created.body.id;

  for (const status of enums.ticketStatus) {
    const res = await client.patch(`/api/tickets/${id}`, { token: admin.token, body: { status } });
    assert.equal(res.status, 200, `PATCH status="${status}" was rejected: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, status, `status "${status}" was not stored verbatim`);
  }

  const bogus = await client.patch(`/api/tickets/${id}`, { token: admin.token, body: { status: 'Nonsense' } });
  assert.equal(bogus.status, 400, 'an unknown status must be rejected, not ignored');
});

// ---------------------------------------------------------------------------
// #33 — asset statuses: offered by the UI, silently rewritten before.
// ---------------------------------------------------------------------------
test('an asset keeps the exact status it was created/labelled with (#33)', async () => {
  const enums = (await client.get('/api/meta/enums', { token: admin.token })).body;

  for (const status of enums.inventoryStatus) {
    const serial = `SN-${status.replace(/\W+/g, '-').toUpperCase()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await client.post('/api/inventory', {
      token: admin.token,
      body: { name: 'Test Asset', category: 'Laptop', serial_number: serial, status },
    });
    assert.equal(created.status, 200, `POST status="${status}" failed: ${JSON.stringify(created.body)}`);
    assert.equal(created.body.status, status, `status "${status}" was silently changed on create`);

    const patched = await client.patch(`/api/inventory/${created.body.id}`, {
      token: admin.token,
      body: { status },
    });
    assert.equal(patched.status, 200, `PATCH status="${status}" was rejected: ${JSON.stringify(patched.body)}`);
    assert.equal(patched.body.status, status, `status "${status}" was not stored verbatim`);
  }

  const bad = await client.post('/api/inventory', {
    token: admin.token,
    body: { name: 'Bad Asset', category: 'Laptop', serial_number: 'SN-BAD-STATUS', status: 'Teleported' },
  });
  assert.equal(bad.status, 400, 'an unknown asset status must be rejected, never silently replaced');
});

// ---------------------------------------------------------------------------
// #34 — the employee "Direct Request to Agent" dropdown must do something.
// ---------------------------------------------------------------------------
test('an employee request to a specific agent is honoured (#34)', async () => {
  const email = `emp-${Date.now()}@example.com`;
  const signup = await client.post('/api/auth/signup', {
    body: { name: 'Test Employee', email, password: 'EmployeePass!23' },
  });
  assert.equal(signup.status, 200);
  const emp = signup.body;

  const agents = (await client.get('/api/agents', { token: emp.token })).body;
  assert.ok(agents.length >= 1, 'the seeded admin agent should be listed');
  const target = agents[0];

  const ticket = await client.post('/api/tickets', {
    token: emp.token,
    body: { title: 'Direct request', description: 'please assign this to my agent', assigned_to_id: target.id },
  });
  assert.equal(ticket.status, 200, `employee request was rejected: ${JSON.stringify(ticket.body)}`);
  assert.equal(ticket.body.assigned_to_id, target.id, 'the requested agent must be assigned');
  assert.equal(ticket.body.assigned_to, target.name, 'the display name must match the agent');
});

test('a ticket cannot be assigned to a non-agent or an unknown user (#8)', async () => {
  const email = `emp2-${Date.now()}@example.com`;
  const emp = (
    await client.post('/api/auth/signup', {
      body: { name: 'Second Employee', email, password: 'EmployeePass!23' },
    })
  ).body;

  const toEmployee = await client.post('/api/tickets', {
    token: admin.token,
    body: { title: 'Bad assignee', description: 'x', assigned_to_id: emp.user.id },
  });
  assert.equal(toEmployee.status, 400, 'tickets may only go to IT agents');
  assert.match(toEmployee.body.error, /agent/i);

  const toNobody = await client.post('/api/tickets', {
    token: admin.token,
    body: { title: 'Ghost assignee', description: 'x', assigned_to_id: 'user-does-not-exist' },
  });
  assert.equal(toNobody.status, 400, 'an unknown assignee must be rejected');
});

// ---------------------------------------------------------------------------
// #17 — assignments keyed by id: renames, duplicates, deletes.
// ---------------------------------------------------------------------------
test('assignments survive a rename and follow the same account (#17)', async () => {
  const email = `rename-${Date.now()}@example.com`;
  const emp = (
    await client.post('/api/auth/signup', {
      body: { name: 'Renamable Person', email, password: 'EmployeePass!23' },
    })
  ).body.user;

  const asset = (
    await client.post('/api/inventory', {
      token: admin.token,
      body: { name: 'Renamed Laptop', category: 'Laptop', serial_number: `SN-RENAME-${Date.now()}`, assigned_to_id: emp.id, status: 'Assigned' },
    })
  ).body;
  assert.equal(asset.assigned_to_id, emp.id);
  assert.equal(asset.assigned_to, 'Renamable Person');

  const renamed = await client.patch(`/api/users/${emp.id}`, {
    token: admin.token,
    body: { name: 'Renamed Person' },
  });
  assert.equal(renamed.status, 200);

  const after = (await client.get('/api/inventory', { token: admin.token })).body.find((i) => i.id === asset.id);
  assert.equal(after.assigned_to_id, emp.id, 'a rename must not orphan the assignment');
  assert.equal(after.assigned_to, 'Renamed Person', 'the denormalized name must be refreshed');
});

test('two users with the same display name are distinguishable (#17)', async () => {
  const stamp = Date.now();
  const a = (
    await client.post('/api/auth/signup', { body: { name: 'Same Name', email: `same-a-${stamp}@example.com`, password: 'EmployeePass!23' } })
  ).body.user;
  const b = (
    await client.post('/api/auth/signup', { body: { name: 'Same Name', email: `same-b-${stamp}@example.com`, password: 'EmployeePass!23' } })
  ).body.user;
  assert.notEqual(a.id, b.id);

  const asset = (
    await client.post('/api/inventory', {
      token: admin.token,
      body: { name: 'Shared Name Laptop', category: 'Laptop', serial_number: `SN-SAME-${stamp}`, assigned_to_id: b.id },
    })
  ).body;
  assert.equal(asset.assigned_to_id, b.id, 'the id, not the name, decides who owns it');
});

test('deleting a user clears their assignments', async () => {
  const stamp = Date.now();
  const emp = (
    await client.post('/api/auth/signup', { body: { name: 'Doomed User', email: `doomed-${stamp}@example.com`, password: 'EmployeePass!23' } })
  ).body.user;

  const asset = (
    await client.post('/api/inventory', {
      token: admin.token,
      body: { name: 'Doomed Laptop', category: 'Laptop', serial_number: `SN-DOOM-${stamp}`, assigned_to_id: emp.id, status: 'Assigned' },
    })
  ).body;

  const del = await client.delete(`/api/users/${emp.id}`, { token: admin.token });
  assert.equal(del.status, 200);

  const after = (await client.get('/api/inventory', { token: admin.token })).body.find((i) => i.id === asset.id);
  assert.equal(after.assigned_to_id, null);
  assert.equal(after.assigned_to, 'Unassigned');
  assert.equal(after.status, 'In Stock', 'a freed asset returns to stock');
});

test('legacy name-keyed assignments are migrated on boot (#17)', async () => {
  // Simulate a pre-#17 database: assignments stored as display names only.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-legacy-'));
  const legacyDb = path.join(legacyDir, 'db.json');
  fs.writeFileSync(
    legacyDb,
    JSON.stringify({
      users: [
        // A plain employee: the name on the ticket is what the migration has
        // to resolve, and leaving no agent means the admin seed still runs.
        { id: 'legacy-agent', name: 'Legacy Agent', email: 'legacy@sayedfarms.test', role: 'user', password: 'x' },
      ],
      tickets: [{ id: 'legacy-1', title: 'Old ticket', description: 'd', assigned_to: 'Legacy Agent', messages: [] }],
      inventory: [{ id: 'legacy-asset', name: 'Old laptop', category: 'Laptop', serial_number: 'SN-OLD', assigned_to: 'Legacy Agent', status: 'Assigned' }],
      resetCodes: {},
    })
  );

  const legacyServer = await startServer(legacyDb, await freePort());
  try {
    const c = api(legacyServer.base);
    const token = (await login(c, ADMIN_EMAIL, ADMIN_PASSWORD)).token;
    const tickets = (await c.get('/api/tickets', { token })).body;
    assert.equal(tickets[0].assigned_to_id, 'legacy-agent', 'the name should be resolved to an id');
    const assets = (await c.get('/api/inventory', { token })).body;
    assert.equal(assets[0].assigned_to_id, 'legacy-agent');

    const onDisk = JSON.parse(fs.readFileSync(legacyDb, 'utf8'));
    assert.equal(onDisk.tickets[0].assigned_to_id, 'legacy-agent', 'the migration must be persisted');
  } finally {
    await legacyServer.stop();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #24 — reset codes survive a restart, and are not stored in plaintext.
// ---------------------------------------------------------------------------
test('a password-reset code still works after a server restart (#24)', async () => {
  const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-restart-'));
  const restartDb = path.join(restartDir, 'db.json');
  let s = await startServer(restartDb, await freePort());
  try {
    let c = api(s.base);
    const email = `reset-${Date.now()}@example.com`;
    await c.post('/api/auth/signup', { body: { name: 'Reset Person', email, password: 'OriginalPass!23' } });

    const asked = await c.post('/api/auth/forgot-password', { body: { email } });
    assert.equal(asked.status, 200);
    const code = asked.body.devOtp;
    assert.match(String(code), /^\d{6}$/, 'dev mode should return the code so reset can be tested');

    const onDisk = JSON.parse(fs.readFileSync(restartDb, 'utf8'));
    const stored = onDisk.resetCodes[email];
    assert.ok(stored, 'the code must be persisted, not held in memory');
    assert.ok(!JSON.stringify(stored).includes(String(code)), 'the code must not be stored in plaintext');

    // Restart the server — before #24 this voided the code.
    await s.stop();
    s = await startServer(restartDb, await freePort());
    c = api(s.base);

    const reset = await c.post('/api/auth/reset-password', {
      body: { email, otp: code, password: 'BrandNewPass!23' },
    });
    assert.equal(reset.status, 200, `reset after restart failed: ${JSON.stringify(reset.body)}`);

    const relogin = await c.post('/api/auth/login', { body: { email, password: 'BrandNewPass!23' } });
    assert.equal(relogin.status, 200, 'the new password must work');
  } finally {
    await s.stop();
    fs.rmSync(restartDir, { recursive: true, force: true });
  }
});

test('reset codes expire and burn after repeated wrong guesses (#24)', async () => {
  const email = `burn-${Date.now()}@example.com`;
  await client.post('/api/auth/signup', { body: { name: 'Burn Person', email, password: 'OriginalPass!23' } });
  const asked = await client.post('/api/auth/forgot-password', { body: { email } });
  const code = asked.body.devOtp;

  let lastBad;
  for (let i = 0; i < 5; i += 1) {
    lastBad = await client.post('/api/auth/reset-password', {
      body: { email, otp: '000000', password: 'BrandNewPass!23' },
    });
    assert.equal(lastBad.status, 400);
  }
  assert.match(lastBad.body.error, /too many/i, 'the final wrong guess should say the code was burned');

  const afterBurn = await client.post('/api/auth/reset-password', {
    body: { email, otp: code, password: 'BrandNewPass!23' },
  });
  assert.equal(afterBurn.status, 400, 'the code should be dead after too many wrong guesses');

  const noLogin = await client.post('/api/auth/login', { body: { email, password: 'OriginalPass!23' } });
  assert.equal(noLogin.status, 200, 'a burned reset attempt must not change the password');
});

// ---------------------------------------------------------------------------
// Guards that must not regress while the above was changed.
// ---------------------------------------------------------------------------
test('employees still cannot escalate or reassign other people\'s tickets (#8)', async () => {
  const stamp = Date.now();
  const owner = (await client.post('/api/auth/signup', { body: { name: 'Owner', email: `owner-${stamp}@example.com`, password: 'EmployeePass!23' } })).body;
  const other = (await client.post('/api/auth/signup', { body: { name: 'Other', email: `other-${stamp}@example.com`, password: 'EmployeePass!23' } })).body;

  const ticket = (await client.post('/api/tickets', { token: owner.token, body: { title: 'Mine', description: 'mine' } })).body;

  const escalation = await client.patch(`/api/users/${owner.user.id}`, { token: owner.token, body: { role: 'agent' } });
  assert.equal(escalation.status, 403, 'self-promotion must stay blocked');

  const reassign = await client.patch(`/api/tickets/${ticket.id}`, {
    token: other.token,
    body: { status: 'Cancelled' },
  });
  assert.equal(reassign.status, 403, 'you may only touch your own tickets');

  const agentOnly = await client.get('/api/users', { token: owner.token });
  assert.equal(agentOnly.status, 403, 'the user directory stays agent-only');
});

test('the login rate limiter still returns 429 with retry hints (#7)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-ratelimit-'));
  const file = path.join(dir, 'db.json');
  // Scaling off: this test wants the limiter at its real budget.
  const s = await startServer(file, await freePort(), { RATE_LIMIT_SCALE: '1' });
  try {
    const c = api(s.base);
    await client.post('/api/auth/signup', {
      body: { name: 'Brute Force Target', email: 'brute@example.com', password: 'EmployeePass!23' },
    });

    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await c.post('/api/auth/login', { body: { email: 'brute@example.com', password: `wrong-${i}` } });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429, 'repeated failed logins must eventually be rate limited');
    assert.ok(last.body.retryAfter > 0, 'a 429 should tell the client when to retry');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown API routes still return JSON 404s', async () => {
  const res = await client.get('/api/does-not-exist', { token: admin.token });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Unknown API endpoint/);
});
