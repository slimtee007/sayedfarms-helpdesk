/**
 * PBX module façade.
 *
 * `server.js` talks only to this file: it injects the few helpers the call
 * logger needs (id generation, persistence, ticket creation, sockets), then
 * starts the configured SMDR transport. Everything else — parsing, storage,
 * ticket policy, reporting — lives in `./service.js`.
 */

'use strict';

const service = require('./service');
const { pbxConfig, describeConfig } = require('./config');
const { createTransports } = require('./transports');

let transports = null;

/**
 * Wire the module to the running server. `deps` must provide:
 *   genId            — the server's monotonic id generator
 *   saveData         — persists db.json (calls/extensions included)
 *   getUsers         — live user array (re-assigned on delete, so a getter)
 *   getTickets       — live ticket array
 *   newTicketRecord  — builds a ticket object with the server's exact shape
 *   addTicket        — inserts it, saves, and notifies the dispatch queue
 *   io               — Socket.IO server (for live console updates)
 */
const init = (deps) => {
  service.setDeps(deps);
  transports = createTransports({
    config: pbxConfig,
    onText: (text) => service.ingestText(text, { source: 'smdr' }),
    log: deps.log || ((msg) => console.log(msg)),
  });
  return status();
};

/** Start reading call records (no-op unless PBX_ENABLED is true). */
const start = () => (transports ? transports.start() : null);

const stop = () => {
  if (transports) transports.stop();
};

const status = () => service.status(transports ? transports.getState() : {});

module.exports = {
  ...service,
  init,
  start,
  stop,
  status,
  pbxConfig,
  describeConfig,
};
