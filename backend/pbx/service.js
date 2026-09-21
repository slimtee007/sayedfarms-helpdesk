/**
 * Call logging & call-to-ticket service for the Panasonic PBX.
 *
 * Responsibilities:
 *   - take SMDR records (from the TCP feeds, the webhook, manual entry or the
 *     built-in simulator) and store them as *calls*;
 *   - raise a helpdesk ticket for the calls the IT office cares about, with the
 *     call time, ring time, talk time and direction already recorded;
 *   - keep the two in step both ways: resolving the ticket marks the call's
 *     issue solved (with the time from the phone call to the fix), and an agent
 *     can state "solved / not solved" on the call itself for issues fixed while
 *     the phone was still in their hand;
 *   - aggregate the call log into the Call Reports feed.
 *
 * Everything stateful lives here (calls + the extension directory) and is
 * persisted through the `saveData` callback the server injects, so `db.json`
 * stays the single source of truth and nothing else has to know the shape of a
 * call record.
 */

'use strict';

const crypto = require('crypto');
const { parseCapture, parseSmdrLine, formatSeconds, durationTokenToSeconds } = require('./smdr');
const { pbxConfig } = require('./config');

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
/** Injected by server.js so this module never re-implements ticket creation. */
let deps = null;
let calls = [];
let extensions = [];

const stats = {
  startedAt: new Date().toISOString(),
  recordsReceived: 0,
  recordsStored: 0,
  duplicatesMerged: 0,
  ticketsRaised: 0,
  lastRecordAt: null,
  lastCall: null,
  unparsed: [],
  warnings: [],
};

const nowIso = () => new Date().toISOString();
const minutesBetween = (fromIso, toIso) => {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round(((to - from) / 60000) * 10) / 10;
};
const digest = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
const isSuperAdminUser = (u) => Boolean(u && u.role === 'agent' && u.super_admin === true);
const users = () => (deps && deps.getUsers ? deps.getUsers() : []);
const tickets = () => (deps && deps.getTickets ? deps.getTickets() : []);
const config = () => pbxConfig;

const loadData = (db) => {
  calls = Array.isArray(db && db.calls) ? db.calls : [];
  extensions = Array.isArray(db && db.extensions) ? db.extensions : [];
  stats.warnings = calls.filter((c) => c.unparsed_reason).length
    ? [`${calls.length} stored call(s) were imported from an older database.`]
    : [];
};

const setDeps = (injected) => { deps = injected; };
const getCalls = () => calls;
const getExtensions = () => extensions;
const save = () => { if (deps && deps.saveData) deps.saveData(); };

// ------------------------------------------------------------------
// Extension directory — which extension belongs to whom
// ------------------------------------------------------------------
const resolveDirectoryEntry = (extension) => {
  const ext = String(extension || '').trim();
  if (!ext) return null;
  return extensions.find((e) => e.extension === ext) || null;
};

/** Directory entry + the live account it points at (renames/deletes followed). */
const resolveExtension = (extension) => {
  const entry = resolveDirectoryEntry(extension);
  if (!entry) return null;
  const user = entry.user_id ? users().find((u) => u.id === entry.user_id) : null;
  return {
    ...entry,
    user_name: user ? user.name : (entry.name || ''),
    user_email: user ? user.email : '',
    user_role: user ? user.role : null,
  };
};

const displayNameForExtension = (extension) => {
  const entry = resolveExtension(extension);
  if (!entry) return '';
  return entry.user_name || entry.name || '';
};

const listDirectory = () => extensions
  .map((e) => {
    const resolved = resolveExtension(e.extension);
    return {
      id: e.id,
      extension: e.extension,
      user_id: e.user_id || null,
      name: e.name || '',
      department: e.department || '',
      note: e.note || '',
      user_name: resolved ? resolved.user_name : '',
      user_email: resolved ? resolved.user_email : '',
      linked: Boolean(e.user_id && users().some((u) => u.id === e.user_id)),
      updated_at: e.updated_at || e.created_at || null,
    };
  })
  .sort((a, b) => String(a.extension).localeCompare(String(b.extension), undefined, { numeric: true }));

