/**
 * PBX call logging tests — the Panasonic SMDR parser, the call-to-ticket
 * pipeline and the call report.
 *
 * Two layers:
 *   1. parser unit tests (no server): every Panasonic record shape the helpdesk
 *      claims to understand, plus the noise a real SMDR port produces;
 *   2. API tests against a real booted server: webhook ingestion, ticket
 *      creation and attribution, the solved/not-solved lifecycle, the ticket
 *      policy modes, queue scoping, the report/CSV, and both TCP feed modes
 *      (the PBX pushing records to us, and us connecting to the PBX).
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

const { parseSmdrLine, parseCapture, parseCallMoment, durationTokenToSeconds } = require('../pbx/smdr');

const SERVER = path.join(__dirname, '..', 'server.js');
const ADMIN_EMAIL = 'admin@pbx.test';
const ADMIN_PASSWORD = 'AdminPass!2345';
const PBX_TOKEN = 'test-pbx-secret';
const IT_EXT = '204,205';

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

test('SMDR parser: reads a modern Panasonic record (date, ext, trunk, CLI, ring, talk time, condition code)', () => {
  const parsed = parseSmdrLine("21/09/25 14:32:10 204 01 +2348031234567 0'12 00:03'45 AN", { dateFormat: 'auto', dayFirst: true });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const r = parsed.record;
  assert.equal(r.extension, '204');
  assert.equal(r.trunk, '01');
  assert.equal(r.dialed_number, '+2348031234567');
  assert.equal(r.caller_number, '+2348031234567', 'an inbound CLI is the caller number');
  assert.equal(r.ring_seconds, 12);
  assert.equal(r.duration_seconds, 225, "00:03'45 = 3m45s");
  assert.equal(r.condition_code, 'AN');
  assert.equal(r.answered, true);
  assert.equal(r.direction, 'Incoming');
  assert.deepEqual([r.call_day, r.call_time], ['2025-09-21', '14:32:10']);
});

test('SMDR parser: an unanswered call is recorded as not answered with zero talk time', () => {
  const parsed = parseSmdrLine("21/09/25 15:02:01 204 01 08035550123 0'22 00:00'00 NA", { dateFormat: 'auto', dayFirst: true });
  assert.equal(parsed.record.answered, false);
  assert.equal(parsed.record.duration_seconds, 0);
  assert.equal(parsed.record.ring_seconds, 22);
  assert.equal(parsed.record.direction, 'Incoming');
});

test('SMDR parser: an extension-to-extension call is Internal and names both ends', () => {
  const parsed = parseSmdrLine("21/09/25 15:10:00 210 01 204 0'05 00:01'12 AN", { dateFormat: 'auto', dayFirst: true });
  assert.equal(parsed.record.direction, 'Internal');
  assert.equal(parsed.record.extension, '210');
  assert.equal(parsed.record.dialed_number, '204');
  assert.equal(parsed.record.caller_number, '', 'an internal call has no external CLI');
  assert.equal(parsed.record.duration_seconds, 72);
});

test('SMDR parser: an outgoing call is Outgoing and the dialled number is not reported as a CLI', () => {
  const parsed = parseSmdrLine("21/09/25 16:00:00 204 02 08031234567 0'00 00:06'30 O", { dateFormat: 'auto', dayFirst: true });
  assert.equal(parsed.record.direction, 'Outgoing');
  assert.equal(parsed.record.dialed_number, '08031234567');
  assert.equal(parsed.record.caller_number, '');
  assert.equal(parsed.record.duration_seconds, 390);
});

test('SMDR parser: handles the `\\` no-CLI marker, 12-hour clocks and AM/PM', () => {
  const parsed = parseSmdrLine("14/05/14 10:23AM 501 16 \\ 0'05 00:00'10", { dateFormat: 'auto', dayFirst: true });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.record.direction, 'Incoming');
  assert.equal(parsed.record.extension, '501');
  assert.equal(parsed.record.trunk, '16');
  assert.equal(parsed.record.dialed_number, '');
  assert.equal(parsed.record.ring_seconds, 5);
  assert.equal(parsed.record.duration_seconds, 10);
  assert.equal(parsed.record.call_time, '10:23:00');
});

test('SMDR parser: verification codes (`*9533`) are kept as-is in the extension column', () => {
  const parsed = parseSmdrLine('05/14/14 09:59AM *9533 02 9538177108 00:11\'17', { dateFormat: 'auto' });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.record.extension, '*9533');
  assert.equal(parsed.record.trunk, '02');
  assert.equal(parsed.record.dialed_number, '9538177108');
  assert.equal(parsed.record.duration_seconds, 677);
});

test('SMDR parser: header rows, separators, control lines and junk are not records', () => {
  assert.equal(parseSmdrLine('Date     Time   Ext CO     Dial Number       Ring Duration Acc code CD').reason, 'header');
  assert.equal(parseSmdrLine('-------------------------------------------------------------------').reason, 'separator');
  assert.equal(parseSmdrLine('OK').reason, 'control');
  assert.equal(parseSmdrLine('   ').reason, 'blank');
  assert.equal(parseSmdrLine('not a real record').reason, 'unparsed');
  const capture = parseCapture('Date     Time   Ext CO\n------\n21/09/25 15:10:00 210 01 204 0\'05 00:01\'12 AN\njunk line\n');
  assert.equal(capture.records.length, 1, 'exactly one usable record');
  assert.deepEqual(capture.skipped.map((s) => s.reason), ['unparsed']);
});

test('SMDR parser: day-first vs month-first dates, and an explicit PBX_DATE_FORMAT', () => {
  // Unambiguous: 21 cannot be a month.
  assert.equal(parseCallMoment('21/09/25', '14:32:10', {}).day, '2025-09-21');
  // Ambiguous: DD/MM vs MM/DD is decided by PBX_DAY_FIRST (Panasonic's console
  // defaults to MM/DD/YY, so that is the default here too).
  assert.equal(parseCallMoment('09/10/25', '09:00', {}).day, '2025-09-10');
  assert.equal(parseCallMoment('09/10/25', '09:00', { dayFirst: true }).day, '2025-10-09');
  // An explicit console setting always wins (KX-NS "international" YY-MM-DD).
  assert.equal(parseCallMoment('25-09-21', '08:15:59', { dateFormat: 'YY-MM-DD' }).day, '2025-09-21');
  assert.equal(parseCallMoment('21-09-2025', '08:15', { dateFormat: 'DD-MM-YYYY' }).day, '2025-09-21');
  assert.equal(parseCallMoment('nonsense', '08:15', {}), null);
});

test('SMDR parser: duration formats, and JSON/delimited payloads from middleware', () => {
  assert.equal(durationTokenToSeconds("0'05"), 5);
  assert.equal(durationTokenToSeconds("00:03'45"), 225);
  assert.equal(durationTokenToSeconds('00:01:23'), 83);
  assert.equal(durationTokenToSeconds('2:10'), 130);
  assert.equal(durationTokenToSeconds('nope'), null);

  const json = parseSmdrLine(JSON.stringify({
    date: '2025-09-21', time: '14:32:10', ext: '204', co: '01',
    dialedNumber: '08035550123', ring: '12', duration: '225', conditionCode: 'AN',
  }), {});
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.equal(json.record.duration_seconds, 225);
  assert.equal(json.record.caller_number, '08035550123');
  assert.equal(json.record.extension, '204');
  assert.equal(json.record.parse_format, 'json');

  const delimited = parseSmdrLine('2025-09-21,15:10:00,210,01,204,5,72,AN', { delimiter: ',', dateFormat: 'auto' });
  assert.equal(delimited.ok, true, JSON.stringify(delimited));
  assert.equal(delimited.record.parse_format, 'delimited');
  assert.equal(delimited.record.extension, '210');
  assert.equal(delimited.record.duration_seconds, 72);
});

// ---------------------------------------------------------------------------
// API harness (same shape as api.test.js: a real server on a scratch store)
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

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
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
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
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${logs.join('')}`);
    try {
      const res = await fetch(`${base}/api/meta/enums`);
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
  const call = async (method, url, { token, body, headers, raw } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(raw ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json, headers: res.headers };
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

const makeAgent = async (client, label, adminToken) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${label}-${stamp}@example.com`;
  const created = await client.post('/api/auth/signup', { body: { name: `${label} ${stamp}`, email, password: 'AgentPass!2345' } });
  assert.equal(created.status, 200);
  const promoted = await client.patch(`/api/users/${created.body.user.id}`, { token: adminToken, body: { role: 'agent' } });
  assert.equal(promoted.status, 200, `promotion failed: ${JSON.stringify(promoted.body)}`);
  const session = await login(client, email, 'AgentPass!2345');
  return { ...session.user, token: session.token };
};

const makeEmployee = async (client, label) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${label}-${stamp}@example.com`;
  const created = await client.post('/api/auth/signup', { body: { name: `${label} ${stamp}`, email, password: 'EmployeePass!23' } });
  assert.equal(created.status, 200);
  const session = await login(client, email, 'EmployeePass!23');
  return { ...session.user, token: session.token };
};

/** POST raw SMDR text the way PBX middleware would. */
const pushSmdr = (client, text, token) =>
  client.post('/api/pbx/calls', { raw: text, headers: token ? { 'X-PBX-Token': token, 'Content-Type': 'text/plain' } : { 'Content-Type': 'text/plain' } });

