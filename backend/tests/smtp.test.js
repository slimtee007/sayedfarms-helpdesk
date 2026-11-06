/**
 * SMTP diagnostics tests.
 *
 * Reproduces the failure mode from the "I configured the mail in .env but the
 * app still says Failed to send the verification email" report: the server was
 * configured, the mail host refused the message (550 5.2.252 SendAsDenied) and
 * every cause collapsed into one opaque sentence, so the .env mistake was
 * invisible.
 *
 * A tiny in-process SMTP server stands in for Exchange/Office 365, so the whole
 * nodemailer path — connect, STARTTLS-less greeting, EHLO, AUTH, MAIL FROM,
 * RCPT TO, DATA — is exercised for real, with no network access.
 *
 * Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const ADMIN_EMAIL = 'admin@sayedfarms.test';
const ADMIN_PASSWORD = 'AdminPass!2345';
const { explainSmtpError, smtpConfigWarnings } = require('../utils/sendEmail');

/**
 * A throwaway SMTP server. `behaviour` decides how far a client gets:
 *   auth-fail     reject the AUTH exchange with 535
 *   sendas-denied accept AUTH, refuse MAIL FROM with 550 5.2.252
 *   smtp-disabled accept AUTH, refuse it with 5.7.57
 *   ok            accept everything (message accepted for delivery)
 */
const startFakeSmtp = (behaviour, credentials = { user: 'it-helpdesk@sayedfarms.com', pass: 'secret' }) =>
  new Promise((resolve, reject) => {
    const received = [];
    const srv = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let data = '';
      let stage = 'greeting';
      const say = (line) => socket.write(`${line}\r\n`);

      socket.write('220 fake.office365.test ESMTP ready\r\n');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end === -1) return;
            data += buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            received.push({ stage, data });
            say('250 2.0.0 Ok: queued as FAKE123');
            continue;
          }

          const idx = buffer.indexOf('\r\n');
          if (idx === -1) return;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            say('250-fake.office365.test');
            say('250-AUTH LOGIN PLAIN');
            say('250 OK');
          } else if (upper.startsWith('AUTH LOGIN')) {
            if (behaviour === 'smtp-disabled') {
              say('550 5.7.57 Client not authenticated to send mail. SMTP AUTH is disabled for this mailbox.');
            } else {
              stage = 'auth-user';
              say('334 VXNlcm5hbWU6');
            }
          } else if (upper.startsWith('AUTH PLAIN')) {
            if (behaviour === 'smtp-disabled') {
              say('550 5.7.57 Client not authenticated to send mail. SMTP AUTH is disabled for this mailbox.');
            } else if (behaviour === 'auth-fail') {
              say('535 5.7.8 Authentication unsuccessful');
            } else {
              stage = 'authed';
              say('235 2.7.0 Authentication successful');
            }
          } else if (stage === 'auth-user') {
            stage = 'auth-pass';
            say('334 UGFzc3dvcmQ6');
          } else if (stage === 'auth-pass') {
            if (behaviour === 'auth-fail') {
              say('535 5.7.8 Authentication unsuccessful');
            } else {
              stage = 'authed';
              say('235 2.7.0 Authentication successful');
            }
          } else if (upper.startsWith('MAIL FROM')) {
            if (behaviour === 'sendas-denied' && !upper.includes(credentials.user.toUpperCase())) {
              say(
                '550 5.2.252 SendAsDenied; not allowed to send as ' +
                  "it-helpdesk@sayedfarms.com; STOREDRV.Submission.Exception:SendAsDeniedException.MapiExceptionSendAsDenied"
              );
            } else {
              stage = 'mail-from';
              say('250 2.1.0 Sender OK');
            }
          } else if (upper.startsWith('RCPT TO')) {
            say('250 2.1.5 Recipient OK');
          } else if (upper.startsWith('DATA')) {
            inData = true;
            data = '';
            say('354 Start mail input; end with <CRLF>.<CRLF>');
          } else if (upper.startsWith('QUIT')) {
            say('221 2.0.0 Bye');
            socket.end();
          } else {
            say('250 2.0.0 OK');
          }
        }
      });
      socket.on('error', () => {});
    });

    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        received,
        stop: () => new Promise((res) => srv.close(() => res())),
      });
    });
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
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
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${logs.join('')}`);
    try {
      const res = await fetch(`${base}/api/meta/enums`);
      if (res.status === 401 || res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    logs,
    stop: () => new Promise((resolve) => {
      proc.once('exit', resolve);
      proc.kill('SIGKILL');
    }),
  };
};

const api = (base) => ({
  get: (url, token) =>
    fetch(`${base}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
  post: (url, body, token) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
});