const EXTENSION_RE = /^[*#]?\d{1,8}$/;

const upsertDirectoryEntry = ({ id, extension, user_id, name, department, note }) => {
  const target = id ? extensions.find((e) => e.id === id) : null;
  if (id && !target) return { error: 'Extension not found.' };

  let ext = target ? target.extension : '';
  if (extension !== undefined) {
    const clean = String(extension || '').trim().replace(/^0+(?=\d)/, '') || String(extension || '').trim();
    if (!EXTENSION_RE.test(clean)) {
      return { error: 'Extension must be the PBX number (up to 8 digits, e.g. 204).' };
    }
    const clash = extensions.find((e) => e.extension === clean && e.id !== (target && target.id));
    if (clash) {
      return { error: `Extension ${clean} is already in the directory. Edit that entry instead.` };
    }
    ext = clean;
  }
  if (!ext) return { error: 'Extension is required.' };

  let userId = target ? target.user_id || null : null;
  if (user_id !== undefined) {
    if (user_id === null || user_id === '') {
      userId = null;
    } else {
      const user = users().find((u) => u.id === user_id);
      if (!user) return { error: 'That account no longer exists. Pick someone from the directory.' };
      userId = user.id;
    }
  }

  const trimmedName = name !== undefined ? String(name || '').trim().slice(0, 100) : (target ? target.name || '' : '');
  const trimmedDept = department !== undefined ? String(department || '').trim().slice(0, 100) : (target ? target.department || '' : '');
  const trimmedNote = note !== undefined ? String(note || '').trim().slice(0, 300) : (target ? target.note || '' : '');

  if (target) {
    target.extension = ext;
    target.user_id = userId;
    target.name = trimmedName;
    target.department = trimmedDept;
    target.note = trimmedNote;
    target.updated_at = nowIso();
    save();
    return { entry: target };
  }

  const entry = {
    id: deps.genId('ext-'),
    extension: ext,
    user_id: userId,
    name: trimmedName,
    department: trimmedDept,
    note: trimmedNote,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  extensions.push(entry);
  save();
  return { entry };
};

const deleteDirectoryEntry = (id) => {
  const idx = extensions.findIndex((e) => e.id === id);
  if (idx === -1) return { error: 'Extension not found.' };
  const [removed] = extensions.splice(idx, 1);
  save();
  return { entry: removed };
};

// ------------------------------------------------------------------
// Call classification
// ------------------------------------------------------------------
const normaliseNumber = (value) => String(value == null ? '' : value).trim();

const isHelpdeskExtension = (ext) => Boolean(ext) && pbxConfig.itExtensions.includes(normaliseNumber(ext));

/**
 * Work out who called whom, whether the IT office was involved, and which
 * employee account the call belongs to (when the extension directory knows).
 */
const classifyCall = (record) => {
  const cfg = pbxConfig;
  const direction = record.direction || 'Incoming';
  const ext = normaliseNumber(record.extension);
  const dialed = normaliseNumber(record.dialed_number);
  const callerNumber = normaliseNumber(record.caller_number);

  // For an inbound call Panasonic prints the *answered* extension (the IT
  // desk); for an internal call it prints the calling extension with the
  // called one in the Dial Number column; for an outbound call the Ext column
  // is the extension that dialled out.
  const involved = [ext, dialed, callerNumber].filter(Boolean);
  const itExtension = involved.find((x) => cfg.itExtensions.includes(x)) || '';
  const ticketingDisabled = cfg.ticketPolicy === 'off';
  const isHelpdeskCall = cfg.itExtensions.length
    ? Boolean(itExtension)
    : (cfg.ticketAllCalls === true && !ticketingDisabled);

  const callerExtension = direction === 'Internal'
    ? ext
    : direction === 'Outgoing'
      ? ext
      : (callerNumber && callerNumber.length <= 6 ? callerNumber : '');

  const targetExtension = direction === 'Internal'
    ? dialed
    : (direction === 'Incoming' ? ext : dialed);

  // Attribution: the person who phoned in. Never attribute a call to whoever
  // sits at the IT desk (that would file their own ticket as an employee
  // request), and never invent an identity for an external caller.
  let attributedUserId = null;
  let attributedName = '';
  if (callerExtension && !cfg.itExtensions.includes(callerExtension)) {
    const entry = resolveExtension(callerExtension);
    if (entry && entry.user_id) {
      attributedUserId = entry.user_id;
      attributedName = entry.user_name || '';
    } else if (entry) {
      attributedName = entry.user_name || entry.name || '';
    }
  }

  return {
    direction,
    it_extension: itExtension,
    is_helpdesk_call: isHelpdeskCall,
    caller_extension: callerExtension,
    target_extension: targetExtension,
    caller_name: attributedName,
    caller_user_id: attributedUserId,
    ticketable: isHelpdeskCall && !ticketingDisabled && cfg.itExtensions.length > 0,
  };
};

/** Remember the last few problems worth showing an admin (never to a client). */
const warn = (message) => {
  if (!message) return;
  stats.warnings = [message, ...stats.warnings.filter((w) => w !== message)].slice(0, 5);
};

const applyRetention = () => {
  const max = pbxConfig.retainCalls;
  if (calls.length > max) {
    const dropped = calls.length - max;
    calls.splice(max, dropped);
    warn(`Retention: dropped the ${dropped} oldest call record(s) (PBX_RETAIN_CALLS=${max}).`);
  }
};

const describeCall = (call) => {
  const who = call.caller_name || (call.caller_extension ? `Ext ${call.caller_extension}` : '')
    || call.caller_number || 'external caller';
  return `${call.direction} call — ${who}`;
};

/**
 * Store one parsed SMDR record.
 *
 * De-duplication keeps the log honest when the PBX resends a buffer after a
 * reconnect, and merges the two records Panasonic prints for a single internal
 * call (one per extension involved) into one logical call.
 */
const ingestRecord = (record, { source = 'smdr' } = {}) => {
  stats.recordsReceived += 1;
  const classification = classifyCall(record);

  const key = digest(
    record.call_day, record.call_time, record.extension, record.trunk,
    record.dialed_number, record.duration_seconds, record.condition_code
  );
  if (calls.some((c) => c.dedupe_key === key)) {
    stats.duplicatesMerged += 1;
    return { duplicate: true, reason: 'already logged' };
  }

  // Internal call printed twice (Ext 210 -> 204 and 204 -> 210): merge.
  if (record.direction === 'Internal' && record.extension && record.dialed_number) {
    const windowMs = pbxConfig.intercomDedupeWindowSeconds * 1000;
    const at = Date.parse(record.call_at);
    const twin = calls.find((c) => c.direction === 'Internal'
      && c.extension === record.dialed_number
      && c.dialed_number === record.extension
      && Math.abs(Date.parse(c.call_at) - at) <= windowMs);
    if (twin) {
      stats.duplicatesMerged += 1;
      twin.mirrored_records = (twin.mirrored_records || 1) + 1;
      if (record.duration_seconds != null) {
        twin.duration_seconds = Math.max(twin.duration_seconds || 0, record.duration_seconds);
      }
      twin.raw_extra = [...(Array.isArray(twin.raw_extra) ? twin.raw_extra : []), record.raw].slice(-5);
      save();
      return { duplicate: true, reason: 'merged with the mirrored intercom record', call: twin };
    }
  }

  const call = {
    id: deps.genId('call-'),
    source,
    received_at: nowIso(),
    call_at: record.call_at,
    call_day: record.call_day,
    call_time: record.call_time,
    direction: classification.direction,
    extension: normaliseNumber(record.extension),
    target_extension: classification.target_extension,
    trunk: normaliseNumber(record.trunk),
    dialed_number: normaliseNumber(record.dialed_number),
    caller_number: normaliseNumber(record.caller_number),
    caller_extension: classification.caller_extension,
    caller_name: classification.caller_name,
    caller_user_id: classification.caller_user_id,
    it_extension: classification.it_extension,
    is_helpdesk_call: classification.is_helpdesk_call,
    ring_seconds: record.ring_seconds,
    duration_seconds: record.duration_seconds,
    answered: record.answered,
    condition_code: record.condition_code || null,
    account_code: record.account_code || null,
    parse_format: record.parse_format || 'panasonic',
    mirrored_records: 1,
    ticket_id: null,
    issue_resolved: null,
    resolution_source: null,
    resolved_at: null,
    resolved_by: null,
    resolution_minutes: null,
    notes: '',
    dedupe_key: key,
    raw: record.raw,
  };

  // Two honest-data guards: a misread date column (Panasonic consoles print
  // MM/DD/YY, DD/MM/YY *and* YY-MM-DD depending on a setting) would silently
  // move every call to the wrong year, and an assumed direction means the PBX
  // is not printing condition codes. Both are surfaced to the admin instead of
  // being quietly averaged into the reports.
  const stamp = Date.parse(call.call_at);
  if (Number.isFinite(stamp) && Math.abs(stamp - Date.now()) > 400 * 24 * 60 * 60 * 1000) {
    warn(`The PBX date ${call.call_day} is a long way from today — check PBX_DATE_FORMAT (currently "${pbxConfig.dateFormat}").`);
  }
  if (record.assumed_direction) {
    warn(`The PBX is not printing condition codes, so call direction is assumed ("${pbxConfig.assumeDirection}"). Turn on condition-code printing in the PBX console, or set PBX_ASSUME_DIRECTION.`);
  }

  calls.unshift(call);
  stats.recordsStored += 1;
  stats.lastRecordAt = call.received_at;
  stats.lastCall = { id: call.id, call_at: call.call_at, extension: call.caller_extension || call.extension, direction: call.direction };
  applyRetention();

  let ticket = null;
  if (shouldRaiseTicket(call)) {
    const created = createTicketForCall(call, { internal: true });
    if (created.ticket) ticket = created.ticket;
    else if (created.error) warn(`Call ${call.id}: ${created.error}`);
  }
  save();
  return { call, ticket };
};

const shouldRaiseTicket = (call) => {
  const cfg = pbxConfig;
  if (cfg.ticketPolicy === 'off') return false;
  // `is_helpdesk_call` is set both on the classification result and on the
  // stored call record, so this works before and after the record is saved.
  if (!call.is_helpdesk_call) return false;
  if (cfg.ticketPolicy === 'answered' && call.answered !== true) return false;
  if (cfg.ticketPolicy === 'missed' && call.answered !== false) return false;
  // Ignore calls that barely happened — a 3-second pickup is not an issue
  // report. Missed calls are measured on ring time instead, so a
  // never-answered call is never dropped by the talk-time threshold.
  if (call.answered === true && call.duration_seconds != null && call.duration_seconds < cfg.minCallSeconds) return false;
  if (call.answered !== true && call.ring_seconds != null && call.ring_seconds < cfg.minRingSeconds) return false;
  return true;
};

const callerLabelFor = (call) => {
  if (call.direction === 'Internal') {
    const name = call.caller_name || displayNameForExtension(call.caller_extension);
    return `Ext ${call.caller_extension || call.extension}${name ? ` (${name})` : ''} → Ext ${call.target_extension || call.it_extension || '?'}`;
  }
  if (call.direction === 'Outgoing') {
    return `Ext ${call.extension || call.it_extension} → ${call.dialed_number || 'external number'}`;
  }
  return call.caller_number || (call.caller_extension ? `Ext ${call.caller_extension}` : 'external caller');
};

/** `2025-09-21` + `15:10:00` -> `21/09/2025 15:10` (the PBX's own wall clock). */
const formatCallWhen = (call) => {
  const [y, m, d] = String(call.call_day || '').split('-');
  const time = String(call.call_time || '').slice(0, 5);
  if (!y || !m || !d) return `${call.call_day || ''} ${call.call_time || ''}`.trim();
  return `${d}/${m}/${y} ${time}`;
};

/** The human-readable call summary that goes into the ticket description. */
const describeCallForTicket = (call) => {
  const cfg = pbxConfig;
  const when = formatCallWhen(call);
  const lines = [
    'Raised from an IP-phone call to the IT office.',
    '',
    `• Call time: ${when}`,
    `• Direction: ${call.direction}${call.trunk ? ` (CO/trunk line ${call.trunk})` : ''}`,
    `• Caller: ${callerLabelFor(call)}`,
  ];
  if (call.ring_seconds != null) lines.push(`• Ring time: ${formatSeconds(call.ring_seconds)}`);
  lines.push(`• Call duration: ${call.answered === false ? 'not answered' : formatSeconds(call.duration_seconds)}`);
  if (call.condition_code) lines.push(`• PBX condition code: ${call.condition_code}`);
  if (call.account_code) lines.push(`• Account code: ${call.account_code}`);
  lines.push(`• Logged by: ${cfg.model} (SMDR, source: ${call.source})`);
  if (call.answered === false) {
    lines.push('', 'The call was not answered — please call this extension back about the issue raised.');
  } else {
    lines.push('', 'The details were taken over the phone. Add notes or chat here as the issue is worked.');
  }
  lines.push('', `PBX record: ${String(call.raw || '').slice(0, 300)}`);
  return lines.join('\n');
};

const ticketTitleFor = (call) => {
  const base = (() => {
    if (call.direction === 'Internal') {
      const name = call.caller_name || displayNameForExtension(call.caller_extension);
      return `IT call — Ext ${call.caller_extension || call.extension}${name ? ` (${name})` : ''}`;
    }
    if (call.direction === 'Outgoing') {
      return `IT call-out — Ext ${call.extension || call.it_extension} to ${call.dialed_number || 'external number'}`;
    }
    const who = call.caller_number || 'external caller';
    // Name the IT line that rang so the queue reads at a glance.
    const line = call.it_extension ? ` to Ext ${call.it_extension}` : '';
    return `IT call — ${who}${line}`;
  })();
  const suffix = call.answered === false ? ' (missed)' : '';
  return `${base}${suffix}`.slice(0, 200);
};

const resolveDefaultAgent = () => {
  const wanted = String(pbxConfig.defaultAgent || '').trim().toLowerCase();
  if (!wanted) return null;
  const byId = users().find((u) => u.id === pbxConfig.defaultAgent);
  if (byId && byId.role === 'agent') return byId;
  const byEmail = users().find((u) => String(u.email || '').toLowerCase() === wanted && u.role === 'agent');
  if (byEmail) return byEmail;
  const byName = users().find((u) => String(u.name || '').toLowerCase() === wanted && u.role === 'agent');
  if (byName) return byName;
  warn(`PBX_DEFAULT_AGENT="${pbxConfig.defaultAgent}" does not match any IT agent — phone tickets stay unassigned.`);
  return null;
};

/**
 * Create the helpdesk ticket for a call. Used automatically at ingestion time
 * (per PBX_TICKET_POLICY) and by the console's "Raise ticket" button.
 */
const createTicketForCall = (call, { force = false, internal = false } = {}) => {
  if (!call) return { error: 'Call not found.' };
  if (call.ticket_id && !force) return { error: 'This call already has a ticket.' };
  const cfg = pbxConfig;
  if (!call.is_helpdesk_call && !force) {
    return { error: 'This call did not involve the IT office extensions, so no ticket was raised. Use "Raise ticket" to overrule that.' };
  }
  if (!deps || !deps.newTicketRecord || !deps.addTicket) {
    return { error: 'Ticket creation is unavailable.' };
  }
  const assigned = resolveDefaultAgent();
  const record = deps.newTicketRecord({
    title: ticketTitleFor(call),
    description: describeCallForTicket(call),
    category: cfg.ticketCategory,
    priority: cfg.ticketPriority,
    assigned_to_id: assigned ? assigned.id : null,
    created_by: call.caller_user_id || null,
    created_by_name: call.caller_user_id
      ? (call.caller_name || 'Employee')
      : `${callerLabelFor(call)} (logged from the PBX)`,
    source: 'pbx_call',
    call_id: call.id,
  });
  deps.addTicket(record);
  call.ticket_id = record.id;
  call.ticket_created_at = record.created_at;
  stats.ticketsRaised += 1;
  save();
  if (!internal) notifyChange(call, 'call_ticket');
  return { ticket: record, call };
};

/**
 * Re-derive a call's "was the issue solved?" state from its ticket.
 *
 *   ticket working (Open/In Progress/Pending) -> pending (null)
 *   ticket Resolved/Closed                    -> solved, with the time it took
 *                                                from the phone call to the fix
 *   ticket Cancelled                          -> not solved
 *   ticket reopened                           -> pending again
 */
const syncCallFromTicket = (ticket, actorName = '') => {
  if (!ticket || !ticket.call_id) return null;
  const call = calls.find((c) => c.id === ticket.call_id);
  if (!call) return null;

  const status = ticket.status;
  if (status === 'Resolved' || status === 'Closed') {
    call.issue_resolved = true;
    call.resolution_source = 'ticket';
    call.resolved_at = ticket.resolved_at || nowIso();
    // Prefer the ticket's assignee, but record the agent who actually moved the
    // ticket when nobody owned it yet.
    call.resolved_by = (ticket.assigned_to && ticket.assigned_to !== 'Unassigned' ? ticket.assigned_to : null)
      || (actorName || null);
  } else if (status === 'Cancelled') {
    call.issue_resolved = false;
    call.resolution_source = 'ticket';
    call.resolved_at = null;
    call.resolved_by = null;
  } else {
    call.issue_resolved = null;
    call.resolution_source = null;
    call.resolved_at = null;
    call.resolved_by = null;
  }
  call.resolution_minutes = call.resolved_at ? minutesBetween(call.call_at, call.resolved_at) : null;
  save();
  notifyChange(call, 'call_updated');
  return call;
};

/** The console's solved / not-solved toggle on the call itself. */
const setCallResolved = (call, value, actorName) => {
  if (!call) return { error: 'Call not found.' };
  if (value !== true && value !== false && value !== null) {
    return { error: 'issue_resolved must be true (solved), false (not solved) or null (pending).' };
  }
  call.issue_resolved = value;
  call.resolution_source = value === null ? null : 'agent';
  call.resolved_at = value === true ? nowIso() : null;
  call.resolved_by = value === true ? (actorName || 'IT agent') : null;
  call.resolution_minutes = value === true ? minutesBetween(call.call_at, call.resolved_at) : null;
  save();
  notifyChange(call, 'call_updated');
  return { call };
};

const updateCall = (call, body) => {
  if (!call) return { error: 'Call not found.' };
  if (body.notes !== undefined) call.notes = String(body.notes || '').trim().slice(0, 2000);
  if (body.caller_extension !== undefined) {
    const ext = String(body.caller_extension || '').trim().replace(/^0+(?=\d)/, '');
    if (ext && !EXTENSION_RE.test(ext)) return { error: 'Caller extension must be a PBX number (e.g. 210).' };
    call.caller_extension = ext;
    call.caller_name = displayNameForExtension(ext) || call.caller_name;
    const entry = resolveExtension(ext);
    call.caller_user_id = entry && entry.user_id ? entry.user_id : null;
  }
  if (body.direction !== undefined) {
    if (!['Incoming', 'Outgoing', 'Internal'].includes(body.direction)) {
      return { error: 'Direction must be Incoming, Outgoing or Internal.' };
    }
    call.direction = body.direction;
  }
  if (body.duration_seconds !== undefined) {
    const v = body.duration_seconds === null ? null : Number(body.duration_seconds);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 24 * 3600)) {
      return { error: 'Duration must be a number of seconds between 0 and 86400.' };
    }
    call.duration_seconds = v === null ? null : Math.round(v);
  }
  save();
  notifyChange(call, 'call_updated');
  return { call };
};

