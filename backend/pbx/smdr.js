/**
 * Panasonic SMDR (Station Message Detail Recording) parsing.
 *
 * The helpdesk turns an IP-phone call to the IT office into a ticket, so the
 * first job is understanding what the PBX prints. Panasonic's "Central PBX"
 * family (KX-NS/NSX, KX-TDA/TDE, KX-TDE, KX-NCP and the older KX-T/KX-TD lines)
 * all emit SMDR records, but the column *widths* differ between models and
 * firmware versions and the fields are space-padded rather than comma
 * separated, so a strict fixed-column parser breaks on the next model.
 *
 * This parser is therefore deliberately tolerant. Every record is read as
 * `<date> <time> <rest>` and the *rest* is classified by shape:
 *
 *   Ext       2-6 digits (`*9533` verification codes included)
 *   CO/trunk  1-3 digits
 *   Dial      >= 4 digits, or `+`-prefixed, or the `\` / `<I>` / `<INCOMING>`
 *             markers Panasonic prints when there is no dialled number
 *   Ring      `M'SS` / `MM:SS`  (printed before the duration)
 *   Duration  `H:MM'SS`, `M'SS`, `H:MM:SS` or `M:SS`
 *   CD / Acc  2-4 letter condition codes (`AN`, `NA`, `RC`, `TR`, ...), or an
 *             accounting code
 *
 * When two duration-shaped tokens are present the first is the ring time and
 * the second is the call duration (that is the order Panasonic prints them);
 * with one, it is the duration. A trailing/leading condition code decides
 * answered vs missed, and the presence of a trunk plus a long dialled number
 * decides external vs internal.
 *
 * Nothing here throws or mutates: unparseable lines are returned as
 * `{ ok: false, reason }` so the caller can keep the raw text for the admin to
 * inspect instead of silently dropping a call.
 */

'use strict';

// ------------------------------------------------------------------
// Field shapes
// ------------------------------------------------------------------
// `09/02/02`, `2025-09-21`, `21.09.2025`, `14-05-14`
const DATE_TOKEN_RE = /^(\d{2,4})[/\-.](\d{1,2})[/\-.](\d{2,4})$/;
// `10:23`, `10:23:45`, `10:23AM`, `10:23:45 am`
const TIME_TOKEN_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

// Durations, in the order they must be tried (`H:MM'SS` before `M:SS`).
const DURATION_APOS_HMS_RE = /^(\d{1,3}):(\d{2})'(\d{2})"?$/; // 00:00'10 = 10s
const DURATION_APOS_HMS2_RE = /^(\d{1,3})'(\d{1,2})'(\d{2})"?$/; // 0'00'45 = 45s (the same column, apostrophes only)
const DURATION_APOS_MS_RE = /^(\d{1,3})'(\d{2})"?$/;         // 1'05    = 65s
const DURATION_HMS_RE = /^(\d{1,3}):(\d{2}):(\d{2})$/;       // 00:01:23
const DURATION_MS_RE = /^(\d{1,3}):(\d{2})$/;                // 2:10

