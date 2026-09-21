require('dotenv').config(); // <-- MUST BE AT THE VERY TOP
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// Call logging for the Panasonic PBX: SMDR parsing, the extension directory,
// call-to-ticket creation and the call report all live in ./pbx.
const pbx = require('./pbx');

const app = express();

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production';

// JWT signing secret. Refuse to boot in production without one; in dev fall
// back to a random per-boot secret (sessions die on restart) rather than a
// hard-coded value that could ever ship.
let JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (!JWT_SECRET) {
  if (isProduction) {
    console.error('[FATAL] JWT_SECRET is not set. Refusing to start in production without a signing secret.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[WARN] JWT_SECRET is not set — using a random secret generated for this boot.');
  console.warn('       All sessions will be invalidated when the server restarts. Set JWT_SECRET in backend/.env.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// CORS allow-list (comma-separated). Auth uses Bearer tokens rather than
// cookies, so there are no ambient credentials for a foreign origin to ride
// on — but production should still lock this to the real frontend origin(s).
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
if (CORS_ORIGIN === '*' && isProduction) {
  console.warn('[WARN] CORS_ORIGIN allows every origin in production. Set CORS_ORIGIN in backend/.env.');
}
const corsOrigin = CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

// Overridable so tests (and multi-instance deployments) can point the server
// at a scratch file without touching the real store.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'db.json');

// Default initial data if db.json does not exist. db.json is git-ignored and
// local to each machine — the admin account below is created on first boot
// (see the ensure-admin block) so a fresh checkout can sign in.
const initialData = {
  users: [],
  tickets: [
    {
      id: '101',
      title: 'Get IT help',
      description: 'Printer configuration assistance needed in the main office.',
      category: 'Hardware',
      priority: 'Medium',
      status: 'Open',
      assigned_to: 'Unassigned',
      created_by: null,
      created_by_name: 'Employee User',
      image: ''
    }
  ],
  inventory: [
    { id: '1', name: 'MacBook Pro 16 M2', category: 'Laptop', serial_number: 'SN-8942-X1', assigned_to: 'Unassigned', assigned_to_id: null, status: 'In Stock', quantity: 1, reorder_level: null },
    // A consumable stock line (quantity + low-stock alert level) so the
    // restock feature is visible on a fresh checkout: 4 left, alert at 5.
    { id: '2', name: 'HP 85A Black Toner Cartridge', category: 'Toner', serial_number: 'BATCH-HP-85A', assigned_to: 'Unassigned', assigned_to_id: null, status: 'In Stock', quantity: 4, reorder_level: 5 }
  ],
  // Persisted password-reset codes (#24) — keyed by normalized email.
  resetCodes: {},
  // Call records read from the PBX (Panasonic SMDR) and the extension →
  // person directory that maps a ringing extension back to an account.
  calls: [],
  extensions: []
};

// Load persistent data from JSON file
const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
    return JSON.parse(JSON.stringify(initialData));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(initialData));
  }
};

const db = loadData();
let users = db.users || [];
let tickets = db.tickets || [];
let inventory = db.inventory || [];
// Reset codes survive restarts (#24) — a restart used to void every pending
// code, which looked like "the code you just emailed me is wrong".
let resetCodes = db.resetCodes && typeof db.resetCodes === 'object' ? db.resetCodes : {};
// Call records + extension directory for the PBX call-to-ticket feature. The
// PBX module owns these arrays; loading them here (before the first saveData
// call, which happens during the migrations below) means a boot-time write
// can never wipe the call log.
pbx.loadData(db);

// Monotonic id generator (#18). Date.now() primary keys collided under
// concurrent writes: 6 simultaneous signups produced the same id, and
// Array.filter then deleted every matching row. We suffix a counter that
// always advances within the millisecond so ids are unique even under load.
let idCounter = 0;
const genId = (prefix) => {
  idCounter = (idCounter + 1) % 1000000;
  return `${prefix || ''}${Date.now()}-${idCounter}`;
};

// Normalize emails (trim + lowercase) so casing or stray whitespace
// can never block sign-in or create duplicate accounts.
const normalizeEmail = (email) => (email || '').trim().toLowerCase();

// Save state to disk
const saveData = () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    users,
    tickets,
    inventory,
    resetCodes,
    // Owned by the PBX module; `pbx.getCalls()` returns an empty array until
    // `pbx.loadData()` has run, which happens immediately after loadData().
    calls: pbx.getCalls(),
    extensions: pbx.getExtensions(),
  }, null, 2));
};

// ------------------------------------------------------------------
// Auth helpers
// ------------------------------------------------------------------
const BCRYPT_ROUNDS = 10;
const isBcryptHash = (value) => typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

// ------------------------------------------------------------------
// Super-admin tier (#36).
//
// Every agent used to see every ticket and could reassign any of them. Now:
//   employee     — only their own tickets
//   agent        — only the tickets assigned to them
//   super admin  — every ticket, and the only role that can dispatch
//                  (reassign) work or manage user accounts
// `super_admin` is a flag on agent accounts rather than a third role value, so
// every existing `role === 'agent'` check keeps working unchanged.
// ------------------------------------------------------------------
const isSuperAdmin = (u) => Boolean(u && u.role === 'agent' && u.super_admin === true);

// Never serialize the password hash to clients.
const safeUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, super_admin: isSuperAdmin(u) });

// Databases created before auth hardening store plaintext passwords — hash
// them in place on boot so every credential at rest is a bcrypt hash.
let passwordsMigrated = false;
users.forEach((u) => {
  if (u.password && !isBcryptHash(u.password)) {
    u.password = bcrypt.hashSync(String(u.password), BCRYPT_ROUNDS);
    passwordsMigrated = true;
  }
});
if (passwordsMigrated) {
  saveData();
  console.log('[INIT] Migrated plaintext passwords to bcrypt hashes.');
}

// Ensure at least one agent account exists so the console is never
// unmanageable. Unlike the old seed, this only fires when NO agent exists —
// deliberately deleting an admin while other agents remain will not resurrect
// it. Override the fallback credentials with ADMIN_EMAIL / ADMIN_PASSWORD.
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || 'admin@sayedfarms.com');
if (!users.some((u) => u.role === 'agent')) {
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';
  users.push({
    id: genId('admin-'),
    name: 'IT Admin',
    email: ADMIN_EMAIL,
    role: 'agent',
    super_admin: true,
    password: bcrypt.hashSync(adminPassword, BCRYPT_ROUNDS),
  });
  saveData();
  console.log(`[INIT] No agent account found — created ${ADMIN_EMAIL} (super admin)`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[WARN] Using the default admin password. Set ADMIN_PASSWORD in backend/.env (and change it after first sign-in).');
  }
}

// Super-admin migration (#36). Agents that predate the flag become regular
// agents — they now see only the tickets assigned to them — and one account is
// always promoted so the helpdesk can never end up with nobody able to
// dispatch work. The configured ADMIN_EMAIL account wins; otherwise the first
// agent in the directory is promoted and named in the log.
let superAdminMigrated = false;
users.forEach((u) => {
  if (u.role === 'agent' && typeof u.super_admin !== 'boolean') {
    u.super_admin = false;
    superAdminMigrated = true;
  }
});
if (!users.some(isSuperAdmin)) {
  const byAdminEmail = users.find((u) => u.role === 'agent' && normalizeEmail(u.email) === ADMIN_EMAIL);
  const promoted = byAdminEmail || users.find((u) => u.role === 'agent');
  if (promoted) {
    promoted.super_admin = true;
    superAdminMigrated = true;
    console.log(`[INIT] No super admin found — promoted ${promoted.email} to super admin so tickets can be dispatched.`);
    if (!byAdminEmail) {
      console.warn('[WARN] Promote the intended dispatcher in User Management and demote this account.');
    }
  }
}
if (superAdminMigrated) saveData();

// ------------------------------------------------------------------
// Assignments keyed by user id (#17).
//
// Assignments used to be stored as the assignee's *display name*. Renaming a
// user orphaned every ticket and asset pointing at them, and two accounts with
// the same name were indistinguishable (the <select> even emitted duplicate
// React keys). `assigned_to_id` is now the source of truth and `assigned_to`
// is kept as a denormalized display name so existing API consumers, badges and
// exports keep working.
// ------------------------------------------------------------------
const UNASSIGNED = 'Unassigned';

const displayNameForId = (id) => {
  if (!id) return UNASSIGNED;
  const u = users.find((x) => x.id === id);
  return u ? u.name : UNASSIGNED;
};

const setAssignee = (row, id) => {
  row.assigned_to_id = id || null;
  row.assigned_to = displayNameForId(id);
};

/**
 * Resolve a client-supplied assignee (id, or a legacy display name) to a user.
 * Returns { id } on success (id === null means "Unassigned"), or { error }.
 *
 * `onlyRole` restricts who may be assigned (tickets go to IT agents).
 * `allowCurrent` lets a row keep an assignee that no longer matches the
 * restriction instead of hard-failing the whole PATCH.
 */
const resolveAssignee = (raw, { onlyRole, allowCurrent } = {}) => {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === undefined || value === null || value === '' || value === UNASSIGNED) {
    return { id: null };
  }
  const byId = users.find((u) => u.id === value);
  const byName = users.find((u) => u.name && u.name.toLowerCase() === String(value).toLowerCase());
  const user = byId || byName;
  if (!user) {
    return { error: `No such user: "${String(value).slice(0, 100)}". Pick someone from the list, or Unassigned.` };
  }
  if (onlyRole && user.role !== onlyRole && user.id !== allowCurrent) {
    return { error: `${user.name} is not an IT agent. Tickets can only be assigned to agents or Unassigned.` };
  }
  return { id: user.id };
};

// Keep the denormalized names honest after a rename.
const refreshAssigneeNames = (userId) => {
  let changed = false;
  const sync = (row) => {
    if (row.assigned_to_id === userId) {
      row.assigned_to = displayNameForId(userId);
      changed = true;
    }
  };
  tickets.forEach(sync);
  inventory.forEach(sync);
  return changed;
};

// Backfill per-ticket chat history for tickets created before it existed, plus
// ownership for tickets created before reporter identity was stamped (#14),
// plus id-keyed assignments for rows written before #17 was fixed.
let ticketsMigrated = false;
const migrateAssignee = (row) => {
  if (row.assigned_to_id !== undefined) return;
  const raw = row.assigned_to;
  if (!raw || raw === UNASSIGNED) {
    row.assigned_to_id = null;
    row.assigned_to = UNASSIGNED;
  } else {
    const owner = users.find((u) => u.name && u.name.toLowerCase() === String(raw).toLowerCase());
    row.assigned_to_id = owner ? owner.id : null;
    // An unresolvable legacy name (deleted account, hand-edited db.json) is
    // kept visible rather than silently relabelled "Unassigned".
    row.assigned_to = owner ? owner.name : String(raw);
  }
};
tickets.forEach((t) => {
  if (!Array.isArray(t.messages)) {
    t.messages = [];
    ticketsMigrated = true;
  }
  if (t.created_by === undefined) {
    const owner = t.created_by_name
      ? users.find((u) => u.name && u.name.toLowerCase() === String(t.created_by_name).toLowerCase())
      : null;
    t.created_by = owner ? owner.id : null;
    ticketsMigrated = true;
  }
  if (t.assigned_to_id === undefined) {
    migrateAssignee(t);
    ticketsMigrated = true;
  }
});
inventory.forEach((i) => {
  if (i.assigned_to_id === undefined) {
    migrateAssignee(i);
    ticketsMigrated = true;
  }
});
if (ticketsMigrated) saveData();

