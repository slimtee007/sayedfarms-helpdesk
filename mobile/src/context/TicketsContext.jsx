import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, socket } from '../lib/api.js';
import { useSession } from './SessionContext.jsx';

// Fallback dropdown values (kept in step with the desktop app). The live list
// comes from GET /api/meta/enums; these keep the forms usable offline.
export const FALLBACK_ENUMS = {
  ticketStatus: ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled'],
  ticketPriority: ['Low', 'Medium', 'High', 'Urgent'],
  ticketCategory: ['Hardware', 'Software', 'Network', 'Access/Security', 'Account', 'Other'],
};

const TicketsContext = createContext(null);

/**
 * Loads everything the mobile screens need in one place: the signed-in user's
 * ticket queue (the server scopes it per role — employees get their own
 * tickets, agents the ones assigned to them), the agent directory for the
 * "direct request" picker, and the server's enum lists. Live updates arrive
 * over the socket ('ticket_changed' / 'ticket_created') and debounce into a
 * silent refresh.
 */
export function TicketsProvider({ children }) {
  const { token, logout } = useSession();
  const [tickets, setTickets] = useState([]);
  const [agents, setAgents] = useState([]);
  const [enums, setEnums] = useState(FALLBACK_ENUMS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inflight = useRef(false);
  const pending = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!token) return;
    if (inflight.current) { pending.current = true; return; }
    inflight.current = true;
    if (!silent) setLoading(true);
    try {
      const [t, a, e] = await Promise.all([
        api('/api/tickets', { token }),
        api('/api/agents', { token }),
        api('/api/meta/enums', { token }),
      ]);
      if (t.status === 401 || e.status === 401) { logout(); return; }
      if (t.ok && Array.isArray(t.data)) setTickets(t.data);
      if (a.ok && Array.isArray(a.data)) setAgents(a.data);
      if (e.ok && e.data && typeof e.data === 'object') setEnums({ ...FALLBACK_ENUMS, ...e.data });
      setError(t.ok ? '' : (t.data?.error || 'Could not load your requests.'));
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      inflight.current = false;
      setLoading(false);
      if (pending.current) { pending.current = false; refresh(true); }
    }
  }, [token, logout]);

  useEffect(() => {
    if (token) {
      refresh();
    } else {
      setTickets([]);
      setAgents([]);
      setEnums(FALLBACK_ENUMS);
      setLoading(false);
      setError('');
    }
  }, [token, refresh]);

  // Live queue updates — debounced so a burst of socket events (an agent
  // reassigning work, a status change, a new message) costs one refresh.
  useEffect(() => {
    if (!token) return undefined;
    let timer = null;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh(true), 350);
    };
    socket.on('ticket_changed', handler);
    socket.on('ticket_created', handler);
    return () => {
      socket.off('ticket_changed', handler);
      socket.off('ticket_created', handler);
      clearTimeout(timer);
    };
  }, [token, refresh]);

  return (
    <TicketsContext.Provider value={{ tickets, agents, enums, loading, error, refresh }}>
      {children}
    </TicketsContext.Provider>
  );
}

export const useTickets = () => useContext(TicketsContext);