let tmpDir;
let dbFile;

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayedfarms-smtp-'));
  dbFile = path.join(tmpDir, 'db.json');
});

test.after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure mapping: the error classifier the app relies on.
// ---------------------------------------------------------------------------
test('a real SendAsDenied response is classified as a MAIL_FROM problem', () => {
  const explained = explainSmtpError(
    {
      responseCode: 550,
      code: 'EENVELOPE',
      response:
        '550 5.2.252 SendAsDenied; not allowed to send as it-helpdesk@sayedfarms.com; ' +
        'STOREDRV.Submission.Exception:SendAsDeniedException.MapiExceptionSendAsDenied',
    }
  );
  assert.equal(explained.code, 'SEND_AS_DENIED');
  assert.match(explained.hint, /MAIL_FROM/, 'the hint must name the setting to change');
  assert.match(explained.hint, /Send As/i, 'the hint must name the permission that is missing');
});

test('auth failures, disabled SMTP AUTH, relay denial and blocked ports are told apart', () => {
  assert.equal(explainSmtpError({ code: 'EAUTH', response: '535 5.7.8 Authentication unsuccessful' }).code, 'SMTP_AUTH_FAILED');
  assert.equal(
    explainSmtpError({ responseCode: 550, response: '550 5.7.57 Client not authenticated to send mail' }).code,
    'SMTP_AUTH_DISABLED'
  );
  assert.match(
    explainSmtpError({ responseCode: 550, response: '550 5.7.57 Client not authenticated to send mail' }).hint,
    /Authenticated SMTP/i
  );
  assert.equal(
    explainSmtpError({ response: '554 5.7.1 <it-helpdesk@sayedfarms.com>: Relay access denied' }).code,
    'SMTP_RELAY_DENIED'
  );
  assert.equal(explainSmtpError({ code: 'ETIMEDOUT', message: 'Connection timeout' }).code, 'SMTP_UNREACHABLE');
  assert.equal(explainSmtpError({ code: 'EDNS', message: 'getaddrinfo ENOTFOUND smtp.example.invalid' }).code, 'SMTP_HOST_NOT_FOUND');
  assert.equal(explainSmtpError({ code: 'ESOCKET', message: 'wrong version number' }).code, 'SMTP_TLS');
});

test('boot-time warnings catch MAIL_FROM != SMTP_USER and port/TLS mismatches', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      SMTP_HOST: 'smtp.office365.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'true',
      SMTP_USER: 'it-helpdesk@sayedfarms.com',
      SMTP_PASS: 'x',
      MAIL_FROM: 'SayedFarms Help Desk <someone-else@sayedfarms.com>',
    });
    const warnings = smtpConfigWarnings().join('\n');
    assert.match(warnings, /MAIL_FROM .*different mailbox than SMTP_USER/);
    assert.match(warnings, /587 with SMTP_SECURE=true/);

    process.env.MAIL_FROM = 'SayedFarms Help Desk <it-helpdesk@sayedfarms.com>';
    process.env.SMTP_SECURE = 'false';
    assert.equal(smtpConfigWarnings().length, 0, 'a correct configuration must not warn');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// ---------------------------------------------------------------------------