// ------------------------------------------------------------------
// Ticket factory (shared by the portal API and the PBX call logger).
//
// A ticket raised by an IP-phone call must be indistinguishable from one
// raised in the portal: same fields, same MTTR stamps, same dispatch
// notification. Both paths therefore go through `newTicketRecord` +
// `addTicket` below — the PBX module receives them as dependencies instead of
// re-implementing ticket creation.
//
// `source` ('portal' | 'pbx_call') and `call_id` are additive: they record
// where the request came from without changing any existing field.
// ------------------------------------------------------------------
const newTicketRecord = ({
  title,
  description,
  category = 'Hardware',
  priority = 'Medium',
  assigned_to_id = null,
  created_by = null,
  created_by_name = '',
  image = '',
  source = 'portal',
  call_id = null,
}) => ({
  id: genId('ticket-'),
  title,
  description,
  category,
  priority,
  status: 'Open',
  assigned_to_id,
  assigned_to: displayNameForId(assigned_to_id),
  created_by,
  created_by_name,
  image,
  messages: [],
  source,
  call_id,
  created_at: new Date().toISOString(),
  // MTTR lifecycle stamps (#mttr). Resolution time is measured
  // created_at -> resolved_at and snapshotted into `resolution_minutes`.
  // All null until the ticket actually reaches a resolved/closed state.
  first_response_at: null,
  resolved_at: null,
  closed_at: null,
  resolution_minutes: null,
  reopened_count: 0,
});

/** Insert a ticket, persist it and alert the dispatch queue. */
const addTicket = (ticket) => {
  tickets.unshift(ticket);
  saveData();
  // #36: alert the super admin that there is something to dispatch. Regular
  // agents hear nothing about tickets they do not own.
  io.to('role_super_admin').emit('ticket_created', { ticketId: ticket.id });
  return ticket;
};

// ------------------------------------------------------------------
// PBX call logging (Panasonic SMDR).
//
// Injects the helpers the call logger needs. Records can arrive from a TCP
// feed (client or server mode), the webhook, manual entry or the simulator —
// all of them end up in the same `calls` store and, per PBX_TICKET_POLICY,
// in the ticket queue.
// ------------------------------------------------------------------
pbx.init({
  genId,
  saveData,
  getUsers: () => users,
  getTickets: () => tickets,
  newTicketRecord,
  addTicket,
  io,
});
if (pbx.pbxConfig.enabled) {
  console.log(`[PBX] Call logging enabled — ${pbx.describeConfig()}`);
  if (!pbx.pbxConfig.itExtensions.length) {
    console.warn('[PBX] PBX_IT_EXTENSIONS is not set: calls will be logged but no tickets raised. Set it to the IT office extension(s), e.g. PBX_IT_EXTENSIONS=204,205');
  }
}


// ------------------------------------------------------------------
// MTTR (mean time to resolution) lifecycle stamps.
//
// Every ticket carries the timestamps the reporting endpoint aggregates:
//   first_response_at   — first reply posted by an IT agent (one per ticket)
//   resolved_at         — when the ticket reached "Resolved" (or "Closed"
//                         directly); re-stamped on re-resolution after a
//                         reopen so the final cycle is measured
//   closed_at           — when the ticket reached "Closed"
//   resolution_minutes  — resolved_at − created_at, in minutes (total
//                         elapsed time to resolution, reopens included)
//   reopened_count      — how many times work resumed after a resolution
//
// Tickets that were already resolved before these stamps existed (or before
// created_at existed) keep null stamps and are simply excluded from the
// aggregates rather than counted with fabricated numbers.
// ------------------------------------------------------------------
const minutesBetween = (fromIso, toIso) => {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round(((to - from) / 60000) * 10) / 10;
};

const RESOLUTION_STATUSES = new Set(['Resolved', 'Closed']);

/**
 * Move a ticket to `nextStatus` while maintaining its MTTR stamps.
 * Returns true when the status actually changed.
 *
 *   Open/In Progress/Pending -> Resolved/Closed : stamp resolution
 *   Resolved <-> Closed                          : keep resolve time, stamp/unstamp close time
 *   Resolved/Closed -> Open/In Progress/Pending  : reopen (count it, measure the next cycle fresh)
 *   Resolved/Closed -> Cancelled                 : abandoned, not a resolution (stamps cleared, not a reopen)
 */
const applyTicketStatus = (ticket, nextStatus) => {
  const prev = ticket.status;
  if (prev === nextStatus) return false;
  const wasResolved = RESOLUTION_STATUSES.has(prev);
  const isResolved = RESOLUTION_STATUSES.has(nextStatus);
  const nowIso = new Date().toISOString();

  if (isResolved && !wasResolved) {
    // Entering a resolution state. Closing straight from an active state
    // counts as resolved at close time; re-resolving after a reopen
    // re-stamps the whole cycle (resolution stays "total elapsed").
    ticket.resolved_at = nowIso;
    if (nextStatus === 'Closed') ticket.closed_at = nowIso;
  } else if (isResolved && wasResolved) {
    // Resolved <-> Closed keeps the original resolve time.
    if (nextStatus === 'Closed') {
      if (!ticket.resolved_at) ticket.resolved_at = nowIso;
      if (!ticket.closed_at) ticket.closed_at = nowIso;
    } else {
      ticket.closed_at = null; // un-closing back to Resolved
    }
  } else if (wasResolved && !isResolved) {
    if (nextStatus !== 'Cancelled') {
      // Work resumed after a resolution — that is a reopen.
      ticket.reopened_count = (ticket.reopened_count || 0) + 1;
    }
    // Measure the next resolution cycle fresh.
    ticket.resolved_at = null;
    ticket.closed_at = null;
    ticket.resolution_minutes = null;
  }

  ticket.status = nextStatus;
  if (ticket.resolved_at) {
    ticket.resolution_minutes = minutesBetween(ticket.created_at, ticket.resolved_at);
  }
  return true;
};

// Backfill the MTTR fields for tickets written before they existed. Timestamps
// that cannot be reconstructed honestly stay null (and are excluded from the
// report) — a guessed "resolved_at" would poison every average downstream.
let mttrMigrated = false;
tickets.forEach((t) => {
  if (t.first_response_at === undefined) { t.first_response_at = null; mttrMigrated = true; }
  if (t.resolved_at === undefined) { t.resolved_at = null; mttrMigrated = true; }
  if (t.closed_at === undefined) { t.closed_at = null; mttrMigrated = true; }
  if (t.resolution_minutes === undefined) {
    t.resolution_minutes = t.resolved_at ? minutesBetween(t.created_at, t.resolved_at) : null;
    mttrMigrated = true;
  }
  if (t.reopened_count === undefined) { t.reopened_count = 0; mttrMigrated = true; }
});
if (mttrMigrated) saveData();

// Asset-category migration (#asset-categories): the old Add Asset form offered
// "Desktop"; the server-owned list calls it "Desktop Computer". Map the legacy
// value so it stays in the published pick list instead of becoming an
// unselectable oddity in the dropdown.
let categoryMigrated = false;
inventory.forEach((i) => {
  if (i.category === 'Desktop') {
    i.category = 'Desktop Computer';
    categoryMigrated = true;
  }
});
if (categoryMigrated) saveData();

// Stock-tracking migration: rows recorded before quantities existed each
// describe one physical unit (quantity 1) with no low-stock alerting
// (reorder_level null). Anything hand-edited into an invalid value is reset
// the same way rather than crashing the stock report.
let stockMigrated = false;
inventory.forEach((i) => {
  if (!Number.isInteger(i.quantity) || i.quantity < 0) {
    i.quantity = 1;
    stockMigrated = true;
  }
  const level = i.reorder_level;
  if (level !== null && level !== undefined && !(Number.isInteger(level) && level >= 0)) {
    i.reorder_level = null;
    stockMigrated = true;
  }
});
if (stockMigrated) saveData();

// Append a chat message to a ticket (shared by the REST endpoint and sockets).
const appendTicketMessage = (ticketId, sender, senderName, text) => {
  const ticket = tickets.find((t) => t.id === String(ticketId));
  if (!ticket || !text || !String(text).trim()) return null;
  if (!Array.isArray(ticket.messages)) ticket.messages = [];
  const message = {
    id: genId('msg-'),
    sender: sender === 'agent' ? 'agent' : 'user',
    senderName: senderName || (sender === 'agent' ? 'IT Agent' : 'Employee'),
    text: String(text).trim(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  ticket.messages.push(message);
  // MTTR sibling metric: the first reply from an IT agent is the ticket's
  // first response. Stamped once — later replies never move it.
  if (message.sender === 'agent' && !ticket.first_response_at) {
    ticket.first_response_at = new Date().toISOString();
  }
  saveData();
  return { ticket, message };
};

// True when `user` may see/post in a ticket (#36).
//   employee    — tickets they raised
//   agent       — tickets assigned to them
//   super admin — everything
const canAccessTicket = (user, ticketId) => {
  if (!user) return false;
  const ticket = tickets.find((t) => t.id === String(ticketId));
  if (!ticket) return false;
  if (isSuperAdmin(user)) return true;
  if (user.role === 'agent') return ticket.assigned_to_id === user.id;
  return ticket.created_by === user.id;
};

// The tickets a given session is allowed to list.
const visibleTicketsFor = (user) => {
  if (isSuperAdmin(user)) return tickets;
  if (user.role === 'agent') return tickets.filter((t) => t.assigned_to_id === user.id);
  return tickets.filter((t) => t.created_by === user.id);
};

// Verify the Bearer token and attach the CURRENT user record.
const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }
  let payload;
  try {
    payload = jwt.verify(match[1].trim(), JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
  const user = users.find((u) => u.id === payload.id);
  if (!user) {
    return res.status(401).json({ error: 'Account no longer exists. Please sign in again.' });
  }
  req.user = user;
  next();
};

const requireAgent = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'This action requires an IT agent account.' });
    }
    next();
  });
};

// User administration and ticket dispatch are the super admin's job (#36).
const requireSuperAdmin = (req, res, next) => {
  requireAuth(req, res, () => {
    if (!isSuperAdmin(req.user)) {
      return res.status(403).json({ error: 'This action requires a super admin account.' });
    }
    next();
  });
};

