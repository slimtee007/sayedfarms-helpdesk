import { io } from 'socket.io-client';

// Same-origin by default: in dev, Vite proxies /api and /socket.io to the
// backend; in production the mobile app is served from the same origin as the
// backend (or set VITE_API_URL to point at it directly).
export const API_URL = import.meta.env.VITE_API_URL || '';

const TOKEN_KEY = 'token';
const USER_KEY = 'user';

/**
 * Read the stored session. Returns { token, user } or null.
 * Mirrors the desktop frontend's storage keys ('token' / 'user') and its
 * "usable session" rule: a token with a missing or role-less user is not a
 * session, it is leftover garbage.
 */
export const loadSession = () => {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (token && user && (user.role === 'agent' || user.role === 'user')) {
      return { token, user };
    }
    return null;
  } catch {
    try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
    return null;
  }
};

export const saveSession = ({ token, user }) => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* storage unavailable — session lives in memory only */ }
};

export const clearSession = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
};

/**
 * Small fetch wrapper. Returns { ok, status, data } and never throws for
 * HTTP errors — callers branch on ok/status and show the API's own error
 * message when there is one.
 */
export async function api(path, { method = 'GET', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error — check your connection and try again.' } };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// One shared socket, authenticated with the session token once a session
// exists (SessionContext). The server ignores chat/join emits from
// unauthenticated sockets, so the socket stays disconnected while logged out.
export const socket = io(API_URL, { autoConnect: false });