const today = (secondsAgo = 0) => {
  const d = new Date(Date.now() - secondsAgo * 1000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
};
const nowClock = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toTimeString().slice(0, 8);
/**
 * A realistic SMDR line dated *today* so reports and the retention window see it.
 * `secondsAgo` shifts the record back in time: two tests that both print an
 * internal call between the same two extensions would otherwise be merged into
 * one call by the intercom de-duplication.
 */
const smdr = (extension, dialed, { ring = "0'10", duration = "0'00'30", cd = 'AN', secondsAgo = 0 } = {}) =>
  `${today(secondsAgo)} ${nowClock(secondsAgo)} ${extension} 01 ${dialed} ${ring} ${duration} ${cd}`;

// ---------------------------------------------------------------------------
// Webhook ingestion → tickets
// ---------------------------------------------------------------------------
let tmpDir;
let dbFile;
let server;
let client;
let admin;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-'));
  dbFile = path.join(tmpDir, 'db.json');
  server = await startServer(dbFile, await freePort(), {
    PBX_ENABLED: 'true',
    PBX_TRANSPORT: 'webhook',
    PBX_TOKEN,
    PBX_IT_EXTENSIONS: IT_EXT,
    PBX_TICKET_POLICY: 'all',
    PBX_MIN_CALL_SECONDS: '5',
    PBX_ALLOW_SIMULATOR: 'true',
  });
  client = api(server.base);
  admin = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD);
});

test.after(async () => {
  if (server) await server.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PBX: the ingestion webhook requires the shared token or an IT agent session', async () => {
  const anon = await pushSmdr(client, smdr('204', '08035550123'), null);
  assert.equal(anon.status, 401, 'anonymous posts must be refused');
  assert.match(anon.body.error, /shared secret|PBX_TOKEN/);

  const wrong = await pushSmdr(client, smdr('204', '08035550123'), 'not-the-secret');
  assert.equal(wrong.status, 401);

  const employee = await makeEmployee(client, 'pbx-employee');
  const asEmployee = await pushSmdr(client, smdr('204', '08035550123'), null) && (await client.post('/api/pbx/calls', {
    token: employee.token, raw: smdr('204', '08035550123'), headers: { 'Content-Type': 'text/plain' },
  }));
  assert.equal(asEmployee.status, 401, 'employees cannot file calls');

  const asAgent = await pushSmdr(client, smdr('204', '08035550124'), PBX_TOKEN);
  assert.equal(asAgent.status, 202);
  assert.equal(asAgent.body.parsed, 1);
});