// ------------------------------------------------------------------
// Rate limiting (#7) — tiny in-memory sliding window, zero new deps.
// Blunts brute-force on login/OTP endpoints; production can put a real
// reverse-proxy limiter in front. Configurable via RATE_LIMIT_* env.
// ------------------------------------------------------------------
const rateBuckets = new Map();
// Multiplier for every bucket's budget. Default 1; raise it (e.g. behind a
// trusted proxy, or in a test suite that drives the whole API from one IP)
// without disabling the limiter outright.
const RATE_LIMIT_SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE) || 1);
const rateLimit = (opts) => {
  const { windowMs, max, keyFn, message } = {
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyFn: (req) => req.ip,
    message: 'Too many requests. Please slow down and try again in a few minutes.',
    ...opts,
  };
  const budget = Math.max(1, Math.round(max * RATE_LIMIT_SCALE));
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = rateBuckets.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now };
      rateBuckets.set(key, entry);
    }
    entry.count += 1;
    res.set('X-RateLimit-Limit', String(budget));
    res.set('X-RateLimit-Remaining', String(Math.max(0, budget - entry.count)));
    const resetSec = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
    res.set('X-RateLimit-Reset', String(resetSec));
    if (entry.count > budget) {
      return res.status(429).json({ error: message, retryAfter: resetSec });
    }
    next();
  };
};
// GC old buckets so an attacker can't fill memory forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of rateBuckets) if (v.start < cutoff) rateBuckets.delete(k);
}, 60 * 1000).unref?.();