/** Link/unlink a ticket by hand (e.g. the same issue already had a ticket). */
const linkTicket = (call, ticketId) => {
  if (!call) return { error: 'Call not found.' };
  if (ticketId === null || ticketId === '') {
    call.ticket_id = null;
    call.issue_resolved = null;
    call.resolution_source = null;
    call.resolved_at = null;
    call.resolution_minutes = null;
    save();
    notifyChange(call, 'call_updated');
    return { call };
  }
  const ticket = tickets().find((t) => t.id === ticketId);
  if (!ticket) return { error: 'Ticket not found.' };
  if (ticket.call_id && ticket.call_id !== call.id) {
    return { error: 'That ticket is already linked to another call.' };
  }
  ticket.call_id = call.id;
  ticket.source = ticket.source || 'pbx_call';
  call.ticket_id = ticket.id;
  syncCallFromTicket(ticket);
  save();
  notifyChange(call, 'call_updated');
  return { call, ticket };
};

// ------------------------------------------------------------------
// Manual entry + simulator
// ------------------------------------------------------------------
/**
 * Log a call by hand (used when the PBX feed is not wired up yet, and by the
 * console's "Log a call" form). Accepts either a duration in seconds or the
 * PBX's own `M'SS` / `H:MM'SS` text.
 */
