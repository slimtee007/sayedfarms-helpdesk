#!/usr/bin/env node
/**
 * Super-admin recovery / account inspection CLI.
 *
 * Passwords are stored as bcrypt hashes — they cannot be read back out of
 * db.json, by design. This tool is how you get back in: it shows which account
 * holds super-admin access, and can set a new password and/or grant that access
 * directly in the data file.
 *
 *   node scripts/admin.js --list
 *       Show every account, its role and whether it is a super admin.
 *       (Never prints password hashes.)
 *
 *   node scripts/admin.js <email> --password <new-password>
 *       Set a new password for <email>, promoting it to IT agent + super admin.
 *
 *   node scripts/admin.js <email> --password <new-password> --agent
 *       Same, but only make it an IT agent (no super-admin rights).
 *
 *   node scripts/admin.js <email>            (no --password)
 *       Generates a strong random password and prints it once.
 *
 * IMPORTANT: stop the server before running this. The server keeps the whole
 * database in memory and rewrites db.json on every write, so a change made
 * while it is running can be silently overwritten. Start the server again
 * afterwards — accounts are loaded at boot.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'db.json');
const BCRYPT_ROUNDS = 10;

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const die = (msg) => {
  console.error(`\n${c.red('✗')} ${msg}\n`);
  process.exit(1);
};

const usage = () => {
  console.log(`
${c.bold('SayedFarms Helpdesk — account recovery')}

  ${c.bold('node scripts/admin.js --list')}
      List accounts, roles and who is a super admin.

  ${c.bold('node scripts/admin.js <email> --password <pw>')}
      Reset that account's password and grant IT agent + super admin.

  ${c.bold('node scripts/admin.js <email> --agent --password <pw>')}
      Reset the password but grant plain IT agent access only.

  ${c.bold('node scripts/admin.js <email>')}
      Generate a strong password for that account and print it once.

  ${c.bold('node scripts/admin.js <email> --demote')}
      Make that account a plain IT agent: it keeps its password but loses
      super-admin rights, so it only ever sees tickets assigned to it.
      Use this to leave exactly one dispatcher (e.g. admin@sayedfarms.com).

Options:
  --password <pw>   The new password (8+ characters).
  --agent           Grant IT agent without super-admin rights.
  --demote          Keep the password, drop super-admin rights (own queue only).
  --name "<name>"   Set the display name (default: keep, or derive from email).
  --file <path>     Use a different db.json (default: ${DATA_FILE}).
  --force           Proceed even if a server looks like it is running.
`);
};

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(0);
}

const takeFlag = (name, hasValue) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  if (!hasValue) {
    argv.splice(i, 1);
    return true;
  }
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) die(`${name} needs a value.`);
  argv.splice(i, 2);
  return value;
};

const fileOverride = takeFlag('--file', true);
const passwordFlag = takeFlag('--password', true);
const nameFlag = takeFlag('--name', true);
const agentOnly = Boolean(takeFlag('--agent', false));
const demote = Boolean(takeFlag('--demote', false));
const force = Boolean(takeFlag('--force', false));
const listOnly = Boolean(takeFlag('--list', false)) || argv.length === 0;
const emailArg = argv[0];

const dataFile = fileOverride ? path.resolve(fileOverride) : DATA_FILE;

// ---------------------------------------------------------------- load data
if (!fs.existsSync(dataFile)) {
  die(`No database at ${dataFile}
   Start the server once (cd backend && npm start) to create it with seed data,
   or point at your own copy with --file <path>.`);
}

let db;
try {
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
} catch (err) {
  die(`Could not parse ${dataFile}: ${err.message}`);
}
if (!Array.isArray(db.users)) die(`${dataFile} has no "users" array — is this the right file?`);

const save = () => {
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, dataFile); // atomic: a crash can't leave a half-written db
};

const isHash = (v) => typeof v === 'string' && /^\$2[aby]\$\d{2}\$/.test(v);
const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * Warn if the live server is probably running: it holds the database in memory
 * and will overwrite whatever we write here.
 */
const warnIfServerRunning = () => {
  if (force) return;
  const lockish = [
    path.join(__dirname, '..', '.server.pid'),
  ].filter((p) => fs.existsSync(p));
  if (lockish.length === 0) return;
  console.warn(`${c.yellow('!')} A server process looks active. Stop it first, or pass --force.`);
};