// End to end: the reset endpoint against a mail server that refuses it.
// ---------------------------------------------------------------------------
test('a refused send returns the reason and the fix instead of one generic sentence', async () => {
  const smtp = await startFakeSmtp('sendas-denied');
  const s = await startServer(dbFile, await freePort(), {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'false',
    SMTP_USER: 'it-helpdesk@sayedfarms.com',
    SMTP_PASS: 'secret',
    // The mistake from the report: From-address is not the signed-in mailbox.
    MAIL_FROM: 'SayedFarms Help Desk <noreply@sayedfarms.com>',
  });
  try {
    const c = api(s.base);
    const email = `smtp-${Date.now()}@example.com`;
    await c.post('/api/auth/signup', { name: 'SMTP Person', email, password: 'OriginalPass!23' });

    const asked = await c.post('/api/auth/forgot-password', { email });
    assert.equal(asked.status, 502, `expected a delivery failure, got ${JSON.stringify(asked.body)}`);
    assert.equal(asked.body.emailSent, false);
    assert.equal(asked.body.reason, 'SEND_AS_DENIED');
    assert.match(asked.body.hint, /MAIL_FROM/, 'the UI must be able to show the actual fix');
    assert.doesNotMatch(asked.body.error, /secret/, 'credentials must never be echoed back');

    // The dev fallback code is still printed + returned in development so the
    // person is not locked out of their own account.
    assert.match(s.logs.join(''), /DEV FALLBACK OTP CODE/);
  } finally {
    await s.stop();
    await smtp.stop();
  }
});

test('a working SMTP setup reports success and really delivers the code', async () => {
  const smtp = await startFakeSmtp('ok');
  const s = await startServer(dbFile, await freePort(), {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'false',
    SMTP_USER: 'it-helpdesk@sayedfarms.com',
    SMTP_PASS: 'secret',
    MAIL_FROM: 'SayedFarms Help Desk <it-helpdesk@sayedfarms.com>',
  });
  try {
    const c = api(s.base);
    const email = `smtp-ok-${Date.now()}@example.com`;
    await c.post('/api/auth/signup', { name: 'Delivered Person', email, password: 'OriginalPass!23' });

    const asked = await c.post('/api/auth/forgot-password', { email });
    assert.equal(asked.status, 200, `a delivered code must succeed: ${JSON.stringify(asked.body)}`);
    assert.equal(asked.body.emailSent, true);
    assert.equal(asked.body.devOtp, undefined, 'the code must not be returned once it was emailed');

    const message = smtp.received.find((m) => m.stage === 'mail-from' || m.data);
    assert.ok(message, 'the fake mail server must have received the message');
    assert.match(message.data, /Subject: Password Reset Verification Code/i);
    assert.match(message.data, /\d{6}/, 'the email body must carry the 6-digit code');
    assert.match(message.data, /To: smtp-ok-.*@example\.com/i);
  } finally {
    await s.stop();
    await smtp.stop();
  }
});

test('GET /api/admin/email-status proves the SMTP connection without emailing anyone', async () => {
  const smtp = await startFakeSmtp('auth-fail');
  const s = await startServer(dbFile, await freePort(), {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'false',
    SMTP_USER: 'it-helpdesk@sayedfarms.com',
    SMTP_PASS: 'wrong-password',
    MAIL_FROM: 'SayedFarms Help Desk <it-helpdesk@sayedfarms.com>',
  });
  try {
    const c = api(s.base);
    const anon = await c.get('/api/admin/email-status');
    assert.equal(anon.status, 401, 'the mail configuration is not public');

    const admin = (await c.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body;
    const status = await c.get('/api/admin/email-status', admin.token);
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, true);
    assert.equal(status.body.reachable, false, 'a rejected password must be reported, not thrown');
    assert.equal(status.body.reason, 'SMTP_AUTH_FAILED');
    assert.match(status.body.hint, /SMTP_PASS/);
    assert.equal(status.body.port, smtp.port);
    assert.equal(smtp.received.length, 0, 'the status check must not send mail');
  } finally {
    await s.stop();
    await smtp.stop();
  }
});