// Login + password-reset endpoints get TIGHT limits (keyed by IP+email so one
// IP can't brute-force the whole userbase, and one email can't be hammered).
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip}:${normalizeEmail(req.body && req.body.email)}`,
  message: 'Too many sign-in / reset attempts for this account. Try again in a few minutes.',
});
const sensitiveRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many sensitive actions from this address. Try again later.',
});
const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many requests. Slow down.',
});

// ------------------------------------------------------------------
// Mass-assignment protection (#8): pick only allowed fields from req.body.
// id/role/password/created_by/messages/etc. can never be overwritten by a
// PATCH/POST no matter what the client sends.
// ------------------------------------------------------------------
const pick = (body, fields) => {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
};
const requireStrings = (obj, fields) => {
  for (const f of fields) {
    if (!obj || typeof obj[f] !== 'string' || !obj[f].trim()) return f;
  }
  return null;
};

// Validators for #15 input validation.
//
// These sets MUST cover every value the UI can submit. They previously did not:
// the Agent Console offers "Pending / On Hold" and "Closed" (both 400'd), and
// the Asset forms offer "Under Maintenance" and "Decommissioned" (the create
// endpoint *silently* replaced them with "In Stock"). See BUG-REPORT #32/#33.
// GET /api/meta/enums publishes these sets so the frontend renders its
// <select>s from the server's list instead of drifting again.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TICKET_STATUS = new Set(['Open', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled']);
const VALID_TICKET_PRIORITY = new Set(['Low', 'Medium', 'High', 'Urgent']);
// Matches the options the portal form actually offers (incl. 'Access/Security').
const VALID_TICKET_CATEGORY = new Set(['Hardware', 'Software', 'Network', 'Access/Security', 'Account', 'Other']);
const VALID_USER_ROLE = new Set(['agent', 'user']);
// Union of the two asset forms: the console's edit dropdown used In Repair /
// Retired while the "Add Asset" form used Under Maintenance / Decommissioned.
const VALID_INVENTORY_STATUS = new Set(['In Stock', 'Assigned', 'In Repair', 'Retired', 'Under Maintenance', 'Decommissioned']);
// Asset categories (#asset-categories). The Add Asset form used to hardcode
// five options in the frontend while the API accepted any string; the set is
// now server-owned and published through GET /api/meta/enums so the picker and
// the API can never disagree (same contract as ticket categories #32/#33).
// Covers office IT plus the hardware actually held on the farms: printers and
// their consumables, IP / solar PTZ cameras, NVRs, storage, and so on.
const VALID_INVENTORY_CATEGORY = new Set([
  'Laptop',
  'Desktop Computer',
  'Monitor',
  'Printer',
  'Cartridge',
  'Toner',
  'IP Camera',
  'Solar PTZ Camera',
  'NVR',
  'SSD/HDD',
  'Network Equipment',
  'Peripherals',
  'Server',
  'UPS',
  'Other',
]);
// PBX call log vocabularies. Published here so the console's filters offer
// exactly what the API accepts, same contract as the ticket/asset enums.
const VALID_CALL_DIRECTION = new Set(['Incoming', 'Outgoing', 'Internal']);
const VALID_CALL_OUTCOME = new Set(['Solved', 'Not solved', 'Pending']);
const VALID_PBX_TICKET_POLICY = new Set(['all', 'answered', 'missed', 'off']);

const ENUMS = {
  ticketStatus: [...VALID_TICKET_STATUS],
  ticketPriority: [...VALID_TICKET_PRIORITY],
  ticketCategory: [...VALID_TICKET_CATEGORY],
  inventoryStatus: [...VALID_INVENTORY_STATUS],
  inventoryCategory: [...VALID_INVENTORY_CATEGORY],
  userRole: [...VALID_USER_ROLE],
  callDirection: [...VALID_CALL_DIRECTION],
  callOutcome: [...VALID_CALL_OUTCOME],
  pbxTicketPolicy: [...VALID_PBX_TICKET_POLICY],
};

const { sendOtpEmail, isSmtpConfigured } = require('./utils/sendEmail');

// ------------------------------------------------------------------
// Password-reset codes (#24).
//
// These used to live in a plain in-memory object: any restart (a deploy, a
// crash, a free-tier dyno cycle) silently voided every code a user had just
// been emailed, which reads as "the code you sent me is wrong". They are now
// persisted in db.json, stored as a SHA-256 digest rather than plaintext, and
// capped at RESET_MAX_ATTEMPTS guesses each.
// ------------------------------------------------------------------
const RESET_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESET_MAX_ATTEMPTS = 5;

const otpDigest = (email, otp) =>
  crypto.createHash('sha256').update(`${normalizeEmail(email)}:${String(otp).trim()}`).digest('hex');

const digestsMatch = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};

const pruneResetCodes = () => {
  const now = Date.now();
  let pruned = false;
  for (const [email, rec] of Object.entries(resetCodes)) {
    if (!rec || typeof rec !== 'object' || !rec.expiresAt || rec.expiresAt < now) {
      delete resetCodes[email];
      pruned = true;
    }
  }
  if (pruned) saveData();
  return pruned;
};

const storeResetCode = (email, otp) => {
  pruneResetCodes();
  resetCodes[normalizeEmail(email)] = {
    codeHash: otpDigest(email, otp),
    expiresAt: Date.now() + RESET_TTL_MS,
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  saveData();
};

// Drop codes that expired while the server was down.
pruneResetCodes();

if (!isSmtpConfigured()) {
  console.warn('\n[WARN] SMTP is NOT configured (backend/.env). Password reset emails will NOT be sent.');
  console.warn('       Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in backend/.env and restart the server.');
  console.warn('       Until then, reset codes are only printed to this terminal / shown in the app (dev mode).\n');
}

/**
 * Generates an OTP for `email` and delivers it.
 *
 * #10 account-enumeration fix: when SMTP is configured, we return the same
 * generic success response whether the email exists or not, so an attacker
 * cannot probe the user directory. OTP is only generated/sent when real.
 */
const generateAndSendOtp = async (res, email, kind) => {
  const key = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === key);

  const genericSuccess = () =>
    res.json({ success: true, emailSent: true, message: 'If an account matches that email, a verification code has been sent.' });

  const otp = crypto.randomInt(100000, 1000000).toString();

  if (user) storeResetCode(key, otp);

  if (!isSmtpConfigured()) {
    if (!user) {
      return res.status(400).json({ error: 'If this email exists, a code would be sent. (Dev: address not found.)' });
    }
    console.log(`\n========================================\n [DEV ${kind.toUpperCase()} OTP CODE for ${key}]: ${otp}\n========================================\n`);
    if (isProduction) {
      return res.status(500).json({
        error: 'Email delivery is not configured on this server. Please contact the administrator.',
        emailSent: false,
      });
    }
    return res.json({
      success: true,
      emailSent: false,
      devOtp: otp,
      message: 'Email delivery is not configured on the server; use the development code shown on screen.',
    });
  }

  if (!user) return genericSuccess();

  try {
    await sendOtpEmail(key, otp, kind);
    return genericSuccess();
  } catch (err) {
    console.error(`[${kind.toUpperCase()}] Email send error:`, err && err.message ? err.message : err);
    console.log(`\n========================================\n [DEV FALLBACK OTP CODE for ${key}]: ${otp}\n========================================\n`);
    return res.status(500).json({
      error: 'Failed to send the verification email. Please try again or contact the administrator.',
      emailSent: false,
    });
  }
};

app.post('/api/auth/signup', writeRateLimit, async (req, res) => {
  try {
    const body = pick(req.body, ['name', 'email', 'password']);
    const cleanName = String(body.name || '').trim();
    const cleanEmail = normalizeEmail(body.email);
    if (!cleanName) return res.status(400).json({ error: 'Full name is required' });
    if (cleanName.length > 100) return res.status(400).json({ error: 'Name is too long (max 100 characters)' });
    if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (typeof body.password !== 'string' || body.password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (body.password.length > 200) return res.status(400).json({ error: 'Password is too long' });
    if (users.some((u) => normalizeEmail(u.email) === cleanEmail)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    // Any `role` sent by the client is deliberately ignored (#6).
    const newUser = {
      id: genId('user-'),
      name: cleanName,
      email: cleanEmail,
      password: await bcrypt.hash(body.password, BCRYPT_ROUNDS),
      role: 'user',
    };
    users.push(newUser);
    saveData();
    res.json({ token: signToken(newUser), user: safeUser(newUser) });
  } catch (err) {
    console.error('[signup] error:', err);
    res.status(500).json({ error: 'Could not create the account. Please try again.' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email', 'password']);
  const user = users.find((u) => normalizeEmail(u.email) === normalizeEmail(body.email));
  const ok = user && typeof body.password === 'string' && await bcrypt.compare(body.password, user.password || '');
  if (!ok) {
    // Same message for unknown email and bad password — prevents enumeration.
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: safeUser(user) });
});

// Who am I, according to the server (#36). Lets a signed-in console pick up a
// role/super-admin change (or a revocation) without signing out and back in.
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(safeUser(req.user));
});

app.post('/api/auth/forgot-password', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email']);
  if (!body.email || !normalizeEmail(body.email)) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, normalizeEmail(body.email), 'reset');
});

app.post('/api/auth/resend-otp', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email']);
  if (!body.email || !normalizeEmail(body.email)) {
    return res.status(400).json({ error: 'Email address is required' });
  }
  await generateAndSendOtp(res, normalizeEmail(body.email), 'resend');
});

app.post('/api/auth/reset-password', authRateLimit, async (req, res) => {
  const body = pick(req.body, ['email', 'otp', 'password']);
  if (!body.email || body.otp === undefined || body.otp === null || body.otp === '' || !body.password) {
    return res.status(400).json({ error: 'Email, verification code and new password are required' });
  }
  const key = normalizeEmail(body.email);
  const user = users.find((u) => normalizeEmail(u.email) === key);
  if (!user) return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  const record = resetCodes[key];
  if (!record || !record.expiresAt || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }
  if (!digestsMatch(record.codeHash, otpDigest(key, body.otp))) {
    // Burn the code after too many wrong guesses so a 6-digit space can't be
    // walked by hand within the 10-minute window.
    record.attempts = Number(record.attempts || 0) + 1;
    if (record.attempts >= RESET_MAX_ATTEMPTS) {
      delete resetCodes[key];
      saveData();
      return res.status(400).json({ error: 'Too many incorrect codes. Request a new one.' });
    }
    saveData();
    return res.status(400).json({ error: 'Invalid or expired OTP code.' });
  }
  if (typeof body.password !== 'string' || body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }
  user.password = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  delete resetCodes[key];
  saveData();
  res.json({ success: true, message: 'Password updated successfully' });
});

// The full directory (emails, roles) is for the super admin who manages
// accounts; plain agents get the id/name agent picker below (#36).
app.get('/api/users', requireSuperAdmin, (req, res) => {
  // `super_admin` is always an explicit boolean so the console's access
  // dropdown is never fed an `undefined` (#36).
  res.json(users.map((u) => ({ ...safeUser(u) })));
});

app.get('/api/agents', requireAuth, (req, res) => {
  res.json(users.filter((u) => u.role === 'agent').map((u) => ({ id: u.id, name: u.name })));
});

// Email-free directory for the assignment pickers, so a regular agent can
// still choose who an asset belongs to now that the full directory (emails,
// roles, account management) is super-admin-only (#36).
app.get('/api/people', requireAgent, (req, res) => {
  res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role })));
});

// Single source of truth for the values the API accepts (#32/#33). The
// frontend renders its dropdowns from this, so a status added here can never
// be rejected by the server or silently rewritten.
app.get('/api/meta/enums', requireAuth, (req, res) => {
  res.json(ENUMS);
});

app.delete('/api/users/:id', requireSuperAdmin, sensitiveRateLimit, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  if (target.role === 'agent' && users.filter((u) => u.role === 'agent').length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last IT agent account' });
  }
  // Re-home every assignment that pointed at this account — matched by id
  // (the canonical key) and by legacy display name (#17).
  const wasTheirs = (row) =>
    (row.assigned_to_id && row.assigned_to_id === target.id)
    || (!row.assigned_to_id && row.assigned_to === target.name);
  tickets.forEach((t) => {
    if (wasTheirs(t)) setAssignee(t, null);
  });
  inventory.forEach((i) => {
    if (wasTheirs(i)) {
      setAssignee(i, null);
      if (i.status === 'Assigned') i.status = 'In Stock';
    }
  });
  users = users.filter((u) => u.id !== target.id);
  // The PBX extension directory points at accounts too: unlink the deleted
  // person so an extension never resolves to a ghost.
  pbx.onUserDeleted(target.id);
  saveData();
  res.json({ success: true });
});

app.patch('/api/users/:id', requireSuperAdmin, writeRateLimit, (req, res) => {
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // #8: explicit field allow-list — id/email/password can never be rewritten.
  // `super_admin` is settable here because managing the dispatcher tier is a
  // super-admin action by definition (#36).
  const body = pick(req.body, ['role', 'name', 'super_admin']);
  let needsResync = false;
  if (body.role !== undefined) {
    if (!VALID_USER_ROLE.has(body.role)) {
      return res.status(400).json({ error: 'Role must be either "agent" or "user"' });
    }
    if (target.id === req.user.id && body.role !== target.role) {
      return res.status(403).json({ error: 'You cannot change your own role' });
    }
    if (target.role === 'agent' && body.role === 'user' && users.filter((u) => u.role === 'agent').length <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last IT agent account' });
    }
    if (body.role === 'user' && isSuperAdmin(target)) {
      // Demoting an agent to employee drops the flag with it.
      target.super_admin = false;
    }
    if (body.role === 'agent' && typeof target.super_admin !== 'boolean') {
      // New agents start as regular agents (own queue only) until a super
      // admin grants them the wider view.
      target.super_admin = false;
    }
    target.role = body.role;
    needsResync = true;
  }
  if (body.super_admin !== undefined) {
    if (typeof body.super_admin !== 'boolean') {
      return res.status(400).json({ error: 'super_admin must be true or false' });
    }
    if (target.role !== 'agent') {
      return res.status(400).json({ error: 'Only IT agent accounts can be super admins. Promote the account to agent first.' });
    }
    if (body.super_admin === true) {
      target.super_admin = true;
    } else if (isSuperAdmin(target)) {
      // Never let the last dispatcher demote themselves out of the job — that
      // would leave a queue nobody can reassign from.
      const remaining = users.filter((u) => isSuperAdmin(u) && u.id !== target.id);
      if (remaining.length === 0) {
        return res.status(400).json({ error: 'This is the only super admin. Promote another agent before removing the role.' });
      }
      target.super_admin = false;
    }
    needsResync = true;
  }
  if (body.name !== undefined) {
    const trimmed = String(body.name).trim();
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    if (trimmed.length > 100) return res.status(400).json({ error: 'Name is too long' });
    const previousName = target.name;
    target.name = trimmed;
    // Assignments are keyed by id, so a rename must not orphan anything —
    // but the denormalized display names on tickets/assets do need refreshing
    // (#17). Before this, renaming a user left every one of their tickets
    // labelled with the old name.
    if (previousName !== trimmed) refreshAssigneeNames(target.id);
  }
  saveData();
  // Role/flag changes alter what this account may see, so update any live
  // socket it holds before responding.
  if (needsResync) resyncUserSockets(target.id);
  res.json(safeUser(target));
});

app.get('/api/tickets', requireAuth, (req, res) => {
  // #36: agents only ever receive the tickets assigned to them; the super
  // admin receives the whole queue. (Not just filtered in the UI — the data
  // never leaves the server.)
  res.json(visibleTicketsFor(req.user));
});

app.post('/api/tickets', requireAuth, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['title', 'description', 'category', 'priority', 'assigned_to_id', 'assigned_to', 'image']);
  if (!String(body.title || '').trim() || !String(body.description || '').trim()) {
    return res.status(400).json({ error: 'Title and description are required' });
  }
  if (String(body.title).trim().length > 200) {
    return res.status(400).json({ error: 'Title is too long (max 200 characters)' });
  }
  if (body.category !== undefined && !VALID_TICKET_CATEGORY.has(body.category)) {
    return res.status(400).json({ error: `Category must be one of: ${[...VALID_TICKET_CATEGORY].join(', ')}` });
  }
  if (body.priority !== undefined && !VALID_TICKET_PRIORITY.has(body.priority)) {
    return res.status(400).json({ error: `Priority must be one of: ${[...VALID_TICKET_PRIORITY].join(', ')}` });
  }
  const category = body.category || 'Hardware';
  const priority = body.priority || 'Medium';
  // "Direct Request to Agent" is honoured for everyone — but the target must be
  // a real IT agent (or left Unassigned). Employees still cannot assign a
  // ticket to an arbitrary user or invent a name (#8). This used to be dropped
  // on the floor for employees, so the dropdown silently did nothing (#34).
  const requested = body.assigned_to_id !== undefined ? body.assigned_to_id : body.assigned_to;
  const assignee = resolveAssignee(requested, { onlyRole: 'agent' });
  if (assignee.error) return res.status(400).json({ error: assignee.error });
  const image = typeof body.image === 'string' && body.image.length < 2_000_000 ? body.image : '';
  if (body.image && !image) {
    return res.status(400).json({ error: 'Attached image is too large (max ~1.5 MB after encoding). Please remove it and try again.' });
  }
  const newTicket = addTicket(newTicketRecord({
    title: String(body.title).trim(),
    description: String(body.description).trim(),
    category,
    priority,
    assigned_to_id: assignee.id || null,
    created_by: req.user.id,
    created_by_name: req.user.name,
    image,
    source: 'portal',
  }));
  res.json(newTicket);
});

app.patch('/api/tickets/:id', requireAuth, writeRateLimit, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'agent') {
    if (ticket.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only update your own requests' });
    }
    // #8: strict allow-list for employees — only {status:'Cancelled'}.
    const body = pick(req.body, ['status']);
    if (Object.keys(body).length !== 1 || body.status !== 'Cancelled') {
      return res.status(403).json({ error: 'You can only cancel your own requests' });
    }
    applyTicketStatus(ticket, 'Cancelled');
    saveData();
    // A call-raised ticket that is cancelled means the issue was not solved.
    pbx.syncCallFromTicket(ticket, req.user.name);
    return res.json(ticket);
  }
  // #36: a regular agent only works on the tickets assigned to them. The
  // super admin manages (and dispatches) every ticket.
  const superAdmin = isSuperAdmin(req.user);
  if (!superAdmin && ticket.assigned_to_id !== req.user.id) {
    return res.status(403).json({
      error: 'This ticket is not assigned to you. Ask a super admin to reassign it if you need access.',
    });
  }
  let assigneeChanged = false;
  const changingAssignee = req.body && (req.body.assigned_to_id !== undefined || req.body.assigned_to !== undefined);
  if (changingAssignee && !superAdmin) {
    return res.status(403).json({ error: 'Only a super admin can reassign tickets.' });
  }
  // #8 mass-assignment fix: explicit allow-list for agents — id/created_by/
  // created_by_name/messages/created_at can never be overwritten from PATCH.
  const body = pick(req.body, ['title', 'description', 'category', 'priority', 'status', 'assigned_to_id', 'assigned_to', 'image']);
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) return res.status(400).json({ error: 'Title cannot be empty' });
    if (t.length > 200) return res.status(400).json({ error: 'Title is too long' });
    ticket.title = t;
  }
  if (body.description !== undefined) {
    const d = String(body.description).trim();
    if (!d) return res.status(400).json({ error: 'Description cannot be empty' });
    ticket.description = d;
  }
  if (body.category !== undefined) {
    if (!VALID_TICKET_CATEGORY.has(body.category)) {
      return res.status(400).json({ error: `Category must be one of: ${[...VALID_TICKET_CATEGORY].join(', ')}` });
    }
    ticket.category = body.category;
  }
  if (body.priority !== undefined) {
    if (!VALID_TICKET_PRIORITY.has(body.priority)) {
      return res.status(400).json({ error: `Priority must be one of: ${[...VALID_TICKET_PRIORITY].join(', ')}` });
    }
    ticket.priority = body.priority;
  }
  if (body.status !== undefined) {
    if (!VALID_TICKET_STATUS.has(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${[...VALID_TICKET_STATUS].join(', ')}` });
    }
    // Keeps the MTTR stamps (resolved_at / closed_at / reopened_count) in
    // step with the status instead of leaving them to be recomputed later.
    applyTicketStatus(ticket, body.status);
  }
  if (body.assigned_to_id !== undefined || body.assigned_to !== undefined) {
    // `assigned_to_id` is canonical; `assigned_to` is still accepted so older
    // clients (and hand-written scripts) keep working (#17).
    const requested = body.assigned_to_id !== undefined ? body.assigned_to_id : body.assigned_to;
    const assignee = resolveAssignee(requested, { onlyRole: 'agent', allowCurrent: ticket.assigned_to_id });
    if (assignee.error) return res.status(400).json({ error: assignee.error });
    setAssignee(ticket, assignee.id);
    assigneeChanged = true;
  }
  if (body.image !== undefined) {
    ticket.image = typeof body.image === 'string' ? body.image : '';
  }
  saveData();
  // Keep the phone call that raised this ticket in step: resolving the ticket
  // marks the call's issue solved and records how long the fix took from the
  // moment the call came in; reopening it puts the call back to pending.
  pbx.syncCallFromTicket(ticket, req.user.name);
  // A reassignment moves the ticket between agents: the previous owner must
  // stop receiving it and the new one must start, live (#36).
  if (assigneeChanged) resyncUserSockets(ticket.assigned_to_id);
  notifyTicketChanged(ticket);
  res.json(ticket);
});