// ---------------------------------------------------------------- --list
if (listOnly) {
  const users = db.users;
  console.log(`\n${c.bold(`Accounts in ${dataFile}`)}  ${c.dim(`(${users.length} total)`)}\n`);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  console.log(`  ${c.dim(pad('EMAIL', 40) + pad('NAME', 22) + pad('ROLE', 8) + 'ACCESS')}`);
  users
    .slice()
    .sort((a, b) => Number(b.super_admin === true) - Number(a.super_admin === true) || String(a.email).localeCompare(String(b.email)))
    .forEach((u) => {
      const access = u.role !== 'agent'
        ? c.dim('own tickets')
        : u.super_admin === true
          ? c.green('SUPER ADMIN (all tickets)')
          : 'agent (own queue)';
      console.log(`  ${pad(u.email, 40)}${pad(u.name || '—', 22)}${pad(u.role, 8)}${access}`);
    });

  const supers = users.filter((u) => u.role === 'agent' && u.super_admin === true);
  const plaintext = users.filter((u) => u.password && !isHash(u.password));
  console.log();
  if (supers.length === 0) {
    console.log(`${c.yellow('!')} No super admin is set. Boot the server (it promotes one automatically),`);
    console.log(`  or grant it here: ${c.bold(`node scripts/admin.js <email> --password <pw>`)}`);
  } else {
    console.log(`${supers.length} super admin account(s):`);
    supers.forEach((u) => console.log(`  • ${c.bold(u.email)}`));
  }
  if (plaintext.length) {
    console.log(`\n${c.yellow('!')} ${plaintext.length} account(s) still store a PLAINTEXT password — the server`);
    console.log('  hashes these on its next boot.');
  }
  console.log(`\n${c.dim('Passwords are bcrypt hashes and cannot be displayed. To get back into an')}`);
  console.log(`${c.dim('account, reset it:')} node scripts/admin.js <email> --password <new-password>\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- reset
if (!emailArg || emailArg.startsWith('--')) {
  usage();
  process.exit(1);
}

const email = norm(emailArg);
let user = db.users.find((u) => norm(u.email) === email);

// --demote: keep the password, drop the wide view (#36). This is how you make
// sure only one account can see and reassign every ticket.
if (demote) {
  if (!user) die(`No account found for ${email}.`);
  if (!(user.role === 'agent' && user.super_admin === true)) {
    console.log(`\n${c.dim('Nothing to do:')} ${c.bold(email)} is not a super admin.`);
    console.log(`   role = ${user.role}, super_admin = ${user.super_admin === true}\n`);
    process.exit(0);
  }
  const others = db.users.filter((u) => u.role === 'agent' && u.super_admin === true && u.id !== user.id);
  if (others.length === 0) {
    die(`Refusing to demote ${email}: it is the only super admin, and a helpdesk with\n   nobody able to reassign tickets cannot be recovered from the UI.\n   Promote another agent first:  node scripts/admin.js <other-email> --password <pw>`);
  }
  warnIfServerRunning();
  user.super_admin = false;
  save();
  console.log(`${c.green('✓')} ${c.bold(email)} is now a regular IT agent.`);
  console.log(`   ticket access: own queue only (it no longer sees or reassigns other tickets)`);
  console.log(`   password     : unchanged`);
  console.log(`\n   Super admins remaining: ${others.map((u) => u.email).join(', ')}\n`);
  process.exit(0);
}

const generated = !passwordFlag;
const password = passwordFlag || crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12) + '!A9';

if (password.length < 8) die('Password must be at least 8 characters long.');
if (generated && passwordFlag === undefined && argv.includes('--password')) die('`--password` needs a value.');

warnIfServerRunning();

const wasNew = !user;
const previousRole = user ? user.role : null;
const previousSuper = user ? user.super_admin === true : false;

if (!user) {
  user = {
    id: password ? `admin-${Date.now()}-recovered` : `admin-${Date.now()}`,
    name: nameFlag || emailArg.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    email,
    role: 'agent',
    super_admin: !agentOnly,
    password: '',
  };
  db.users.push(user);
  console.log(`\n${c.green('+')} Created a new account for ${c.bold(email)}`);
}

if (nameFlag) user.name = nameFlag;
user.password = bcrypt.hashSync(password, BCRYPT_ROUNDS);
user.role = 'agent';
user.super_admin = !agentOnly;
if (!user.name) user.name = emailArg.split('@')[0];

// Guard the invariant the server enforces on every boot: never zero super admins.
const supers = db.users.filter((u) => u.role === 'agent' && u.super_admin === true);
if (supers.length === 0) {
  die('Refusing to write: that would leave no super admin at all.');
}

save();

console.log(`${c.green('✓')} Updated ${c.bold(email)}`);
console.log(`   role        : ${user.role}${previousRole && previousRole !== user.role ? c.dim(` (was ${previousRole})`) : ''}`);
console.log(`   ticket access: ${user.super_admin ? c.green('super admin — every ticket, can reassign') : 'agent — only their own queue'}${previousSuper !== user.super_admin && !wasNew ? c.dim(` (was ${previousSuper ? 'super admin' : 'agent'})`) : ''}`);
console.log(`   password    : ${generated ? c.yellow(password) : c.dim('(the one you passed)')}`);
if (generated) console.log(`                 ${c.yellow('shown once — copy it now')}`);
console.log(`\n${c.bold('Next steps')}`);
console.log(`   1. Start the server:  ${c.dim('cd backend && npm start')}`);
console.log(`   2. Sign in as ${c.bold(email)}`);
console.log(`   3. Change the password from the app once you are in.`);
if (dataFile !== DATA_FILE) console.log(`\n${c.dim(`(wrote to ${dataFile})`)}`);
console.log();