const logManualCall = (body, { source = 'manual' } = {}) => {
  if (!deps) return { error: 'Call logging is unavailable.' };
  const { extension, direction, call_at, time, duration, duration_seconds, dialed_number, caller_number, ring_seconds, condition_code, notes, answered } = body || {};
  const when = call_at ? new Date(call_at) : new Date();
  if (Number.isNaN(when.getTime())) return { error: 'Call time is not a valid date/time.' };
  const ext = String(extension || '').trim().replace(/^0+(?=\d)/, '');
  if (!EXTENSION_RE.test(ext)) return { error: 'Extension is required (the PBX extension the call was on, e.g. 204).' };
  const dir = direction || (pbxConfig.itExtensions.includes(ext) ? 'Incoming' : 'Internal');
  if (!['Incoming', 'Outgoing', 'Internal'].includes(dir)) {
    return { error: 'Direction must be Incoming, Outgoing or Internal.' };
  }
  // Either a plain number of seconds, or the PBX's own duration text (`2'35`).
  let seconds = null;
  if (duration_seconds !== undefined && duration_seconds !== null && duration_seconds !== '') {
    seconds = Number(duration_seconds);
  } else if (duration !== undefined && duration !== null && duration !== '') {
    seconds = durationTokenToSeconds(String(duration));
    if (seconds == null) seconds = Number(duration);
  }
  if (seconds !== null && (!Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 3600)) {
    return { error: 'Duration must be between 0 seconds and 24 hours.' };
  }
  const ringValue = ring_seconds === undefined || ring_seconds === null || ring_seconds === ''
    ? null
    : Math.round(Number(ring_seconds));
  if (ringValue !== null && (!Number.isFinite(ringValue) || ringValue < 0 || ringValue > 3600)) {
    return { error: 'Ring time must be between 0 and 3600 seconds.' };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const timeText = time && /^\d{1,2}:\d{2}/.test(String(time))
    ? `${String(time).split(':')[0].padStart(2, '0')}:${String(time).split(':')[1].slice(0, 2)}:00`
    : `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  const record = {
    call_at: when.toISOString(),
    call_day: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    call_time: timeText,
    direction: dir,
    extension: ext,
    trunk: '',
    dialed_number: String(dialed_number || '').trim(),
    caller_number: String(caller_number || '').trim(),
    ring_seconds: ringValue,
    duration_seconds: seconds === null ? null : Math.round(seconds),
    condition_code: condition_code || (answered === false ? 'NA' : 'AN'),
    answered: answered === false ? false : (seconds === null ? (answered === true ? true : null) : (seconds > 0 || answered === true)),
    account_code: null,
    parse_format: 'manual',
    raw: `manual entry — Ext ${ext} ${dir}${seconds !== null ? ` ${seconds}s` : ''}${notes ? ` — ${String(notes).slice(0, 120)}` : ''}`,
  };

  const result = ingestRecord(record, { source });
  const stored = result.call || null;
  if (!stored) {
    return {
      error: result.duplicate
        ? 'That call is already in the log (same time, extension and duration).'
        : 'Could not log the call.',
    };
  }
  if (notes) {
    stored.notes = String(notes).trim().slice(0, 2000);
    save();
  }
  notifyChange(stored, 'call_logged');
  return { call: stored, ticket: result.ticket || null, duplicate: Boolean(result.duplicate) };
};

/**
 * Build a realistic Panasonic SMDR line and push it through the real
 * ingestion path — the "prove the wiring" button. Nothing here is hard-coded
 * into storage: the line is parsed exactly like a PBX record.
 */
const simulateCall = ({ extension, direction = 'Incoming', seconds = 95, ring = 8, answered = true, dialed_number, caller_number } = {}) => {
  if (!pbxConfig.allowSimulator) {
    return { error: 'The call simulator is disabled on this server (set PBX_ALLOW_SIMULATOR=true to enable it).' };
  }
  const cfg = pbxConfig;
  const itExt = cfg.itExtensions[0] || extension || '204';
  const dir = direction;
  const ext = extension || (dir === 'Internal' ? '210' : itExt);
  const when = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${pad(when.getDate())}/${pad(when.getMonth() + 1)}/${String(when.getFullYear()).slice(2)}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  const dur = `00:${pad(Math.floor(seconds / 60))}'${pad(seconds % 60)}`;
  const ringTok = `${Math.floor(ring / 60)}'${pad(ring % 60)}`;
  const cd = answered ? 'AN' : 'NA';
  const dialed = dialed_number || (dir === 'Internal' ? (itExt || '101') : dir === 'Outgoing' ? '08031234567' : '\\');
  const caller = caller_number || (dir === 'Outgoing' ? '' : '08035550123');
  // Same layout the console prints: Ext, CO, Dial Number, Ring, Duration, CD —
  // for an incoming call the CLI is printed in the Dial Number column, and `\`
  // stands in when the network passed no number.
  const line = dir === 'Incoming'
    ? `${date} ${time} ${ext} 01 ${caller || '\\'} ${ringTok} ${dur} ${cd}`
    : `${date} ${time} ${ext} 01 ${dialed || '\\'} ${ringTok} ${dur} ${cd}`;
  const result = ingestText(line, { source: 'simulator' });
  const call = result.calls && result.calls.length ? calls.find((c) => c.id === result.calls[0]) : null;
  if (!call) return { error: result.skipped && result.skipped.length ? `Could not parse the simulated record: ${result.skipped[0].reason}` : 'Simulated call could not be logged.' };
  return { call, ticket: result.tickets[0] ? tickets().find((t) => t.id === result.tickets[0]) : null, raw: line, parsed: result.parsed };
};

// ------------------------------------------------------------------
// Ingestion entry points (text / capture)
// ------------------------------------------------------------------
const ingestText = (text, { source = 'smdr' } = {}) => {
  const cfg = pbxConfig;
  const { records, skipped } = parseCapture(text, {
    dateFormat: cfg.dateFormat,
    dayFirst: cfg.dayFirst,
    delimiter: cfg.smdrDelimiter,
    columns: cfg.smdrColumns,
    assumeDirection: cfg.assumeDirection,
  });
  const created = [];
  const ticketIds = [];
  let duplicates = 0;
  records.forEach((record) => {
    const result = ingestRecord(record, { source });
    if (result.duplicate) duplicates += 1;
    if (result.call) created.push(result.call.id);
    if (result.ticket) ticketIds.push(result.ticket.id);
  });
  skipped.forEach((s) => {
    stats.unparsed = [{ ...s, at: nowIso() }, ...stats.unparsed].slice(0, 20);
  });
  const total = records.length + skipped.length;
  if (skipped.length) {
    warn(`${skipped.length} of the last ${total} PBX record(s) could not be parsed — check PBX_SMDR_* settings or send a sample to IT.`);
  }
  if (created.length || duplicates) notifyChange(null, 'calls_logged', { count: created.length });
  return { parsed: records.length, skipped, duplicates, calls: created, tickets: ticketIds };
};

const parsePreview = (text) => {
  const cfg = pbxConfig;
  const lines = String(text || '').split(/\r\n|\r|\n/).filter((l) => l.trim());
  return lines.slice(0, 50).map((line) => {
    const parsed = parseSmdrLine(line, {
      dateFormat: cfg.dateFormat,
      dayFirst: cfg.dayFirst,
      delimiter: cfg.smdrDelimiter,
      columns: cfg.smdrColumns,
      assumeDirection: cfg.assumeDirection,
    });
    if (!parsed.ok) return { ok: false, reason: parsed.reason, raw: parsed.raw };
    const classification = classifyCall(parsed.record);
    return {
      ok: true,
      raw: parsed.raw,
      record: {
        ...parsed.record,
        ...classification,
        duration_display: formatSeconds(parsed.record.duration_seconds),
        ring_display: parsed.record.ring_seconds == null ? null : formatSeconds(parsed.record.ring_seconds),
      },
      would_raise_ticket: classification.ticketable && shouldRaiseTicket({ ...parsed.record, ...classification }),
    };
  });
};

// ------------------------------------------------------------------
// Visibility + reporting
// ------------------------------------------------------------------
/** Super admins see every call; agents see their own calls plus unclaimed ones. */
/**
 * A call nobody has claimed yet: either it never raised a ticket, or the ticket
 * it raised is still unassigned. These are the calls an agent can pick up, so
 * every agent sees them until dispatch hands the ticket to someone.
 */
const isUnclaimedCall = (call) => {
  if (!call || !call.ticket_id) return true;
  const ticket = tickets().find((t) => t.id === call.ticket_id);
  return !ticket || !ticket.assigned_to_id;
};

const visibleCallsFor = (user) => {
  if (!user) return [];
  if (isSuperAdminUser(user)) return calls;
  if (user.role !== 'agent') return [];
  const myTicketIds = new Set(tickets().filter((t) => t.assigned_to_id === user.id).map((t) => t.id));
  return calls.filter((c) => isUnclaimedCall(c) || myTicketIds.has(c.ticket_id));
};

const canAccessCall = (user, call) => {
  if (!user || !call) return false;
  if (isSuperAdminUser(user)) return true;
  if (user.role !== 'agent') return false;
  if (isUnclaimedCall(call)) return true; // unclaimed calls are anyone's to pick up
  const ticket = tickets().find((t) => t.id === call.ticket_id);
  return Boolean(ticket && ticket.assigned_to_id === user.id);
};

const decorate = (call) => {
  const ticket = call.ticket_id ? tickets().find((t) => t.id === call.ticket_id) : null;
  const directory = call.caller_extension ? resolveExtension(call.caller_extension) : null;
  return {
    ...call,
    duration_display: formatSeconds(call.duration_seconds),
    ring_display: call.ring_seconds == null ? null : formatSeconds(call.ring_seconds),
    caller_label: callerLabelFor(call),
    caller_display_name: (directory && directory.user_name) || call.caller_name || '',
    resolution_outcome: call.issue_resolved === true ? 'Solved'
      : call.issue_resolved === false ? 'Not solved' : 'Pending',
    ticket_title: ticket ? ticket.title : null,
    ticket_status: ticket ? ticket.status : null,
    ticket_assignee: ticket ? (ticket.assigned_to || null) : null,
  };
};

const round1 = (n) => Math.round(n * 10) / 10;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const parseRange = (query) => {
  const raw = String((query && query.days) ?? '30').trim().toLowerCase();
  if (raw === 'all') return { days: 'all', raw };
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { error: 'days must be an integer between 1 and 365, or "all"' };
  }
  return { days, raw };
};