test('PBX: a call to the IT office is logged with its time, ring time and duration, and raises a ticket', async () => {
  const line = smdr('204', '08035559999', { ring: "0'14", duration: "0'02'05", cd: 'AN' });
  const pushed = await pushSmdr(client, `${line}\n`, PBX_TOKEN);
  assert.equal(pushed.status, 202, JSON.stringify(pushed.body));
  assert.equal(pushed.body.parsed, 1);
  assert.equal(pushed.body.ticketIds.length, 1, 'a ticket is raised for an IT-office call');

  const call = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.calls
    .find((c) => c.id === pushed.body.callIds[0]);
  assert.equal(call.direction, 'Incoming');
  assert.equal(call.extension, '204');
  assert.equal(call.caller_number, '08035559999');
  assert.equal(call.ring_seconds, 14);
  assert.equal(call.duration_seconds, 125);
  assert.equal(call.duration_display, '2m 5s');
  assert.equal(call.answered, true);
  assert.equal(call.is_helpdesk_call, true);
  assert.equal(call.resolution_outcome, 'Pending');
  assert.equal(call.ticket_id, pushed.body.ticketIds[0]);

  const ticket = (await client.get('/api/tickets', { token: admin.token })).body.find((t) => t.id === call.ticket_id);
  assert.equal(ticket.source, 'pbx_call');
  assert.equal(ticket.call_id, call.id);
  assert.match(ticket.title, /204/);
  assert.match(ticket.description, /Call time:/);
  assert.match(ticket.description, /Call duration: 2m 5s/);
  assert.match(ticket.description, /Ring time: 14s/);
  assert.equal(ticket.status, 'Open');
});

test('PBX: calls that never touched the IT office are logged but raise no ticket', async () => {
  const pushed = await pushSmdr(client, `${smdr('310', '08035551111')}\n`, PBX_TOKEN);
  assert.equal(pushed.status, 202);
  assert.equal(pushed.body.parsed, 1);
  assert.deepEqual(pushed.body.ticketIds, [], 'extension 310 is not an IT-office extension');
  const call = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.calls
    .find((c) => c.id === pushed.body.callIds[0]);
  assert.equal(call.is_helpdesk_call, false);
  assert.equal(call.ticket_id, null);
});

test('PBX: calls too short to be an issue report are logged without a ticket', async () => {
  const pushed = await pushSmdr(client, `${smdr('204', '08035552222', { ring: "0'02", duration: "0'03" })}\n`, PBX_TOKEN);
  assert.equal(pushed.body.parsed, 1);
  assert.deepEqual(pushed.body.ticketIds, [], 'a 3-second call is below PBX_MIN_CALL_SECONDS');
  const call = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.calls
    .find((c) => c.id === pushed.body.callIds[0]);
  assert.equal(call.is_helpdesk_call, true, 'still recognised as an IT-office call');
  assert.equal(call.duration_seconds, 3);

  // …and an agent can still turn it into a ticket by hand.
  const raised = await client.post(`/api/pbx/calls/${call.id}/ticket`, { token: admin.token });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.ok(raised.body.ticket.id);
});

test('PBX: replaying the same records does not duplicate calls or tickets', async () => {
  const line = smdr('204', '08035553333', { ring: "0'06", duration: "0'01'00" });
  const first = await pushSmdr(client, `${line}\n`, PBX_TOKEN);
  assert.equal(first.body.parsed, 1);
  const before = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.total;

  const replay = await pushSmdr(client, `${line}\n`, PBX_TOKEN);
  assert.equal(replay.body.parsed, 1);
  assert.equal(replay.body.duplicates, 1, 'the identical record is recognised');
  assert.deepEqual(replay.body.callIds, []);
  assert.deepEqual(replay.body.ticketIds, []);

  const after = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.total;
  assert.equal(after, before, 'no new call was stored');
});

test('PBX: the two records Panasonic prints for one intercom call merge into one call and one ticket', async () => {
  const out = smdr('210', '204', { ring: "0'05", duration: "0'00'50" });
  const back = `${today()} ${nowClock()} 204 01 210 0'05 00:00'48 AN`;
  const first = await pushSmdr(client, `${out}\n`, PBX_TOKEN);
  assert.equal(first.body.parsed, 1);
  assert.equal(first.body.ticketIds.length, 1);

  const second = await pushSmdr(client, `${back}\n`, PBX_TOKEN);
  assert.equal(second.body.duplicates, 1, 'the mirrored record is merged');
  assert.deepEqual(second.body.ticketIds, [], 'no second ticket for the same conversation');

  const calls = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.calls;
  const merged = calls.find((c) => c.id === first.body.callIds[0]);
  assert.equal(merged.mirrored_records, 2);
  assert.equal(merged.duration_seconds, 50, 'the longer talk time is kept');
  assert.equal(calls.filter((c) => c.mirrored_records === 2).length, 1);
});

test('PBX: unreadable records are rejected with a reason instead of being silently dropped', async () => {
  const res = await pushSmdr(client, 'this is not smdr\nnor is this\n', PBX_TOKEN);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No usable SMDR records/);
  assert.equal(res.body.skipped.length, 2);
  assert.equal(res.body.skipped[0].reason, 'unparsed');
});

// ---------------------------------------------------------------------------
// Extension directory → attribution
// ---------------------------------------------------------------------------

