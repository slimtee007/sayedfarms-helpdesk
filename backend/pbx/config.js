/**
 * PBX (Panasonic SMDR) configuration.
 *
 * Everything is environment-driven so a site can be wired up without a code
 * change: how the call records reach us (`PBX_TRANSPORT`), which extensions
 * belong to the IT office (`PBX_IT_EXTENSIONS`), and which calls should raise a
 * ticket (`PBX_TICKET_POLICY`).
 *
 * Defaults are deliberately conservative: the listener is OFF unless
 * `PBX_ENABLED=true`, and with no IT extensions configured the helpdesk still
 * *logs* calls but raises no tickets automatically — a misconfigured PBX feed
 * cannot flood the queue.
 */

'use strict';

const isProduction = process.env.NODE_ENV === 'production';

const str = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
};

const bool = (name, fallback) => {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(v);
};

const int = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = str(name);
  // An unset variable must fall back to the default — `Number('')` is 0, which
  // would silently turn defaults like "keep 5000 calls" into "keep 100".
  if (raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v)) return fallback;
  return Math.min(max, Math.max(min, v));
};

const list = (name) => str(name).split(',').map((s) => s.trim()).filter(Boolean);

const VALID_POLICIES = new Set(['all', 'answered', 'missed', 'off']);
const VALID_TRANSPORTS = new Set(['off', 'auto', 'tcp-client', 'tcp-server', 'webhook']);

const TRANSPORT = (() => {
  const t = str('PBX_TRANSPORT', 'auto').toLowerCase();
  return VALID_TRANSPORTS.has(t) ? t : 'auto';
})();

const HOST = str('PBX_HOST');
const LISTEN_PORT = int('PBX_LISTEN_PORT', 0, { min: 0, max: 65535 });

// `auto` picks a live connection when one is configured: talk to the PBX when
// it has an address (the KX-NS/NSX SMDR port accepts a client), otherwise
// listen for whatever pushes records at us (serial-to-IP gateways, PBX push).
const resolvedTransport = TRANSPORT !== 'auto'
  ? TRANSPORT
  : HOST ? 'tcp-client' : LISTEN_PORT ? 'tcp-server' : 'webhook';

const POLICY = (() => {
  const p = str('PBX_TICKET_POLICY', 'all').toLowerCase();
  return VALID_POLICIES.has(p) ? p : 'all';
})();