app.post('/api/tickets/:id/messages', requireAuth, writeRateLimit, (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  // #36: the reporter, the assigned agent, or a super admin.
  if (!canAccessTicket(req.user, ticket.id)) {
    return res.status(403).json({
      error: req.user.role === 'agent'
        ? 'This ticket is not assigned to you.'
        : 'You can only chat on your own requests',
    });
  }
  const body = pick(req.body, ['text']);
  const result = appendTicketMessage(
    ticket.id,
    req.user.role === 'agent' ? 'agent' : 'user',
    req.user.name,
    body.text
  );
  if (!result) return res.status(400).json({ error: 'Message text is required' });
  io.to(`ticket_${result.ticket.id}`).emit('receive_ticket_message', {
    ticketId: result.ticket.id,
    message: result.message,
  });
  notifyTicketChanged(result.ticket);
  res.json(result.message);
});

// ------------------------------------------------------------------
// MTTR reporting.
//
// Aggregates the resolution lifecycle stamps maintained by
// `applyTicketStatus` above. Visibility follows the ticket-visibility rules
// (#36) exactly: a super admin's report covers every ticket, a regular
// agent's covers only the tickets assigned to them.
//
// Resolution time is `resolved_at - created_at` in minutes (total elapsed,
// reopens included). Tickets resolved before the stamps existed keep null
// timestamps and are excluded rather than estimated.
// ------------------------------------------------------------------
const round1 = (n) => Math.round(n * 10) / 10;

const statsFromMinutes = (values) => {
  if (!values.length) return { count: 0, meanMinutes: null, medianMinutes: null, minMinutes: null, maxMinutes: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length,
    meanMinutes: round1(mean),
    medianMinutes: round1(median),
    minMinutes: round1(sorted[0]),
    maxMinutes: round1(sorted[sorted.length - 1]),
  };
};

const groupStats = (rows, keyOf) => {
  const groups = new Map();
  rows.forEach((r) => {
    const key = keyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.minutes);
  });
  return [...groups.entries()]
    .map(([key, mins]) => ({ key, ...statsFromMinutes(mins) }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
};

const isoDay = (iso) => iso.slice(0, 10);
const isoWeekStart = (iso) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

// One measurement per resolved ticket: total elapsed minutes to resolution.
// Shared by the on-screen report and the CSV export so both always agree.
const mttrRows = (scopeTickets, { days, now }) => {
  const cutoff = days === 'all' ? -Infinity : now - days * 24 * 60 * 60 * 1000;
  return scopeTickets
    .filter((t) => {
      if (!RESOLUTION_STATUSES.has(t.status)) return false;
      const resolved = Date.parse(t.resolved_at);
      return Number.isFinite(resolved) && resolved >= cutoff;
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      category: t.category,
      agentId: t.assigned_to_id || null,
      agentName: t.assigned_to || 'Unassigned',
      createdAt: t.created_at || null,
      firstResponseAt: t.first_response_at || null,
      resolvedAt: t.resolved_at,
      closedAt: t.closed_at || null,
      minutes: t.resolution_minutes != null ? t.resolution_minutes : minutesBetween(t.created_at, t.resolved_at),
      firstResponseMinutes: t.first_response_at ? minutesBetween(t.created_at, t.first_response_at) : null,
      reopenedCount: t.reopened_count || 0,
    }))
    .filter((r) => r.minutes != null);
};

const buildMttrReport = (scopeTickets, { days, now }) => {
  const cutoff = days === 'all' ? -Infinity : now - days * 24 * 60 * 60 * 1000;
  const rows = mttrRows(scopeTickets, { days, now });

  const summary = {
    ...statsFromMinutes(rows.map((r) => r.minutes)),
    // Companion to MTTR: how long the reporter waited for the first agent reply.
    firstResponseCount: rows.filter((r) => r.firstResponseMinutes != null).length,
    meanFirstResponseMinutes: (() => {
      const fr = rows.map((r) => r.firstResponseMinutes).filter((v) => v != null);
      return fr.length ? round1(fr.reduce((a, b) => a + b, 0) / fr.length) : null;
    })(),
    reopenedCount: rows.reduce((a, r) => a + r.reopenedCount, 0),
  };

  // Trend buckets: days while the range is short, ISO weeks, then months.
  const bucketOf = days !== 'all' && days <= 30
    ? (iso) => isoDay(iso)
    : days !== 'all' && days <= 365
      ? isoWeekStart
      : (iso) => iso.slice(0, 7);
  const bucketLabel = days !== 'all' && days <= 30 ? 'day' : days !== 'all' && days <= 365 ? 'week' : 'month';
  const trend = groupStats(rows, (r) => bucketOf(r.resolvedAt))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((g) => ({ bucket: g.key, count: g.count, meanMinutes: g.meanMinutes, medianMinutes: g.medianMinutes }));

  const agentGroups = groupStats(rows, (r) => r.agentId || 'unassigned');
  const nameById = new Map(rows.map((r) => [r.agentId || 'unassigned', r.agentName]));
  const byAgent = agentGroups.map((g) => ({ id: g.key === 'unassigned' ? null : g.key, name: nameById.get(g.key) || 'Unassigned', count: g.count, meanMinutes: g.meanMinutes, medianMinutes: g.medianMinutes, maxMinutes: g.maxMinutes }));

  const slowest = [...rows]
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5)
    .map(({ firstResponseMinutes: _fr, reopenedCount: _rc, ...rest }) => rest);

  return {
    range: { days, from: cutoff === -Infinity ? null : new Date(cutoff).toISOString(), to: new Date(now).toISOString() },
    bucket: bucketLabel,
    summary,
    trend,
    byCategory: groupStats(rows, (r) => r.category || 'Other'),
    byPriority: groupStats(rows, (r) => r.priority || 'Medium'),
    byAgent,
    slowest,
  };
};

// ---- Report generation (CSV exports + asset stock report) -----------------

// Shared ?days= parsing for the MTTR dashboard feed and its CSV export.
const parseMttrRange = (query) => {
  const raw = String((query.days ?? '30')).trim().toLowerCase();
  if (raw === 'all') return { days: 'all', raw };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { error: 'days must be an integer between 1 and 365, or "all"' };
  }
  return { days, raw };
};

const rangeLabel = (days) => (days === 'all' ? 'All time' : `Last ${days} days`);