test('PBX: mapping an extension to an employee files the ticket under their account', async () => {
  const employee = await makeEmployee(client, 'pbx-amina');

  const mapped = await client.post('/api/pbx/extensions', {
    token: admin.token,
    body: { extension: '210', user_id: employee.id, department: 'Farm Ops' },
  });
  assert.equal(mapped.status, 201, JSON.stringify(mapped.body));
  assert.equal(mapped.body.user_name, employee.name);
  assert.equal(mapped.body.linked, true);

  const pushed = await pushSmdr(client, `${smdr('210', '204', { ring: "0'05", duration: "0'02'00", secondsAgo: 900 })}\n`, PBX_TOKEN);
  assert.equal(pushed.body.ticketIds.length, 1);

  const ticket = (await client.get('/api/tickets', { token: admin.token })).body.find((t) => t.id === pushed.body.ticketIds[0]);
  assert.equal(ticket.created_by, employee.id, 'the caller owns the request');
  assert.equal(ticket.created_by_name, employee.name);
  assert.match(ticket.title, new RegExp(employee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // …which means the employee sees it in their own portal, with the phone marker.
  const mine = await client.get('/api/tickets', { token: employee.token });
  const seen = mine.body.find((t) => t.id === ticket.id);
  assert.ok(seen, 'the employee can see the ticket the phone call raised');
  assert.equal(seen.source, 'pbx_call');

  // The call log is operational data: employees never reach it.
  const denied = await client.get('/api/pbx/calls', { token: employee.token });
  assert.equal(denied.status, 403);
});

test('PBX: the extension directory is readable by agents but only editable by a super admin', async () => {
  const agent = await makeAgent(client, 'pbx-agent', admin.token);
  const read = await client.get('/api/pbx/extensions', { token: agent.token });
  assert.equal(read.status, 200);
  assert.ok(Array.isArray(read.body));

  const write = await client.post('/api/pbx/extensions', { token: agent.token, body: { extension: '211' } });
  assert.equal(write.status, 403, 'a regular agent cannot remap extensions');

  const bad = await client.post('/api/pbx/extensions', { token: admin.token, body: { extension: 'not-a-number' } });
  assert.equal(bad.status, 400);

  const clash = await client.post('/api/pbx/extensions', { token: admin.token, body: { extension: '210' } });
  assert.equal(clash.status, 400, 'the same extension cannot be mapped twice');
  assert.match(clash.body.error, /already in the directory/);
});

// ---------------------------------------------------------------------------
// Solved / not solved
// ---------------------------------------------------------------------------

test('PBX: resolving the ticket marks the call solved and records the time from the phone call to the fix', async () => {
  const pushed = await pushSmdr(client, `${smdr('204', '08035554444', { ring: "0'09", duration: "0'04'00" })}\n`, PBX_TOKEN);
  const callId = pushed.body.callIds[0];
  const ticketId = pushed.body.ticketIds[0];

  let call = (await client.get(`/api/pbx/calls/${callId}`, { token: admin.token })).body;
  assert.equal(call.resolution_outcome, 'Pending');
  assert.equal(call.resolution_minutes, null);

  const resolved = await client.patch(`/api/tickets/${ticketId}`, { token: admin.token, body: { status: 'Resolved' } });
  assert.equal(resolved.status, 200);

  call = (await client.get(`/api/pbx/calls/${callId}`, { token: admin.token })).body;
  assert.equal(call.issue_resolved, true);
  assert.equal(call.resolution_outcome, 'Solved');
  assert.equal(call.resolution_source, 'ticket');
  assert.equal(call.resolved_by, admin.user.name, 'the agent who resolved the ticket is on record');
  assert.ok(call.resolved_at);
  assert.ok(call.resolution_minutes >= 0 && call.resolution_minutes < 60, `minutes to solve looked wrong: ${call.resolution_minutes}`);

  // Closing keeps it solved…
  await client.patch(`/api/tickets/${ticketId}`, { token: admin.token, body: { status: 'Closed' } });
  call = (await client.get(`/api/pbx/calls/${callId}`, { token: admin.token })).body;
  assert.equal(call.resolution_outcome, 'Solved');

  // …and reopening puts it back to pending rather than claiming it was fixed.
  await client.patch(`/api/tickets/${ticketId}`, { token: admin.token, body: { status: 'In Progress' } });
  call = (await client.get(`/api/pbx/calls/${callId}`, { token: admin.token })).body;
  assert.equal(call.resolution_outcome, 'Pending');
  assert.equal(call.resolution_minutes, null);
});

test('PBX: an agent can mark a call solved (or not solved) on the call itself, and add notes', async () => {
  const pushed = await pushSmdr(client, `${smdr('204', '08035555555', { ring: "0'11", duration: "0'05'00", cd: 'NA' })}\n`, PBX_TOKEN);
  const callId = pushed.body.callIds[0];
  assert.equal((await client.get(`/api/pbx/calls/${callId}`, { token: admin.token })).body.answered, false);

  const solved = await client.patch(`/api/pbx/calls/${callId}`, {
    token: admin.token,
    body: { issue_resolved: true, notes: 'Called the caller back and fixed it remotely.' },
  });
  assert.equal(solved.status, 200, JSON.stringify(solved.body));
  assert.equal(solved.body.resolution_outcome, 'Solved');
  assert.equal(solved.body.resolution_source, 'agent');
  assert.equal(solved.body.resolved_by, admin.user.name);
  assert.equal(solved.body.notes, 'Called the caller back and fixed it remotely.');

  const notSolved = await client.patch(`/api/pbx/calls/${callId}`, { token: admin.token, body: { issue_resolved: false } });
  assert.equal(notSolved.body.resolution_outcome, 'Not solved');
  assert.equal(notSolved.body.resolution_minutes, null);

  const back = await client.patch(`/api/pbx/calls/${callId}`, { token: admin.token, body: { issue_resolved: null } });
  assert.equal(back.body.resolution_outcome, 'Pending');

  const invalid = await client.patch(`/api/pbx/calls/${callId}`, { token: admin.token, body: { issue_resolved: 'maybe' } });
  assert.equal(invalid.status, 400);
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

test('PBX: an agent sees their own calls plus unclaimed ones, never another agent\'s', async () => {
  const agentA = await makeAgent(client, 'pbx-a', admin.token);
  const agentB = await makeAgent(client, 'pbx-b', admin.token);

  const pushed = await pushSmdr(client, `${smdr('204', '08035556666', { ring: "0'07", duration: "0'03'30" })}\n`, PBX_TOKEN);
  const callId = pushed.body.callIds[0];
  const ticketId = pushed.body.ticketIds[0];

  // Unclaimed: both agents may see it (that is the "pick it up" case).
  for (const agent of [agentA, agentB]) {
    const list = await client.get('/api/pbx/calls?days=all', { token: agent.token });
    assert.ok(list.body.calls.some((c) => c.id === callId), `${agent.name} should see an unclaimed call`);
  }

  // Dispatch it to agent A: now it belongs to their queue only.
  const dispatched = await client.patch(`/api/tickets/${ticketId}`, { token: admin.token, body: { assigned_to_id: agentA.id } });
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));

  const aList = await client.get('/api/pbx/calls?days=all', { token: agentA.token });
  assert.ok(aList.body.calls.some((c) => c.id === callId), 'the owner still sees their call');
  const bList = await client.get('/api/pbx/calls?days=all', { token: agentB.token });
  assert.ok(!bList.body.calls.some((c) => c.id === callId), 'another agent must not see it');
  const bDirect = await client.get(`/api/pbx/calls/${callId}`, { token: agentB.token });
  assert.equal(bDirect.status, 403);
  const bPatch = await client.patch(`/api/pbx/calls/${callId}`, { token: agentB.token, body: { issue_resolved: true } });
  assert.equal(bPatch.status, 403);

  // The super admin sees everything.
  const adminRow = await client.get(`/api/pbx/calls/${callId}`, { token: admin.token });
  assert.equal(adminRow.status, 200);
});

// ---------------------------------------------------------------------------
// Filters, report, CSV, dry-run parse and the simulator
// ---------------------------------------------------------------------------

test('PBX: the call log filters by direction, outcome, extension, ticket and free text', async () => {
  const all = await client.get('/api/pbx/calls?days=all', { token: admin.token });
  assert.ok(all.body.total > 0);

  const incoming = await client.get('/api/pbx/calls?days=all&direction=Incoming', { token: admin.token });
  assert.ok(incoming.body.calls.every((c) => c.direction === 'Incoming'));

  const internal = await client.get('/api/pbx/calls?days=all&direction=Internal', { token: admin.token });
  assert.ok(internal.body.calls.every((c) => c.direction === 'Internal'));

  const noTicket = await client.get('/api/pbx/calls?days=all&ticket=no', { token: admin.token });
  assert.ok(noTicket.body.calls.every((c) => !c.ticket_id));

  const byExtension = await client.get('/api/pbx/calls?days=all&extension=204', { token: admin.token });
  assert.ok(byExtension.body.calls.length > 0);

  const bad = await client.get('/api/pbx/calls?days=all&direction=Sideways', { token: admin.token });
  assert.equal(bad.status, 400);

  const badOutcome = await client.get('/api/pbx/calls?days=all&outcome=Fuzzy', { token: admin.token });
  assert.equal(badOutcome.status, 400);

  const badRange = await client.get('/api/reports/calls?days=nope', { token: admin.token });
  assert.equal(badRange.status, 400);
});

test('PBX: the call report aggregates volume, durations and outcomes, and exports CSV', async () => {
  const report = await client.get('/api/reports/calls?days=all', { token: admin.token });
  assert.equal(report.status, 200);
  const s = report.body.summary;
  assert.ok(s.total > 0);
  assert.equal(s.total, report.body.rows.length);
  assert.equal(s.total, s.incoming + s.outgoing + s.internal, 'every call has exactly one direction');
  assert.equal(s.total, s.answered + s.missed + s.unknownAnswer);
  assert.equal(s.ticketed + s.unticketed, s.total);
  assert.ok(s.solved + s.unsolved + s.pending === s.total);
  assert.ok(s.totalTalkSeconds >= 0);
  assert.equal(report.body.byHour.length, 24);
  assert.ok(Array.isArray(report.body.byExtension) && report.body.byExtension.length > 0);
  assert.ok(report.body.byDay.length > 0);
  assert.equal(report.body.scope, 'all');
  assert.match(report.body.range.label, /All time/);
  // The per-extension split names the person once the extension is mapped.
  const ext210 = report.body.byExtension.find((e) => e.key === '210');
  assert.ok(ext210 && ext210.calls > 0);
  assert.ok(ext210.name, 'the mapped caller is named in the report');

  const csv = await fetch(`${server.base}/api/reports/calls/export?days=all`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /PBX Call Report/);
  assert.match(text, /Average phone-call-to-fix \(minutes\)/);
  assert.match(text, /Calls per day/);
  assert.match(text, /Extension,Name,Calls/);
  assert.match(text, /Call ID,Call time,Day,Time,Direction/);
  assert.ok(text.split('\r\n').length > 10);
});

test('PBX: the report is scoped like the ticket queue (an agent only sees their own calls)', async () => {
  const agent = await makeAgent(client, 'pbx-report-agent', admin.token);
  const other = await makeAgent(client, 'pbx-report-other', admin.token);

  // One unclaimed IT call, and one dispatched to a different agent.
  const unclaimed = await pushSmdr(client, `${smdr('204', '08039990001', { ring: "0'05", duration: "0'02'00", secondsAgo: 1200 })}\n`, PBX_TOKEN);
  const claimed = await pushSmdr(client, `${smdr('204', '08039990002', { ring: "0'05", duration: "0'02'00", secondsAgo: 1500 })}\n`, PBX_TOKEN);
  assert.equal(unclaimed.body.ticketIds.length, 1);
  const dispatched = await client.patch(`/api/tickets/${claimed.body.ticketIds[0]}`, {
    token: admin.token, body: { assigned_to_id: other.id },
  });
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));

  const mine = await client.get('/api/reports/calls?days=all', { token: agent.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.scope, 'own');
  const ids = mine.body.rows.map((r) => r.id);
  assert.ok(ids.includes(unclaimed.body.callIds[0]), "unclaimed calls are part of an agent's queue");
  assert.ok(!ids.includes(claimed.body.callIds[0]), "another agent's call is not in the report");

  const every = await client.get('/api/reports/calls?days=all', { token: admin.token });
  assert.equal(every.body.scope, 'all');
  assert.ok(every.body.summary.total >= mine.body.summary.total, 'a super admin sees at least as much');
  assert.ok(every.body.rows.some((r) => r.id === claimed.body.callIds[0]));

  // The call itself is equally out of reach for the agent who does not own it.
  const direct = await client.get(`/api/pbx/calls/${claimed.body.callIds[0]}`, { token: agent.token });
  assert.equal(direct.status, 403);
});

test('PBX: POST /api/pbx/parse is a dry run — it reads records but stores nothing', async () => {
  const before = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.total;
  const res = await client.post('/api/pbx/parse', {
    token: admin.token,
    raw: `${smdr('204', '08039998888', { ring: "0'04", duration: "0'01'00" })}\nDate Time Ext CO Dial Number\njunk\n`,
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.parsed, 1);
  assert.equal(res.body.skipped, 2, 'the header row and the junk row are both skipped');
  assert.deepEqual(res.body.itExtensions, ['204', '205'], 'the preview names the configured IT extensions');
  assert.equal(res.body.results[0].ok, true);
  assert.equal(res.body.results[0].record.extension, '204');
  assert.equal(res.body.results[0].record.duration_seconds, 60);
  assert.equal(res.body.results[0].would_raise_ticket, true);
  assert.equal(res.body.results[1].ok, false);

  const after = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.total;
  assert.equal(after, before, 'the dry run must not touch the call log');
});

test('PBX: the simulator pushes a real SMDR record through the pipeline (and gates itself in production)', async () => {
  const before = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.total;
  const sim = await client.post('/api/pbx/calls/simulate', { token: admin.token, body: { direction: 'Incoming', seconds: 140, ring: 9 } });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.match(sim.body.raw, /^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, 'the simulated line is a real SMDR record');
  assert.equal(sim.body.call.duration_display, '2m 20s');
  assert.equal(sim.body.call.ring_display, '9s');
  assert.equal(sim.body.call.direction, 'Incoming');
  assert.equal(sim.body.call.caller_number, '08035550123', 'the CLI sits in the Dial Number column, like the console prints it');
  assert.ok(sim.body.ticket, 'the simulated call raised a ticket');

  // The line the simulator prints is a real record: feeding it back to the dry
  // run parses identically (that is what an admin pastes to check settings).
  const echo = await client.post('/api/pbx/parse', {
    token: admin.token,
    raw: `${sim.body.raw}\n`,
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(echo.body.results[0].ok, true, JSON.stringify(echo.body.results[0]));
  assert.equal(echo.body.results[0].record.caller_number, '08035550123');
  assert.equal(echo.body.results[0].record.duration_seconds, 140);
  const after = (await client.get('/api/pbx/calls?days=all', { token: admin.token })).body.total;
  assert.equal(after, before + 1);
});

test('PBX: logging a call by hand works, and refuses nonsense', async () => {
  const logged = await client.post('/api/pbx/calls/manual', {
    token: admin.token,
    body: { extension: '205', direction: 'Incoming', duration: "2'35", ring_seconds: 6, caller_number: '08031112222', notes: 'Printer jam in accounts' },
  });
  assert.equal(logged.status, 200, JSON.stringify(logged.body));
  assert.equal(logged.body.call.duration_seconds, 155);
  assert.equal(logged.body.call.duration_display, '2m 35s');
  assert.equal(logged.body.call.source, 'manual');
  assert.equal(logged.body.call.notes, 'Printer jam in accounts');
  assert.ok(logged.body.ticket, 'a manual call to an IT extension raises a ticket too');

  const badExtension = await client.post('/api/pbx/calls/manual', { token: admin.token, body: { extension: '', direction: 'Incoming' } });
  assert.equal(badExtension.status, 400);
  const badDirection = await client.post('/api/pbx/calls/manual', { token: admin.token, body: { extension: '205', direction: 'Sideways' } });
  assert.equal(badDirection.status, 400);
  const badDuration = await client.post('/api/pbx/calls/manual', { token: admin.token, body: { extension: '205', duration_seconds: -5 } });
  assert.equal(badDuration.status, 400);
});

test('PBX: /api/pbx/status reports the feed, the policy and what still needs configuring', async () => {
  const status = await client.get('/api/pbx/status', { token: admin.token });
  assert.equal(status.status, 200);
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.transport, 'webhook');
  assert.deepEqual(status.body.itExtensions, ['204', '205']);
  assert.equal(status.body.ticketPolicy, 'all');
  assert.equal(status.body.webhookConfigured, true);
  assert.ok(status.body.stats.storedCalls > 0);
  assert.ok(Array.isArray(status.body.warnings));

  const anon = await client.get('/api/pbx/status');
  assert.equal(anon.status, 401, 'the PBX status is IT-console data');
});

test('PBX: the published enums include the call vocabularies the console filters on', async () => {
  const enums = (await client.get('/api/meta/enums', { token: admin.token })).body;
  assert.deepEqual(enums.callDirection, ['Incoming', 'Outgoing', 'Internal']);
  assert.deepEqual(enums.callOutcome, ['Solved', 'Not solved', 'Pending']);
  assert.deepEqual(enums.pbxTicketPolicy, ['all', 'answered', 'missed', 'off']);
});

// ---------------------------------------------------------------------------
// Ticket policy modes (separate servers: the policy is boot-time config)
// ---------------------------------------------------------------------------

test('PBX_TICKET_POLICY=answered only raises tickets for calls that were answered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-answered-'));
  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_TOKEN, PBX_IT_EXTENSIONS: IT_EXT, PBX_TICKET_POLICY: 'answered',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const answered = await pushSmdr(c, `${smdr('204', '08030000001', { ring: "0'10", duration: "0'01'00", cd: 'AN' })}\n`, PBX_TOKEN);
    const missed = await pushSmdr(c, `${smdr('204', '08030000002', { ring: "0'25", duration: "0'00'00", cd: 'NA' })}\n`, PBX_TOKEN);
    assert.equal(answered.body.ticketIds.length, 1);
    assert.deepEqual(missed.body.ticketIds, [], 'a missed call is logged, not ticketed, in this mode');

    const calls = (await c.get('/api/pbx/calls?days=all', { token: adminSession.token })).body.calls;
    assert.equal(calls.length, 2, 'both calls are in the log');
    assert.equal(calls.find((x) => x.answered === false).ticket_id, null);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PBX_TICKET_POLICY=missed raises call-back tickets only for unanswered calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-missed-'));
  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_TOKEN, PBX_IT_EXTENSIONS: IT_EXT, PBX_TICKET_POLICY: 'missed',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const answered = await pushSmdr(c, `${smdr('204', '08030000003', { ring: "0'08", duration: "0'01'30", cd: 'AN' })}\n`, PBX_TOKEN);
    const missed = await pushSmdr(c, `${smdr('204', '08030000004', { ring: "0'30", duration: "0'00'00", cd: 'NA' })}\n`, PBX_TOKEN);
    assert.deepEqual(answered.body.ticketIds, []);
    assert.equal(missed.body.ticketIds.length, 1);
    const ticket = (await c.get('/api/tickets', { token: adminSession.token })).body.find((t) => t.id === missed.body.ticketIds[0]);
    assert.match(ticket.title, /missed/i);
    assert.match(ticket.description, /not answered/i);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PBX_TICKET_POLICY=off logs calls without ever touching the ticket queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-off-'));
  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_TOKEN, PBX_IT_EXTENSIONS: IT_EXT, PBX_TICKET_POLICY: 'off',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const pushed = await pushSmdr(c, `${smdr('204', '08030000005', { ring: "0'09", duration: "0'08'00" })}\n`, PBX_TOKEN);
    assert.equal(pushed.body.parsed, 1);
    assert.deepEqual(pushed.body.ticketIds, []);
    const tickets = (await c.get('/api/tickets', { token: adminSession.token })).body;
    assert.equal(tickets.filter((t) => t.source === 'pbx_call').length, 0);
    // An agent can still raise one deliberately.
    const forced = await c.post(`/api/pbx/calls/${pushed.body.callIds[0]}/ticket`, { token: adminSession.token });
    assert.equal(forced.status, 200);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without PBX_IT_EXTENSIONS the log works but no tickets are raised, and the status says why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-noext-'));
  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_TOKEN, PBX_IT_EXTENSIONS: '',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const pushed = await pushSmdr(c, `${smdr('204', '08030000006', { ring: "0'09", duration: "0'08'00" })}\n`, PBX_TOKEN);
    assert.equal(pushed.body.parsed, 1, 'the call is still logged');
    assert.deepEqual(pushed.body.ticketIds, [], 'no ticket can be attributed without knowing the IT extensions');
    const status = (await c.get('/api/pbx/status', { token: adminSession.token })).body;
    assert.ok(status.warnings.some((w) => /PBX_IT_EXTENSIONS/.test(w)), JSON.stringify(status.warnings));
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TCP transports — the two ways a Panasonic PBX is actually wired up
// ---------------------------------------------------------------------------

test('PBX_TRANSPORT=tcp-server: records the PBX (or a serial-to-IP gateway) pushes to us become calls and tickets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-tcpsrv-'));
  const listenPort = await freePort();
  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true',
    PBX_TRANSPORT: 'tcp-server',
    PBX_LISTEN_HOST: '127.0.0.1',
    PBX_LISTEN_PORT: String(listenPort),
    PBX_IT_EXTENSIONS: IT_EXT,
    PBX_TICKET_POLICY: 'all',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);

    // The PBX pushes two records over one connection, split across packets to
    // prove the line framing handles partial reads.
    const socket = net.createConnection({ host: '127.0.0.1', port: listenPort });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const line = smdr('204', '08037770001', { ring: "0'05", duration: "0'00'45" });
    socket.write(`${line.slice(0, 20)}`);
    await new Promise((r) => setTimeout(r, 120));
    socket.write(`${line.slice(20)}\r\n${smdr('310', '08037770002', { ring: "0'04", duration: "0'00'20" })}\r\n`);
    await new Promise((r) => setTimeout(r, 400));
    socket.end();

    const status = (await c.get('/api/pbx/status', { token: adminSession.token })).body;
    assert.equal(status.transport, 'tcp-server');
    assert.equal(status.connection.status, 'connected');
    assert.ok(status.stats.recordsReceived >= 2, `records received: ${status.stats.recordsReceived}`);
    assert.equal(status.stats.linesReceived, undefined, 'line counters live under connection');

    const calls = (await c.get('/api/pbx/calls?days=all', { token: adminSession.token })).body.calls;
    assert.equal(calls.length, 2, `expected two calls, got ${JSON.stringify(calls.map((x) => x.extension))}`);
    const itCall = calls.find((x) => x.extension === '204');
    assert.equal(itCall.caller_number, '08037770001');
    assert.equal(itCall.duration_seconds, 45);
    assert.ok(itCall.ticket_id, 'the IT-office call raised a ticket');
    assert.equal(calls.find((x) => x.extension === '310').ticket_id, null);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PBX_TRANSPORT=tcp-client: we connect to the PBX SMDR port, authenticate and read records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-tcpcli-'));
  const pbxPort = await freePort();

  // A stand-in for the PBX: accepts the connection, prompts, then prints SMDR.
  const received = [];
  let answered = false;
  const fakePbx = net.createServer((socket) => {
    socket.write('SMDR\r\nPassword: ');
    socket.on('data', (chunk) => {
      received.push(chunk.toString('utf8'));
      // The helpdesk sends the SMDR account as soon as it connects (both lines
      // may share one packet), so answer once the password has been seen.
      if (!answered && received.join('').includes('PCCSMDR')) {
        answered = true;
        socket.write(`${smdr('204', '08038880001', { ring: "0'06", duration: "0'01'15" })}\r\n`);
      }
    });
  });
  await new Promise((resolve) => fakePbx.listen(pbxPort, '127.0.0.1', resolve));

  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true',
    PBX_TRANSPORT: 'tcp-client',
    PBX_HOST: '127.0.0.1',
    PBX_PORT: String(pbxPort),
    PBX_USERNAME: 'SMDR',
    PBX_PASSWORD: 'PCCSMDR',
    PBX_IT_EXTENSIONS: IT_EXT,
    PBX_TICKET_POLICY: 'all',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Wait for the record to arrive over the socket.
    let call = null;
    const deadline = Date.now() + 8000;
    while (!call && Date.now() < deadline) {
      const calls = (await c.get('/api/pbx/calls?days=all', { token: adminSession.token })).body.calls;
      call = calls.find((x) => x.extension === '204');
      if (!call) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(call, 'the record pushed by the PBX was logged');
    assert.equal(call.caller_number, '08038880001');
    assert.equal(call.duration_seconds, 75);
    assert.ok(call.ticket_id, 'and it raised a ticket');

    // The SMDR credentials were sent to the PBX.
    assert.ok(received.join('').includes('SMDR'), `credentials sent: ${JSON.stringify(received)}`);
    assert.ok(received.join('').includes('PCCSMDR'), `password sent: ${JSON.stringify(received)}`);

    const status = (await c.get('/api/pbx/status', { token: adminSession.token })).body;
    assert.equal(status.transport, 'tcp-client');
    assert.equal(status.connection.status, 'connected');
    assert.ok(status.stats.linesReceived === undefined || status.stats.linesReceived >= 1);
    assert.ok(status.connection.linesReceived >= 1, 'the listener counted the line');
  } finally {
    await srv.stop();
    await new Promise((resolve) => fakePbx.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken PBX connection never takes the helpdesk down: the API keeps serving and the status shows the error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-down-'));
  const deadPort = await freePort(); // nothing is listening here
  const srv = await startServer(path.join(dir, 'db.json'), await freePort(), {
    PBX_ENABLED: 'true',
    PBX_TRANSPORT: 'tcp-client',
    PBX_HOST: '127.0.0.1',
    PBX_PORT: String(deadPort),
    PBX_IT_EXTENSIONS: IT_EXT,
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const status = (await c.get('/api/pbx/status', { token: adminSession.token })).body;
    assert.ok(['connecting', 'reconnecting', 'error'].includes(status.connection.status), status.connection.status);
    assert.ok(status.connection.lastError || status.connection.status === 'connecting');

    // The rest of the helpdesk is unaffected.
    const tickets = await c.get('/api/tickets', { token: adminSession.token });
    assert.equal(tickets.status, 200);
    const manual = await c.post('/api/pbx/calls/manual', { token: adminSession.token, body: { extension: '204', duration_seconds: 70 } });
    assert.equal(manual.status, 200, 'calls can still be logged by hand while the feed is broken');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Persistence & user lifecycle
// ---------------------------------------------------------------------------

test('calls and the extension directory survive a restart, and deleting an account unlinks its extension', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-pbx-persist-'));
  const dataFile = path.join(dir, 'db.json');
  let srv = await startServer(dataFile, await freePort(), {
    PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_TOKEN, PBX_IT_EXTENSIONS: IT_EXT, PBX_TICKET_POLICY: 'all',
  });
  let callId;
  let employeeId;
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const employee = await makeEmployee(c, 'persist');
    employeeId = employee.id;
    await c.post('/api/pbx/extensions', { token: adminSession.token, body: { extension: '212', user_id: employee.id } });
    const pushed = await pushSmdr(c, `${smdr('212', '204', { ring: "0'05", duration: "0'02'00" })}\n`, PBX_TOKEN);
    callId = pushed.body.callIds[0];
    assert.ok(callId);
  } finally {
    await srv.stop();
  }

  // Restart against the same store.
  srv = await startServer(dataFile, await freePort(), {
    PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_TOKEN, PBX_IT_EXTENSIONS: IT_EXT, PBX_TICKET_POLICY: 'all',
  });
  try {
    const c = api(srv.base);
    const adminSession = await login(c, ADMIN_EMAIL, ADMIN_PASSWORD);
    const calls = (await c.get('/api/pbx/calls?days=all', { token: adminSession.token })).body.calls;
    assert.ok(calls.some((x) => x.id === callId), 'the call log survived the restart');
    const directory = (await c.get('/api/pbx/extensions', { token: adminSession.token })).body;
    assert.ok(directory.some((e) => e.extension === '212' && e.user_id === employeeId));

    // Deleting the account must not leave the extension pointing at a ghost.
    const deleted = await c.delete(`/api/users/${employeeId}`, { token: adminSession.token });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const afterDelete = (await c.get('/api/pbx/extensions', { token: adminSession.token })).body;
    const entry = afterDelete.find((e) => e.extension === '212');
    assert.equal(entry.user_id, null, 'the extension is unlinked');
    assert.equal(entry.linked, false);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