const filterByDays = (scopeCalls, days, now) => {
  const cutoff = days === 'all' ? -Infinity : now - days * 24 * 60 * 60 * 1000;
  return scopeCalls.filter((c) => {
    const at = Date.parse(c.call_at);
    return Number.isFinite(at) && at >= cutoff;
  });
};

const buildCallReport = (scopeCalls, { days = 30, now = Date.now() } = {}) => {
  const rows = filterByDays(scopeCalls, days, now)
    .map((c) => decorate(c))
    .sort((a, b) => String(b.call_at).localeCompare(String(a.call_at)));

  const durations = rows.map((c) => c.duration_seconds).filter((v) => Number.isFinite(v));
  const solved = rows.filter((r) => r.issue_resolved === true);
  const unsolved = rows.filter((r) => r.issue_resolved === false);
  const pending = rows.filter((r) => r.issue_resolved === null);
  const helpdesk = rows.filter((r) => r.is_helpdesk_call);
  const solveMinutes = solved.map((r) => r.resolution_minutes).filter((v) => Number.isFinite(v));

  const summary = {
    total: rows.length,
    helpdeskCalls: helpdesk.length,
    incoming: rows.filter((r) => r.direction === 'Incoming').length,
    outgoing: rows.filter((r) => r.direction === 'Outgoing').length,
    internal: rows.filter((r) => r.direction === 'Internal').length,
    answered: rows.filter((r) => r.answered === true).length,
    missed: rows.filter((r) => r.answered === false).length,
    unknownAnswer: rows.filter((r) => r.answered == null).length,
    totalTalkSeconds: durations.reduce((a, b) => a + b, 0),
    avgDurationSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    medianDurationSeconds: durations.length ? Math.round(median(durations)) : null,
    longestCallSeconds: durations.length ? Math.max(...durations) : null,
    ticketed: rows.filter((r) => r.ticket_id).length,
    unticketed: rows.filter((r) => !r.ticket_id).length,
    solved: solved.length,
    unsolved: unsolved.length,
    pending: pending.length,
    solveRatePercent: rows.length ? round1((solved.length / rows.length) * 100) : null,
    helpdeskSolveRatePercent: helpdesk.length ? round1((helpdesk.filter((r) => r.issue_resolved === true).length / helpdesk.length) * 100) : null,
    meanMinutesToSolve: solveMinutes.length ? round1(solveMinutes.reduce((a, b) => a + b, 0) / solveMinutes.length) : null,
    medianMinutesToSolve: solveMinutes.length ? round1(median(solveMinutes)) : null,
    mirroredIntercomRecords: rows.reduce((a, r) => a + Math.max(0, (r.mirrored_records || 1) - 1), 0),
  };

  const group = (keyOf, decorateGroup) => {
    const map = new Map();
    rows.forEach((r) => {
      const key = keyOf(r);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    return [...map.entries()]
      .map(([key, list]) => ({ key, ...decorateGroup(list) }))
      .sort((a, b) => b.calls - a.calls || String(a.key).localeCompare(String(b.key)));
  };

  const byExtension = group(
    (r) => r.caller_extension || r.extension || 'unknown',
    (list) => ({
      calls: list.length,
      name: list.map((r) => r.caller_display_name).find(Boolean) || '',
      solved: list.filter((r) => r.issue_resolved === true).length,
      unsolved: list.filter((r) => r.issue_resolved === false).length,
      avgDurationSeconds: (() => {
        const d = list.map((r) => r.duration_seconds).filter((v) => Number.isFinite(v));
        return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null;
      })(),
    })
  );

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 }))
    .map((slot) => ({ ...slot, calls: rows.filter((r) => Number(String(r.call_time || '').slice(0, 2)) === slot.hour).length }));

  const byDay = group(
    (r) => r.call_day || String(r.call_at).slice(0, 10),
    (list) => ({
      calls: list.length,
      solved: list.filter((r) => r.issue_resolved === true).length,
      missed: list.filter((r) => r.answered === false).length,
      avgDurationSeconds: (() => {
        const d = list.map((r) => r.duration_seconds).filter((v) => Number.isFinite(v));
        return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null;
      })(),
    })
  ).sort((a, b) => String(a.key).localeCompare(String(b.key)));

  const byOutcome = ['Solved', 'Not solved', 'Pending'].map((key) => ({
    key,
    calls: rows.filter((r) => r.resolution_outcome === key).length,
  }));

  return {
    range: { days, from: days === 'all' ? null : new Date(now - days * 24 * 60 * 60 * 1000).toISOString(), to: new Date(now).toISOString() },
    generatedAt: new Date(now).toISOString(),
    model: pbxConfig.model,
    itExtensions: pbxConfig.itExtensions,
    ticketPolicy: pbxConfig.ticketPolicy,
    summary,
    byExtension,
    byHour,
    byDay,
    byOutcome,
    rows,
  };
};