// Minimal CSV writer: RFC-4180 quoting plus a UTF-8 BOM so Excel on Windows
// opens the file with the right encoding.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');
const sendCsv = (res, filename, lines) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${lines.join('\r\n')}`);
};
const exportDate = () => new Date().toISOString().slice(0, 10);
const fmtNum = (v) => (v == null ? '' : String(v));

// GET /api/reports/mttr?days=30|7|90|365|all — the MTTR dashboard feed.
// Agents: metrics over the tickets assigned to them. Super admins: the whole
// helpdesk (plus the per-agent breakdown). Employees are not ops-reporting
// users and get a 403 from requireAgent.
app.get('/api/reports/mttr', requireAgent, (req, res) => {
  const range = parseMttrRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const report = buildMttrReport(visibleTicketsFor(req.user), { days: range.days, now: Date.now() });
  report.scope = isSuperAdmin(req.user) ? 'all' : 'own';
  res.json(report);
});

// GET /api/reports/mttr/export?days=... — the same report as a CSV download:
// a summary block, then one row per resolved ticket behind the numbers.
app.get('/api/reports/mttr/export', requireAgent, (req, res) => {
  const range = parseMttrRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const scope = visibleTicketsFor(req.user);
  const now = Date.now();
  const report = buildMttrReport(scope, { days: range.days, now });
  const rows = mttrRows(scope, { days: range.days, now });
  const s = report.summary;

  const lines = [];
  lines.push(csvRow(['MTTR Report', rangeLabel(range.days)]));
  lines.push(csvRow(['Scope', isSuperAdmin(req.user) ? 'All tickets' : 'Tickets assigned to me']));
  lines.push(csvRow(['Generated', new Date(now).toISOString()]));
  lines.push('');
  lines.push(csvRow(['Metric', 'Value']));
  lines.push(csvRow(['Resolved tickets', s.count]));
  lines.push(csvRow(['Mean time to resolve (minutes)', fmtNum(s.meanMinutes)]));
  lines.push(csvRow(['Median time to resolve (minutes)', fmtNum(s.medianMinutes)]));
  lines.push(csvRow(['Fastest resolution (minutes)', fmtNum(s.minMinutes)]));
  lines.push(csvRow(['Slowest resolution (minutes)', fmtNum(s.maxMinutes)]));
  lines.push(csvRow(['Mean first response (minutes)', fmtNum(s.meanFirstResponseMinutes)]));
  lines.push(csvRow(['Reopened after resolution', s.reopenedCount]));
  lines.push('');
  lines.push(csvRow(['Ticket ID', 'Title', 'Status', 'Category', 'Priority', 'Agent', 'Created at', 'First response at', 'Resolved at', 'Closed at', 'Time to resolve (minutes)', 'First response (minutes)', 'Reopened count']));
  rows.forEach((r) => lines.push(csvRow([
    r.id, r.title, r.status, r.category, r.priority, r.agentName,
    r.createdAt, r.firstResponseAt, r.resolvedAt, r.closedAt,
    fmtNum(r.minutes), fmtNum(r.firstResponseMinutes), r.reopenedCount,
  ])));

  sendCsv(res, `mttr-report-${range.raw}-${exportDate()}.csv`, lines);
});

// ---- IT asset reports -----------------------------------------------------
//
// Three stock states, one rule each:
//   In Stock     — on the store-room shelf, above its reorder level
//   Low Stock    — on the shelf but at/below its reorder level (running out)
//   Out of Stock — shelf empty (quantity 0) or simply not in the store room
//                  (Assigned, In Repair, Retired, …)
// The exact status is always reported alongside the split so retired gear is
// never confused with deployed gear.
const STOCK_COUNT_MAX = 1000000;

// Accepts 0..1000000 whole numbers, or null/''/undefined (= unset). Anything
// else is a 400 — a bad stock count must never be silently stored.
const parseStockCount = (v) => {
  if (v === undefined || v === null || v === '') return { unset: true };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > STOCK_COUNT_MAX) {
    return { error: `must be a whole number between 0 and ${STOCK_COUNT_MAX}` };
  }
  return { value: n };
};

const itemQuantity = (i) => (Number.isInteger(i.quantity) && i.quantity >= 0 ? i.quantity : 1);
const itemReorderLevel = (i) =>
  Number.isInteger(i.reorder_level) && i.reorder_level >= 0 ? i.reorder_level : null;

const stockStateOf = (item) => {
  if (item.status !== 'In Stock') return 'Out of Stock';
  const qty = itemQuantity(item);
  if (qty <= 0) return 'Out of Stock';
  const level = itemReorderLevel(item);
  return level !== null && qty <= level ? 'Low Stock' : 'In Stock';
};

// "Running out of stock" — the restock watchlist: store-room lines at/below
// their reorder level, or with an empty shelf. Deployed, repaired or retired
// gear is NOT a restock alert; it is simply not on the shelf.
const needsRestock = (item) =>
  item.status === 'In Stock'
  && (itemQuantity(item) <= 0
    || (itemReorderLevel(item) !== null && itemQuantity(item) <= itemReorderLevel(item)));

// The stock fields every inventory response carries — computed server-side so
// the UI, the report and the CSV can never disagree about what "low" means.
const decorateAsset = (i) => ({
  ...i,
  quantity: itemQuantity(i),
  reorder_level: itemReorderLevel(i),
  stock_state: stockStateOf(i),
  needs_restock: needsRestock(i),
});

const buildAssetReport = (items) => {
  const rows = items.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category || 'Other',
    serial: i.serial_number,
    assignedTo: i.assigned_to || 'Unassigned',
    status: i.status || 'In Stock',
    quantity: itemQuantity(i),
    reorderLevel: itemReorderLevel(i),
    stockState: stockStateOf(i),
    needsRestock: needsRestock(i),
  }));

  const inStock = rows.filter((r) => r.stockState === 'In Stock').length;
  const lowStock = rows.filter((r) => r.stockState === 'Low Stock').length;
  const byCategory = new Map();
  rows.forEach((r) => {
    const g = byCategory.get(r.category) || { key: r.category, total: 0, inStock: 0, lowStock: 0, outOfStock: 0 };
    g.total += 1;
    if (r.stockState === 'In Stock') g.inStock += 1;
    else if (r.stockState === 'Low Stock') g.lowStock += 1;
    else g.outOfStock += 1;
    byCategory.set(r.category, g);
  });
  const byStatus = new Map();
  rows.forEach((r) => byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      inStock,
      lowStock,
      outOfStock: rows.length - inStock - lowStock,
    },
    // The actionable list: everything that should be reordered now.
    restockList: rows
      .filter((r) => r.needsRestock)
      .sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name))
      .map(({ id, name, category, quantity, reorderLevel, stockState }) => ({ id, name, category, quantity, reorderLevel, stockState })),
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)),
    byStatus: [...byStatus.entries()].map(([key, count]) => ({ key, count, stockState: stockStateOf({ status: key }) }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    rows,
  };
};

// GET /api/reports/assets — the IT asset stock report (all agents see the
// whole inventory, same as /api/inventory).
app.get('/api/reports/assets', requireAgent, (req, res) => {
  res.json(buildAssetReport(inventory));
});

// GET /api/reports/assets/export — the asset report as a CSV download: a
// summary block (totals and the in/low/out-of-stock split per category), the
// restock watchlist, then one row per asset with quantities and stock state.
app.get('/api/reports/assets/export', requireAgent, (req, res) => {
  const report = buildAssetReport(inventory);
  const lines = [];
  lines.push(csvRow(['IT Asset Report']));
  lines.push(csvRow(['Generated', report.generatedAt]));
  lines.push('');
  lines.push(csvRow(['Metric', 'Value']));
  lines.push(csvRow(['Total assets', report.summary.total]));
  lines.push(csvRow(['In stock', report.summary.inStock]));
  lines.push(csvRow(['Low stock (at/below reorder level)', report.summary.lowStock]));
  lines.push(csvRow(['Out of stock', report.summary.outOfStock]));
  lines.push('');
  lines.push(csvRow(['Restock watchlist (running out or empty)']));
  lines.push(csvRow(['Asset', 'Category', 'Quantity on hand', 'Reorder level', 'Stock state']));
  if (report.restockList.length === 0) lines.push(csvRow(['(nothing to reorder)']));
  report.restockList.forEach((r) => lines.push(csvRow([r.name, r.category, r.quantity, r.reorderLevel == null ? '' : r.reorderLevel, r.stockState])));
  lines.push('');
  lines.push(csvRow(['Category', 'Total', 'In stock', 'Low stock', 'Out of stock']));
  report.byCategory.forEach((c) => lines.push(csvRow([c.key, c.total, c.inStock, c.lowStock, c.outOfStock])));
  lines.push('');
  lines.push(csvRow(['Status', 'Count', 'Stock state']));
  report.byStatus.forEach((s) => lines.push(csvRow([s.key, s.count, s.stockState])));
  lines.push('');
  lines.push(csvRow(['Asset ID', 'Name', 'Category', 'Serial number', 'Assigned to', 'Status', 'Quantity on hand', 'Reorder level', 'Stock state']));
  report.rows.forEach((r) => lines.push(csvRow([r.id, r.name, r.category, r.serial, r.assignedTo, r.status, r.quantity, r.reorderLevel == null ? '' : r.reorderLevel, r.stockState])));

  sendCsv(res, `asset-report-${exportDate()}.csv`, lines);
});

app.get('/api/inventory', requireAgent, (req, res) => {
  res.json(inventory.map(decorateAsset));
});

// GET /api/inventory/low-stock — the restock watchlist: store-room lines that
// are running out (at/below their reorder level) or already empty. Deployed,
// repaired or retired gear is not a restock alert.
app.get('/api/inventory/low-stock', requireAgent, (req, res) => {
  const alerts = inventory
    .filter(needsRestock)
    .map(decorateAsset)
    .sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name));
  res.json({
    generatedAt: new Date().toISOString(),
    counts: {
      total: alerts.length,
      lowStock: alerts.filter((a) => a.stock_state === 'Low Stock').length,
      outOfStock: alerts.filter((a) => a.stock_state === 'Out of Stock').length,
    },
    alerts,
  });
});

app.post('/api/inventory', requireAgent, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['name', 'category', 'serial_number', 'assigned_to_id', 'assigned_to', 'status', 'quantity', 'reorder_level']);
  const missing = requireStrings(body, ['name', 'category', 'serial_number']);
  if (missing) return res.status(400).json({ error: `${missing} is required` });
  const category = String(body.category).trim();
  if (!VALID_INVENTORY_CATEGORY.has(category)) {
    return res.status(400).json({ error: `Category must be one of: ${[...VALID_INVENTORY_CATEGORY].join(', ')}` });
  }
  const serial = String(body.serial_number).trim();
  if (inventory.some((i) => String(i.serial_number).toLowerCase() === serial.toLowerCase())) {
    return res.status(400).json({ error: 'An asset with this serial number already exists' });
  }
  // A status the API doesn't know is now an explicit 400. It used to fall
  // through to 'In Stock', so picking "Under Maintenance" on the Add Asset
  // form saved the asset as "In Stock" without a word (#33).
  if (body.status !== undefined && !VALID_INVENTORY_STATUS.has(body.status)) {
    return res.status(400).json({ error: `Status must be one of: ${[...VALID_INVENTORY_STATUS].join(', ')}` });
  }
  // Stock tracking: quantity defaults to a single unit; the reorder level is
  // optional (null = no low-stock alerting for this line).
  const qty = parseStockCount(body.quantity);
  if (qty.error) return res.status(400).json({ error: `Quantity ${qty.error}` });
  const level = parseStockCount(body.reorder_level);
  if (level.error) return res.status(400).json({ error: `Low-stock alert level ${level.error}` });
  const requested = body.assigned_to_id !== undefined ? body.assigned_to_id : body.assigned_to;
  const assignee = resolveAssignee(requested);
  if (assignee.error) return res.status(400).json({ error: assignee.error });
  const newItem = {
    id: genId('asset-'),
    name: String(body.name).trim(),
    category,
    serial_number: serial,
    assigned_to_id: assignee.id || null,
    assigned_to: displayNameForId(assignee.id),
    status: body.status || 'In Stock',
    quantity: qty.unset ? 1 : qty.value,
    reorder_level: level.unset ? null : level.value,
  };
  inventory.unshift(newItem);
  saveData();
  // Decorated so callers immediately see the stock state their numbers imply.
  res.json(decorateAsset(newItem));
});

app.patch('/api/inventory/:id', requireAgent, writeRateLimit, (req, res) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  // #8 mass-assignment fix: explicit allow-list — id can never be overwritten.
  const body = pick(req.body, ['name', 'category', 'serial_number', 'assigned_to_id', 'assigned_to', 'status', 'quantity', 'reorder_level']);
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
    item.name = n;
  }
  if (body.category !== undefined) {
    // Same contract as ticket categories: an unknown value is a 400, never
    // silently stored (#asset-categories).
    const cat = String(body.category).trim();
    if (!VALID_INVENTORY_CATEGORY.has(cat)) {
      return res.status(400).json({ error: `Category must be one of: ${[...VALID_INVENTORY_CATEGORY].join(', ')}` });
    }
    item.category = cat;
  }
  if (body.serial_number !== undefined) {
    const s = String(body.serial_number).trim();
    if (!s) return res.status(400).json({ error: 'Serial number cannot be empty' });
    if (s.toLowerCase() !== String(item.serial_number).toLowerCase()
        && inventory.some((i) => i.id !== item.id && String(i.serial_number).toLowerCase() === s.toLowerCase())) {
      return res.status(400).json({ error: 'An asset with this serial number already exists' });
    }
    item.serial_number = s;
  }
  if (body.status !== undefined) {
    if (!VALID_INVENTORY_STATUS.has(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${[...VALID_INVENTORY_STATUS].join(', ')}` });
    }
    item.status = body.status;
    if (body.status !== 'Assigned') setAssignee(item, null);
  }
  // Stock tracking: quick quantity adjustments (−/+) and reorder-level edits
  // come through here. An empty reorder_level clears the alerting (null).
  if (body.quantity !== undefined) {
    const qty = parseStockCount(body.quantity);
    if (qty.error) return res.status(400).json({ error: `Quantity ${qty.error}` });
    item.quantity = qty.unset ? 1 : qty.value;
  }
  if (body.reorder_level !== undefined) {
    const level = parseStockCount(body.reorder_level);
    if (level.error) return res.status(400).json({ error: `Low-stock alert level ${level.error}` });
    item.reorder_level = level.unset ? null : level.value;
  }
  if (body.assigned_to_id !== undefined || body.assigned_to !== undefined) {
    const requested = body.assigned_to_id !== undefined ? body.assigned_to_id : body.assigned_to;
    const assignee = resolveAssignee(requested);
    if (assignee.error) return res.status(400).json({ error: assignee.error });
    setAssignee(item, assignee.id);
  }
  saveData();
  // Return the decorated row so callers immediately see the new stock state.
  res.json(decorateAsset(item));
});

app.delete('/api/inventory/:id', requireAgent, sensitiveRateLimit, (req, res) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  inventory = inventory.filter((i) => i.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

// ==================================================================
// PBX call logging (Panasonic SMDR) — REST API
//
// An IP-phone call to the IT office becomes a call record here and, per
// PBX_TICKET_POLICY, a ticket. Employees never reach these endpoints: the call
// log is operational data for the IT console.
// ==================================================================

// A busy PBX can post a record per call; the generic write limiter (60/min)
// would throttle that, so the ingestion endpoint gets its own, larger budget.
const pbxIngestRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: 'Too many call records received. If the PBX is retrying, check its SMDR configuration.',
});

const timingSafeEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/** True when the request may ingest calls: a signed-in agent, or the shared PBX token. */
const isPbxIngestAuthorized = (req) => {
  const expected = pbx.pbxConfig.token;
  const presented = req.headers['x-pbx-token'] || (req.query && req.query.token);
  if (expected && timingSafeEqual(presented, expected)) return { ok: true, actor: 'pbx-token' };
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try {
      const payload = jwt.verify(match[1].trim(), JWT_SECRET);
      const user = users.find((u) => u.id === payload.id);
      if (user && user.role === 'agent') return { ok: true, actor: user.id };
    } catch (err) { /* fall through to 401 */ }
  }
  return { ok: false };
};

// GET /api/pbx/status — is the feed up, which extensions are the IT office,
// which policy is in force, and what needs attention.
app.get('/api/pbx/status', requireAgent, (req, res) => {
  res.json(pbx.status());
});

// GET /api/pbx/calls — the call log. Scoping follows the ticket rules: a super
// admin sees every call, a regular agent their own calls plus unclaimed ones.
app.get('/api/pbx/calls', requireAgent, (req, res) => {
  const range = pbx.parseRange({ days: req.query.days === 'all' ? 'all' : (req.query.days || 'all') });
  if (range.error) return res.status(400).json({ error: range.error });
  const now = Date.now();
  const scoped = pbx.visibleCallsFor(req.user);
  let rows = pbx.filterByDays(scoped, range.days, now).map((c) => pbx.decorate(c));

  const { direction, outcome, extension, ticket, q } = req.query;
  if (direction) {
    if (!VALID_CALL_DIRECTION.has(direction)) {
      return res.status(400).json({ error: 'direction must be Incoming, Outgoing or Internal' });
    }
    rows = rows.filter((c) => c.direction === direction);
  }
  if (outcome) {
    if (!VALID_CALL_OUTCOME.has(outcome)) {
      return res.status(400).json({ error: 'outcome must be "Solved", "Not solved" or "Pending"' });
    }
    rows = rows.filter((c) => c.resolution_outcome === outcome);
  }
  if (extension) {
    const needle = String(extension).trim();
    rows = rows.filter((c) => [c.extension, c.caller_extension, c.target_extension, c.it_extension]
      .some((v) => v && String(v).includes(needle)));
  }
  if (ticket === 'yes' || ticket === 'no') {
    rows = rows.filter((c) => (ticket === 'yes' ? Boolean(c.ticket_id) : !c.ticket_id));
  }
  if (q) {
    const needle = String(q).trim().toLowerCase();
    rows = rows.filter((c) => [c.caller_label, c.caller_display_name, c.dialed_number, c.caller_number, c.notes]
      .some((v) => v && String(v).toLowerCase().includes(needle)));
  }
  res.json({
    range: { days: range.days },
    scope: isSuperAdmin(req.user) ? 'all' : 'own',
    total: rows.length,
    calls: rows,
  });
});

// POST /api/pbx/calls — the ingestion endpoint.
//
// Accepts either raw SMDR text (text/plain — what a PBX, a serial-to-IP
// gateway or `PANASONIC-` middleware can post) or JSON (a single record, an
// array of them, or `{ records: [...] }`). Authorised by the shared
// X-PBX-Token secret, or by a signed-in agent's Bearer token.
app.post(
  '/api/pbx/calls',
  pbxIngestRateLimit,
  express.text({ type: ['text/plain', 'text/csv', 'application/csv'], limit: '2mb' }),
  (req, res) => {
    const auth = isPbxIngestAuthorized(req);
    if (!auth.ok) {
      return res.status(401).json({
        error: pbx.pbxConfig.token
          ? 'Send the PBX shared secret in the X-PBX-Token header (or sign in as an IT agent).'
          : 'This endpoint needs the PBX shared secret (set PBX_TOKEN on the server) or an IT agent session.',
      });
    }
    let text = '';
    if (typeof req.body === 'string') {
      text = req.body;
    } else if (req.body && typeof req.body === 'object') {
      const payload = Array.isArray(req.body) ? req.body : (req.body.records !== undefined ? req.body.records : req.body);
      text = JSON.stringify(payload);
    } else {
      return res.status(400).json({ error: 'Send the SMDR records as text/plain or JSON.' });
    }

    // A JSON payload may be an array of records: parse each independently so
    // one bad element does not discard the batch.
    const result = (() => {
      if (text.trim().startsWith('[')) {
        let list;
        try { list = JSON.parse(text); } catch { return { parsed: 0, skipped: [{ reason: 'bad-json' }], duplicates: 0, calls: [], tickets: [] }; }
        const combined = { parsed: 0, skipped: [], duplicates: 0, calls: [], tickets: [] };
        list.forEach((item) => {
          const one = pbx.ingestText(JSON.stringify(item), { source: 'webhook' });
          combined.parsed += one.parsed;
          combined.skipped.push(...one.skipped);
          combined.duplicates += one.duplicates;
          combined.calls.push(...one.calls);
          combined.tickets.push(...one.tickets);
        });
        return combined;
      }
      return pbx.ingestText(text, { source: 'webhook' });
    })();

    if (!result.parsed && result.skipped.length) {
      return res.status(400).json({
        error: 'No usable SMDR records in that payload.',
        skipped: result.skipped,
        hint: 'POST one record per line (text/plain). Use POST /api/pbx/parse to test a sample first.',
      });
    }
    res.status(202).json({
      accepted: true,
      actor: auth.actor,
      parsed: result.parsed,
      duplicates: result.duplicates,
      skipped: result.skipped,
      callIds: result.calls,
      ticketIds: result.tickets,
    });
  }
);

// POST /api/pbx/calls/manual — log a call by hand (phone rang while the feed
// was down, or a site where SMDR is not wired yet).
app.post('/api/pbx/calls/manual', requireAgent, writeRateLimit, (req, res) => {
  const body = pick(req.body, [
    'extension', 'direction', 'call_at', 'time', 'duration', 'duration_seconds',
    'dialed_number', 'caller_number', 'ring_seconds', 'condition_code', 'notes', 'answered',
  ]);
  const result = pbx.logManualCall(body, { source: 'manual' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ call: pbx.decorate(result.call), ticket: result.ticket || null, duplicate: result.duplicate });
});

// POST /api/pbx/calls/simulate — push a realistic SMDR record through the real
// pipeline, so the wiring (and this feature) can be demonstrated before the
// PBX is connected. Development feature: off in production unless
// PBX_ALLOW_SIMULATOR=true.
app.post('/api/pbx/calls/simulate', requireAgent, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['extension', 'direction', 'seconds', 'ring', 'answered', 'dialed_number', 'caller_number']);
  const result = pbx.simulateCall(body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({
    call: pbx.decorate(result.call),
    ticket: result.ticket || null,
    raw: result.raw,
  });
});

// POST /api/pbx/parse — dry run: paste raw SMDR lines and see exactly what the
// helpdesk would make of them. Nothing is stored. This is how a site tunes
// PBX_* settings without flooding the call log.
app.post('/api/pbx/parse', requireAgent, writeRateLimit, express.text({ type: ['text/plain', 'text/csv'], limit: '1mb' }), (req, res) => {
  // Raw SMDR as text/plain (what the console sends), or `{ text }` / `{ lines }`
  // / a single JSON record for scripts.
  const body = typeof req.body === 'string'
    ? req.body
    : (req.body && typeof req.body === 'object'
      ? (typeof req.body.text === 'string' ? req.body.text
        : Array.isArray(req.body.lines) ? req.body.lines.join('\n')
          : JSON.stringify(req.body))
      : '');
  if (!body.trim()) return res.status(400).json({ error: 'Paste at least one raw SMDR line.' });
  const results = pbx.parsePreview(body);
  res.json({
    model: pbx.status().model,
    itExtensions: pbx.pbxConfig.itExtensions,
    ticketPolicy: pbx.pbxConfig.ticketPolicy,
    parsed: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok).length,
    results,
  });
});

// ---- Call records: read, annotate, link, raise a ticket -------------------
const findScopedCall = (req, res) => {
  const call = pbx.getCalls().find((c) => c.id === req.params.id);
  if (!call) {
    res.status(404).json({ error: 'Call not found' });
    return null;
  }
  if (!pbx.canAccessCall(req.user, call)) {
    res.status(403).json({ error: 'This call belongs to another agent\'s ticket. Ask a super admin to reassign it if you need access.' });
    return null;
  }
  return call;
};

app.get('/api/pbx/calls/:id', requireAgent, (req, res) => {
  const call = findScopedCall(req, res);
  if (!call) return;
  res.json(pbx.decorate(call));
});

// PATCH /api/pbx/calls/:id — notes, the caller's extension (to attribute the
// ticket to the right employee), and the solved / not-solved state.
app.patch('/api/pbx/calls/:id', requireAgent, writeRateLimit, (req, res) => {
  const call = findScopedCall(req, res);
  if (!call) return;
  const body = pick(req.body, ['issue_resolved', 'notes', 'caller_extension', 'direction', 'duration_seconds', 'ticket_id']);

  if (body.ticket_id !== undefined) {
    const linked = pbx.linkTicket(call, body.ticket_id);
    if (linked.error) return res.status(400).json({ error: linked.error });
  }
  if (body.issue_resolved !== undefined) {
    const resolved = pbx.setCallResolved(call, body.issue_resolved, req.user.name);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
  }
  const rest = pick(body, ['notes', 'caller_extension', 'direction', 'duration_seconds']);
  if (Object.keys(rest).length) {
    const updated = pbx.updateCall(call, rest);
    if (updated.error) return res.status(400).json({ error: updated.error });
  }
  res.json(pbx.decorate(call));
});

// POST /api/pbx/calls/:id/ticket — raise the ticket for a call (used when the
// policy skipped it, or when the PBX record arrived before the extension was
// mapped to an employee).
app.post('/api/pbx/calls/:id/ticket', requireAgent, writeRateLimit, (req, res) => {
  const call = findScopedCall(req, res);
  if (!call) return;
  const result = pbx.createTicketForCall(call, { force: true });
  if (result.error) return res.status(400).json({ error: result.error });
  notifyTicketChanged(result.ticket);
  res.json({ call: pbx.decorate(result.call), ticket: result.ticket });
});

// ---- Extension directory (which extension belongs to whom) ----------------
// Agents read it (the call log shows names); only a super admin edits it,
// because it decides whose account a phone-raised ticket is filed under.
app.get('/api/pbx/extensions', requireAgent, (req, res) => {
  res.json(pbx.listDirectory());
});

app.post('/api/pbx/extensions', requireSuperAdmin, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['extension', 'user_id', 'name', 'department', 'note']);
  const result = pbx.upsertDirectoryEntry(body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(pbx.listDirectory().find((e) => e.id === result.entry.id));
});

app.patch('/api/pbx/extensions/:id', requireSuperAdmin, writeRateLimit, (req, res) => {
  const body = pick(req.body, ['extension', 'user_id', 'name', 'department', 'note']);
  const result = pbx.upsertDirectoryEntry({ id: req.params.id, ...body });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(pbx.listDirectory().find((e) => e.id === result.entry.id));
});

app.delete('/api/pbx/extensions/:id', requireSuperAdmin, sensitiveRateLimit, (req, res) => {
  const result = pbx.deleteDirectoryEntry(req.params.id);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json({ success: true });
});