const policy = {
  // What the PBX says on the wire.
  enabled: bool('PBX_ENABLED', false),
  transport: resolvedTransport,
  host: HOST,
  port: int('PBX_PORT', 2300, { min: 1, max: 65535 }),
  // The NS/NSX SMDR feed asks for credentials before it prints (default
  // SMDR / PCCSMDR on a factory-fresh PBX).
  username: str('PBX_USERNAME', 'SMDR'),
  password: str('PBX_PASSWORD', 'PCCSMDR'),
  listenHost: str('PBX_LISTEN_HOST', '0.0.0.0'),
  listenPort: LISTEN_PORT,
  // Shared secret for `POST /api/pbx/calls` from middleware that cannot hold a
  // user token. Without it configured, that endpoint only accepts a signed-in
  // agent, so an exposed instance can never be fed bogus calls.
  token: str('PBX_TOKEN'),
  // Which extensions ring in the IT office (Panasonic Ext column).
  itExtensions: list('PBX_IT_EXTENSIONS').map((e) => e.replace(/^0+(?=\d)/, '') || e),
  // Raise a ticket when a call is logged.
  ticketPolicy: POLICY,
  minCallSeconds: int('PBX_MIN_CALL_SECONDS', 5, { min: 0, max: 3600 }),
  minRingSeconds: int('PBX_MIN_RING_SECONDS', 0, { min: 0, max: 3600 }),
  ticketCategory: str('PBX_TICKET_CATEGORY', 'Other'),
  ticketPriority: str('PBX_TICKET_PRIORITY', 'Medium'),
  // Optional dispatcher for phone-raised tickets (agent email or account id).
  defaultAgent: str('PBX_DEFAULT_AGENT'),
  // Identity shown in ticket descriptions / reports.
  model: str('PBX_MODEL', 'Panasonic PBX'),
  // Date handling. Panasonic's console default is MM/DD/YY; set
  // PBX_DAY_FIRST=true (or an explicit PBX_DATE_FORMAT) for DD/MM/YY sites.
  dateFormat: str('PBX_DATE_FORMAT', 'auto'),
  dayFirst: bool('PBX_DAY_FIRST', false),
  // Some sites export SMDR to a file/CSV and feed that in (or use middleware
  // that reformats it). PBX_SMDR_DELIMITER switches on delimited parsing —
  // `tab` and `semicolon` are accepted spellings.
  smdrDelimiter: (() => {
    const raw = str('PBX_SMDR_DELIMITER');
    if (!raw) return '';
    const v = raw.toLowerCase();
    if (v === 'tab' || v === '\\t') return '\t';
    if (v === 'semicolon') return ';';
    if (v === 'pipe' || v === 'bar') return '|';
    return raw;
  })(),
  // Optional explicit column map for a strict fixed layout, e.g.
  // PBX_SMDR_COLUMNS="date:1,time:2,ext:3,trunk:4,dialed_number:5,ring_seconds:6,duration_seconds:7,condition_code:8"
  // (1-based column numbers). Leave empty for auto-detection.
  smdrColumns: (() => {
    const raw = str('PBX_SMDR_COLUMNS');
    if (!raw) return null;
    const map = {};
    raw.split(',').forEach((pair) => {
      const [key, value] = pair.split(':').map((s) => String(s || '').trim());
      if (!key || value === undefined) return;
      const idx = Number(value);
      if (Number.isInteger(idx) && idx >= 1) map[key] = idx - 1;
    });
    return Object.keys(map).length ? map : null;
  })(),
  // Direction to assume when the PBX prints neither a condition code nor a
  // `\` / `<I>` marker (i.e. "print condition codes" is off in the PBX
  // console). Incoming | Outgoing.
  assumeDirection: (() => {
    const v = str('PBX_ASSUME_DIRECTION', 'incoming').toLowerCase();
    return v === 'outgoing' ? 'outgoing' : 'incoming';
  })(),
  // Opt-in: raise a ticket for every parsed call even when PBX_IT_EXTENSIONS
  // is empty. Only useful when the PBX itself is programmed to print records
  // for the IT extensions alone — otherwise it tickets the whole company.
  ticketAllCalls: bool('PBX_TICKET_ALL_CALLS', false),
  // Two SMDR records are printed for one intercom call (one per extension
  // involved); records inside this window are merged into the first one.
  intercomDedupeWindowSeconds: int('PBX_INTERCOM_DEDUPE_WINDOW_SECONDS', 180, { min: 0, max: 3600 }),
  // How many call records to keep in db.json (oldest are pruned first).
  retainCalls: int('PBX_RETAIN_CALLS', 5000, { min: 100, max: 200000 }),
  // The built-in "simulate a call" button: useful for demos and for proving
  // the pipeline before the PBX is wired. On by default in development, and
  // only with an explicit opt-in in production.
  allowSimulator: bool('PBX_ALLOW_SIMULATOR', !isProduction),
  isProduction,
};

/** A short human summary used by the status endpoint and the boot log. */
const describe = (cfg = policy) => {
  if (!cfg.enabled) return 'disabled (PBX_ENABLED is not true)';
  if (cfg.transport === 'tcp-client') return `connecting to ${cfg.host || '?'}:${cfg.port}`;
  if (cfg.transport === 'tcp-server') return `listening on ${cfg.listenHost}:${cfg.listenPort || '?'}`;
  return 'webhook only (POST /api/pbx/calls)';
};

module.exports = { pbxConfig: policy, describeConfig: describe, isProduction };