// ------------------------------------------------------------------
// Live updates
// ------------------------------------------------------------------
/**
 * Tell the consoles something changed. The payload is intentionally tiny (ids
 * only) and goes to the agent room, so no call detail leaks to a session that
 * is not entitled to see it.
 */
const notifyChange = (call, event, extra = {}) => {
  if (!deps || !deps.io) return;
  const payload = {
    callId: call ? call.id : null,
    ticketId: call ? call.ticket_id : null,
    event,
    ...extra,
  };
  deps.io.to('role_agent').emit('pbx_call_changed', payload);
  deps.io.to('role_super_admin').emit('pbx_call_changed', payload);
};

// ------------------------------------------------------------------
// Status
// ------------------------------------------------------------------
const status = (transportState = {}) => ({
  enabled: pbxConfig.enabled,
  transport: pbxConfig.transport,
  model: pbxConfig.model,
  connection: transportState,
  itExtensions: pbxConfig.itExtensions,
  ticketPolicy: pbxConfig.ticketPolicy,
  minCallSeconds: pbxConfig.minCallSeconds,
  minRingSeconds: pbxConfig.minRingSeconds,
  ticketCategory: pbxConfig.ticketCategory,
  ticketPriority: pbxConfig.ticketPriority,
  defaultAgent: pbxConfig.defaultAgent || null,
  dateFormat: pbxConfig.dateFormat === 'auto' ? (pbxConfig.dayFirst ? 'DD/MM/YY (day first)' : 'MM/DD/YY') : pbxConfig.dateFormat,
  webhookConfigured: Boolean(pbxConfig.token),
  allowSimulator: pbxConfig.allowSimulator,
  retention: pbxConfig.retainCalls,
  warnings: configWarnings(),
  stats: {
    ...stats,
    storedCalls: calls.length,
    directoryEntries: extensions.length,
  },
});