// ---- Call reports ---------------------------------------------------------
app.get('/api/reports/calls', requireAgent, (req, res) => {
  const range = pbx.parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const report = pbx.buildCallReport(pbx.visibleCallsFor(req.user), { days: range.days, now: Date.now() });
  report.scope = isSuperAdmin(req.user) ? 'all' : 'own';
  report.range.label = rangeLabel(range.days);
  res.json(report);
});

// CSV export: summary block, per-day and per-extension splits, then one row
// per call — the same shape as the MTTR and asset exports.
app.get('/api/reports/calls/export', requireAgent, (req, res) => {
  const range = pbx.parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });
  const report = pbx.buildCallReport(pbx.visibleCallsFor(req.user), { days: range.days, now: Date.now() });
  const s = report.summary;

  const lines = [];
  lines.push(csvRow(['PBX Call Report', rangeLabel(range.days)]));
  lines.push(csvRow(['PBX', report.model]));
  lines.push(csvRow(['Scope', isSuperAdmin(req.user) ? 'All calls' : 'My calls and unclaimed calls']));
  lines.push(csvRow(['IT office extensions', report.itExtensions.join(' ') || 'not configured']));
  lines.push(csvRow(['Ticket policy', report.ticketPolicy]));
  lines.push(csvRow(['Generated', report.generatedAt]));
  lines.push('');
  lines.push(csvRow(['Metric', 'Value']));
  lines.push(csvRow(['Calls logged', s.total]));
  lines.push(csvRow(['Calls involving the IT office', s.helpdeskCalls]));
  lines.push(csvRow(['Incoming', s.incoming]));
  lines.push(csvRow(['Outgoing', s.outgoing]));
  lines.push(csvRow(['Internal', s.internal]));
  lines.push(csvRow(['Answered', s.answered]));
  lines.push(csvRow(['Not answered', s.missed]));
  lines.push(csvRow(['Total talk time (seconds)', s.totalTalkSeconds]));
  lines.push(csvRow(['Average call duration (seconds)', fmtNum(s.avgDurationSeconds)]));
  lines.push(csvRow(['Median call duration (seconds)', fmtNum(s.medianDurationSeconds)]));
  lines.push(csvRow(['Calls with a ticket', s.ticketed]));
  lines.push(csvRow(['Calls without a ticket', s.unticketed]));
  lines.push(csvRow(['Issue solved', s.solved]));
  lines.push(csvRow(['Issue not solved', s.unsolved]));
  lines.push(csvRow(['Still pending', s.pending]));
  lines.push(csvRow(['Solve rate (%)', fmtNum(s.solveRatePercent)]));
  lines.push(csvRow(['Average phone-call-to-fix (minutes)', fmtNum(s.meanMinutesToSolve)]));
  lines.push('');
  lines.push(csvRow(['Calls per day', 'Calls', 'Solved', 'Not answered', 'Average duration (seconds)']));
  report.byDay.forEach((d) => lines.push(csvRow([d.key, d.calls, d.solved, d.missed, fmtNum(d.avgDurationSeconds)])));
  lines.push('');
  lines.push(csvRow(['Extension', 'Name', 'Calls', 'Solved', 'Not solved', 'Average duration (seconds)']));
  report.byExtension.forEach((e) => lines.push(csvRow([e.key, e.name, e.calls, e.solved, e.unsolved, fmtNum(e.avgDurationSeconds)])));
  lines.push('');
  lines.push(csvRow([
    'Call ID', 'Call time', 'Day', 'Time', 'Direction', 'Extension', 'Caller', 'Target extension',
    'Trunk', 'Dialed number', 'Caller number', 'Ring (s)', 'Duration (s)', 'Answered', 'Condition code',
    'IT office call', 'Ticket ID', 'Ticket status', 'Issue solved', 'Resolved at', 'Minutes to solve', 'Notes', 'Raw record',
  ]));
  report.rows.forEach((r) => lines.push(csvRow([
    r.id, r.call_at, r.call_day, r.call_time, r.direction, r.extension, r.caller_display_name || r.caller_name || '',
    r.target_extension, r.trunk, r.dialed_number, r.caller_number,
    fmtNum(r.ring_seconds), fmtNum(r.duration_seconds),
    r.answered === true ? 'Yes' : r.answered === false ? 'No' : '',
    r.condition_code, r.is_helpdesk_call ? 'Yes' : 'No', r.ticket_id, r.ticket_status,
    r.resolution_outcome, r.resolved_at, fmtNum(r.resolution_minutes), r.notes, r.raw,
  ])));

  sendCsv(res, `call-report-${range.raw}-${exportDate()}.csv`, lines);
});

// 404 JSON handler for any unmatched /api route (#24).
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.path}` });
});

// Error middleware — never leak stack traces, always send JSON.
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// Attach the verified session user to each socket.
io.use((socket, next) => {
  socket.user = null;
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (typeof token === 'string' && token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = users.find((u) => u.id === payload.id);
      if (user) socket.user = { id: user.id, name: user.name, role: user.role, super_admin: isSuperAdmin(user) };
    } catch (err) {
      // Stays unauthenticated — handlers below will ignore its emits.
    }
  }
  next();
});

// Give every session the rooms it is entitled to (#36): employees follow the
// tickets they raised, agents the ones assigned to them, super admins all of
// them. Without this, per-ticket chat messages were broadcast to every agent
// socket regardless of who the ticket belonged to.
const syncTicketRooms = (socket) => {
  if (!socket.user) return;
  const member = users.find((u) => u.id === socket.user.id);
  if (!member) return;
  if (isSuperAdmin(member)) socket.join('role_super_admin');
  else socket.leave('role_super_admin');
  // Everyone in the IT console joins the agent room: it carries queue-level
  // notifications that are not tied to one ticket (a new call logged from the
  // PBX), never ticket or call details.
  socket.join('role_agent');
  // Reassignment moves a ticket between agents: re-derive the rooms from
  // scratch so nobody keeps receiving a queue that is no longer theirs.
  const allowed = new Set(visibleTicketsFor(member).map((t) => `ticket_${t.id}`));
  for (const room of socket.rooms) {
    if (room.startsWith('ticket_') && !allowed.has(room)) socket.leave(room);
  }
  allowed.forEach((room) => socket.join(room));
};

// Called after a reassignment so the socket identity and rooms follow the
// change immediately (promotions/demotions included).
const resyncUserSockets = (userId) => {
  io.sockets.sockets.forEach((socket) => {
    if (!socket.user || socket.user.id !== userId) return;
    const fresh = users.find((u) => u.id === userId);
    if (fresh) {
      socket.user = { id: fresh.id, name: fresh.name, role: fresh.role, super_admin: isSuperAdmin(fresh) };
    }
    syncTicketRooms(socket);
  });
};

// Tell only the sessions entitled to a ticket that it changed, so agents'
// queues update on assignment/status changes without leaking other queues.
const notifyTicketChanged = (ticket) => {
  const room = `ticket_${ticket.id}`;
  const seeing = users.filter((u) => u.role === 'agent'
    && (isSuperAdmin(u) || u.id === ticket.assigned_to_id));
  const reporterSocket = users.find((u) => u.id === ticket.created_by);
  io.to(room).emit('ticket_changed', { ticketId: ticket.id });
  io.sockets.sockets.forEach((socket) => {
    if (!socket.user) return;
    const u = users.find((x) => x.id === socket.user.id);
    if (!u) return;
    const maySee = isSuperAdmin(u)
      || (u.role === 'agent' && ticket.assigned_to_id === u.id)
      || ticket.created_by === u.id;
    if (!maySee) return;
    if (seeing.some((a) => a.id === u.id) || (reporterSocket && reporterSocket.id === u.id)) {
      socket.emit('ticket_changed', { ticketId: ticket.id });
    }
  });
};

io.on('connection', (socket) => {
  syncTicketRooms(socket);
  // Per-socket message rate-limit (#7) so one client can't spam everyone.
  let socketMsgCount = 0;
  let socketMsgWindow = Date.now();
  const socketAllowed = () => {
    const now = Date.now();
    if (now - socketMsgWindow > 10_000) { socketMsgWindow = now; socketMsgCount = 0; }
    socketMsgCount += 1;
    return socketMsgCount <= 20; // 20 messages / 10s per socket
  };

  socket.on('send_message', (data) => {
    if (!socket.user) return;
    if (!socketAllowed()) return;
    if (!data || typeof data !== 'object' || !String(data.text || '').trim()) return;
    if (String(data.text).length > 2000) return;
    io.emit('receive_message', {
      id: genId('msg-'),
      sender: socket.user.role === 'agent' ? 'agent' : 'user',
      senderName: socket.user.name,
      text: String(data.text).trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });

  socket.on('join_ticket', (ticketId) => {
    if (ticketId === undefined || ticketId === null) return;
    if (!canAccessTicket(socket.user, ticketId)) return;
    socket.join(`ticket_${ticketId}`);
  });
  socket.on('leave_ticket', (ticketId) => {
    if (ticketId === undefined || ticketId === null) return;
    socket.leave(`ticket_${ticketId}`);
  });
  socket.on('send_ticket_message', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user) return;
    if (!socketAllowed()) return;
    if (!canAccessTicket(socket.user, data.ticketId)) return;
    const result = appendTicketMessage(
      data.ticketId,
      socket.user.role === 'agent' ? 'agent' : 'user',
      socket.user.name,
      data.text
    );
    if (!result) return;
    io.to(`ticket_${result.ticket.id}`).emit('receive_ticket_message', {
      ticketId: result.ticket.id,
      message: result.message,
    });
    notifyTicketChanged(result.ticket);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection (server kept alive):', reason);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  // Start reading call records only after the HTTP server is up, so a PBX that
  // is slow to answer can never delay boot. No-op unless PBX_ENABLED=true.
  const pbxState = pbx.start();
  if (pbxState && pbxState.status !== 'disabled') {
    console.log(`[PBX] SMDR transport: ${pbxState.status} — ${pbxState.detail}`);
  }
  if (pbx.pbxConfig.enabled && pbx.pbxConfig.allowSimulator) {
    console.log('[PBX] Call simulator is available (Agent Console → Call Log → Simulate call).');
  }
});

// A second `npm start` used to die with a raw EADDRINUSE stack trace, which
// reads like a code fault rather than "you already have a server running".
// Recovered from the stale arena/01a08b5a branch before it was deleted.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[FATAL] Port ${PORT} is already in use — another copy of the backend is probably still running.`);
    console.error('        Stop the other process, then start the server again:');
    console.error(`          Windows (PowerShell):  Get-Process node | Stop-Process -Force`);
    console.error(`          macOS/Linux:           lsof -ti:${PORT} | xargs kill -9`);
    console.error('        Or start this copy on a different port:  PORT=5001 npm start\n');
    process.exit(1);
  }
  if (err && err.code === 'EACCES') {
    console.error(`\n[FATAL] Not allowed to bind port ${PORT}. Ports below 1024 need elevated privileges.`);
    console.error('        Set PORT to a value above 1024 in backend/.env and try again.\n');
    process.exit(1);
  }
  console.error('[FATAL] Server error:', err);
  process.exit(1);
});
