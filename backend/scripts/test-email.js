#!/usr/bin/env node
/**
 * SMTP self-test for the Help Desk's password-reset emails.
 *
 *   cd backend
 *   npm run test-email                      # connect + sign in, send nothing
 *   npm run test-email -- you@sayedfarms.com  # ...and send a real test email
 *
 * Prints, step by step, whether the server can reach the mail host, get through
 * TLS, sign in as SMTP_USER and (optionally) deliver a message — and when a step
 * fails, what to change in backend/.env. Nothing here touches the app database.
 *
 * Exit codes: 0 = healthy, 1 = failed, 2 = SMTP not configured.
 */
require('dotenv').config();

const {
  isSmtpConfigured,
  verifySmtp,
  explainSmtpError,
  smtpConfigWarnings,
  mailFromAddress,
  sendTestEmail,
} = require('../utils/sendEmail');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const ok = (s) => console.log(`${c.green('✓')} ${s}`);
const bad = (s) => console.log(`${c.red('✗')} ${s}`);
const info = (s) => console.log(`  ${c.dim(s)}`);

const maskSecret = (value) => {
  const s = String(value || '');
  if (!s) return c.red('(empty)');
  if (s.length <= 2) return '*'.repeat(s.length);
  return `${s[0]}${'*'.repeat(Math.max(3, s.length - 2))}${s[s.length - 1]} ${c.dim(`(${s.length} chars)`)}`;
};

/** Explain a raw nodemailer error, including the full SMTP conversation if any. */
const reportFailure = (err, step) => {
  const explained = explainSmtpError(err);
  bad(`${step} failed ${c.dim(`[${explained.code}]`)}`);
  console.log(`\n${c.bold('What the mail server said:')}`);
  console.log(`  ${String((err && err.message) || err).split('\n').join('\n  ')}`);
  if (err && err.response) info(`SMTP response: ${err.response}`);
  if (err && err.responseCode) info(`SMTP status: ${err.responseCode}`);
  console.log(`\n${c.bold('What that means:')}`);
  console.log(`  ${explained.detail}`);
  if (explained.hint) {
    console.log(`\n${c.bold('How to fix it:')}`);
    console.log(`  ${explained.hint}`);
  }
};

const main = async () => {
  const to = process.argv.slice(2).find((a) => !a.startsWith('-')) || null;

  console.log(`\n${c.bold('SayedFarms Help Desk — SMTP self-test')}\n`);

  const host = (process.env.SMTP_HOST || '').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  console.log(c.bold('1. Configuration read from backend/.env'));
  info(`SMTP_HOST   ${host || c.red('(empty)')}`);
  info(`SMTP_PORT   ${port}`);
  info(`SMTP_SECURE ${secure ? 'true (implicit TLS)' : 'false (STARTTLS)'}`);
  info(`SMTP_USER   ${process.env.SMTP_USER || c.red('(empty)')}`);
  info(`SMTP_PASS   ${maskSecret(process.env.SMTP_PASS)}`);
  info(`MAIL_FROM   ${mailFromAddress() || c.red('(empty)')}`);

  if (!isSmtpConfigured()) {
    console.log('');
    bad('SMTP is not configured — this run cannot test anything.');
    console.log(`\n  Copy the template and fill it in:\n    ${c.cyan('cp .env.example .env')}\n`);
    console.log(`  Then set ${c.bold('SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS')} and restart.\n`);
    process.exit(2);
  }

  const warnings = smtpConfigWarnings();
  if (warnings.length) {
    console.log('');
    warnings.forEach((w) => console.log(`${c.yellow('!')} ${w}`));
  }

  console.log(`\n${c.bold('2. Connect and sign in (nothing is sent yet)')}`);
  try {
    await verifySmtp();
    ok(
      secure
        ? 'Reached the server over TLS and authenticated successfully.'
        : 'Reached the server and authenticated successfully (STARTTLS is used when the server offers it; set SMTP_REQUIRE_TLS=true to insist on it).'
    );
  } catch (err) {
    reportFailure(err, 'Connect / sign-in');
    console.log(`\n${c.yellow('Note:')} a rejected password, SMTP AUTH being switched off for the mailbox, and a\n` +
      `firewall blocking port ${port} all fail here — the message above tells you which.\n`);
    process.exit(1);
  }

  if (!to) {
    console.log(`\n${c.bold('3. Send a test message')}`);
    info('Skipped — pass an address to send one:');
    info(`${c.cyan('npm run test-email -- you@sayedfarms.com')}`);
    console.log(`\n${c.green('SMTP looks healthy.')} Verification-code emails should now be delivered.\n`);
    process.exit(0);
  }

  console.log(`\n${c.bold('3. Send a test message')}`);
  try {
    const sent = await sendTestEmail(to);
    ok(`Accepted for delivery to ${to}${sent.messageId ? c.dim(` (id ${sent.messageId})`) : ''}`);
    console.log(`\n  A 250 "accepted" answer only means the mail host took it. If it does not\n` +
      `  arrive, check the mailbox's Junk folder and the tenant's quarantine / message\n` +
      `  trace — a rejection there arrives later as a bounce, not as an SMTP error.\n`);
  } catch (err) {
    reportFailure(err, 'Send');
    console.log(`\n${c.yellow('Note:')} if sign-in succeeded but the send was refused, the usual cause is\n` +
      'MAIL_FROM naming a mailbox SMTP_USER is not allowed to send as (SendAsDenied).\n');
    process.exit(1);
  }
};

main().catch((err) => {
  // Never let a stack trace be the only output — always give the fix.
  console.error(`\n${c.red('Unexpected error:')} ${(err && err.stack) || err}\n`);
  process.exit(1);
});