/** Plain-language problems the admin can fix, shown in the console. */
const configWarnings = () => {
  const out = [];
  if (!pbxConfig.enabled && pbxConfig.transport !== 'webhook') {
    out.push('PBX_ENABLED is not true, so no call records are being read from the PBX yet.');
  }
  if (!pbxConfig.itExtensions.length) {
    out.push('PBX_IT_EXTENSIONS is empty — calls are logged but no tickets are raised automatically, because the helpdesk does not know which extensions ring in the IT office.');
  }
  if (pbxConfig.ticketPolicy === 'off') {
    out.push('PBX_TICKET_POLICY=off — calls are logged but never turned into tickets.');
  }
  if (!pbxConfig.token) {
    out.push('PBX_TOKEN is not set — the call webhook only accepts a signed-in agent, so PBX middleware cannot post records.');
  }
  if (stats.unparsed.length) {
    out.push(`${stats.unparsed.length} record(s) in the last batch could not be parsed — check the raw lines under "Unparsed records".`);
  }
  return [...out, ...stats.warnings].slice(0, 8);
};

const resetStatsForTests = () => {
  stats.recordsReceived = 0;
  stats.recordsStored = 0;
  stats.duplicatesMerged = 0;
  stats.ticketsRaised = 0;
  stats.unparsed = [];
  stats.warnings = [];
};

