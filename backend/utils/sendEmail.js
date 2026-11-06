const nodemailer = require('nodemailer');

/**
 * Returns true only when real SMTP settings are present.
 * Placeholder hosts containing "example" are treated as "not configured".
 */
const isSmtpConfigured = () => {
  const host = (process.env.SMTP_HOST || '').trim();
  return Boolean(host) && !host.includes('example');
};

const buildTransporter = () => {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Port 465 uses implicit TLS; 587/25 use STARTTLS (secure: false)
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    requireTLS: process.env.SMTP_REQUIRE_TLS === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
    // Without these, a blocked port 587 (common on office/home networks and
    // some cloud hosts) leaves the request hanging until nodemailer's 2-minute
    // default instead of failing with something a human can act on.
    connectionTimeout: parseInt(process.env.SMTP_CONNECT_TIMEOUT_MS || '15000', 10),
    greetingTimeout: parseInt(process.env.SMTP_GREETING_TIMEOUT_MS || '15000', 10),
    socketTimeout: parseInt(process.env.SMTP_SOCKET_TIMEOUT_MS || '30000', 10),
  });
};

/**
 * `Name <mailbox@domain>` → `mailbox@domain`. Used for envelope / comparisons.
 */
const bareAddress = (value) => {
  const s = String(value || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
};

/**
 * Turns a nodemailer / SMTP failure into a short, human explanation plus an
 * administrator-facing fix. OTP delivery used to fail with one generic
 * sentence, so the actual Exchange/Google answer ("SendAsDenied…") stayed
 * hidden in the terminal — see BUG-REPORT "Email delivery diagnostics".
 *
 * Returns { code, detail, hint }.
 *  - detail: what the mail server actually said (safe to show to the user —
 *    it is their own server's wording, no credentials).
 *  - hint:   what to change in backend/.env / the tenant to fix it.
 */
const explainSmtpError = (err) => {
  const code = (err && (err.code || err.command)) || '';
  const responseCode = err && err.responseCode;
  const raw = String((err && (err.response || err.message)) || 'Unknown email error');
  const message = raw.replace(/\s+/g, ' ').trim();
  const lower = message.toLowerCase();
  const has = (needle) => lower.includes(needle);

  // The most common one for this app: MAIL_FROM is a different mailbox than
  // SMTP_USER and the account has no "Send As" right on it.
  if (has('sendasdenied') || has('not allowed to send as') || has('sender not allowed') || has('does not match')) {
    return {
      code: 'SEND_AS_DENIED',
      detail: 'The mail server refused the From address.',
      hint:
        'MAIL_FROM in backend/.env must be the mailbox that signed in (SMTP_USER), ' +
        'or a mailbox that SMTP_USER has "Send As" rights on in the Microsoft 365 admin center. ' +
        'The quickest fix is to set MAIL_FROM="SayedFarms Help Desk <SMTP_USER address>".',
    };
  }

  if (has('smtp auth') || has('5.7.57') || has('client submission') || has('5.7.30')) {
    return {
      code: 'SMTP_AUTH_DISABLED',
      detail:
        'The mail server does not accept username/password sign-in for this mailbox (basic SMTP AUTH).',
      hint:
        'Enable "Authenticated SMTP" on the sending mailbox (Microsoft 365 admin center → Users → ' +
        'the mailbox → Mail → Manage email apps → tick Authenticated SMTP). If the tenant has blocked ' +
        'SMTP AUTH entirely, an admin must enable it for that mailbox, or use an OAuth/relay alternative.',
    };
  }

  if (code === 'EAUTH' || has('535') || has('authentication unsuccessful') || has('invalid login') || has('username and password not accepted')) {
    return {
      code: 'SMTP_AUTH_FAILED',
      detail: 'The mail server rejected the mailbox username or password.',
      hint:
        'Check SMTP_USER / SMTP_PASS in backend/.env. For Microsoft 365 the account must not have MFA ' +
        'blocking sign-in and, if the tenant enforces it, SMTP AUTH must be enabled for the mailbox; ' +
        'for Gmail enable 2-step verification and use an App Password, not the normal login password.',
    };
  }

  if (has('5.7.1') || has('relay denied') || has('relaying denied') || has('not permitted to relay') || has('554')) {
    return {
      code: 'SMTP_RELAY_DENIED',
      detail: 'The mail server refused to relay the message.',
      hint:
        'This happens when SMTP_USER does not authenticate (empty user/password) or when MAIL_FROM is not ' +
        'a mailbox on that server. Set SMTP_USER/SMTP_PASS to a real mailbox on the SMTP_HOST domain.',
    };
  }

  if (has('5.7.708') || has('blocked by') || has('5.7.139') || has('outbound spam')) {
    return {
      code: 'SMTP_BLOCKED',
      detail: 'The mail server blocked this sender/connection by policy.',
      hint:
        'The tenant or its anti-spam policy is blocking outbound SMTP from this sender. A Microsoft 365 ' +
        'admin must allow the mailbox (and/or SMTP AUTH) in the Exchange admin center → Mail flow → ' +
        'Anti-spam outbound policies, or the connection must come from an allowed network.',
    };
  }

  if (has('5.7.60') || has('sender address rejected') || has('envelope')) {
    return {
      code: 'SMTP_SENDER_REJECTED',
      detail: 'The mail server rejected the sender address.',
      hint: 'Set MAIL_FROM to exactly the SMTP_USER mailbox address, then restart the backend.',
    };
  }

  if (code === 'EDNS' || has('enotfound') || has('getaddrinfo')) {
    return {
      code: 'SMTP_HOST_NOT_FOUND',
      detail: 'The SMTP host name could not be resolved.',
      hint: 'Check SMTP_HOST in backend/.env (smtp.office365.com for Microsoft 365, smtp.gmail.com for Gmail).',
    };
  }

  if (has('certificate') || has('wrong version number') || has('ssl')) {
    return {
      code: 'SMTP_TLS',
      detail: 'TLS negotiation with the mail server failed.',
      hint: 'Use port 587 with SMTP_SECURE=false, or port 465 with SMTP_SECURE=true. Do not mix the two.',
    };
  }

  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || has('timeout') || has('timed out') || code === 'ECONNREFUSED') {
    return {
      code: 'SMTP_UNREACHABLE',
      detail: 'Could not reach the mail server on the configured port.',
      hint:
        'Check SMTP_PORT / SMTP_SECURE in backend/.env — 587 with SMTP_SECURE=false (STARTTLS) for Microsoft 365 ' +
        'and Gmail, 465 with SMTP_SECURE=true only for implicit TLS. A firewall, VPN or hosting provider may ' +
        'also be blocking outbound port 587/25; try a mobile hotspot to confirm.',
    };
  }

  return {
    code: 'SMTP_UNKNOWN',
    detail: message.slice(0, 400),
    hint:
      'Run `npm run test-email -- you@sayedfarms.com` in backend/ to see the full SMTP conversation and the ' +
      'suggested fix.',
  };
};

