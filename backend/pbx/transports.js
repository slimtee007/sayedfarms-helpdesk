/**
 * SMDR transports — how call records physically reach the helpdesk.
 *
 * Panasonic systems deliver SMDR in three ways depending on the model and how
 * the site is cabled, so all three are supported and chosen by configuration:
 *
 *   tcp-client  the PBX listens on its SMDR port (2300/22300 on the KX-NS/NSX
 *               series) and we connect to it. The NS/NSX expects the SMDR
 *               username/password before it prints anything.
 *   tcp-server  the PBX (or a serial-to-IP device on the KX-TDA/TDE RS-232
 *               port) connects *to us* and pushes records. We just listen.
 *   webhook     middleware posts records to `POST /api/pbx/calls` (see
 *               server.js) — nothing to listen for here.
 *
 * Everything is defensive: a PBX that reboots, drops the socket or never
 * answers must never take the helpdesk down, so sockets are reconnected with
 * backoff and every error is recorded for the status endpoint instead of
 * throwing.
 */

'use strict';

const net = require('net');

const MAX_BUFFER = 64 * 1024; // a runaway peer can't exhaust memory
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;

const nowIso = () => new Date().toISOString();

/**
 * Turn a stream of chunks into whole SMDR lines.
 *
 * PBX feeds are line-oriented but the framing is not guaranteed, so partial
 * lines are held until their terminator arrives rather than parsed as records.
 */
const createLineFramer = (onLine, { onOverflow } = {}) => {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_BUFFER) {
      if (onOverflow) onOverflow(buffer.length);
      buffer = '';
      return;
    }
    let index = buffer.search(/\r\n|\n|\r/);
    while (index !== -1) {
      const line = buffer.slice(0, index);
      const sepLength = buffer.startsWith('\r\n', index) ? 2 : 1;
      buffer = buffer.slice(index + sepLength);
      if (line.trim()) onLine(line);
      index = buffer.search(/\r\n|\n|\r/);
    }
  };
};

/**
 * The SMDR login handshake is not call data: the feed greets us with a banner
 * and a prompt (`SMDR\r\nPassword: `) before any record is printed, and some
 * firmwares glue the first record straight onto the prompt. Strip that prefix
 * so the record that follows is still framed as a whole line.
 */
const SMDR_PROMPT_RE = /(^|[\r\n])[ \t]*(?:SMDR(?:[ \t]+FEED|[ \t]+DATA)?|PBX)[ \t]*:?[ \t]*/gi;
const SMDR_CREDENTIAL_PROMPT_RE = /(^|[\r\n])[ \t]*(?:Password|Passwd|Passcode|Login|Log-in|User(?:name)?|Account)[ \t]*:?[ \t]*/gi;
const stripHandshake = (text) => {
  let out = String(text || '');
  out = out.replace(SMDR_PROMPT_RE, '$1').replace(SMDR_CREDENTIAL_PROMPT_RE, '$1');
  // `SOMETHING: ` glued in front of a record (`Password: 21/09/25 ...`) — keep
  // everything from the first date-like token on.
  out = out.replace(/^([^\r\n]*?)(\d{2,4}[/\-.]\d{1,2}[/\-.]\d{2,4})/, '$2');
  return out;
};