const resetForTests = () => {
  calls = [];
  extensions = [];
  resetStatsForTests();
};

// ------------------------------------------------------------------
// Follow user lifecycle so the directory never points at a deleted account
// ------------------------------------------------------------------
const onUserDeleted = (userId) => {
  let changed = false;
  extensions.forEach((e) => {
    if (e.user_id === userId) {
      e.user_id = null;
      changed = true;
    }
  });
  calls.forEach((c) => {
    if (c.caller_user_id === userId) {
      c.caller_user_id = null;
      changed = true;
    }
  });
  if (changed) save();
  return changed;
};

module.exports = {
  loadData,
  setDeps,
  getCalls,
  getExtensions,
  config,
  status,
  listDirectory,
  upsertDirectoryEntry,
  deleteDirectoryEntry,
  resolveExtension,
  displayNameForExtension,
  ingestText,
  ingestRecord,
  parsePreview,
  logManualCall,
  simulateCall,
  createTicketForCall,
  shouldRaiseTicket,
  syncCallFromTicket,
  setCallResolved,
  updateCall,
  linkTicket,
  visibleCallsFor,
  canAccessCall,
  isUnclaimedCall,
  decorate,
  formatCallWhen,
  buildCallReport,
  filterByDays,
  parseRange,
  notifyChange,
  onUserDeleted,
  resetForTests,
};