const EXTENSION_TOKEN_RE = /^[*#]?\d{1,6}$/;
const LONG_NUMBER_RE = /^\+?\d{7,24}$/;

// Direction markers Panasonic prints in the Dial Number column when there is
// nothing dialled: `\` for an incoming call, `<I>`/`<INCOMING>` on the older
// TDA/TD firmwares.
const INCOMING_MARKER_RE = /(<incoming>|<i>|\\|\|\s*$)/i;
const OUTGOING_MARKER_RE = /<outgoing>/i;
const INTERCOM_MARKER_RE = /<intercom>|<ic>/i;

// Condition ("CD") codes. Panasonic prints the highest-priority code for a
// call, so these identify both the call stage and what happened to it.
//   RC received · AN answered · NA no answer · AB abandoned
//   TR/T transfer · H hold · FW call forward · VM voicemail · AT attendant
//   I/D/S/N incoming variants (DID / DISA / network) · O/L/W outgoing
const ANSWERED_CODES = new Set(['AN', 'AT']);
const MISSED_CODES = new Set(['NA', 'AB', 'VM']);
const INCOMING_CODES = new Set(['RC', 'I', 'D', 'S', 'N', 'IN']);
const OUTGOING_CODES = new Set(['O', 'L', 'W']);
const TRANSFER_CODES = new Set(['TR', 'T', 'H', 'h', 't', 'FW']);
const KNOWN_CODES = new Set([
  ...ANSWERED_CODES, ...MISSED_CODES, ...INCOMING_CODES, ...OUTGOING_CODES, ...TRANSFER_CODES,
]);

const pad2 = (n) => String(n).padStart(2, '0');

/** Seconds from a `H:MM'SS` / `M'SS` / `H:MM:SS` / `M:SS` duration token. */
const durationTokenToSeconds = (token) => {
  // JSON/CSV middleware often sends the number of seconds as a plain value.
  if (typeof token === 'number') return Number.isFinite(token) ? Math.max(0, Math.round(token)) : null;
  if (typeof token !== 'string') return null;
  const t = token.trim();
  let m = DURATION_APOS_HMS_RE.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = DURATION_APOS_HMS2_RE.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = DURATION_APOS_MS_RE.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = DURATION_HMS_RE.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = DURATION_MS_RE.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  // A bare number column is seconds (`duration_seconds` in a JSON/CSV feed).
  if (/^\d{1,7}$/.test(t)) return Number(t);
  return null;
};

/** `125` -> `2m 5s` (used in ticket descriptions and the call log). */
const formatSeconds = (seconds) => {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'unknown';
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
};

// `2025-09-21` + `14:32:10` -> the ISO instant, read as *server local time*
// because the PBX clock is set to the office's wall clock.
/**
 * Turn the PBX's date + time columns into an ISO instant.
 *
 * Returns `{ iso, day, time }` or null. `day` is the local calendar day
 * (YYYY-MM-DD) used for report grouping — grouping on the UTC slice would move
 * an evening call into the next day for timezones east of Greenwich.
 */
const parseCallMoment = (dateToken, timeToken, { dateFormat = 'auto', dayFirst = false } = {}) => {
  const d = DATE_TOKEN_RE.exec(String(dateToken || '').trim());
  const t = TIME_TOKEN_RE.exec(String(timeToken || '').trim());
  if (!d || !t) return null;

  let [, p1, p2, p3] = d;
  let year; let month; let day;
  if (dateFormat && dateFormat !== 'auto') {
    // Explicit order from PBX_DATE_FORMAT, e.g. "DD/MM/YY" or "MM-DD-YYYY".
    const order = dateFormat.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    const parts = { Y: null, M: null, D: null };
    const values = [p1, p2, p3];
    for (let i = 0; i < order.length && i < values.length; i += 1) {
      const key = order[i][0];
      if (key in parts) parts[key] = values[i];
    }
    year = parts.Y; month = parts.M; day = parts.D;
  } else if (p1.length === 4) {
    // ISO-ish: YYYY-MM-DD
    [year, month, day] = [p1, p2, p3];
  } else if (Number(p1) > 12 && Number(p2) <= 12) {
    [day, month, year] = [p1, p2, p3]; // unambiguous day-first (21/09/25)
  } else if (Number(p2) > 12) {
    [month, day, year] = [p1, p2, p3]; // unambiguous month-first (09/21/25)
  } else if (dayFirst) {
    [day, month, year] = [p1, p2, p3];
  } else {
    [month, day, year] = [p1, p2, p3]; // Panasonic's default is MM/DD/YY
  }
  if (year.length === 2) year = `20${year}`;
  const y = Number(year); const mo = Number(month); const da = Number(day);
  if (!(y >= 1990 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return null;

  let hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = t[3] === undefined ? 0 : Number(t[3]);
  const meridiem = t[4] ? t[4].toUpperCase() : null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;

  const when = new Date(y, mo - 1, da, hour, minute, second, 0);
  if (Number.isNaN(when.getTime())) return null;
  return {
    iso: when.toISOString(),
    day: `${y}-${pad2(mo)}-${pad2(da)}`,
    time: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
  };
};

// ------------------------------------------------------------------
// Header / noise detection
// ------------------------------------------------------------------
const isSeparatorLine = (line) => /^[-=_*~]{3,}$/.test(line.trim());
const isHeaderLine = (line) => {
  const l = line.trim();
  if (!l) return false;
  if (isSeparatorLine(l)) return true;
  const has = (re) => re.test(l);
  // `Date  Time  Ext CO  Dial Number  Ring Duration  Acc code CD`
  return has(/\bdate\b/i) && has(/\btime\b/i) && (has(/\bext/i) && has(/\b(co|trunk|line)\b/i));
};
// The PBX echoes prompts/results on the same TCP stream; they are not records.
const isControlLine = (line) => {
  const l = line.trim();
  return !l
    || /^(ok|error|rejected|ready|login|username|password|authenticat)/i.test(l)
    || /^at[dt]?[+:]?\d*/i.test(l);
};

// ------------------------------------------------------------------
// Delimited records (handy for CSV/TSV exports and our own log files)
// ------------------------------------------------------------------
/**
 * Parse a delimited SMDR export (`date,time,ext,co,dialed,ring,duration,cd`).
 * `columns` maps our field names to 1-based column indexes; a header row with
 * recognisable names is used automatically when present.
 */
const COLUMN_ALIASES = {
  date: ['date', 'calldate', 'call_date'],
  time: ['time', 'calltime', 'call_time', 'start', 'starttime', 'start_time'],
  extension: ['ext', 'extn', 'extension', 'station', 'internal'],
  trunk: ['co', 'trunk', 'line', 'coline', 'co_line', 'trunknumber', 'trunk_number'],
  dialed_number: ['dial', 'dialed', 'dialled', 'dialnumber', 'dial_number', 'dialed_number', 'dialled_number', 'number', 'phone', 'called'],
  caller_number: ['caller', 'caller_number', 'clid', 'cli', 'callerid', 'caller_id'],
  ring_seconds: ['ring', 'ringtime', 'ring_time', 'ring_seconds'],
  duration_seconds: ['duration', 'dur', 'talk', 'talktime', 'talk_time', 'call_duration', 'duration_seconds'],
  condition_code: ['cd', 'code', 'condition', 'condition_code', 'calltype', 'call_type', 'direction', 'status'],
  account_code: ['acc', 'account', 'account_code', 'acct'],
  direction: ['direction', 'dir'],
};

const mapHeader = (cells) => {
  const map = {};
  cells.forEach((cell, i) => {
    const key = String(cell || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) return;
    Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => {
      if (map[field] === undefined && (aliases.includes(key) || aliases.includes(key.replace(/_/g, '')))) {
        map[field] = i;
      }
    });
  });
  return map;
};

// The order the Panasonic console prints when the log is exported as CSV
// (`Date,Time,Ext,CO,Dial Number,Ring,Duration,Acc code,CD`).
const DEFAULT_DELIMITED_ORDER = {
  date: 0,
  time: 1,
  extension: 2,
  trunk: 3,
  dialed_number: 4,
  ring_seconds: 5,
  duration_seconds: 6,
  account_code: 7,
  condition_code: 8,
};

const parseDelimited = (line, { delimiter, columns, headerMap }) => {
  const cells = line.split(delimiter).map((c) => c.trim());
  if (cells.length < 3) return null;
  let idx = headerMap && Object.keys(headerMap).length ? headerMap : columns;
  // No header row (and no PBX_SMDR_COLUMNS): fall back to the documented
  // column order when the row starts with a date and a time.
  if (!(idx && Object.keys(idx).some((k) => k in COLUMN_ALIASES))
    && DATE_TOKEN_RE.test(cells[0] || '') && TIME_TOKEN_RE.test(cells[1] || '')) {
    idx = DEFAULT_DELIMITED_ORDER;
  }
  const at = (field) => {
    const i = idx && idx[field];
    if (i === undefined || i === null) return '';
    return cells[Number(i)] !== undefined ? String(cells[Number(i)]) : '';
  };
  const hasAnyMapped = idx && Object.keys(idx).some((k) => k in COLUMN_ALIASES);
  if (!hasAnyMapped) return null;
  const dateToken = at('date');
  const timeToken = at('time');
  // Without a mapped date there is nothing to timestamp the call with.
  if (!dateToken) return null;
  return {
    dateToken,
    timeToken,
    extension: at('extension'),
    trunk: at('trunk'),
    dialed_number: at('dialed_number'),
    caller_number: at('caller_number'),
    ringToken: at('ring_seconds'),
    durationToken: at('duration_seconds'),
    condition_code: at('condition_code'),
    account_code: at('account_code'),
    directionHint: at('direction'),
  };
};

// ------------------------------------------------------------------
// The main entry point
// ------------------------------------------------------------------
/**
 * Parse one SMDR line.
 *
 * @returns {{ok: true, record: object} | {ok: false, reason: string, raw: string}}
 */
const parseSmdrLine = (rawLine, options = {}) => {
  const cfg = {
    dateFormat: 'auto',
    dayFirst: false,
    delimiter: ',',
    columns: null,
    // Used only when the PBX prints neither a direction marker nor a
    // condition code (see normaliseDirection).
    assumeDirection: 'incoming',
    ...options,
  };
  const raw = String(rawLine == null ? '' : rawLine).replace(/\r|\n/g, ' ').trim();
  if (!raw) return { ok: false, reason: 'blank', raw };
  // A JSON payload is checked before the header heuristic below: keys named
  // date/time/ext/co would otherwise look exactly like a Panasonic header row.
  const looksJson = raw.startsWith('{');
  if (!looksJson) {
    if (isSeparatorLine(raw)) return { ok: false, reason: 'separator', raw };
    if (isHeaderLine(raw)) return { ok: false, reason: 'header', raw };
    if (isControlLine(raw)) return { ok: false, reason: 'control', raw };
  }

  const finish = (partial, format) => {
    if (!partial.dateToken || !partial.timeToken) return { ok: false, reason: 'unparsed', raw };
    const moment = parseCallMoment(partial.dateToken, partial.timeToken, cfg);
    if (!moment) return { ok: false, reason: 'bad-timestamp', raw };

    const ring = partial.ringToken !== undefined && partial.ringToken !== null && partial.ringToken !== ''
      ? durationTokenToSeconds(partial.ringToken)
      : (partial.ring_seconds != null ? Number(partial.ring_seconds) : null);
    const durationSeconds = partial.duration_seconds != null
      ? Number(partial.duration_seconds)
      : durationTokenToSeconds(partial.durationToken);

    const condition = (partial.condition_code || '').trim().toUpperCase();
    const direction = normaliseDirection(partial.directionHint || partial.direction, condition, partial, cfg.assumeDirection);
    // The CLI of an incoming call sits in the same column as the dialled
    // number, so only an inbound record may claim a caller number.
    const dialedDigits = String(partial.dialed_number || '').replace(/\D/g, '');
    const callerNumber = cleanToken(partial.caller_number)
      || (direction === 'Incoming' && LONG_NUMBER_RE.test(dialedDigits) ? String(partial.dialed_number).trim() : '');
    if (!condition && !partial.directionHint && !partial.direction && (partial.dialed_number || partial.trunk)) {
      // Surfaced for the admin: the PBX is not printing condition codes, so
      // inbound/outbound had to be assumed.
      partial.assumed_direction = true;
    }

    return {
      ok: true,
      record: {
        call_at: moment.iso,
        call_day: moment.day,
        call_time: moment.time,
        direction,
        extension: cleanExtension(partial.extension),
        target_extension: cleanExtension(partial.target_extension),
        trunk: cleanToken(partial.trunk),
        dialed_number: cleanToken(partial.dialed_number),
        caller_number: callerNumber,
        ring_seconds: Number.isFinite(ring) ? Math.max(0, Math.round(ring)) : null,
        duration_seconds: Number.isFinite(durationSeconds) ? Math.max(0, Math.round(durationSeconds)) : null,
        condition_code: condition || null,
        account_code: cleanToken(partial.account_code) || null,
        answered: answeredFrom(condition, durationSeconds),
        // True when the PBX printed no condition code and the direction had to
        // be assumed (the status endpoint warns about this).
        assumed_direction: Boolean(partial.assumed_direction),
        parse_format: format,
        raw,
      },
    };
  };

  // ---- 1. JSON (our own webhook payloads, and PBX middleware that posts JSON)
  if (raw.startsWith('{')) {
    let body;
    try { body = JSON.parse(raw); } catch { return { ok: false, reason: 'bad-json', raw }; }
    const get = (...keys) => {
      for (const k of keys) {
        if (body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k];
        const hit = Object.keys(body).find((bk) => bk.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (hit !== undefined && body[hit] !== undefined && body[hit] !== null && body[hit] !== '') return body[hit];
      }
      return '';
    };
    const dateToken = get('date', 'calldate', 'callDay', 'call_day');
    const timeToken = get('time', 'calltime', 'start', 'callTime');
    const record = {
      dateToken: String(dateToken || ''),
      timeToken: String(timeToken || ''),
      extension: get('extension', 'ext', 'extn', 'station', 'internal'),
      trunk: get('trunk', 'co', 'line', 'coline'),
      dialed_number: get('dialednumber', 'diallednumber', 'dialed', 'dialled', 'dial', 'number', 'called'),
      caller_number: get('callernumber', 'caller', 'clid', 'cli', 'callerid'),
      ringToken: get('ring', 'ringtime', 'ringseconds', 'ring_seconds'),
      durationToken: get('duration', 'talktime', 'callduration', 'duration_seconds'),
      condition_code: get('conditioncode', 'condition', 'cd', 'code', 'calltype'),
      account_code: get('accountcode', 'account', 'acc'),
      directionHint: get('direction', 'dir'),
    };
    // A JSON payload may carry an explicit ISO timestamp instead of columns.
    const iso = get('callAt', 'call_at', 'timestamp', 'datetime', 'startedAt');
    if (!record.dateToken && iso) {
      const when = new Date(String(iso));
      if (Number.isNaN(when.getTime())) return { ok: false, reason: 'bad-timestamp', raw };
      const local = new Date(when.getTime());
      const result = finish({
        ...record,
        dateToken: `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`,
        timeToken: `${pad2(local.getHours())}:${pad2(local.getMinutes())}:${pad2(local.getSeconds())}`,
        duration_seconds: record.durationToken !== '' ? null : get('durationSeconds', 'duration_seconds', 'seconds', 'talkSeconds'),
        ring_seconds: get('ringSeconds', 'ring_seconds'),
      }, 'json');
      return result;
    }
    return finish(record, 'json');
  }

  // ---- 2. Delimited, when the caller configured it or a header row was seen
  if (cfg.delimiter) {
    const headerMap = (cfg.headerMap && Object.keys(cfg.headerMap).length)
      ? cfg.headerMap
      : (COLUMN_ALIASES && mapHeader(raw.split(cfg.delimiter)));
    const cells = raw.split(cfg.delimiter);
    // A row that starts with a date and a time is a delimited record even when
    // the feeder configures no column mapping (see DEFAULT_DELIMITED_ORDER).
    const positional = cells.length >= 5
      && DATE_TOKEN_RE.test((cells[0] || '').trim()) && TIME_TOKEN_RE.test((cells[1] || '').trim());
    const looksDelimited = raw.includes(cfg.delimiter)
      && (cfg.columns || Object.keys(headerMap).length || positional);
    if (looksDelimited) {
      const parsed = parseDelimited(raw, { delimiter: cfg.delimiter, columns: cfg.columns, headerMap });
      if (parsed) return finish(parsed, 'delimited');
    }
  }

  // ---- 3. Panasonic fixed/token format
  let tokens = raw.split(/\s+/).filter(Boolean);

  // Some models prefix the record with a call-type letter (I/O/D/S/h/t) before
  // the date. Keep it as a direction hint rather than losing the row.
  let leadingHint = '';
  if (tokens.length > 2 && /^[A-Za-z]{1,2}$/.test(tokens[0]) && DATE_TOKEN_RE.test(tokens[1])) {
    leadingHint = tokens[0];
    tokens = tokens.slice(1);
  }
  if (!DATE_TOKEN_RE.test(tokens[0] || '') || !TIME_TOKEN_RE.test(tokens[1] || '')) {
    return { ok: false, reason: 'unparsed', raw };
  }

  const dateToken = tokens[0];
  const timeToken = tokens[1];
  const rest = tokens.slice(2);

  const durationTokens = [];
  const numbers = [];
  const words = [];
  let incomingMarker = false;
  let outgoingMarker = false;
  let intercomMarker = false;

  for (const token of rest) {
    if (DURATION_APOS_HMS_RE.test(token) || DURATION_APOS_HMS2_RE.test(token)
      || DURATION_APOS_MS_RE.test(token)
      || DURATION_HMS_RE.test(token) || DURATION_MS_RE.test(token)) {
      durationTokens.push(token);
      continue;
    }
    if (token === '\\' || INCOMING_MARKER_RE.test(token)) { incomingMarker = true; continue; }
    if (OUTGOING_MARKER_RE.test(token)) { outgoingMarker = true; continue; }
    if (INTERCOM_MARKER_RE.test(token)) { intercomMarker = true; continue; }
    // A short run is an extension / trunk / internal number; anything longer
    // (or `+`-prefixed) is an external number — a caller's CLI or a number the
    // IT desk dialled out to.
    if (EXTENSION_TOKEN_RE.test(token)) { numbers.push({ value: token, long: false }); continue; }
    if (/^\+?\d{4,}$/.test(token)) { numbers.push({ value: token, long: true }); continue; }
    // Legacy station markers (`T1033`, `E108`) and everything else textual.
    const legacy = /^[TE](\d{2,6})$/.exec(token);
    if (legacy) { numbers.push({ value: legacy[1], long: false }); continue; }
    words.push(token);
  }

  // Ring and duration are printed in that order; a single duration-shaped
  // token is the call duration (Ring is blank when the call never rang, e.g.
  // an outgoing or internal call).
  let ringToken = null;
  let durationToken = durationTokens.length ? durationTokens[durationTokens.length - 1] : null;
  if (durationTokens.length >= 2) ringToken = durationTokens[0];

  // Panasonic prints Ext first, then CO, then Dial Number. A leading
  // verification code (`*9533`) is still the Ext column.
  const extension = numbers.length ? numbers[0].value : '';
  let trunk = '';
  let dialed = '';
  const tail = numbers.slice(1);
  // With two or more tokens left, the first is the CO/trunk line (1-3 digits).
  if (tail.length > 1 && /^\d{1,3}$/.test(tail[0].value) && !tail[0].long) {
    trunk = tail.shift().value;
  }
  // An incoming call with no CLI prints a marker instead of a number, leaving
  // only the CO line behind it.
  if (incomingMarker && tail.length === 1 && /^\d{1,3}$/.test(tail[0].value) && !tail[0].long) {
    trunk = tail.shift().value;
    dialed = '';
  } else if (tail.length) {
    // Otherwise the external number (longest / `+`-prefixed) is the dialled
    // number; two short tokens mean an internal extension-to-extension call.
    const external = tail.find((t) => t.long);
    dialed = (external || tail[0]).value;
  }


  // Condition code + accounting code from the textual tail.
  let condition = '';
  let accountCode = '';
  const extras = [];
  words.forEach((w) => {
    const upper = w.toUpperCase();
    if (!condition && KNOWN_CODES.has(upper)) { condition = upper; return; }
    if (!accountCode && /^[A-Za-z0-9]{1,12}$/.test(w) && !KNOWN_CODES.has(upper)) { accountCode = w; return; }
    extras.push(w);
  });

  const directionHint = leadingHint
    ? leadingHint
    : (incomingMarker ? 'I' : outgoingMarker ? 'O' : intercomMarker ? 'IC' : condition);

  // A `<INCOMING>` marker line has no dialled number at all: the Ext column is
  // the extension that received the call.
  if (!dialed && incomingMarker && extras.length) dialed = '';

  return finish({
    dateToken,
    timeToken,
    extension,
    trunk,
    dialed_number: dialed,
    caller_number: '',
    ringToken,
    durationToken,
    condition_code: condition,
    account_code: accountCode,
    directionHint,
  }, 'panasonic');
};

// ------------------------------------------------------------------
// Small normalisers
// ------------------------------------------------------------------
const cleanToken = (value) => {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  if (!s || s === '-' || s === '\\' || s === '/') return '';
  return s;
};

const cleanExtension = (value) => {
  const s = cleanToken(value);
  if (!s) return '';
  // 0005, 005 etc. are padding, not an extension.
  if (/^0+$/.test(s)) return '';
  return s.replace(/^0+(?=\d)/, '') || s;
};

/**
 * Decide Incoming / Outgoing / Internal.
 *
 * What we have to work with, in order of trustworthiness:
 *   1. the direction marker the PBX prints in the Dial Number column
 *      (`\`, `<I>`, `<INCOMING>`, `<INTERCOM>`);
 *   2. the condition code (`AN`, `RC`, `NA` are inbound stages; `O`/`L`/`W`
 *      are outbound);
 *   3. the shape of the numbers: two short internal numbers means an
 *      extension-to-extension call, whatever else is printed.
 *
 * When the PBX prints neither a marker nor a condition code — which happens on
 * a PBX whose console has "print condition codes" switched off — an external
 * call cannot be told apart from a CLI. `assumeDirection` (PBX_ASSUME_DIRECTION)
 * decides, and the status endpoint says the setting is in use so the site can
 * either turn the codes on in the PBX or pin the assumption.
 */
const normaliseDirection = (hint, condition, partial, assumeDirection = 'incoming') => {
  const h = String(hint || '').trim().toUpperCase();
  const rawDialed = String(partial.dialed_number || '');
  const dialed = rawDialed.replace(/\D/g, '');
  const ext = String(partial.extension || '').replace(/\D/g, '');
  const hasTrunk = Boolean(cleanToken(partial.trunk));
  const externalDial = LONG_NUMBER_RE.test(dialed) || /^\+/.test(rawDialed);
  // An extension-to-extension call: the dialled number is a station number and
  // the extension is not dialling itself.
  const internalDial = dialed.length > 0 && dialed.length <= 4 && !externalDial && dialed !== ext;

  if (INTERCOM_MARKER_RE.test(h)) return 'Internal';
  if (INCOMING_MARKER_RE.test(h) && !externalDial) return 'Incoming';
  if (internalDial) return 'Internal';
  if (OUTGOING_CODES.has(h) || OUTGOING_CODES.has(condition)) return 'Outgoing';
  if (INCOMING_CODES.has(h) || ANSWERED_CODES.has(h) || MISSED_CODES.has(h)
    || INCOMING_CODES.has(condition) || ANSWERED_CODES.has(condition) || MISSED_CODES.has(condition)) {
    return 'Incoming';
  }
  if (TRANSFER_CODES.has(h)) return 'Incoming';
  if (externalDial || hasTrunk) {
    if (String(assumeDirection).toLowerCase() === 'outgoing') return 'Outgoing';
    return 'Incoming';
  }
  return 'Incoming';
};

const answeredFrom = (condition, durationSeconds) => {
  if (ANSWERED_CODES.has(condition)) return true;
  if (MISSED_CODES.has(condition)) return false;
  if (condition && TRANSFER_CODES.has(condition)) return true;
  // No condition code printed: a call with talk time was answered, a
  // zero-second call was not.
  if (Number.isFinite(durationSeconds)) return Number(durationSeconds) > 0;
  return null;
};

/** Split a raw SMDR capture into individual records (handles \r\n and \n). */
const splitLines = (text) => String(text == null ? '' : text).split(/\r\n|\r|\n/);

/**
 * Parse a whole capture. Returns the records plus a per-line audit so the
 * admin can see exactly which lines were skipped and why.
 */
const parseCapture = (text, options = {}) => {
  const lines = splitLines(text);
  const records = [];
  const skipped = [];
  let headerMap = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A delimited export announces its columns in a header row; remember them.
    if (options.delimiter && trimmed.includes(options.delimiter) && /date/i.test(trimmed) && /time/i.test(trimmed)) {
      const candidate = mapHeader(trimmed.split(options.delimiter));
      if (Object.keys(candidate).length >= 3) { headerMap = candidate; continue; }
    }
    const parsed = parseSmdrLine(trimmed, { ...options, headerMap });
    if (parsed.ok) records.push(parsed.record);
    else if (parsed.reason !== 'blank' && parsed.reason !== 'separator' && parsed.reason !== 'header' && parsed.reason !== 'control') {
      skipped.push({ reason: parsed.reason, raw: parsed.raw.slice(0, 500) });
    }
  }
  return { records, skipped };
};

module.exports = {
  parseSmdrLine,
  parseCapture,
  parseCallMoment,
  durationTokenToSeconds,
  formatSeconds,
  splitLines,
  isHeaderLine,
  ANSWERED_CODES,
  MISSED_CODES,
  KNOWN_CODES,
};