const createTransports = ({ config, onText, log = () => {} }) => {
  const state = {
    mode: 'off',
    status: 'disabled',
    detail: 'PBX_ENABLED is not true',
    connectedAt: null,
    remote: null,
    lastLineAt: null,
    lastError: null,
    linesReceived: 0,
    connections: 0,
    reconnects: 0,
    startedAt: null,
    credentialSent: false,
  };

  let clientSocket = null;
  let server = null;
  let reconnectTimer = null;
  let stopped = true;
  let backoff = BACKOFF_BASE_MS;

  const setStatus = (status, detail) => {
    state.status = status;
    if (detail !== undefined) state.detail = detail;
  };

  const handleLine = (line) => {
    state.linesReceived += 1;
    state.lastLineAt = nowIso();
    try {
      onText(`${line}\r\n`);
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
      log(`[PBX] Failed to ingest an SMDR line: ${state.lastError}`);
    }
  };

  // ------------------------------------------------------------------
  // tcp-client: we connect to the PBX's SMDR port
  // ------------------------------------------------------------------
  const sendCredentials = (socket) => {
    if (state.credentialSent) return;
    const { username, password } = config;
    if (!password) return;
    state.credentialSent = true;
    // The KX-NS/NSX SMDR feed prompts for the SMDR account. Sending the pair
    // up-front covers both "prompt first" and "silent" PBX behaviours.
    if (username) socket.write(`${username}\r\n`);
    socket.write(`${password}\r\n`);
    log('[PBX] Sent SMDR credentials to the PBX.');
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = Math.min(BACKOFF_MAX_MS, Math.round(backoff * (0.8 + Math.random() * 0.4)));
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    state.reconnects += 1;
    setStatus('reconnecting', `Retrying ${config.host}:${config.port} in ${Math.round(delay / 1000)}s (${state.lastError || 'connection closed'})`);
    reconnectTimer = setTimeout(connectClient, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  };

  function connectClient() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    setStatus('connecting', `Connecting to ${config.host}:${config.port}`);
    const socket = net.createConnection({ host: config.host, port: config.port });
    clientSocket = socket;
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);
    const framer = createLineFramer(handleLine, {
      onOverflow: (size) => {
        state.lastError = `Discarded ${size} bytes from the PBX — no line terminator was found.`;
        log(`[PBX] ${state.lastError}`);
      },
    });

    socket.on('connect', () => {
      state.connectedAt = nowIso();
      state.remote = `${config.host}:${config.port}`;
      state.lastError = null;
      backoff = BACKOFF_BASE_MS;
      setStatus('connected', `Connected to ${config.host}:${config.port}`);
      log(`[PBX] Connected to the PBX SMDR feed at ${config.host}:${config.port}`);
      sendCredentials(socket);
    });
    // A prompt can be split across packets, so a short record-less prefix is
    // held until the rest of it (or the first record) arrives.
    let preface = '';
    socket.on('data', (chunk) => {
      const raw = preface + chunk.toString('utf8');
      preface = '';
      // Some PBX firmwares echo a password prompt before the records start.
      if (!state.credentialSent && /pass|login|user/i.test(raw) && config.password) sendCredentials(socket);
      const text = stripHandshake(raw);
      if (!state.linesReceived && text.length < 64 && !/[\r\n]/.test(text) && !/\d{2,4}[/\-.]\d{1,2}[/\-.]\d{2,4}/.test(text)) {
        preface = text;
        return;
      }
      framer(text);
    });
    socket.on('error', (err) => {
      state.lastError = err && err.message ? err.message : String(err);
      log(`[PBX] SMDR socket error: ${state.lastError}`);
    });
    socket.on('close', () => {
      state.connectedAt = null;
      state.credentialSent = false;
      if (stopped) return;
      scheduleReconnect();
    });
    return socket;
  }

  // ------------------------------------------------------------------
  // tcp-server: the PBX / serial-to-IP gateway pushes records to us
  // ------------------------------------------------------------------
  const startServer = () => {
    setStatus('listening', `Listening on ${config.listenHost}:${config.listenPort}`);
    server = net.createServer((socket) => {
      state.connections += 1;
      state.remote = `${socket.remoteAddress}:${socket.remotePort}`;
      state.connectedAt = nowIso();
      state.lastError = null;
      setStatus('connected', `Receiving records from ${state.remote}`);
      log(`[PBX] SMDR feed connected from ${state.remote}`);
      socket.setNoDelay(true);
      const framer = createLineFramer(handleLine, { onOverflow: () => log('[PBX] Discarded an oversized buffer.') });
      socket.on('data', framer);
      socket.on('error', (err) => {
        state.lastError = err && err.message ? err.message : String(err);
        log(`[PBX] Inbound SMDR socket error: ${state.lastError}`);
      });
      socket.on('close', () => {
        state.connectedAt = null;
        setStatus('listening', `Listening on ${config.listenHost}:${config.listenPort}`);
      });
    });
    server.on('error', (err) => {
      state.lastError = err && err.message ? err.message : String(err);
      setStatus('error', `Could not listen on ${config.listenHost}:${config.listenPort} — ${state.lastError}`);
      log(`[PBX] Listener error: ${state.lastError}`);
    });
    server.listen(config.listenPort, config.listenHost);
  };

  const start = () => {
    if (!config.enabled) {
      setStatus('disabled', 'PBX_ENABLED is not true — no call records are being read.');
      return state;
    }
    if (config.transport === 'webhook') {
      setStatus('webhook', 'Waiting for records on POST /api/pbx/calls');
      return state;
    }
    stopped = false;
    state.mode = config.transport;
    state.startedAt = nowIso();
    if (config.transport === 'tcp-client') {
      if (!config.host) {
        setStatus('error', 'PBX_HOST is not set, so there is nothing to connect to.');
        return state;
      }
      connectClient();
    } else if (config.transport === 'tcp-server') {
      if (!config.listenPort) {
        setStatus('error', 'PBX_LISTEN_PORT is not set, so the listener has nowhere to listen.');
        return state;
      }
      startServer();
    } else {
      setStatus('disabled', `Unknown PBX_TRANSPORT "${config.transport}".`);
    }
    return state;
  };

  const stop = () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (clientSocket) {
      clientSocket.removeAllListeners('close');
      clientSocket.destroy();
      clientSocket = null;
    }
    if (server) {
      server.close();
      server = null;
    }
    setStatus('stopped', 'Stopped');
  };

  return { start, stop, getState: () => ({ ...state }) };
};

module.exports = { createTransports, createLineFramer };