/**
 * Opens the connection and authenticates without sending anything.
 * The cheapest way to tell "wrong password / SMTP AUTH off / port blocked"
 * apart from "the message was rejected".
 */
const verifySmtp = async () => {
  if (!isSmtpConfigured()) throw new Error('SMTP_NOT_CONFIGURED');
  const transporter = buildTransporter();
  await transporter.verify();
  return true;
};

const mailFromAddress = () => (process.env.MAIL_FROM || process.env.SMTP_USER || '').trim();

/**
 * Config problems detectable without talking to the server, so the server can
 * warn at boot instead of the first user discovering it via a reset email.
 * Returns an array of human-readable warnings (empty when nothing is wrong).
 */
const smtpConfigWarnings = () => {
  const warnings = [];
  if (!isSmtpConfigured()) return warnings;

  const user = bareAddress(process.env.SMTP_USER);
  const from = bareAddress(mailFromAddress());
  if (!process.env.SMTP_USER) {
    warnings.push('SMTP_HOST is set but SMTP_USER is empty — the connection will be unauthenticated and almost certainly rejected.');
  }
  if (!process.env.SMTP_PASS) {
    warnings.push('SMTP_USER is set but SMTP_PASS is empty.');
  }
  if (from && user && from !== user) {
    warnings.push(
      `MAIL_FROM (${from}) is a different mailbox than SMTP_USER (${user}). This only works if the account has ` +
      '"Send As" permission on it in Microsoft 365 — otherwise every send fails with "SendAsDenied" (550 5.2.252).'
    );
  }
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  if (port === 465 && process.env.SMTP_SECURE !== 'true') {
    warnings.push('SMTP_PORT=465 implies implicit TLS; set SMTP_SECURE=true explicitly to avoid confusion.');
  }
  if (port === 587 && secure && process.env.SMTP_SECURE === 'true') {
    warnings.push('SMTP_PORT=587 with SMTP_SECURE=true will fail — port 587 uses STARTTLS, so set SMTP_SECURE=false.');
  }
  if (!['25', '465', '587', '2525'].includes(String(port))) {
    warnings.push(`SMTP_PORT=${port} is unusual; Microsoft 365 expects 587 and Gmail expects 587 (or 465 with SMTP_SECURE=true).`);
  }
  return warnings;
};

/**
 * Sends the password-reset OTP email.
 * Resolves with { sent: true, messageId } on success.
 * Throws on failure — caller must handle and tell the user the truth.
 */
const sendOtpEmail = async (email, otp, kind = 'reset') => {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP_NOT_CONFIGURED');
  }

  const from = mailFromAddress();
  const subject =
    kind === 'resend'
      ? 'New Password Reset Verification Code'
      : 'Password Reset Verification Code';
  const intro = kind === 'resend' ? 'Your new verification code' : 'Your verification code';

  const transporter = buildTransporter();
  const info = await transporter.sendMail({
    from,
    to: email,
    subject,
    text: `${intro} is: ${otp}. It expires in 10 minutes. If you did not request a password reset, you can ignore this email.`,
    html: `<p>${intro} is: <strong style="font-size:18px;letter-spacing:2px;">${otp}</strong></p><p>It expires in 10 minutes.</p><p style="color:#94a3b8;font-size:12px;">If you did not request a password reset, you can ignore this email.</p>`,
  });

  // A 250 response means only that the message was accepted for delivery —
  // Exchange can still bounce it afterwards. Log the recipient + queue id so
  // "I never got the code" can be traced.
  console.log(`[SMTP SUCCESS] OTP emailed to ${email} (messageId: ${info.messageId || 'n/a'})`);
  return { sent: true, messageId: info.messageId };
};

/** Delivers an arbitrary test message — used by scripts/test-email.js. */
const sendTestEmail = async (to) => {
  if (!isSmtpConfigured()) throw new Error('SMTP_NOT_CONFIGURED');
  const transporter = buildTransporter();
  return transporter.sendMail({
    from: mailFromAddress(),
    to,
    subject: 'SayedFarms Help Desk — SMTP test',
    text: 'This is a test message from the SayedFarms Help Desk backend. If you received it, verification-code emails will be delivered too.',
    html: '<p>This is a test message from the <b>SayedFarms Help Desk</b> backend.</p><p>If you received it, verification-code emails will be delivered too.</p>',
  });
};

module.exports = {
  sendOtpEmail,
  sendTestEmail,
  isSmtpConfigured,
  verifySmtp,
  explainSmtpError,
  smtpConfigWarnings,
  mailFromAddress,
};
