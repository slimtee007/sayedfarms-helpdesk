import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, clearSession, loadSession, saveSession, socket } from '../lib/api.js';

const SessionContext = createContext(null);

/**
 * Holds the signed-in session (token + user), mirrors it to localStorage,
 * keeps the shared socket authenticated, and picks up role changes made by
 * someone else (same contract as the desktop console).
 */
export function SessionProvider({ children }) {
  const [session, setSession] = useState(() => loadSession());

  // Authenticate / drop the shared socket whenever the session changes.
  useEffect(() => {
    if (session?.token) {
      socket.auth = { token: session.token };
      socket.disconnect();
      socket.connect();
    } else {
      socket.disconnect();
    }
  }, [session?.token]);

  const login = useCallback(async (email, password) => {
    const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    if (r.ok && r.data?.token && r.data?.user) {
      const next = { token: r.data.token, user: r.data.user };
      saveSession(next);
      setSession(next);
    }
    return r;
  }, []);

  // Public signups are always employee accounts — no role is ever sent.
  const signup = useCallback(async (name, email, password) => {
    const r = await api('/api/auth/signup', { method: 'POST', body: { name, email, password } });
    if (r.ok && r.data?.token && r.data?.user) {
      const next = { token: r.data.token, user: r.data.user };
      saveSession(next);
      setSession(next);
    }
    return r;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  // Who am I, according to the server — picks up a role change (employee
  // promoted to agent, super-admin granted/revoked) without a re-login.
  useEffect(() => {
    if (!session?.token) return undefined;
    let cancelled = false;
    (async () => {
      const r = await api('/api/auth/me', { token: session.token });
      if (cancelled) return;
      if (r.status === 401) {
        logout();
        return;
      }
      if (r.ok && r.data?.role) {
        const prev = loadSession();
        if (prev && JSON.stringify(prev.user) !== JSON.stringify(r.data)) {
          const next = { token: prev.token, user: r.data };
          saveSession(next);
          setSession(next);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [session?.token, logout]);

  const value = useMemo(
    () => ({
      session,
      user: session?.user || null,
      token: session?.token || null,
      login,
      signup,
      logout,
    }),
    [session, login, signup, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
