import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, Navigate, Link, useLocation } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Activity, Plus, ShieldCheck, User, LogOut, Image as ImageIcon, X, Paperclip, Users, Ticket, UserPlus, Copy, Check, Trash2, Box, PackagePlus, ChevronRight, Search, Headphones, KeyRound, AlertCircle, Monitor, Laptop, FilePlus, ChevronDown, Filter, MessageSquare, Send, Timer, FileText, Download, Printer, Phone, PhoneCall, RefreshCw, ClipboardList, BarChart3 } from 'lucide-react';
import ForgotPassword from './pages/ForgotPassword.jsx';

// Same-origin by default: in dev, Vite proxies /api and /socket.io to the
// backend; in production the frontend is expected to be served from the same
// origin as the backend. Override with VITE_API_URL if hosted elsewhere.
const API_URL = import.meta.env.VITE_API_URL || '';
// Connected explicitly once a session exists (see MainRouter): the server
// ignores chat/join emits from unauthenticated sockets.
const socket = io(API_URL, { autoConnect: false });

// Fallback dropdown values. The live list comes from GET /api/meta/enums
// (#32/#33): the server used to reject or silently rewrite options the UI
// offered, so the UI now renders whatever the API actually accepts. These
// defaults keep the forms usable if that call fails.
const FALLBACK_ENUMS = {
  ticketStatus: ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed', 'Cancelled'],
  ticketPriority: ['Low', 'Medium', 'High', 'Urgent'],
  ticketCategory: ['Hardware', 'Software', 'Network', 'Access/Security', 'Account', 'Other'],
  inventoryStatus: ['In Stock', 'Assigned', 'In Repair', 'Retired', 'Under Maintenance', 'Decommissioned'],
  // Server-owned asset-category pick list (#asset-categories). Kept in step
  // with VALID_INVENTORY_CATEGORY in backend/server.js — the live list comes
  // from GET /api/meta/enums, this is the offline fallback.
  inventoryCategory: ['Laptop', 'Desktop Computer', 'Monitor', 'Printer', 'Cartridge', 'Toner', 'IP Camera', 'Solar PTZ Camera', 'NVR', 'SSD/HDD', 'Network Equipment', 'Peripherals', 'Server', 'UPS', 'Other'],
};

// Human labels for values whose API name is terse.
const STATUS_LABELS = {
  Pending: 'Pending / On Hold',
  'In Repair': 'In Repair',
};

const statusLabel = (value) => STATUS_LABELS[value] || value;

// Three stock states, coloured consistently everywhere they appear:
// on the shelf (green), running out — at/below the reorder level (amber),
// shelf empty or not in the store room at all (red). The state itself is
// always computed server-side (stock_state) so UI and exports can't disagree.
const STOCK_BADGE_CLASSES = {
  'In Stock': 'bg-emerald-100 text-emerald-800',
  'Low Stock': 'bg-amber-100 text-amber-800',
  'Out of Stock': 'bg-red-100 text-red-800',
};
const StockStateBadge = ({ state }) => (
  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${STOCK_BADGE_CLASSES[state] || 'bg-slate-100 text-slate-600'}`}>
    {state}
  </span>
);

// Assignments are keyed by user id (#17) so two people with the same display
// name stay distinguishable and renaming someone never orphans their tickets.
// These literals are sentinel option values, never real ids.
const UNASSIGNED = 'Unassigned';
const LEGACY_ASSIGNEE = '__legacy_assignee__';

/**
 * Options for an assignee <select>. `current` is the row being edited
 * ({ assigned_to_id, assigned_to }) and `people` the candidates.
 */
const assigneeOptions = (people, current) => {
  const opts = [{ value: UNASSIGNED, label: 'Unassigned' }];
  (people || []).forEach((p) => opts.push({ value: p.id, label: p.name }));
  const currentId = current && current.assigned_to_id;
  const currentName = current && current.assigned_to;
  const known = currentId && opts.some((o) => o.value === currentId);
  if (currentId && !known) {
    // Assigned to someone outside this list (e.g. an employee on a ticket).
    opts.push({ value: currentId, label: `${currentName || 'Current assignee'} (not in this list)` });
  } else if (!currentId && currentName && currentName !== UNASSIGNED) {
    // A legacy/unresolvable name: keep it visible instead of pretending the
    // row is unassigned.
    opts.push({ value: LEGACY_ASSIGNEE, label: `${currentName} (account no longer exists)` });
  }
  return opts;
};

/**
 * Options for an asset-category <select> (#asset-categories). `categories` is
 * the server-owned list (GET /api/meta/enums); `current` keeps a row whose
 * stored value predates the list selectable instead of blanking the field.
 */
const categoryOptions = (categories, current) => {
  const list = categories && categories.length ? categories : FALLBACK_ENUMS.inventoryCategory;
  return current && !list.includes(current) ? [...list, current] : list;
};

// Super admins see every ticket and own the dispatch/user-management screens
// (#36). `super_admin` rides along on the signed-in user object.
const isSuperAdmin = (user) => Boolean(user && user.role === 'agent' && user.super_admin === true);

// Turn a chosen option value into the payload the API expects.
const assigneePayload = (value) => {
  if (!value || value === UNASSIGNED || value === LEGACY_ASSIGNEE) return { assigned_to_id: null };
  return { assigned_to_id: value };
};

// ---- MTTR (mean time to resolution) display helpers -----------------------
// `resolution_minutes` is stamped server-side when a ticket is resolved
// (resolved_at − created_at). Formatting is shared by the ticket tables and
// the MTTR report.
const formatDuration = (minutes) => {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const m = Math.max(0, Math.round(Number(minutes)));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
};

// A one-line timing summary for a ticket row: how long resolution took, or how
// old the request still is while it is being worked.
const ticketElapsed = (t) => {
  if (t.resolution_minutes != null) return `Resolved in ${formatDuration(t.resolution_minutes)}`;
  if (t.status === 'Cancelled') return null;
  const created = Date.parse(t.created_at);
  if (!Number.isFinite(created)) return null;
  return `Age ${formatDuration((Date.now() - created) / 60000)}`;
};

// Report bucket keys come back as YYYY-MM-DD (day), YYYY-MM-DD week starts
// (week) or YYYY-MM (month).
const bucketLabel = (bucket) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return bucket.slice(5).replace('-', '/');
  return bucket;
};

// ---- Report generation (CSV download + print / save-as-PDF) ----------------

// Download a CSV export. The endpoints need the session token, so this goes
// through fetch + blob rather than a plain link.
const downloadCsv = async (token, url, fallbackName) => {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return alert(data.error || `Could not generate the export (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^";]+)"?/i);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (match && match[1]) || fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch {
    alert('Network error — could not reach the server.');
  }
};

const escHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Print / Save-as-PDF via a hidden iframe: a clean, chrome-free document the
// browser can print or archive without shipping a PDF dependency.
const openPrintableReport = (title, bodyHtml) => {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  const doc = win && win.document;
  if (!doc) {
    document.body.removeChild(iframe);
    return alert('Printing is not available in this browser.');
  }
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, Arial, sans-serif; color: #1e293b; margin: 28px; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { color: #64748b; margin-bottom: 16px; }
  h2 { font-size: 12px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: #475569; }
  td.num, th.num { text-align: right; }
  .muted { color: #94a3b8; }
</style></head><body>${bodyHtml}</body></html>`);
  doc.close();
  win.focus();
  win.print();
  // Give the print dialog time to open before the iframe goes away.
  setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 2000);
};

// Table/KPI builders for the printable documents.
const printTable = (headers, rows, numCols = []) => {
  const body = rows.length ? rows : [headers.map((h, i) => (i === 0 ? 'No data' : ''))];
  return `
  <table><thead><tr>${headers.map((h, i) => `<th${numCols.includes(i) ? ' class="num"' : ''}>${escHtml(h)}</th>`).join('')}</tr></thead>
  <tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td${numCols.includes(i) ? ' class="num"' : ''}>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
};
const printKpis = (pairs) => `
  <table><thead><tr>${pairs.map(([label]) => `<th>${escHtml(label)}</th>`).join('')}</tr></thead>
  <tbody><tr>${pairs.map(([, value]) => `<td>${escHtml(value)}</td>`).join('')}</tr></tbody></table>`;
const printHeader = (title, metaLines) => `
  <h1>${escHtml(title)}</h1>
  <div class="meta">${metaLines.map(escHtml).join(' · ')}</div>`;

// ---- PBX call log helpers -------------------------------------------------
// Every IP-phone call the Panasonic PBX reports (SMDR) is stored as a call
// record; the ones that rang in the IT office raise a ticket. These helpers
// only format what the server already computed — the duration, the direction
// and the solved / not-solved state all come from the API.

const CALL_DIRECTION_STYLES = {
  Incoming: 'bg-blue-50 text-blue-700 border-blue-200',
  Outgoing: 'bg-amber-50 text-amber-700 border-amber-200',
  Internal: 'bg-slate-100 text-slate-600 border-slate-200',
};

const CALL_OUTCOME_STYLES = {
  Solved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Not solved': 'bg-red-50 text-red-700 border-red-200',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200',
};

const CALL_OUTCOMES = ['Solved', 'Not solved', 'Pending'];

// `2025-09-21` + `15:10:00` -> `21/09/2025 15:10` (the PBX's own wall clock).
const callStamp = (call) => {
  const [y, m, d] = String(call.call_day || '').split('-');
  const time = String(call.call_time || '').slice(0, 5);
  if (!y || !m || !d) return `${call.call_day || ''} ${time}`.trim();
  return `${d}/${m}/${y} ${time}`;
};

const callDateLabel = (call) => {
  const day = String(call.call_day || '');
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (day === todayKey) return 'Today';
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  return day === yKey ? 'Yesterday' : day;
};

// A phone-raised ticket, marked wherever tickets are listed so an agent can
// tell a call request from a portal one at a glance.
const PhoneSourceBadge = () => (
  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200" title="Raised from an IP-phone call (Panasonic PBX)">
    <Phone className="h-2.5 w-2.5" /> Phone
  </span>
);

// Catches any render-time exception and shows a recoverable message instead of
// unmounting the whole app into a blank page.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info && info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-slate-100 text-slate-800 flex items-center justify-center p-6 font-sans">
        <div className="bg-white border border-slate-200 rounded-lg shadow-md p-8 max-w-md w-full text-center">
          <div className="mx-auto mb-4 p-3 bg-red-50 border border-red-200 rounded-full w-fit">
            <AlertCircle className="h-6 w-6 text-red-600" />
          </div>
          <h1 className="text-base font-bold text-slate-900 mb-2">Something went wrong on this page</h1>
          <p className="text-xs text-slate-600 mb-3">
            Your tickets and data are safe on the server. You can try again, reload, or sign in again from a clean session.
          </p>
          <pre className="text-left text-[10px] text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-4 overflow-auto max-h-28">
            {String((this.state.error && this.state.error.message) || this.state.error)}
          </pre>
          <div className="flex justify-center gap-2">
            <button onClick={() => this.setState({ error: null })} className="px-3 py-1.5 bg-[#0052CC] hover:bg-blue-700 text-white text-xs font-medium rounded transition">
              Try again
            </button>
            <button onClick={() => window.location.reload()} className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-medium rounded transition">
              Reload page
            </button>
            <button
              onClick={() => { window.localStorage.clear(); window.location.assign('/login'); }}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs rounded transition"
            >
              Sign out & clear session
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <MainRouter />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

function MainRouter() {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem('token') || ''; } catch { return ''; }
  });
  // A corrupt "user" value used to throw inside the useState initialiser and
  // white-screen the app on every load until the browser storage was cleared
  // by hand.
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('user') || 'null');
    } catch {
      try { localStorage.removeItem('user'); } catch {}
      return null;
    }
  });
  const [tickets, setTickets] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [agentsList, setAgentsList] = useState([]);
  // Email-free {id,name,role} directory for the asset-assignment pickers (#36).
  const [peopleList, setPeopleList] = useState([]);
  const [inventoryList, setInventoryList] = useState([]);
  // Status/category/priority lists come from the API so the dropdowns can only
  // ever offer values the server accepts (#32/#33).
  const [enums, setEnums] = useState(FALLBACK_ENUMS);
  // Which ticket's chat modal is open (set by the consoles below), plus the
  // session state the live-refresh handler needs. Refs keep that handler
  // subscribed once instead of re-registering on every render.
  const chatTicketIdRef = useRef(null);
  const loggedInRef = useRef(false);
  const fetchTicketsRef = useRef(() => {});
  
  const navigate = useNavigate();

  // Single source of truth for "is there a usable session?". A token with a
  // missing/corrupt/role-less user (e.g. half-cleared localStorage) used to
  // bounce /portal -> /login -> /portal forever and render nothing at all.
  const loggedIn = Boolean(token && user && (user.role === 'agent' || user.role === 'user'));

  // Authenticate the shared socket with the current session token so chat
  // emits carry a verified identity. Reconnects when the session changes and
  // disconnects on sign-out (registered listeners survive reconnects).
  useEffect(() => {
    if (loggedIn && token) {
      socket.auth = { token };
      socket.disconnect();
      socket.connect();
    } else {
      socket.disconnect();
    }
  }, [loggedIn, token]);

  // Live queue updates (#36): the server tells a session when a ticket it may
  // see has changed — a super admin reassigning work away from (or to) an
  // agent, a new request arriving in the dispatch queue, a status change.
  // Subscribed once and read through refs, so it survives every re-render.
  useEffect(() => {
    const handler = () => {
      if (!loggedInRef.current) return;
      // A thread is open on that ticket; the modal refreshes itself.
      const active = chatTicketIdRef.current;
      if (active) return;
      fetchTicketsRef.current();
    };
    socket.on('ticket_changed', handler);
    socket.on('ticket_created', handler);
    return () => {
      socket.off('ticket_changed', handler);
      socket.off('ticket_created', handler);
    };
  }, []);

  // A 401 means the session is invalid or expired — drop it and bounce to login.
  const handleUnauthorized = (res) => {
    if (res.status === 401) {
      handleLogout();
      return true;
    }
    return false;
  };

  // Declared as a function (not a const arrow) so the effect above can call it
  // without tripping the "used before initialised" lint rule.
  async function fetchEnums() {
    try {
      const res = await fetch(`${API_URL}/api/meta/enums`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      // Merge over the fallback so a partial response can't blank a dropdown.
      if (res.ok && data && typeof data === 'object') setEnums({ ...FALLBACK_ENUMS, ...data });
    } catch (err) {
      console.error('Could not load dropdown options; using built-in defaults.', err);
    }
  }

  const fetchTickets = async () => {
    try {
      const res = await fetch(`${API_URL}/api/tickets`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (res.ok) setTickets(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_URL}/api/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (!res.ok) return;
      setUsersList(data);
      // If an admin changed my own role, move to the right console immediately.
      if (user) {
        const me = data.find((u) => u.id === user.id);
        if (me && me.role !== user.role) {
          const updated = { ...user, role: me.role };
          localStorage.setItem('user', JSON.stringify(updated));
          setUser(updated);
          navigate(me.role === 'agent' ? '/agent/tickets' : '/portal');
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchAgents = async () => {
    try {
      const res = await fetch(`${API_URL}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (res.ok) setAgentsList(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchPeople = async () => {
    try {
      const res = await fetch(`${API_URL}/api/people`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (res.ok) setPeopleList(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchInventory = async () => {
    try {
      const res = await fetch(`${API_URL}/api/inventory`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (handleUnauthorized(res)) return;
      const data = await res.json();
      if (res.ok) setInventoryList(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (loggedIn) {
      fetchEnums();
      fetchTickets();
      // The full user directory is super-admin-only (#36): it feeds the
      // dispatch and User Management screens. Everyone else — agents included —
      // gets the trimmed agent picker for the "direct request" dropdown.
      if (isSuperAdmin(user)) {
        fetchUsers();
        fetchInventory();
      } else if (user?.role === 'agent') {
        fetchInventory();
        fetchAgents();
        fetchPeople();
      } else {
        fetchAgents();
      }
    }
  }, [loggedIn]);


  // Pick up role / super-admin changes made by someone else (#36) without a
  // sign-out: the same account can be promoted to dispatcher, or have that
  // access revoked, while this tab is open.
  useEffect(() => {
    if (!loggedIn || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (handleUnauthorized(res) || !res.ok) return;
        const fresh = await res.json();
        if (cancelled || !fresh || !fresh.role) return;
        if (fresh.role !== user?.role || Boolean(fresh.super_admin) !== Boolean(user?.super_admin)) {
          localStorage.setItem('user', JSON.stringify(fresh));
          setUser(fresh);
        }
      } catch (err) {
        console.error(err);
      }
    })();
    return () => { cancelled = true; };
  }, [loggedIn, token]);

  // Keep the live-refresh handler's refs pointing at the newest values.
  useEffect(() => {
    loggedInRef.current = loggedIn;
    fetchTicketsRef.current = fetchTickets;
  });


  const handleLogout = () => {
    localStorage.clear();
    setToken('');
    setUser(null);
    navigate('/login');
  };

  return (
    <Routes>
      {/* Auth Routes */}
      <Route 
        path="/login" 
        element={!loggedIn ? <AuthScreen setToken={setToken} setUser={setUser} /> : <Navigate to={user?.role === 'agent' ? '/agent/tickets' : '/portal'} />} 
      />
      <Route 
        path="/signup" 
        element={!loggedIn ? <AuthScreen initialMode="signup" setToken={setToken} setUser={setUser} /> : <Navigate to={user?.role === 'agent' ? '/agent/tickets' : '/portal'} />} 
      />
      <Route
        path="/forgot-password"
        element={<ForgotPasswordRoute />}
      />

      {/* Customer / Employee Portal Routes */}
      <Route 
        path="/portal/*" 
        element={
          loggedIn && user?.role === 'user' ? (
            <CustomerPortal
              user={user}
              tickets={tickets}
              agentsList={agentsList}
              enums={enums}
              fetchTickets={fetchTickets}
              handleLogout={handleLogout}
              token={token}
            />
          ) : (
            <Navigate to="/login" />
          )
        } 
      />

      {/* Agent Console Routes */}
      <Route 
        path="/agent/*" 
        element={
          loggedIn && user?.role === 'agent' ? (
            <AgentConsole 
              user={user} 
              tickets={tickets} 
              usersList={usersList} 
              inventoryList={inventoryList || []} 
              enums={enums} 
              peopleList={peopleList}
              onChatTicketChange={(id) => { chatTicketIdRef.current = id; }}
              fetchTickets={fetchTickets} 
              fetchUsers={fetchUsers} 
              fetchInventory={fetchInventory} 
              handleLogout={handleLogout} 
              token={token} 
            />
          ) : (
            <Navigate to="/login" />
          )
        } 
      />

      {/* Default Fallback */}
      <Route 
        path="*" 
        element={<Navigate to={!loggedIn ? '/login' : user?.role === 'agent' ? '/agent/tickets' : '/portal'} />} 
      />
    </Routes>
  );
}

// Standalone password-reset page. ForgotPassword honours the server's
// emailSent/devOtp response contract, unlike the old inline form it replaces.
function ForgotPasswordRoute() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex items-center justify-center p-4 font-sans">
      <ForgotPassword onBackToLogin={() => navigate('/login')} apiBase={API_URL} />
    </div>
  );
}

function AuthScreen({ initialMode = 'login', setToken, setUser }) {
  // #20: the Agent Console's "Invite" button copies `${origin}?invite=<email>`
  // — honour it. Landing on the app with that query switches this screen to
  // signup and pre-fills the invited email. Read once at mount; navigating
  // within the app never carries an invite.
  const [invitedBy] = useState(() => {
    const invite = new URLSearchParams(window.location.search).get('invite');
    return invite && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite) ? invite : null;
  });
  const [authMode, setAuthMode] = useState(invitedBy ? 'signup' : initialMode);
  const [authForm, setAuthForm] = useState(() => (invitedBy
    ? { name: '', email: invitedBy, password: '' }
    : { name: '', email: '', password: '' }));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      // Public signups are always employee accounts — agent access is granted
      // by an existing agent from the console. No `role` is ever sent.
      const payload = authMode === 'login'
        ? { email: authForm.email, password: authForm.password }
        : { name: authForm.name, email: authForm.email, password: authForm.password };
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Authentication failed');

      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
      navigate(data.user.role === 'agent' ? '/agent/tickets' : '/portal');
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex items-center justify-center p-4 font-sans">
      <div className="bg-white border border-slate-200 p-8 rounded-lg w-full max-w-md shadow-md">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <div className="p-2.5 bg-[#0052CC] rounded text-white shadow-sm">
            <Activity className="h-6 w-6" />
          </div>
          <span className="font-bold text-2xl tracking-tight text-slate-900">Help Desk</span>
        </div>

        {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 text-xs rounded">{error}</div>}
        {invitedBy && authMode === 'signup' && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 text-[#0052CC] text-xs rounded">
            You were invited by <span className="font-semibold">{invitedBy}</span> — create your account to get started.
          </div>
        )}

        <form onSubmit={handleAuth} className="space-y-4">
          {authMode === 'signup' && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Full Name</label>
              <input required type="text" value={authForm.name} className="w-full bg-slate-50 border border-slate-300 rounded p-2 text-xs focus:bg-white focus:border-[#0052CC] focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Email Address</label>
            <input required type="email" value={authForm.email} className="w-full bg-slate-50 border border-slate-300 rounded p-2 text-xs focus:bg-white focus:border-[#0052CC] focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="block text-xs font-semibold text-slate-600">Password</label>
              {authMode === 'login' && (
                <Link to="/forgot-password" className="text-[11px] text-[#0052CC] hover:underline">Forgot password?</Link>
              )}
            </div>
            <input required type="password" value={authForm.password} className="w-full bg-slate-50 border border-slate-300 rounded p-2 text-xs focus:bg-white focus:border-[#0052CC] focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} />
          </div>
          <button type="submit" disabled={loading} className="w-full py-2.5 bg-[#0052CC] hover:bg-blue-700 font-medium text-xs text-white rounded transition shadow-sm disabled:opacity-50">
            {loading ? (authMode === 'login' ? 'Signing in...' : 'Creating Account...') : (authMode === 'login' ? 'Sign In' : 'Create Account')}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-slate-500">
          {authMode === 'login' ? (
            <p>Need an account? <button onClick={() => { setAuthMode('signup'); setError(''); }} className="text-[#0052CC] font-semibold hover:underline">Sign up</button></p>
          ) : (
            <p>Already registered? <button onClick={() => { setAuthMode('login'); setError(''); }} className="text-[#0052CC] font-semibold hover:underline">Log in</button></p>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-ticket chat thread between the employee and the assigned agent.
// History is persisted on the ticket; new messages arrive in real time
// over the ticket's socket room. `sender` is 'user' or 'agent'.
function TicketChatModal({ ticket, sender, senderName, onClose, onMessagesChanged, token }) {
  const [messages, setMessages] = useState(ticket.messages || []);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState('');
  const bottomRef = useRef(null);
  const otherSide = sender === 'agent' ? 'employee' : 'IT agent';

  useEffect(() => {
    setMessages(ticket.messages || []);
  }, [ticket.id]);

  useEffect(() => {
    socket.emit('join_ticket', ticket.id);
    const handler = (payload) => {
      if (payload.ticketId !== ticket.id) return;
      setMessages((prev) =>
        prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message]
      );
      if (onMessagesChanged) onMessagesChanged();
    };
    socket.on('receive_ticket_message', handler);
    return () => {
      socket.off('receive_ticket_message', handler);
      socket.emit('leave_ticket', ticket.id);
    };
  }, [ticket.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send through the REST endpoint so a message is persisted (and broadcast to
  // the ticket room by the server) even if the socket is still connecting or
  // has dropped. The socket remains the live *receive* path; echoes are
  // de-duplicated by message id.
  const handleSend = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    setSendError('');
    try {
      const res = await fetch(`${API_URL}/api/tickets/${ticket.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sender, senderName, text }),
      });
      if (!res.ok) throw new Error('send failed');
      const message = await res.json();
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      if (onMessagesChanged) onMessagesChanged();
    } catch {
      setInput(text);
      setSendError('Could not send your message. Check your connection and try again.');
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
      <div className="bg-white border border-slate-200 rounded-lg shadow-2xl w-full max-w-lg flex flex-col h-[520px] overflow-hidden">
        <div className="bg-[#0052CC] text-white px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold">Ticket Chat — {ticket.title}</div>
            <div className="text-[11px] text-blue-100">
              {ticket.status} · {ticket.category} · Assigned: {ticket.assigned_to}
            </div>
          </div>
          <button onClick={onClose} className="text-blue-100 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 p-3 overflow-y-auto space-y-3 bg-slate-50 text-xs">
          {messages.length === 0 && (
            <div className="text-center text-slate-400 py-8">
              No messages yet. Start the conversation with the {otherSide}.
            </div>
          )}
          {messages.map((msg) => {
            const mine = msg.sender === sender;
            return (
              <div key={msg.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] p-2.5 rounded-lg ${mine ? 'bg-[#0052CC] text-white rounded-br-none' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-none shadow-xs'}`}>
                  <span className={`block text-[9px] font-bold mb-0.5 ${mine ? 'text-blue-100' : 'text-slate-400'}`}>
                    {mine ? 'You' : (msg.senderName || otherSide)}
                  </span>
                  {msg.text}
                </div>
                <span className="text-[10px] text-slate-400 mt-0.5 px-1">{msg.time}</span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {sendError && (
          <div className="px-3 py-2 bg-red-50 border-t border-red-200 text-red-600 text-[11px]">{sendError}</div>
        )}
        <form onSubmit={handleSend} className="p-3 bg-white border-t border-slate-200 flex gap-2">
          <input
            type="text"
            placeholder={`Message the ${otherSide}...`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 bg-slate-100 border border-slate-200 rounded px-3 py-2 text-xs focus:bg-white focus:border-[#0052CC] focus:outline-none"
          />
          <button type="submit" className="bg-[#0052CC] hover:bg-blue-700 text-white px-3 py-2 rounded transition flex items-center justify-center">
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
}

function CustomerPortal({ user, tickets, agentsList = [], enums = FALLBACK_ENUMS, fetchTickets, handleLogout, token }) {
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Shown inside the create-request modal when the POST fails (#19).
  const [ticketError, setTicketError] = useState('');
  const [chatTicketId, setChatTicketId] = useState(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  // No fabricated chat history (#21): the widget starts empty and only ever
  // shows messages that were really sent.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatBottomRef = useRef(null);
  const location = useLocation();
  const isMyTicketsView = location.pathname.includes('tickets');

  const groupDetails = {
    all: { name: 'Select a category...', desc: '' },
    common: { name: 'Common Requests', desc: 'Get IT help, Request a new account, Report a system problem, Report broken hardware' },
    computers: { name: 'Computers', desc: 'Get IT help, Request new software, Request new hardware, Report broken hardware' },
    logins: { name: 'Logins and Accounts', desc: 'Request admin access, Request a new account, Onboard new employees' },
    applications: { name: 'Applications', desc: 'Request new software, Report a system problem' },
    servers: { name: 'Servers and Infrastructure', desc: 'Report a system problem, Report broken hardware' }
  };

  const [newTicket, setNewTicket] = useState({
    title: '',
    description: '',
    category: 'Hardware',
    priority: 'Medium',
    assigned_to_id: UNASSIGNED,
    image: ''
  });

  useEffect(() => {
    // Named handler so cleanup detaches only THIS listener (#22). The old
    // socket.off('receive_message') with no handler detached every
    // component's listener on the shared module-level socket.
    const handler = (incomingMessage) => {
      setChatMessages((prev) => [...prev, incomingMessage]);
    };
    socket.on('receive_message', handler);
    return () => { socket.off('receive_message', handler); };
  }, []);

  useEffect(() => {
    if (isChatOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

  // The API stores attachments inline and rejects anything over ~2 MB of
  // base64, which used to happen silently *after* the user pressed submit.
  // Refuse it up front, with a real message.
  const MAX_IMAGE_BYTES = 1_500_000;

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setTicketError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)} MB. Please attach a smaller screenshot.`);
      e.target.value = '';
      return;
    }
    setTicketError('');
    const reader = new FileReader();
    reader.onloadend = () => {
      setNewTicket({ ...newTicket, image: reader.result });
    };
    reader.readAsDataURL(file);
  };

  const handleCreateTicket = async (e) => {
    e.preventDefault();
    setTicketError('');
    try {
      const res = await fetch(`${API_URL}/api/tickets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        // The modal holds the ID (or the 'Unassigned' sentinel) — the API keys
        // assignments by user id (#17), so translate before sending.
        body: JSON.stringify({ ...newTicket, ...assigneePayload(newTicket.assigned_to_id) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep the modal open and the draft intact so nothing is lost (#19).
        return setTicketError(data.error || `Could not create the request (HTTP ${res.status}). Please try again.`);
      }
      setIsModalOpen(false);
      setTicketError('');
      setNewTicket({ title: '', description: '', category: 'Hardware', priority: 'Medium', assigned_to_id: UNASSIGNED, image: '' });
      fetchTickets();
    } catch (err) {
      setTicketError('Network error — could not reach the server. Check your connection and try again.');
    }
  };

  const closeTicketModal = () => {
    setIsModalOpen(false);
    setTicketError('');
  };

  const openSpecificModal = (requestTypeTitle, defaultCategory) => {
    setNewTicket({
      title: requestTypeTitle,
      description: '',
      category: defaultCategory,
      priority: 'Medium',
      assigned_to_id: UNASSIGNED,
      image: ''
    });
    setTicketError('');
    setIsModalOpen(true);
  };

  const handleCancelTicket = async (id) => {
    // A failed cancel used to be invisible: the row just snapped back to its
    // old status on the refetch, with no explanation (#33's cousin).
    const res = await fetch(`${API_URL}/api/tickets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ status: 'Cancelled' })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Could not cancel this request (HTTP ${res.status}).`);
    }
    fetchTickets();
  };

  const handleSendChatMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const messagePayload = {
      sender: 'user',
      senderName: user.name,
      text: chatInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    socket.emit('send_message', messagePayload);
    setChatInput('');
  };

  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans flex flex-col relative">
      <header className="bg-[#0052CC] text-white px-8 py-3 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-6">
          <div className="font-semibold text-base flex items-center gap-2 tracking-tight cursor-pointer" onClick={() => { setSelectedGroup('all'); navigate('/portal'); }}>
            Help Center
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(isMyTicketsView ? '/portal' : '/portal/tickets')} className="text-xs bg-blue-700 hover:bg-blue-800 px-3 py-1.5 rounded font-medium transition">
            {isMyTicketsView ? 'Raise a Request' : `My Requests (${tickets.length})`}
          </button>
          <div className="flex items-center gap-2 border-l border-blue-400/30 pl-4">
            <span className="text-xs font-medium">{user.name}</span>
            <button onClick={handleLogout} title="Sign Out" className="p-1 hover:bg-blue-700 rounded transition text-blue-100">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="bg-[#0747A6] h-36 w-full relative overflow-hidden flex items-center justify-center">
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:16px_16px]"></div>
        {selectedGroup === 'all' && !isMyTicketsView && (
          <div className="relative w-full max-w-4xl px-6">
            <div className="relative">
              <Search className="absolute left-4 top-3.5 h-4 w-4 text-slate-400" />
              <input type="text" placeholder="Search for help topics, articles, or request types..." className="w-full bg-white text-slate-800 pl-11 pr-4 py-3 rounded-md text-sm shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
          </div>
        )}
      </div>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-6 pb-20">
        <nav className="text-xs text-slate-500 flex items-center gap-1.5 mb-2">
          <Link to="/portal" onClick={() => setSelectedGroup('all')} className="hover:underline text-blue-600">Help Center</Link>
          <ChevronRight className="h-3 w-3" />
          <span>SayedFarm IT</span>
        </nav>
        <h1 className="text-2xl font-bold text-slate-900 mb-1">SayedFarm IT</h1>
        <p className="text-sm text-slate-600 mb-6">Welcome! You can raise a request for SayedFarm IT using the options provided.</p>

        {!isMyTicketsView ? (
          <div>
            <div className="mb-6">
              <label className="block text-xs text-slate-500 mb-1">Contact us about</label>
              <div className="relative w-full max-w-xl">
                <div 
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  className="w-full bg-white border border-blue-500 text-slate-800 rounded px-3 py-2.5 text-xs shadow-xs flex items-center justify-between cursor-pointer focus:outline-none ring-2 ring-blue-100"
                >
                  <span className="font-medium text-slate-800">{groupDetails[selectedGroup].name}</span>
                  <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                </div>

                {isDropdownOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded shadow-xl z-30 max-h-80 overflow-y-auto divide-y divide-slate-100">
                    {Object.keys(groupDetails).map((key) => (
                      <div 
                        key={key}
                        onClick={() => {
                          setSelectedGroup(key);
                          setIsDropdownOpen(false);
                        }}
                        className={`p-3 hover:bg-blue-50 cursor-pointer transition ${selectedGroup === key ? 'bg-blue-50/80' : ''}`}
                      >
                        <div className="font-semibold text-xs text-[#0052CC]">
                          {groupDetails[key].name}
                        </div>
                        {groupDetails[key].desc && (
                          <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
                            {groupDetails[key].desc}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {selectedGroup === 'all' && (
              <div className="space-y-3">
                <div onClick={() => setSelectedGroup('common')} className="bg-white border border-slate-200 hover:border-blue-400 hover:shadow-sm rounded-md p-4 transition cursor-pointer flex items-center justify-between group">
                  <div>
                    <h3 className="font-semibold text-blue-600 group-hover:underline text-sm mb-1">Common Requests</h3>
                    <p className="text-xs text-slate-500">Get IT help, Request a new account, Report a system problem, Report broken hardware</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
                </div>
                <div onClick={() => setSelectedGroup('computers')} className="bg-white border border-slate-200 hover:border-blue-400 hover:shadow-sm rounded-md p-4 transition cursor-pointer flex items-center justify-between group">
                  <div>
                    <h3 className="font-semibold text-blue-600 group-hover:underline text-sm mb-1">Computers</h3>
                    <p className="text-xs text-slate-500">Get IT help, Request new software, Request new hardware, Report broken hardware</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
                </div>
                <div onClick={() => setSelectedGroup('logins')} className="bg-white border border-slate-200 hover:border-blue-400 hover:shadow-sm rounded-md p-4 transition cursor-pointer flex items-center justify-between group">
                  <div>
                    <h3 className="font-semibold text-blue-600 group-hover:underline text-sm mb-1">Logins and Accounts</h3>
                    <p className="text-xs text-slate-500">Request admin access, Request a new account, Onboard new employees</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
                </div>
                <div onClick={() => setSelectedGroup('applications')} className="bg-white border border-slate-200 hover:border-blue-400 hover:shadow-sm rounded-md p-4 transition cursor-pointer flex items-center justify-between group">
                  <div>
                    <h3 className="font-semibold text-blue-600 group-hover:underline text-sm mb-1">Applications</h3>
                    <p className="text-xs text-slate-500">Request new software, Report a system problem</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
                </div>
                <div onClick={() => setSelectedGroup('servers')} className="bg-white border border-slate-200 hover:border-blue-400 hover:shadow-sm rounded-md p-4 transition cursor-pointer flex items-center justify-between group">
                  <div>
                    <h3 className="font-semibold text-blue-600 group-hover:underline text-sm mb-1">Servers and Infrastructure</h3>
                    <p className="text-xs text-slate-500">Report a system problem, Report broken hardware</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-blue-600" />
                </div>
              </div>
            )}

            {selectedGroup !== 'all' && (
              <div>
                <h2 className="text-base font-semibold text-slate-900 mb-4">What can we help you with?</h2>
                <div className="space-y-4">
                  {selectedGroup === 'common' && (
                    <>
                      <div onClick={() => openSpecificModal('Get IT help', 'Hardware')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Headphones className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Get IT help</h4>
                          <p className="text-xs text-slate-500">Get assistance for general IT problems and questions.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Request a new account', 'Access/Security')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <UserPlus className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Request a new account</h4>
                          <p className="text-xs text-slate-500">Request a new account for a system.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Report a system problem', 'Software')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Report a system problem</h4>
                          <p className="text-xs text-slate-500">Let us know if something isn't working properly and we'll aim to get it back up and running quickly.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Report broken hardware', 'Hardware')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Monitor className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Report broken hardware</h4>
                          <p className="text-xs text-slate-500">Report hardware that might be faulty or broken e.g. a broken computer screen or a damaged server.</p>
                        </div>
                      </div>
                    </>
                  )}
                  {selectedGroup === 'computers' && (
                    <>
                      <div onClick={() => openSpecificModal('Get IT help', 'Hardware')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Headphones className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Get IT help</h4>
                          <p className="text-xs text-slate-500">Get assistance for general IT problems and questions.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Request new software', 'Software')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <FilePlus className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Request new software</h4>
                          <p className="text-xs text-slate-500">If you need a software license, raise a request here.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Request new hardware', 'Hardware')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Laptop className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Request new hardware</h4>
                          <p className="text-xs text-slate-500">For example, a new mouse or monitor.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Report broken hardware', 'Hardware')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Monitor className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Report broken hardware</h4>
                          <p className="text-xs text-slate-500">Report hardware that might be faulty or broken e.g. a broken computer screen or a damaged server.</p>
                        </div>
                      </div>
                    </>
                  )}
                  {selectedGroup === 'logins' && (
                    <>
                      <div onClick={() => openSpecificModal('Request admin access', 'Access/Security')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <KeyRound className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Request admin access</h4>
                          <p className="text-xs text-slate-500">For example, if you need to administer Jira.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Request a new account', 'Access/Security')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <UserPlus className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Request a new account</h4>
                          <p className="text-xs text-slate-500">Request a new account for a system.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Onboard new employees', 'Access/Security')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Users className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Onboard new employees</h4>
                          <p className="text-xs text-slate-500">Request access for new employees.</p>
                        </div>
                      </div>
                    </>
                  )}
                  {selectedGroup === 'applications' && (
                    <>
                      <div onClick={() => openSpecificModal('Request new software', 'Software')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <FilePlus className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Request new software</h4>
                          <p className="text-xs text-slate-500">If you need a software license, raise a request here.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Report a system problem', 'Software')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Report a system problem</h4>
                          <p className="text-xs text-slate-500">Let us know if something isn't working properly and we'll aim to get it back up and running quickly.</p>
                        </div>
                      </div>
                    </>
                  )}
                  {selectedGroup === 'servers' && (
                    <>
                      <div onClick={() => openSpecificModal('Report a system problem', 'Network')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Report a system problem</h4>
                          <p className="text-xs text-slate-500">Let us know if something isn't working properly and we'll aim to get it back up and running quickly.</p>
                        </div>
                      </div>
                      <div onClick={() => openSpecificModal('Report broken hardware', 'Hardware')} className="flex items-start gap-4 p-3 hover:bg-slate-100 rounded-md cursor-pointer group transition">
                        <Monitor className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-600 group-hover:underline">Report broken hardware</h4>
                          <p className="text-xs text-slate-500">Report hardware that might be faulty or broken e.g. a broken computer screen or a damaged server.</p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-800 mb-4">My Submitted Requests</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500 font-semibold uppercase">
                  <tr>
                    <th className="pb-2">Summary</th>
                    <th className="pb-2">Category</th>
                    <th className="pb-2">Assigned Agent</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tickets.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="py-6 text-center text-slate-400">You haven't submitted any support requests yet.</td>
                    </tr>
                  ) : (
                    tickets.map(t => (
                      <tr key={t.id} className="hover:bg-slate-50">
                        <td className="py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-slate-800">{t.title}</span>
                            {t.source === 'pbx_call' && <PhoneSourceBadge />}
                          </div>
                          {/* MTTR: how long the resolution took (or how old the request still is). */}
                          {ticketElapsed(t) && (
                            <div className="text-[10px] text-slate-400 mt-0.5">{ticketElapsed(t)}</div>
                          )}
                        </td>
                        <td className="py-3 text-slate-500">{t.category}</td>
                        <td className="py-3 text-slate-600 font-medium">{t.assigned_to}</td>
                        <td className="py-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.status === 'Open' ? 'bg-yellow-100 text-yellow-800' : t.status === 'In Progress' ? 'bg-blue-100 text-blue-800' : t.status === 'Pending' ? 'bg-amber-100 text-amber-800' : t.status === 'Cancelled' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>
                            {t.status}
                          </span>
                        </td>
                        <td className="py-3 text-right whitespace-nowrap">
                          <button onClick={() => setChatTicketId(t.id)} className="text-[#0052CC] hover:underline mr-3">
                            Chat{(t.messages?.length || 0) > 0 ? ` (${t.messages.length})` : ''}
                          </button>
                          {t.status !== 'Closed' && t.status !== 'Cancelled' && (
                            <button onClick={() => handleCancelTicket(t.id)} className="text-red-600 hover:underline">Cancel Request</button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      <div className="fixed bottom-6 right-6 z-50">
        {!isChatOpen ? (
          <button 
            onClick={() => setIsChatOpen(true)}
            className="bg-[#0052CC] hover:bg-blue-700 text-white p-3.5 rounded-full shadow-lg flex items-center gap-2 transition transform hover:scale-105"
          >
            <MessageSquare className="h-5 w-5" />
            <span className="text-xs font-semibold pr-1">Live IT Chat</span>
          </button>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg shadow-2xl w-80 sm:w-96 flex flex-col h-[420px] overflow-hidden">
            <div className="bg-[#0052CC] text-white px-4 py-3 flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></div>
                <span className="text-xs font-semibold">SayedFarm IT Support Chat</span>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-blue-100 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 p-3 overflow-y-auto space-y-3 bg-slate-50 text-xs">
              {chatMessages.length === 0 && (
                <div className="h-full flex items-center justify-center text-slate-400 text-[11px] text-center px-4">
                  No messages yet — say hello and an available IT agent will reply here.
                </div>
              )}
              {chatMessages.map((msg, index) => (
                <div key={index} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] p-2.5 rounded-lg ${msg.sender === 'user' ? 'bg-[#0052CC] text-white rounded-br-none' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-none shadow-xs'}`}>
                    <span className="block text-[9px] font-bold text-slate-400 mb-0.5">{msg.sender === 'agent' ? `IT Agent (${msg.senderName || 'Staff'})` : 'You'}</span>
                    {msg.text}
                  </div>
                  <span className="text-[10px] text-slate-400 mt-0.5 px-1">{msg.time}</span>
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>

            <form onSubmit={handleSendChatMessage} className="p-3 bg-white border-t border-slate-200 flex gap-2">
              <input 
                type="text" 
                placeholder="Type a message to IT agent..." 
                value={chatInput} 
                onChange={(e) => setChatInput(e.target.value)} 
                className="flex-1 bg-slate-100 border border-slate-200 rounded px-3 py-2 text-xs focus:bg-white focus:border-[#0052CC] focus:outline-none" 
              />
              <button type="submit" className="bg-[#0052CC] hover:bg-blue-700 text-white px-3 py-2 rounded transition flex items-center justify-center">
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        )}
      </div>

      <footer className="text-center py-4 text-xs text-slate-400 border-t border-slate-200 mt-auto bg-white">
        Powered by Jira Service Management
      </footer>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-lg shadow-2xl p-6 w-full max-w-lg text-slate-800">
            <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
              <h2 className="text-base font-bold text-slate-900">{newTicket.title}</h2>
              <button onClick={closeTicketModal} className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreateTicket} className="space-y-4">
              {ticketError && <div className="p-3 bg-red-50 border border-red-200 text-red-600 text-xs rounded">{ticketError}</div>}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Summary / Issue Title *</label>
                <input required type="text" value={newTicket.title} onChange={(e) => setNewTicket({ ...newTicket, title: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Details & Description *</label>
                <textarea required placeholder="Provide extra detail about your issue..." value={newTicket.description} onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none h-24" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Direct Request to Agent (Optional)</label>
                {/* Keyed by agent id (#17): two agents with the same display
                    name used to be indistinguishable here. */}
                <select value={newTicket.assigned_to_id} onChange={(e) => setNewTicket({ ...newTicket, assigned_to_id: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                  <option value={UNASSIGNED}>Any Available IT Agent</option>
                  {agentsList.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                  {/* Rendered from the API's list: the portal used to offer
                      only 4 of the 6 categories the server accepts. */}
                  <select value={newTicket.category} onChange={(e) => setNewTicket({ ...newTicket, category: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                    {enums.ticketCategory.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Urgency / Priority</label>
                  {/* "Urgent" was accepted by the API but unreachable here. */}
                  <select value={newTicket.priority} onChange={(e) => setNewTicket({ ...newTicket, priority: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                    {enums.ticketPriority.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Attachment (Screenshot or Image)</label>
                <input type="file" accept="image/*" className="text-xs text-slate-500" onChange={handleImageUpload} />
              </div>
              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                <button type="button" onClick={closeTicketModal} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
                <button type="submit" className="px-4 py-1.5 bg-[#0052CC] hover:bg-blue-700 text-white font-medium text-xs rounded shadow-sm">Create Request</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {chatTicketId && (() => {
        const t = tickets.find((x) => x.id === chatTicketId);
        return t ? (
          <TicketChatModal
            ticket={t}
            sender="user"
            senderName={user.name}
            onClose={() => { setChatTicketId(null); fetchTickets(); }}
            onMessagesChanged={fetchTickets}
            token={token}
          />
        ) : null;
      })()}
    </div>
  );
}

/**
 * MTTR (mean time to resolution) report — the agent-facing analytics screen.
 *
 * Feeds on GET /api/reports/mttr: the server aggregates the per-ticket
 * lifecycle stamps (created_at → resolved_at) and scopes the numbers to the
 * caller — a super admin sees the whole helpdesk, a regular agent the tickets
 * assigned to them. Charts are hand-rolled SVG, so there is no charting
 * dependency to ship or audit.
 */
function MttrReports({ token }) {
  const RANGES = [
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
    { value: '365', label: '12 months' },
    { value: 'all', label: 'All time' },
  ];
  const [days, setDays] = useState('30');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_URL}/api/reports/mttr?days=${days}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setReport(null);
          setError(data.error || `Could not load the MTTR report (HTTP ${res.status}).`);
        } else {
          setReport(data);
        }
      } catch {
        if (!cancelled) {
          setReport(null);
          setError('Network error — could not reach the server.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [days, token]);

  const s = report && report.summary;

  // Printable copy of exactly what is on screen (Print / Save as PDF).
  const handlePrint = () => {
    if (!report || !s) return;
    const rangeName = (RANGES.find((r) => r.value === days) || {}).label || String(days);
    let body = printHeader(`MTTR Report — ${rangeName}`, [
      report.scope === 'all' ? 'Scope: all tickets' : 'Scope: tickets assigned to me',
      `Generated ${new Date(report.range.to).toLocaleString()}`,
    ]);
    body += printKpis([
      ['MTTR (mean)', formatDuration(s.meanMinutes)],
      ['Median', formatDuration(s.medianMinutes)],
      ['Fastest', formatDuration(s.minMinutes)],
      ['Slowest', formatDuration(s.maxMinutes)],
      ['Resolved tickets', String(s.count)],
      ['Mean first reply', s.meanFirstResponseMinutes == null ? '—' : formatDuration(s.meanFirstResponseMinutes)],
      ['Reopens', String(s.reopenedCount)],
    ]);
    body += `<h2>Resolution time per ${escHtml(report.bucket)}</h2>` + printTable(
      ['Period', 'Resolved', 'Mean (min)', 'Median (min)'],
      report.trend.map((b) => [bucketLabel(b.bucket), b.count, b.meanMinutes, b.medianMinutes]),
      [1, 2, 3],
    );
    body += '<h2>By category</h2>' + printTable(
      ['Category', 'Resolved', 'Mean (min)', 'Median (min)', 'Slowest (min)'],
      report.byCategory.map((g) => [g.key, g.count, g.meanMinutes, g.medianMinutes, g.maxMinutes]),
      [1, 2, 3, 4],
    );
    body += '<h2>By priority</h2>' + printTable(
      ['Priority', 'Resolved', 'Mean (min)', 'Median (min)', 'Slowest (min)'],
      report.byPriority.map((g) => [g.key, g.count, g.meanMinutes, g.medianMinutes, g.maxMinutes]),
      [1, 2, 3, 4],
    );
    if (report.byAgent.length > 0) {
      body += '<h2>By agent</h2>' + printTable(
        ['Agent', 'Resolved', 'Mean (min)', 'Median (min)', 'Slowest (min)'],
        report.byAgent.map((a) => [a.name, a.count, a.meanMinutes, a.medianMinutes, a.maxMinutes]),
        [1, 2, 3, 4],
      );
    }
    body += '<h2>Slowest resolved tickets</h2>' + printTable(
      ['Ticket', 'Category', 'Priority', 'Agent', 'Time to resolve (min)'],
      report.slowest.map((t) => [t.title, t.category, t.priority, t.agentName, t.minutes]),
      [4],
    );
    openPrintableReport(`MTTR Report (${rangeName})`, body);
  };

  const kpi = (label, value, hint) => (
    <div className="bg-white border border-slate-200 rounded-md p-3.5 shadow-sm">
      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold text-slate-900 mt-1">{value}</div>
      {hint ? <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div> : null}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500 max-w-xl">
          Mean time to resolution (MTTR) measures how long resolved tickets take from creation
          to resolution — including any time spent reopened. Cancelled and not-yet-resolved
          tickets are excluded. {report && report.scope === 'own' ? 'These numbers cover the tickets assigned to you.' : 'These numbers cover the whole helpdesk.'}
        </p>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-md p-1 shadow-sm">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setDays(r.value)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition ${days === r.value ? 'bg-[#0052CC] text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          {/* Report generation: CSV for spreadsheets, print for PDF archives. */}
          <button
            onClick={() => downloadCsv(token, `${API_URL}/api/reports/mttr/export?days=${days}`, `mttr-report-${days}.csv`)}
            disabled={!report}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-[11px] font-medium text-slate-600 hover:bg-slate-50 shadow-sm transition disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
          <button
            onClick={handlePrint}
            disabled={!report}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-[11px] font-medium text-slate-600 hover:bg-slate-50 shadow-sm transition disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
        </div>
      </div>

      {loading && (
        <div className="bg-white border border-slate-200 rounded-md p-10 text-center text-xs text-slate-400 shadow-sm">
          Loading resolution-time metrics…
        </div>
      )}
      {!loading && error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-xs text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && report && s && (
        <>
          {s.count === 0 ? (
            <div className="bg-white border border-slate-200 rounded-md p-10 text-center shadow-sm">
              <Timer className="h-6 w-6 text-slate-300 mx-auto mb-2" />
              <p className="text-xs text-slate-500">No tickets were resolved in this period.</p>
              <p className="text-[11px] text-slate-400 mt-1">Resolve a ticket (or widen the range) and its resolution time will show up here.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                {kpi('MTTR', formatDuration(s.meanMinutes), 'mean time to resolve')}
                {kpi('Median', formatDuration(s.medianMinutes), 'middle of the pack')}
                {kpi('Fastest', formatDuration(s.minMinutes), 'quickest resolution')}
                {kpi('Slowest', formatDuration(s.maxMinutes), 'longest resolution')}
                {kpi('Resolved', String(s.count), s.reopenedCount > 0 ? `${s.reopenedCount} reopen${s.reopenedCount === 1 ? '' : 's'} along the way` : 'in this period')}
                {kpi('First reply', s.meanFirstResponseMinutes == null ? '—' : formatDuration(s.meanFirstResponseMinutes), `avg · ${s.firstResponseCount} ticket${s.firstResponseCount === 1 ? '' : 's'}`)}
              </div>

              <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800 mb-1">MTTR trend</h3>
                <p className="text-[11px] text-slate-400 mb-3">Mean time to resolve per {report.bucket}. Hover a bar for the count behind it.</p>
                <MttrTrendChart trend={report.trend} />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <MttrBreakdown title="By category" rows={report.byCategory} />
                <MttrBreakdown title="By priority" rows={report.byPriority} />
              </div>

              {Array.isArray(report.byAgent) && report.byAgent.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-800 mb-3">By agent</h3>
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-400 font-semibold uppercase text-[10px] border-b border-slate-100">
                      <tr>
                        <th className="py-2 pr-2">Agent</th>
                        <th className="py-2 pr-2">Resolved</th>
                        <th className="py-2 pr-2">MTTR</th>
                        <th className="py-2 pr-2">Median</th>
                        <th className="py-2">Slowest</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {report.byAgent.map((a) => (
                        <tr key={a.id || 'unassigned'}>
                          <td className="py-2 pr-2 font-medium text-slate-700">{a.name}</td>
                          <td className="py-2 pr-2 text-slate-600">{a.count}</td>
                          <td className="py-2 pr-2 text-slate-800 font-semibold">{formatDuration(a.meanMinutes)}</td>
                          <td className="py-2 pr-2 text-slate-600">{formatDuration(a.medianMinutes)}</td>
                          <td className="py-2 text-slate-600">{formatDuration(a.maxMinutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {report.slowest.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-800 mb-3">Slowest resolved tickets</h3>
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-400 font-semibold uppercase text-[10px] border-b border-slate-100">
                      <tr>
                        <th className="py-2 pr-2">Ticket</th>
                        <th className="py-2 pr-2">Category</th>
                        <th className="py-2 pr-2">Priority</th>
                        <th className="py-2 pr-2">Agent</th>
                        <th className="py-2 text-right">Time to resolve</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {report.slowest.map((t) => (
                        <tr key={t.id}>
                          <td className="py-2 pr-2 font-medium text-slate-700">{t.title}</td>
                          <td className="py-2 pr-2 text-slate-500">{t.category}</td>
                          <td className="py-2 pr-2 text-slate-500">{t.priority}</td>
                          <td className="py-2 pr-2 text-slate-500">{t.agentName}</td>
                          <td className="py-2 text-right font-semibold text-slate-800">{formatDuration(t.minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// Mean-MTTR-per-bucket bars, plain SVG. Bar height = mean minutes, the number
// over each bar is how many tickets were resolved in that bucket.
function MttrTrendChart({ trend }) {
  if (!trend || trend.length === 0) {
    return <p className="text-[11px] text-slate-400">No trend data for this range.</p>;
  }
  const W = 640, H = 170, PAD_L = 44, PAD_R = 10, PAD_T = 20, PAD_B = 24;
  const max = Math.max(...trend.map((b) => b.meanMinutes || 0), 1);
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const slot = innerW / trend.length;
  const barW = Math.max(4, Math.min(28, slot * 0.6));
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[480px]" role="img" aria-label="MTTR trend">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + innerH * f} y2={PAD_T + innerH * f} stroke="#e2e8f0" strokeWidth="1" />
            <text x={PAD_L - 6} y={PAD_T + innerH * f + 3} textAnchor="end" className="fill-slate-400" fontSize="9">
              {formatDuration(max * (1 - f))}
            </text>
          </g>
        ))}
        {trend.map((b, i) => {
          const h = Math.max(2, ((b.meanMinutes || 0) / max) * innerH);
          const x = PAD_L + i * slot + (slot - barW) / 2;
          const y = PAD_T + innerH - h;
          return (
            <g key={b.bucket}>
              <rect x={x} y={y} width={barW} height={h} rx="2" fill="#0052CC">
                <title>{`${b.bucket}: ${formatDuration(b.meanMinutes)} across ${b.count} ticket${b.count === 1 ? '' : 's'}`}</title>
              </rect>
              <text x={x + barW / 2} y={y - 4} textAnchor="middle" className="fill-slate-500" fontSize="9">{b.count}</text>
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-slate-400" fontSize="8.5">{bucketLabel(b.bucket)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MttrBreakdown({ title, rows }) {
  return (
    <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
      <h3 className="text-sm font-bold text-slate-800 mb-3">{title}</h3>
      <table className="w-full text-left text-xs">
        <thead className="text-slate-400 font-semibold uppercase text-[10px] border-b border-slate-100">
          <tr>
            <th className="py-2 pr-2">&nbsp;</th>
            <th className="py-2 pr-2">Resolved</th>
            <th className="py-2 pr-2">MTTR</th>
            <th className="py-2 pr-2">Median</th>
            <th className="py-2">Slowest</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.length === 0 ? (
            <tr><td colSpan="5" className="py-4 text-center text-slate-400">No data.</td></tr>
          ) : rows.map((r) => (
            <tr key={r.key}>
              <td className="py-2 pr-2 font-medium text-slate-700">{r.key}</td>
              <td className="py-2 pr-2 text-slate-600">{r.count}</td>
              <td className="py-2 pr-2 text-slate-800 font-semibold">{formatDuration(r.meanMinutes)}</td>
              <td className="py-2 pr-2 text-slate-600">{formatDuration(r.medianMinutes)}</td>
              <td className="py-2 text-slate-600">{formatDuration(r.maxMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * IT asset stock report — what is in the store room, what is deployed or gone.
 *
 * Feeds on GET /api/reports/assets. "In stock" = status "In Stock"; every
 * other status (Assigned, In Repair, Under Maintenance, Retired,
 * Decommissioned) counts as "out of stock" — not available to hand out — while
 * the exact status stays visible so retired gear is never confused with
 * deployed gear. CSV export and print mirror the screen.
 */
function AssetReports({ token }) {
  const STOCK_FILTERS = [
    { value: 'all', label: 'All assets' },
    { value: 'In Stock', label: 'In stock' },
    { value: 'Low Stock', label: 'Low stock' },
    { value: 'Out of Stock', label: 'Out of stock' },
  ];
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stockFilter, setStockFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_URL}/api/reports/assets`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setReport(null);
          setError(data.error || `Could not load the asset report (HTTP ${res.status}).`);
        } else {
          setReport(data);
        }
      } catch {
        if (!cancelled) {
          setReport(null);
          setError('Network error — could not reach the server.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const summary = report && report.summary;
  const rows = (report && report.rows) || [];
  const visibleRows = stockFilter === 'all' ? rows : rows.filter((r) => r.stockState === stockFilter);

  // Printable copy of the stock report (Print / Save as PDF).
  const handlePrint = () => {
    if (!report) return;
    let body = printHeader('IT Asset Report', [
      `Generated ${new Date(report.generatedAt).toLocaleString()}`,
      'In stock = available in the store room; out of stock = deployed, in repair or retired',
    ]);
    body += printKpis([
      ['Total assets', String(summary.total)],
      ['In stock', String(summary.inStock)],
      ['Out of stock', String(summary.outOfStock)],
    ]);
    body += '<h2>By category</h2>' + printTable(
      ['Category', 'Total', 'In stock', 'Out of stock'],
      report.byCategory.map((c) => [c.key, c.total, c.inStock, c.outOfStock]),
      [1, 2, 3],
    );
    body += '<h2>By status</h2>' + printTable(
      ['Status', 'Stock state', 'Count'],
      report.byStatus.map((st) => [st.key, st.stockState, st.count]),
      [2],
    );
    body += '<h2>Assets</h2>' + printTable(
      ['Asset', 'Category', 'Serial number', 'Assigned to', 'Status', 'Stock state'],
      rows.map((r) => [r.name, r.category, r.serial, r.assignedTo, r.status, r.stockState]),
    );
    openPrintableReport('IT Asset Report', body);
  };

  const stockBadge = (state) => <StockStateBadge state={state} />;

  const kpi = (label, value, hint) => (
    <div className="bg-white border border-slate-200 rounded-md p-3.5 shadow-sm">
      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold text-slate-900 mt-1">{value}</div>
      {hint ? <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div> : null}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500 max-w-xl">
          Inventory stock report — how much hardware is available in the store room versus
          deployed, under repair or retired. "In stock" means status <span className="font-medium text-slate-700">In Stock</span>;
          everything else counts as out of stock.
        </p>
        <div className="flex items-center gap-2">
          {/* Report generation: CSV for spreadsheets, print for PDF archives. */}
          <button
            onClick={() => downloadCsv(token, `${API_URL}/api/reports/assets/export`, 'asset-report.csv')}
            disabled={!report}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-[11px] font-medium text-slate-600 hover:bg-slate-50 shadow-sm transition disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
          <button
            onClick={handlePrint}
            disabled={!report}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-[11px] font-medium text-slate-600 hover:bg-slate-50 shadow-sm transition disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
        </div>
      </div>

      {loading && (
        <div className="bg-white border border-slate-200 rounded-md p-10 text-center text-xs text-slate-400 shadow-sm">
          Loading asset stock metrics…
        </div>
      )}
      {!loading && error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-xs text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {kpi('Total assets', String(summary.total), 'tracked in the inventory')}
            {kpi('In stock', String(summary.inStock), 'on the shelf, above reorder level')}
            {kpi('Low stock', String(summary.lowStock), 'at/below reorder level — reorder soon')}
            {kpi('Out of stock', String(summary.outOfStock), 'shelf empty, deployed or retired')}
            {kpi('Availability', summary.total ? `${Math.round((summary.inStock / summary.total) * 100)}%` : '—', 'share of stock on hand')}
          </div>

          {/* The restock watchlist: the direct answer to "is anything running
              out of stock?" — tracked lines at/below their reorder level. */}
          {(report.restockList || []).length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md p-4 shadow-sm">
              <h3 className="text-sm font-bold text-amber-900 mb-3 flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4" /> Restock watchlist — running out
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-amber-700/70 font-semibold uppercase text-[10px] border-b border-amber-200">
                    <tr>
                      <th className="py-2 pr-2">Asset</th>
                      <th className="py-2 pr-2">Category</th>
                      <th className="py-2 pr-2">On hand</th>
                      <th className="py-2 pr-2">Alert at</th>
                      <th className="py-2">Stock state</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-100">
                    {report.restockList.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-2 font-medium text-slate-800">{r.name}</td>
                        <td className="py-2 pr-2 text-slate-600">{r.category}</td>
                        <td className="py-2 pr-2 font-semibold text-slate-800">{r.quantity}</td>
                        <td className="py-2 pr-2 text-slate-600">{r.reorderLevel == null ? '—' : r.reorderLevel}</td>
                        <td className="py-2">{stockBadge(r.stockState)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">In stock vs out of stock, by category</h3>
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400 font-semibold uppercase text-[10px] border-b border-slate-100">
                  <tr>
                    <th className="py-2 pr-2">Category</th>
                    <th className="py-2 pr-2">Total</th>
                    <th className="py-2 pr-2">In stock</th>
                    <th className="py-2">Out of stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {report.byCategory.length === 0 ? (
                    <tr><td colSpan="4" className="py-4 text-center text-slate-400">No assets in the inventory.</td></tr>
                  ) : report.byCategory.map((c) => (
                    <tr key={c.key}>
                      <td className="py-2 pr-2 font-medium text-slate-700">{c.key}</td>
                      <td className="py-2 pr-2 text-slate-600">{c.total}</td>
                      <td className="py-2 pr-2 text-emerald-700 font-semibold">{c.inStock}</td>
                      <td className="py-2 text-amber-700 font-semibold">{c.outOfStock}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-3">By status</h3>
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400 font-semibold uppercase text-[10px] border-b border-slate-100">
                  <tr>
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2 pr-2">Stock state</th>
                    <th className="py-2">Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {report.byStatus.length === 0 ? (
                    <tr><td colSpan="3" className="py-4 text-center text-slate-400">No assets in the inventory.</td></tr>
                  ) : report.byStatus.map((st) => (
                    <tr key={st.key}>
                      <td className="py-2 pr-2 font-medium text-slate-700">{statusLabel(st.key)}</td>
                      <td className="py-2 pr-2">{stockBadge(st.stockState)}</td>
                      <td className="py-2 text-slate-600">{st.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-md shadow-sm">
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h3 className="text-sm font-bold text-slate-800">Assets</h3>
              <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-md p-1">
                {STOCK_FILTERS.map((f) => {
                  const n = f.value === 'all' ? rows.length : rows.filter((r) => r.stockState === f.value).length;
                  return (
                    <button
                      key={f.value}
                      onClick={() => setStockFilter(f.value)}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition ${stockFilter === f.value ? 'bg-[#0052CC] text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                    >
                      {f.label} ({n})
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase">
                  <tr>
                    <th className="py-3 px-4">Asset</th>
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4">Serial Number</th>
                    <th className="py-3 px-4">Assigned To</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">On Hand</th>
                    <th className="py-3 px-4">Stock State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="py-8 text-center text-slate-400">No assets match this filter.</td>
                    </tr>
                  ) : visibleRows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition">
                      <td className="py-3.5 px-4 font-semibold text-slate-800">{r.name}</td>
                      <td className="py-3.5 px-4 text-slate-600">{r.category}</td>
                      <td className="py-3.5 px-4 font-mono text-[#0052CC]">{r.serial}</td>
                      <td className="py-3.5 px-4 text-slate-600">{r.assignedTo}</td>
                      <td className="py-3.5 px-4 text-slate-600">{statusLabel(r.status)}</td>
                      <td className="py-3.5 px-4 text-slate-700">
                        <span className="font-semibold">{r.quantity}</span>
                        {r.reorderLevel != null && (
                          <span className="text-slate-400 text-[10px]"> / alert at {r.reorderLevel}</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">{stockBadge(r.stockState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PBX call log — every IP-phone call the Panasonic PBX reported, and the
// tickets the IT office calls raised.
// ---------------------------------------------------------------------------

/** Connection banner: is the PBX feed up, and what needs configuring? */
function PbxStatusBar({ status, onRefresh, onSimulate, onParsePreview }) {
  if (!status) return null;
  const conn = status.connection || {};
  const ok = conn.status === 'connected' || conn.status === 'listening';
  const tone = ok ? 'border-emerald-200 bg-emerald-50' : conn.status === 'disabled' ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50';
  const dot = ok ? 'bg-emerald-500' : conn.status === 'disabled' ? 'bg-slate-400' : 'bg-amber-500';
  const stats = status.stats || {};
  return (
    <div className={`mb-4 border rounded-md p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 w-2.5 h-2.5 rounded-full ${dot} ${ok ? 'animate-pulse' : ''}`} />
          <div>
            <div className="text-xs font-bold text-slate-900">
              {status.model} — {ok ? 'connected' : conn.status === 'disabled' ? 'not connected' : conn.status}
              <span className="ml-2 font-normal text-slate-500">{conn.detail}</span>
            </div>
            <div className="text-[11px] text-slate-600 mt-0.5">
              IT office extensions: <span className="font-semibold">{status.itExtensions.length ? status.itExtensions.join(', ') : 'not set (PBX_IT_EXTENSIONS)'}</span>
              {' · '}Tickets: <span className="font-semibold">{
                status.ticketPolicy === 'all' ? 'every call'
                  : status.ticketPolicy === 'answered' ? 'answered calls only'
                    : status.ticketPolicy === 'missed' ? 'missed calls only'
                      : 'off (log only)'
              }</span>
              {' · '}Calls logged: <span className="font-semibold">{stats.storedCalls ?? 0}</span>
              {stats.lastRecordAt ? ` · last ${new Date(stats.lastRecordAt).toLocaleTimeString()}` : ''}
            </div>
            {(status.warnings || []).length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {status.warnings.slice(0, 3).map((w, i) => (
                  <li key={i} className="text-[11px] text-amber-800 flex items-start gap-1">
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status.allowSimulator && (
            <button onClick={onSimulate} className="px-2.5 py-1.5 text-[11px] font-medium bg-white border border-slate-300 rounded text-slate-700 hover:bg-slate-100 transition" title="Push a realistic SMDR record through the real pipeline">
              Simulate call
            </button>
          )}
          <button onClick={onParsePreview} className="px-2.5 py-1.5 text-[11px] font-medium bg-white border border-slate-300 rounded text-slate-700 hover:bg-slate-100 transition" title="Paste a raw SMDR line and see how the helpdesk reads it">
            Test a record
          </button>
          <button onClick={onRefresh} className="p-1.5 bg-white border border-slate-300 rounded text-slate-600 hover:bg-slate-100 transition" title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Extension → person map. Agents read it; a super admin edits it. */
function ExtensionDirectory({ token, superAdmin, directory, people, onChanged }) {
  const [form, setForm] = useState({ extension: '', user_id: '', name: '', department: '' });
  const [busy, setBusy] = useState(false);

  const send = async (method, path, body) => {
    setBusy(true);
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      alert(data.error || `Could not save the extension (HTTP ${res.status}).`);
      return false;
    }
    onChanged();
    return true;
  };

  return (
    <div className="bg-white border border-slate-200 rounded-md shadow-sm p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5 text-[#0052CC]" /> Extension directory
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Maps a PBX extension to the person who sits at it, so a phone-raised ticket is filed under their account
            (they then see it in their own portal) instead of showing a bare number.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 border-y border-slate-200 text-slate-500 font-semibold uppercase">
            <tr>
              <th className="py-2 px-3">Extension</th>
              <th className="py-2 px-3">Person</th>
              <th className="py-2 px-3">Department</th>
              {superAdmin && <th className="py-2 px-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {directory.length === 0 && (
              <tr><td colSpan={superAdmin ? 4 : 3} className="py-6 text-center text-slate-400">No extensions mapped yet.</td></tr>
            )}
            {directory.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50 transition">
                <td className="py-2 px-3 font-mono font-semibold text-[#0052CC]">{e.extension}</td>
                <td className="py-2 px-3">
                  {superAdmin ? (
                    <select
                      value={e.user_id || ''}
                      onChange={(ev) => send('PATCH', `/api/pbx/extensions/${e.id}`, { user_id: ev.target.value || null })}
                      className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]"
                    >
                      <option value="">— not linked —</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-slate-700">{e.user_name || e.name || <span className="text-slate-400">not linked</span>}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-slate-600">{e.department || '—'}</td>
                {superAdmin && (
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={() => { if (confirm(`Remove extension ${e.extension} from the directory?`)) send('DELETE', `/api/pbx/extensions/${e.id}`); }}
                      className="p-1 text-slate-400 hover:text-red-600 transition"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {superAdmin && (
        <form
          onSubmit={async (ev) => {
            ev.preventDefault();
            const done = await send('POST', '/api/pbx/extensions', {
              extension: form.extension,
              user_id: form.user_id || null,
              name: form.name,
              department: form.department,
            });
            if (done) setForm({ extension: '', user_id: '', name: '', department: '' });
          }}
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3"
        >
          <label className="text-[11px] text-slate-600">
            Extension
            <input value={form.extension} onChange={(e) => setForm({ ...form, extension: e.target.value })} placeholder="210" className="block mt-1 w-24 border border-slate-300 rounded p-1.5 text-xs focus:outline-none focus:border-[#0052CC]" />
          </label>
          <label className="text-[11px] text-slate-600">
            Person
            <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} className="block mt-1 w-48 bg-white border border-slate-300 rounded p-1.5 text-xs focus:outline-none focus:border-[#0052CC]">
              <option value="">— not linked —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-slate-600">
            Department
            <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Farm Ops" className="block mt-1 w-40 border border-slate-300 rounded p-1.5 text-xs focus:outline-none focus:border-[#0052CC]" />
          </label>
          <button type="submit" disabled={busy || !form.extension} className="px-3 py-1.5 bg-[#0052CC] hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium rounded transition">
            Map extension
          </button>
        </form>
      )}
    </div>
  );
}

/** Log a call by hand — for sites where the SMDR feed is not wired yet. */
function ManualCallModal({ token, itExtensions, directory, onClose, onLogged }) {
  const now = new Date();
  const localStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const [form, setForm] = useState({
    extension: itExtensions[0] || '',
    direction: 'Incoming',
    call_at: localStamp,
    minutes: 3,
    seconds: 0,
    notAnswered: false,
    ring_seconds: 8,
    caller_number: '',
    dialed_number: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const duration_seconds = form.notAnswered ? 0 : (Number(form.minutes) || 0) * 60 + (Number(form.seconds) || 0);
    const res = await fetch(`${API_URL}/api/pbx/calls/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        extension: form.extension,
        direction: form.direction,
        call_at: new Date(form.call_at).toISOString(),
        duration_seconds,
        ring_seconds: form.ring_seconds === '' ? null : Number(form.ring_seconds),
        caller_number: form.caller_number,
        dialed_number: form.dialed_number,
        notes: form.notes,
        answered: !form.notAnswered,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return alert(data.error || `Could not log the call (HTTP ${res.status}).`);
    onLogged(data);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
      <form onSubmit={submit} className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><PhoneCall className="h-4 w-4 text-[#0052CC]" /> Log a phone call</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-[11px] text-slate-500 mb-4">
          Use this when the PBX feed is not connected yet, or when a call was missed while the server was down.
          A ticket is raised for calls to the IT office, exactly as it would be from the SMDR feed.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-[11px] text-slate-600">
            Extension
            <input
              list="pbx-extension-options"
              value={form.extension}
              onChange={(e) => setForm({ ...form, extension: e.target.value })}
              required
              className="block mt-1 w-full border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]"
            />
            <datalist id="pbx-extension-options">
              {[...new Set([...itExtensions, ...directory.map((d) => d.extension)])].map((x) => <option key={x} value={x} />)}
            </datalist>
          </label>
          <label className="text-[11px] text-slate-600">
            Direction
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} className="block mt-1 w-full bg-white border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]">
              <option value="Incoming">Incoming (someone called the IT office)</option>
              <option value="Internal">Internal (an employee extension called IT)</option>
              <option value="Outgoing">Outgoing (IT called someone)</option>
            </select>
          </label>
          <label className="text-[11px] text-slate-600">
            Call time
            <input type="datetime-local" value={form.call_at} onChange={(e) => setForm({ ...form, call_at: e.target.value })} className="block mt-1 w-full border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]" />
          </label>
          <label className="text-[11px] text-slate-600 flex items-end gap-2">
            <span className="flex-1">
              Duration
              <span className="mt-1 flex items-center gap-1">
                <input type="number" min="0" max="1440" value={form.minutes} disabled={form.notAnswered} onChange={(e) => setForm({ ...form, minutes: e.target.value })} className="w-16 border border-slate-300 rounded p-2 text-xs disabled:bg-slate-100 focus:outline-none focus:border-[#0052CC]" />
                <span className="text-slate-400">min</span>
                <input type="number" min="0" max="59" value={form.seconds} disabled={form.notAnswered} onChange={(e) => setForm({ ...form, seconds: e.target.value })} className="w-14 border border-slate-300 rounded p-2 text-xs disabled:bg-slate-100 focus:outline-none focus:border-[#0052CC]" />
                <span className="text-slate-400">sec</span>
              </span>
            </span>
          </label>
          <label className="text-[11px] text-slate-600 flex items-center gap-2 col-span-2">
            <input type="checkbox" checked={form.notAnswered} onChange={(e) => setForm({ ...form, notAnswered: e.target.checked })} />
            The call was not answered (the ticket asks for a call-back)
          </label>
          <label className="text-[11px] text-slate-600">
            Ring time (seconds)
            <input type="number" min="0" max="3600" value={form.ring_seconds} onChange={(e) => setForm({ ...form, ring_seconds: e.target.value })} className="block mt-1 w-full border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]" />
          </label>
          <label className="text-[11px] text-slate-600">
            Caller number (external)
            <input value={form.caller_number} onChange={(e) => setForm({ ...form, caller_number: e.target.value })} placeholder="08035550123" className="block mt-1 w-full border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]" />
          </label>
          <label className="text-[11px] text-slate-600 col-span-2">
            What was the issue? (goes on the ticket)
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="3" placeholder="Printer in the accounts office is not printing." className="block mt-1 w-full border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]" />
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded transition">Cancel</button>
          <button type="submit" disabled={busy} className="px-4 py-2 text-xs font-medium text-white bg-[#0052CC] hover:bg-blue-700 disabled:opacity-50 rounded transition">
            {busy ? 'Logging…' : 'Log call'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Dry-run a raw SMDR line against the parser — nothing is stored. */
function ParsePreviewModal({ token, onClose }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const res = await fetch(`${API_URL}/api/pbx/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return alert(data.error || `Could not parse that (HTTP ${res.status}).`);
    setResult(data);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-3xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><FileText className="h-4 w-4 text-[#0052CC]" /> Test a PBX record</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-[11px] text-slate-500 mb-3">
          Paste one or more raw SMDR lines from the PBX (as they appear in the SMDR port or the maintenance console&apos;s test view).
          Nothing is saved — this only shows what the helpdesk would read, and whether a ticket would be raised.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows="5"
          spellCheck="false"
          placeholder={"21/09/25 14:32:10 204 01 +2348031234567 0'12 00:03'45 AN"}
          className="w-full border border-slate-300 rounded p-2 text-xs font-mono focus:outline-none focus:border-[#0052CC]"
        />
        <div className="flex justify-end mt-2">
          <button onClick={run} disabled={busy || !text.trim()} className="px-4 py-2 text-xs font-medium text-white bg-[#0052CC] hover:bg-blue-700 disabled:opacity-50 rounded transition">
            {busy ? 'Reading…' : 'Read records'}
          </button>
        </div>

        {result && (
          <div className="mt-4 space-y-2">
            <div className="text-[11px] text-slate-600">
              {result.parsed} record(s) understood · {result.skipped} skipped · IT office extensions {result.itExtensions.join(', ') || 'not set'}
            </div>
            {result.results.map((r, i) => (
              <div key={i} className={`border rounded p-2 text-[11px] ${r.ok ? 'border-slate-200 bg-slate-50' : 'border-red-200 bg-red-50'}`}>
                <div className="font-mono text-[10px] text-slate-500 break-all mb-1">{r.raw}</div>
                {r.ok ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-slate-700">
                    <div><span className="text-slate-400">When:</span> {r.record.call_day} {r.record.call_time}</div>
                    <div><span className="text-slate-400">Direction:</span> {r.record.direction}</div>
                    <div><span className="text-slate-400">Ext:</span> {r.record.extension || '—'}</div>
                    <div><span className="text-slate-400">Trunk:</span> {r.record.trunk || '—'}</div>
                    <div><span className="text-slate-400">Number:</span> {r.record.dialed_number || '—'}</div>
                    <div><span className="text-slate-400">Ring:</span> {r.record.ring_display || '—'}</div>
                    <div><span className="text-slate-400">Duration:</span> {r.record.duration_display}</div>
                    <div><span className="text-slate-400">Answered:</span> {r.record.answered === true ? 'yes' : r.record.answered === false ? 'no' : 'unknown'}</div>
                    <div className="col-span-2 sm:col-span-4">
                      <span className="text-slate-400">Ticket:</span>{' '}
                      {r.would_raise_ticket
                        ? <span className="font-semibold text-emerald-700">would be raised</span>
                        : <span className="text-slate-600">no ticket — {r.record.is_helpdesk_call ? 'the ticket policy or duration threshold filtered it out' : 'this call did not involve the IT office extensions'}</span>}
                    </div>
                  </div>
                ) : (
                  <div className="text-red-700">Skipped: {r.reason === 'header' || r.reason === 'separator' ? 'header/separator line' : r.reason === 'unparsed' ? 'not recognised as an SMDR record' : r.reason}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Notes on a call — what was said on the phone. */
function CallNotesModal({ token, call, onClose, onSaved }) {
  const [notes, setNotes] = useState(call.notes || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const res = await fetch(`${API_URL}/api/pbx/calls/${call.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notes }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return alert(data.error || `Could not save the notes (HTTP ${res.status}).`);
    onSaved(data);
  };
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-900">Call notes — {callStamp(call)}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">{call.caller_label} · {call.duration_display} · {call.direction}</p>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows="5" placeholder="What the caller reported, what was done, follow-up needed…" className="w-full border border-slate-300 rounded p-2 text-xs focus:outline-none focus:border-[#0052CC]" />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="px-3 py-2 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded transition">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 py-2 text-xs font-medium text-white bg-[#0052CC] hover:bg-blue-700 disabled:opacity-50 rounded transition">
            {busy ? 'Saving…' : 'Save notes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The call log: every call the PBX reported, what happened on it, and the
 * ticket it raised.
 */
function CallLog({ token, user, usersList = [], tickets = [], onOpenTicketChat }) {
  const superAdmin = isSuperAdmin(user);
  const [data, setData] = useState({ calls: [], total: 0, scope: 'own' });
  const [status, setStatus] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ days: '30', direction: '', outcome: '', ticket: '', extension: '', q: '' });
  const [searchInput, setSearchInput] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [notesCall, setNotesCall] = useState(null);
  const [showDirectory, setShowDirectory] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ days: filters.days });
      if (filters.direction) params.set('direction', filters.direction);
      if (filters.outcome) params.set('outcome', filters.outcome);
      if (filters.ticket) params.set('ticket', filters.ticket);
      if (filters.extension) params.set('extension', filters.extension);
      if (filters.q) params.set('q', filters.q);
      const [callsRes, statusRes, dirRes] = await Promise.all([
        fetch(`${API_URL}/api/pbx/calls?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/pbx/status`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/pbx/extensions`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const callsData = await callsRes.json().catch(() => ({}));
      if (!callsRes.ok) {
        setError(callsData.error || `Could not load the call log (HTTP ${callsRes.status}).`);
        setData({ calls: [], total: 0, scope: 'own' });
      } else {
        setData(callsData);
      }
      if (statusRes.ok) setStatus(await statusRes.json());
      if (dirRes.ok) setDirectory(await dirRes.json());
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [token, filters]);

  useEffect(() => { load(); }, [load]);

  // Live: a new call lands, or a call's ticket changes state elsewhere.
  useEffect(() => {
    const handler = () => { load(); };
    socket.on('pbx_call_changed', handler);
    return () => { socket.off('pbx_call_changed', handler); };
  }, [load]);

  const patchCall = async (id, body) => {
    setBusyId(id);
    const res = await fetch(`${API_URL}/api/pbx/calls/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const updated = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok) {
      alert(updated.error || `Could not update this call (HTTP ${res.status}).`);
      return;
    }
    setData((prev) => ({ ...prev, calls: prev.calls.map((c) => (c.id === id ? updated : c)) }));
  };

  const raiseTicket = async (call) => {
    setBusyId(call.id);
    const res = await fetch(`${API_URL}/api/pbx/calls/${call.id}/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok) return alert(payload.error || `Could not raise the ticket (HTTP ${res.status}).`);
    setNotice(`Ticket raised for the call from ${call.caller_label}.`);
    load();
  };

  const simulate = async () => {
    const res = await fetch(`${API_URL}/api/pbx/calls/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ direction: 'Incoming', seconds: 95, ring: 8 }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return alert(payload.error || `Could not simulate a call (HTTP ${res.status}).`);
    setNotice(`Simulated an SMDR record: "${payload.raw}"`);
    load();
  };

  const calls = data.calls || [];
  const kpi = {
    total: calls.length,
    helpdesk: calls.filter((c) => c.is_helpdesk_call).length,
    incoming: calls.filter((c) => c.direction === 'Incoming').length,
    missed: calls.filter((c) => c.answered === false).length,
    ticketed: calls.filter((c) => c.ticket_id).length,
    solved: calls.filter((c) => c.resolution_outcome === 'Solved').length,
    notSolved: calls.filter((c) => c.resolution_outcome === 'Not solved').length,
    pending: calls.filter((c) => c.resolution_outcome === 'Pending').length,
    talkSeconds: calls.reduce((a, c) => a + (Number.isFinite(c.duration_seconds) ? c.duration_seconds : 0), 0),
  };

  return (
    <div>
      <PbxStatusBar status={status} onRefresh={load} onSimulate={simulate} onParsePreview={() => setShowPreview(true)} />

      {notice && (
        <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-[11px] text-blue-800 flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="text-blue-500 hover:text-blue-800"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
        {[
          ['Calls in view', kpi.total],
          ['To the IT office', kpi.helpdesk],
          ['Incoming', kpi.incoming],
          ['Not answered', kpi.missed],
          ['Tickets raised', kpi.ticketed],
          ['Talk time', formatDuration(Math.round(kpi.talkSeconds / 60))],
        ].map(([label, value]) => (
          <div key={label} className="bg-white border border-slate-200 rounded-md p-3 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
            <div className="text-lg font-bold text-slate-900 mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-md shadow-sm mb-4 p-3 flex flex-wrap items-center gap-2">
        <select value={filters.days} onChange={(e) => setFilters({ ...filters, days: e.target.value })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1.5 focus:outline-none focus:border-[#0052CC]">
          <option value="1">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
        </select>
        <select value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1.5 focus:outline-none focus:border-[#0052CC]">
          <option value="">All directions</option>
          <option value="Incoming">Incoming</option>
          <option value="Internal">Internal</option>
          <option value="Outgoing">Outgoing</option>
        </select>
        <select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1.5 focus:outline-none focus:border-[#0052CC]">
          <option value="">Any outcome</option>
          <option value="Solved">Solved</option>
          <option value="Not solved">Not solved</option>
          <option value="Pending">Pending</option>
        </select>
        <select value={filters.ticket} onChange={(e) => setFilters({ ...filters, ticket: e.target.value })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1.5 focus:outline-none focus:border-[#0052CC]">
          <option value="">With or without a ticket</option>
          <option value="yes">Has a ticket</option>
          <option value="no">No ticket yet</option>
        </select>
        <input
          value={filters.extension}
          onChange={(e) => setFilters({ ...filters, extension: e.target.value })}
          placeholder="Extension"
          className="w-24 border border-slate-300 rounded p-1.5 text-xs focus:outline-none focus:border-[#0052CC]"
        />
        <form onSubmit={(e) => { e.preventDefault(); setFilters({ ...filters, q: searchInput }); }} className="flex items-center gap-1">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search caller, number, notes…"
            className="w-52 border border-slate-300 rounded p-1.5 text-xs focus:outline-none focus:border-[#0052CC]"
          />
          <button type="submit" className="p-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded text-slate-600 transition" title="Search"><Search className="h-3.5 w-3.5" /></button>
        </form>
        <div className="flex-1" />
        <button onClick={() => setShowDirectory((v) => !v)} className="px-2.5 py-1.5 text-[11px] font-medium bg-white border border-slate-300 rounded text-slate-700 hover:bg-slate-100 transition">
          {showDirectory ? 'Hide' : 'Show'} extension directory
        </button>
        <button onClick={() => setShowManual(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#0052CC] hover:bg-blue-700 text-white rounded transition">
          <Plus className="h-3.5 w-3.5" /> Log a call
        </button>
      </div>

      {showDirectory && (
        <div className="mb-4">
          <ExtensionDirectory
            token={token}
            superAdmin={superAdmin}
            directory={directory}
            people={superAdmin ? usersList : []}
            onChanged={load}
          />
        </div>
      )}

      {error && <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>}

      <div className="bg-white border border-slate-200 rounded-md shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase">
              <tr>
                <th className="py-3 px-4">When</th>
                <th className="py-3 px-4">Caller</th>
                <th className="py-3 px-4">Direction</th>
                <th className="py-3 px-4">Ring</th>
                <th className="py-3 px-4">Duration</th>
                <th className="py-3 px-4">Ticket</th>
                <th className="py-3 px-4">Issue solved?</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && calls.length === 0 && (
                <tr><td colSpan="8" className="py-8 text-center text-slate-400">Loading calls…</td></tr>
              )}
              {!loading && calls.length === 0 && (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">
                    No calls in this view yet.
                    {status && !status.enabled && ' Connect the PBX feed (PBX_ENABLED/PBX_TRANSPORT) or log calls by hand.'}
                  </td>
                </tr>
              )}
              {calls.map((call) => {
                const linkedTicket = call.ticket_id ? tickets.find((t) => t.id === call.ticket_id) : null;
                return (
                  <tr key={call.id} className={`hover:bg-slate-50 transition ${busyId === call.id ? 'opacity-60' : ''}`}>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="font-semibold text-slate-800">{call.call_time ? call.call_time.slice(0, 5) : '—'}</div>
                      <div className="text-slate-400 text-[10px]">{callDateLabel(call)}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800">{call.caller_label}</div>
                      <div className="text-[10px] text-slate-400">
                        {call.caller_display_name && call.caller_display_name !== call.caller_label ? `${call.caller_display_name} · ` : ''}
                        Ext {call.extension || '—'}{call.trunk ? ` · CO ${call.trunk}` : ''}
                        {call.answered === false ? ' · not answered' : ''}
                      </div>
                      {call.notes && <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">Note: {call.notes}</div>}
                      {call.mirrored_records > 1 && (
                        <div className="text-[10px] text-slate-400">{call.mirrored_records} SMDR records merged</div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${CALL_DIRECTION_STYLES[call.direction] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                        {call.direction}
                      </span>
                      {call.is_helpdesk_call && (
                        <div className="text-[10px] text-[#0052CC] mt-0.5">IT office{call.it_extension ? ` · Ext ${call.it_extension}` : ''}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-600">{call.ring_display || '—'}</td>
                    <td className="py-3 px-4">
                      <span className="font-medium text-slate-800">{call.answered === false ? '—' : call.duration_display}</span>
                    </td>
                    <td className="py-3 px-4">
                      {call.ticket_id ? (
                        linkedTicket ? (
                          <button
                            onClick={() => onOpenTicketChat && onOpenTicketChat(linkedTicket.id)}
                            className="px-2 py-1 text-[11px] bg-blue-50 hover:bg-blue-100 text-[#0052CC] border border-blue-300 rounded font-medium transition"
                            title={linkedTicket.title}
                          >
                            Open ticket
                          </button>
                        ) : (
                          <span className="text-[11px] text-slate-500" title={call.ticket_title || ''}>
                            {call.ticket_status || 'Ticket'}{call.ticket_assignee && call.ticket_assignee !== UNASSIGNED ? ` · ${call.ticket_assignee}` : ''}
                          </span>
                        )
                      ) : (
                        <button
                          onClick={() => raiseTicket(call)}
                          disabled={busyId === call.id}
                          className="px-2 py-1 text-[11px] bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 rounded font-medium transition"
                          title="Raise a helpdesk ticket for this call"
                        >
                          Raise ticket
                        </button>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <select
                        value={call.resolution_outcome}
                        onChange={(e) => {
                          const outcome = e.target.value;
                          patchCall(call.id, { issue_resolved: outcome === 'Solved' ? true : outcome === 'Not solved' ? false : null });
                        }}
                        disabled={busyId === call.id}
                        title="Was the issue raised on this call solved?"
                        className={`rounded text-xs p-1 font-bold border focus:outline-none ${CALL_OUTCOME_STYLES[call.resolution_outcome] || 'bg-slate-50 text-slate-600 border-slate-300'}`}
                      >
                        {CALL_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      {call.resolution_minutes != null && (
                        <div className="text-[10px] text-slate-400 mt-0.5">Call → fix: {formatDuration(call.resolution_minutes)}</div>
                      )}
                      {call.resolved_by && <div className="text-[10px] text-slate-400">by {call.resolved_by}</div>}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button onClick={() => setNotesCall(call)} className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded font-medium transition">
                        Notes
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            {data.total} call(s) · scope: {data.scope === 'all' ? 'every call' : 'your calls and unclaimed calls'}
            {status ? ` · source: ${status.model} (${status.transport})` : ''}
          </span>
          <span>“Call → fix” is measured from the moment the phone rang to the ticket being resolved.</span>
        </div>
      </div>

      {showManual && (
        <ManualCallModal
          token={token}
          itExtensions={status ? status.itExtensions : []}
          directory={directory}
          onClose={() => setShowManual(false)}
          onLogged={(payload) => {
            setShowManual(false);
            setNotice(payload.ticket
              ? `Call logged and ticket ${payload.ticket.id} raised.`
              : 'Call logged.');
            load();
          }}
        />
      )}
      {showPreview && <ParsePreviewModal token={token} onClose={() => setShowPreview(false)} />}
      {notesCall && (
        <CallNotesModal
          token={token}
          call={notesCall}
          onClose={() => setNotesCall(null)}
          onSaved={(updated) => {
            setNotesCall(null);
            setData((prev) => ({ ...prev, calls: prev.calls.map((c) => (c.id === updated.id ? updated : c)) }));
          }}
        />
      )}
    </div>
  );
}

/** Call reporting: volume, durations, who phones, and what got fixed. */
function CallReports({ token }) {
  const [report, setReport] = useState(null);
  const [days, setDays] = useState('30');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_URL}/api/reports/calls?days=${days}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setReport(null);
          setError(data.error || `Could not load the call report (HTTP ${res.status}).`);
        } else {
          setReport(data);
        }
      } catch {
        if (!cancelled) {
          setReport(null);
          setError('Network error — could not reach the server.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, days]);

  const summary = report && report.summary;
  const maxHour = report ? Math.max(1, ...report.byHour.map((h) => h.calls)) : 1;

  const handlePrint = () => {
    if (!report) return;
    let body = printHeader('PBX Call Report', [
      `${report.model} · ${report.range.label}`,
      `Scope: ${report.scope === 'all' ? 'all calls' : 'my calls and unclaimed calls'}`,
      `IT office extensions: ${report.itExtensions.join(', ') || 'not configured'}`,
      `Generated ${new Date(report.generatedAt).toLocaleString()}`,
    ]);
    body += printKpis([
      ['Calls', String(summary.total)],
      ['To the IT office', String(summary.helpdeskCalls)],
      ['Answered', String(summary.answered)],
      ['Not answered', String(summary.missed)],
      ['With a ticket', String(summary.ticketed)],
      ['Solved', String(summary.solved)],
      ['Not solved', String(summary.unsolved)],
      ['Pending', String(summary.pending)],
    ]);
    body += '<h2>Calls per day</h2>' + printTable(
      ['Day', 'Calls', 'Solved', 'Not answered', 'Average duration (s)'],
      report.byDay.map((d) => [d.key, d.calls, d.solved, d.missed, d.avgDurationSeconds == null ? '—' : d.avgDurationSeconds]),
      [1, 2, 3, 4],
    );
    body += '<h2>By extension</h2>' + printTable(
      ['Extension', 'Person', 'Calls', 'Solved', 'Not solved', 'Average duration (s)'],
      report.byExtension.map((e) => [e.key, e.name || '—', e.calls, e.solved, e.unsolved, e.avgDurationSeconds == null ? '—' : e.avgDurationSeconds]),
      [2, 3, 4, 5],
    );
    body += '<h2>Calls by hour</h2>' + printTable(
      ['Hour', 'Calls'],
      report.byHour.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, h.calls]),
      [1],
    );
    body += '<h2>Calls</h2>' + printTable(
      ['When', 'Caller', 'Direction', 'Ring', 'Duration', 'Ticket', 'Solved'],
      report.rows.map((r) => [`${r.call_day} ${r.call_time}`, r.caller_label, r.direction, r.ring_display || '—', r.duration_display, r.ticket_id ? 'yes' : 'no', r.resolution_outcome]),
    );
    openPrintableReport('PBX Call Report', body);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-slate-500">Range</label>
          <select value={days} onChange={(e) => setDays(e.target.value)} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1.5 focus:outline-none focus:border-[#0052CC]">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 365 days</option>
            <option value="all">All time</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => downloadCsv(token, `${API_URL}/api/reports/calls/export?days=${days}`, `call-report-${days}.csv`)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded text-xs font-medium text-slate-700 hover:bg-slate-100 transition"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
          <button onClick={handlePrint} disabled={!report} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition">
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
        </div>
      </div>

      {loading && <div className="py-10 text-center text-slate-400 text-xs">Loading the call report…</div>}
      {error && <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>}

      {report && !loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ['Calls logged', summary.total, `${summary.helpdeskCalls} involved the IT office`],
              ['Answered', summary.answered, `${summary.missed} not answered`],
              ['Average call', summary.avgDurationSeconds == null ? '—' : formatDuration(summary.avgDurationSeconds / 60), `median ${summary.medianDurationSeconds == null ? '—' : formatDuration(summary.medianDurationSeconds / 60)}`],
              ['Total talk time', formatDuration(Math.round(summary.totalTalkSeconds / 60)), 'time on the phone'],
              ['Calls with a ticket', summary.ticketed, `${summary.unticketed} without`],
              ['Issue solved', summary.solved, `${summary.pending} pending · ${summary.unsolved} not solved`],
              ['Solve rate', summary.solveRatePercent == null ? '—' : `${summary.solveRatePercent}%`, 'of calls in range'],
              ['Call → fix (average)', summary.meanMinutesToSolve == null ? '—' : formatDuration(summary.meanMinutesToSolve), `median ${summary.medianMinutesToSolve == null ? '—' : formatDuration(summary.medianMinutesToSolve)}`],
            ].map(([label, value, sub]) => (
              <div key={label} className="bg-white border border-slate-200 rounded-md p-4 shadow-sm">
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">{value}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>

          <div className="bg-white border border-slate-200 rounded-md shadow-sm p-4">
            <h3 className="text-xs font-bold text-slate-900 mb-3">When the phone rings</h3>
            <div className="flex items-end gap-1 h-24">
              {report.byHour.map((h) => (
                <div key={h.hour} className="flex-1 flex flex-col items-center justify-end h-full" title={`${String(h.hour).padStart(2, '0')}:00 — ${h.calls} call(s)`}>
                  <div className="w-full bg-[#0052CC]/80 rounded-t" style={{ height: `${Math.round((h.calls / maxHour) * 100)}%`, minHeight: h.calls ? 3 : 1 }} />
                  <span className="text-[9px] text-slate-400 mt-1">{String(h.hour).padStart(2, '0')}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-md shadow-sm p-4">
              <h3 className="text-xs font-bold text-slate-900 mb-3">By extension</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500 font-semibold uppercase border-b border-slate-200">
                    <tr>
                      <th className="py-2">Extension</th>
                      <th className="py-2">Person</th>
                      <th className="py-2 text-right">Calls</th>
                      <th className="py-2 text-right">Solved</th>
                      <th className="py-2 text-right">Not solved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.byExtension.length === 0 && <tr><td colSpan="5" className="py-4 text-center text-slate-400">No calls in this range.</td></tr>}
                    {report.byExtension.map((e) => (
                      <tr key={e.key}>
                        <td className="py-2 font-mono text-[#0052CC]">{e.key}</td>
                        <td className="py-2 text-slate-600">{e.name || '—'}</td>
                        <td className="py-2 text-right font-medium">{e.calls}</td>
                        <td className="py-2 text-right text-emerald-700">{e.solved}</td>
                        <td className="py-2 text-right text-red-600">{e.unsolved}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-md shadow-sm p-4">
              <h3 className="text-xs font-bold text-slate-900 mb-3">Call volume per day</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500 font-semibold uppercase border-b border-slate-200">
                    <tr>
                      <th className="py-2">Day</th>
                      <th className="py-2 text-right">Calls</th>
                      <th className="py-2 text-right">Solved</th>
                      <th className="py-2 text-right">Not answered</th>
                      <th className="py-2 text-right">Avg duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.byDay.length === 0 && <tr><td colSpan="5" className="py-4 text-center text-slate-400">No calls in this range.</td></tr>}
                    {report.byDay.slice(-14).map((d) => (
                      <tr key={d.key}>
                        <td className="py-2 text-slate-600">{d.key}</td>
                        <td className="py-2 text-right font-medium">{d.calls}</td>
                        <td className="py-2 text-right text-emerald-700">{d.solved}</td>
                        <td className="py-2 text-right text-amber-700">{d.missed}</td>
                        <td className="py-2 text-right text-slate-500">{d.avgDurationSeconds == null ? '—' : formatDuration(d.avgDurationSeconds / 60)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-md shadow-sm p-4">
            <h3 className="text-xs font-bold text-slate-900 mb-3">Outcome</h3>
            <div className="flex flex-wrap gap-3">
              {report.byOutcome.map((o) => (
                <div key={o.key} className={`px-3 py-2 border rounded text-xs ${CALL_OUTCOME_STYLES[o.key] || 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  <span className="font-bold">{o.calls}</span> {o.key.toLowerCase()}
                </div>
              ))}
              <div className="px-3 py-2 border rounded text-xs bg-slate-50 border-slate-200 text-slate-600" title="One intercom call is printed twice by Panasonic (once per extension) and merged into a single call here">
                <span className="font-bold">{summary.mirroredIntercomRecords}</span> duplicate intercom record(s) merged
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentConsole({ user, tickets, usersList, inventoryList, enums = FALLBACK_ENUMS, peopleList = [], fetchTickets, fetchUsers, fetchInventory, handleLogout, token, onChatTicketChange }) {
  const superAdmin = isSuperAdmin(user);
  // Who can be picked in the asset-assignment dropdowns: super admins have the
  // full directory; regular agents get the email-free one (#36).
  const assignablePeople = superAdmin ? usersList : peopleList;
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  // Without this declaration the console threw `chatTicketId is not defined`
  // on every render and the whole Agent Console was a blank page.
  const [chatTicketId, setChatTicketId] = useState(null);
  // Sidebar badge: calls in the last 30 days whose issue is still pending —
  // the IT office's "somebody phoned and it is not closed yet" count. Kept
  // light (one small request) and refreshed live when a call lands.
  const [pendingCallCount, setPendingCallCount] = useState(0);
  // Id of the ticket whose per-ticket chat thread is open (null = closed).
  // Mirror it up to MainRouter so the live-refresh handler can skip a full
  // refetch while a thread is open (#36).
  const openTicketChat = (id) => {
    setChatTicketId(id);
    if (onChatTicketChange) onChatTicketChange(id);
  };

  const [isChatOpen, setIsChatOpen] = useState(false);
  // No fabricated chat history (#21): starts empty, shows only real messages.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatBottomRef = useRef(null);

  const [newAsset, setNewAsset] = useState({
    name: '',
    category: 'Laptop',
    serial_number: '',
    assigned_to_id: UNASSIGNED,
    status: 'In Stock',
    quantity: 1,
    reorder_level: ''
  });

  // Restock watchlist straight off the decorated inventory feed: store-room
  // lines at/below their reorder level, or with an empty shelf.
  const restockAlerts = (inventoryList || []).filter((i) => i.needs_restock);
  const lowStockCount = restockAlerts.filter((a) => a.stock_state === 'Low Stock').length;
  const emptyShelfCount = restockAlerts.filter((a) => a.stock_state === 'Out of Stock').length;

  const location = useLocation();
  // Order matters: /agent/asset-reports also contains "reports", and
  // /agent/call-reports contains "reports" too.
  const currentTab = location.pathname.includes('asset-reports') ? 'asset-reports'
    : location.pathname.includes('call-reports') ? 'call-reports'
    : location.pathname.includes('reports') ? 'reports'
    : location.pathname.includes('calls') ? 'calls'
    : location.pathname.includes('inventory') ? 'inventory'
    : location.pathname.includes('users') ? 'users'
    : 'tickets';

  useEffect(() => {
    // Named handler so cleanup detaches only THIS listener (#22) — the socket
    // is shared at module level, so a bare socket.off() nuked every
    // component's listener for the event.
    const handler = (incomingMessage) => {
      setChatMessages((prev) => [...prev, incomingMessage]);
    };
    socket.on('receive_message', handler);
    return () => { socket.off('receive_message', handler); };
  }, []);

  // PBX badge: how many logged calls still have an open issue. Refreshed when
  // the server reports a new call (payload carries ids only, no call data).
  useEffect(() => {
    let cancelled = false;
    const fetchPendingCalls = async () => {
      try {
        const res = await fetch(`${API_URL}/api/pbx/calls?days=30&outcome=Pending`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPendingCallCount(Array.isArray(data.calls) ? data.calls.length : 0);
      } catch {
        /* the badge is not worth an error dialog */
      }
    };
    fetchPendingCalls();
    const handler = () => { fetchPendingCalls(); };
    socket.on('pbx_call_changed', handler);
    return () => {
      cancelled = true;
      socket.off('pbx_call_changed', handler);
    };
  }, [token, tickets]);

  useEffect(() => {
    if (isChatOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

  const handleCreateAsset = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/api/inventory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        // id-keyed assignee (#17). Quantity/reorder_level are sent as proper
        // numbers (or null = no low-stock alerting) for the stock tracker.
        body: JSON.stringify({
          ...newAsset,
          quantity: Number.isInteger(Number(newAsset.quantity)) && Number(newAsset.quantity) >= 0
            ? Number(newAsset.quantity)
            : 1,
          reorder_level: newAsset.reorder_level === '' || newAsset.reorder_level == null
            ? null
            : Number(newAsset.reorder_level),
          ...assigneePayload(newAsset.assigned_to_id)
        })
      });
      // Never render a literal "undefined" dialog (#19): fall back to a real
      // message when the error body isn't JSON or has no `error` field.
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return alert(data.error || `Could not create the asset (HTTP ${res.status}). Please try again.`);
      }
      setIsAssetModalOpen(false);
      setNewAsset({ name: '', category: 'Laptop', serial_number: '', assigned_to_id: UNASSIGNED, status: 'In Stock', quantity: 1, reorder_level: '' });
      fetchInventory();
    } catch (err) {
      alert('Network error — could not reach the server. Please try again.');
    }
  };

  // These four used to ignore the response entirely: a rejected change (400)
  // looked exactly like a successful one until the refetch put the old value
  // back, with no message. Always surface the server's reason.
  const handleUpdateAsset = async (id, updates) => {
    const res = await fetch(`${API_URL}/api/inventory/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updates)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Could not update this asset (HTTP ${res.status}).`);
    }
    fetchInventory();
  };

  const handleDeleteAsset = async (id) => {
    if (!confirm('Are you sure you want to remove this asset?')) return;
    const res = await fetch(`${API_URL}/api/inventory/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Could not remove this asset (HTTP ${res.status}).`);
    }
    fetchInventory();
  };

  const handleAgentUpdate = async (id, updates) => {
    const res = await fetch(`${API_URL}/api/tickets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updates)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Could not update this ticket (HTTP ${res.status}).`);
    }
    fetchTickets();
  };

  const handleUpdateUserAccess = async (id, superAdminFlag) => {
    const res = await fetch(`${API_URL}/api/users/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ super_admin: superAdminFlag })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Could not update ticket access (HTTP ${res.status}).`);
    }
    fetchUsers();
  };

  const handleDeleteUser = async (id) => {
    if (!confirm('Are you sure you want to remove this account?')) return;
    const res = await fetch(`${API_URL}/api/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Could not remove this account (HTTP ${res.status}).`);
    }
    fetchUsers();
  };

  const handleUpdateUserRole = async (id, role) => {
    const res = await fetch(`${API_URL}/api/users/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ role })
    });
    if (!res.ok) {
      const data = await res.json();
      return alert(data.error || 'Failed to update role');
    }
    fetchUsers();
  };

  const handleSendChatMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const messagePayload = {
      sender: 'agent',
      senderName: user.name,
      text: chatInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    socket.emit('send_message', messagePayload);
    setChatInput('');
  };

  const copyInviteLink = () => {
    const link = `${window.location.origin}?invite=${encodeURIComponent(inviteEmail)}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const agentsList = usersList.filter(u => u.role === 'agent');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans relative">
      <header className="bg-[#0052CC] text-white px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <div className="p-1.5 bg-white/10 rounded text-white flex items-center justify-center">
            <Activity className="h-5 w-5" />
          </div>
          <span className="font-semibold text-base tracking-tight">SayedFarm Service Desk <span className="text-xs bg-blue-700 font-medium px-2 py-0.5 rounded ml-2 border border-blue-400/30">Agent Console</span></span>
          {/* #36: make the signed-in access level unmistakable. A super admin
              sees every ticket and can reassign; an agent sees only their own
              queue and must not be shown dispatch controls. */}
          {superAdmin ? (
            <span className="text-xs bg-indigo-500 font-bold px-2 py-0.5 rounded ml-2 border border-indigo-300/40" title="You can see every ticket and reassign work">
              Super Admin
            </span>
          ) : (
            <span className="text-xs bg-blue-800 font-medium px-2 py-0.5 rounded ml-2 border border-blue-400/30" title="You only see tickets assigned to you">
              My Queue
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 border-l border-blue-400/30 pl-4">
            <span className="text-[10px] text-blue-100/80">
              {superAdmin ? 'All tickets · can reassign' : 'Tickets assigned to you'}
            </span>
            <span className="text-xs font-medium">{user.name}</span>
            <button onClick={handleLogout} title="Sign Out" className="p-1 hover:bg-blue-700 rounded transition text-blue-100">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="w-60 bg-white border-r border-slate-200 p-4 flex flex-col justify-between">
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3 px-3">
              Workspaces
            </div>
            <nav className="space-y-1">
              <Link to="/agent/tickets" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'tickets' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`}>
                <Ticket className="h-4 w-4" /> Queues & Tickets
              </Link>
              <Link to="/agent/calls" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'calls' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`} title="IP-phone calls logged from the Panasonic PBX, and the tickets they raised">
                <Phone className="h-4 w-4" /> Call Log
                {pendingCallCount > 0 && (
                  <span className="ml-auto px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold" title={`${pendingCallCount} call(s) with an open issue`}>
                    {pendingCallCount}
                  </span>
                )}
              </Link>
              <Link to="/agent/call-reports" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'call-reports' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`} title="Call volume, durations and how many phone-raised issues got solved">
                <BarChart3 className="h-4 w-4" /> Call Reports
              </Link>
              <Link to="/agent/reports" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'reports' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`} title="Mean time to resolution and first-reply metrics">
                <Timer className="h-4 w-4" /> MTTR Reports
              </Link>
              <Link to="/agent/inventory" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'inventory' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`}>
                <Box className="h-4 w-4" /> IT Assets
              </Link>
              <Link to="/agent/asset-reports" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'asset-reports' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`} title="In stock vs out of stock, per category and status">
                <FileText className="h-4 w-4" /> Asset Reports
              </Link>
              {/* #36: only a super admin manages accounts. */}
              {superAdmin && (
                <Link to="/agent/users" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'users' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`}>
                  <Users className="h-4 w-4" /> User Management
                </Link>
              )}
            </nav>
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
            <span className="font-medium text-slate-700 block mb-0.5">System Status</span> 
            All services operational
          </div>
        </aside>

        <main className="flex-1 p-6 overflow-y-auto max-w-7xl mx-auto w-full pb-20">
          <header className="flex justify-between items-center mb-6 pb-4 border-b border-slate-200">
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                {currentTab === 'tickets' ? (superAdmin ? 'Service Desk Queues' : 'My Assigned Tickets')
                  : currentTab === 'calls' ? 'PBX Call Log'
                  : currentTab === 'call-reports' ? 'PBX Call Report'
                  : currentTab === 'reports' ? 'Resolution Time (MTTR)'
                  : currentTab === 'asset-reports' ? 'Asset Stock Report'
                  : currentTab === 'inventory' ? 'Asset Inventory' : 'User Directory'}
              </h1>
              <p className="text-slate-500 text-xs mt-0.5">
                {currentTab === 'tickets'
                  ? (superAdmin
                    ? 'Every request across the helpdesk — dispatch, reassign, and resolve.'
                    : 'The requests assigned to you. A super admin dispatches work to this queue.')
                  : currentTab === 'calls'
                    ? 'Every IP-phone call the Panasonic PBX reported: when it came in, how long it lasted, whether it was answered — and the ticket it raised.'
                  : currentTab === 'call-reports'
                    ? 'Call volume, talk time, who phones the IT office, and how many of those issues were solved.'
                  : currentTab === 'reports'
                    ? (superAdmin
                      ? 'How quickly requests are resolved across the helpdesk — mean, median, and trends.'
                      : 'How quickly your assigned requests are resolved — mean, median, and trends.')
                    : currentTab === 'asset-reports'
                      ? 'What is in stock, what is out of stock — per category and status. Export or print the report.'
                      : currentTab === 'inventory' ? 'Track hardware, serials, and store-room stock — adjust quantities in place and set low-stock alerts on consumables.' : 'View registered users and invite agents or team members.'}
              </p>
            </div>
            {currentTab === 'users' && (
              <button onClick={() => setIsInviteModalOpen(true)} className="flex items-center gap-2 bg-[#0052CC] hover:bg-blue-700 text-white px-3.5 py-2 rounded text-xs font-medium transition shadow-sm">
                <UserPlus className="h-4 w-4" /> Invite User
              </button>
            )}
            {currentTab === 'inventory' && (
              <button onClick={() => setIsAssetModalOpen(true)} className="flex items-center gap-2 bg-[#0052CC] hover:bg-blue-700 text-white px-3.5 py-2 rounded text-xs font-medium transition shadow-sm">
                <PackagePlus className="h-4 w-4" /> Add IT Asset
              </button>
            )}
            {currentTab === 'calls' && (
              <Link to="/agent/call-reports" className="flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 px-3.5 py-2 rounded text-xs font-medium transition shadow-sm">
                <BarChart3 className="h-4 w-4" /> Call reports
              </Link>
            )}
          </header>

          {currentTab === 'calls' && (
            <CallLog
              token={token}
              user={user}
              usersList={usersList}
              tickets={tickets}
              onOpenTicketChat={openTicketChat}
            />
          )}

          {currentTab === 'call-reports' && (
            <CallReports token={token} />
          )}

          {currentTab === 'reports' && (
            <MttrReports token={token} />
          )}

          {currentTab === 'asset-reports' && (
            <AssetReports token={token} />
          )}

          {currentTab === 'tickets' && (
            <div className="bg-white border border-slate-200 rounded-md shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase">
                    <tr>
                      <th className="py-3 px-4">Summary</th>
                      <th className="py-3 px-4">Attachment</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="py-3 px-4">Priority</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Assignee</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {tickets.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="py-8 text-center text-slate-400">No tickets available in this queue.</td>
                      </tr>
                    ) : (
                      tickets.map((t) => (
                        <tr key={t.id} className="hover:bg-slate-50 transition">
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-blue-600 hover:underline cursor-pointer">{t.title}</span>
                              {t.source === 'pbx_call' && <PhoneSourceBadge />}
                            </div>
                            <div className="text-slate-500 text-[11px] line-clamp-1">{t.description}</div>
                            <div className="text-slate-400 text-[10px] mt-0.5">Reporter: <span className="font-medium text-slate-600">{t.created_by_name}</span></div>
                            {/* MTTR: resolved-in time once done, running age while active,
                                and a marker when work resumed after a resolution. */}
                            {(ticketElapsed(t) || t.reopened_count > 0) && (
                              <div className="text-slate-400 text-[10px] mt-0.5">
                                {ticketElapsed(t)}
                                {ticketElapsed(t) && t.reopened_count > 0 ? ' · ' : ''}
                                {t.reopened_count > 0 ? `Reopened ×${t.reopened_count}` : ''}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            {t.image ? (
                              <button onClick={() => setSelectedImage(t.image)} className="flex items-center gap-1 px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded border border-slate-300 transition">
                                <ImageIcon className="h-3 w-3 text-blue-600" /> View
                              </button>
                            ) : (
                              <span className="text-slate-400 text-[11px]">None</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 font-medium">{t.category}</td>
                          <td className="py-3.5 px-4">
                            <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${t.priority === 'High' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                              {t.priority}
                            </span>
                          </td>
                          <td className="py-3.5 px-4">
                            <select 
                              value={t.status} 
                              onChange={(e) => handleAgentUpdate(t.id, { status: e.target.value })} 
                              className={`rounded text-xs p-1 font-bold focus:outline-none border border-slate-300 ${t.status === 'Open' ? 'bg-yellow-50 text-yellow-800' : t.status === 'In Progress' ? 'bg-blue-50 text-blue-800' : t.status === 'Pending' ? 'bg-amber-50 text-amber-800' : t.status === 'Cancelled' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}
                            >
                              {enums.ticketStatus.map((s) => (
                                <option key={s} value={s}>{statusLabel(s)}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-3.5 px-4">
                            {/* #36: dispatch is the super admin's job — a regular
                                agent sees who the ticket belongs to, nothing more. */}
                            {superAdmin ? (
                              <select value={t.assigned_to_id || (t.assigned_to && t.assigned_to !== UNASSIGNED ? LEGACY_ASSIGNEE : UNASSIGNED)} onChange={(e) => handleAgentUpdate(t.id, { ...assigneePayload(e.target.value), status: e.target.value === UNASSIGNED ? 'Open' : 'In Progress' })} title="Reassign this ticket" className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                                {assigneeOptions(agentsList, t).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            ) : (
                              <span className="text-slate-600">{t.assigned_to_id === user.id ? 'You' : (t.assigned_to || UNASSIGNED)}</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <button
                              onClick={() => openTicketChat(t.id)}
                              title="Open the chat thread with the reporter"
                              className="px-2.5 py-1 text-xs bg-blue-50 hover:bg-blue-100 text-[#0052CC] border border-blue-300 rounded font-medium transition mr-2"
                            >
                              Chat{(t.messages?.length || 0) > 0 ? ` (${t.messages.length})` : ''}
                            </button>
                            {t.status !== 'Closed' && t.status !== 'Resolved' && t.status !== 'Cancelled' && (
                              <button onClick={() => handleAgentUpdate(t.id, { status: 'Resolved' })} className="px-2.5 py-1 text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 rounded font-medium transition">
                                Quick Resolve
                              </button>
                            )}
                            {t.status === 'Resolved' && (
                              <button onClick={() => handleAgentUpdate(t.id, { status: 'Closed' })} className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded font-medium transition">
                                Close Ticket
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {currentTab === 'inventory' && (
            <div>
              {/* Restock banner — answers "is anything running out of stock?"
                  before the table is even scanned. */}
              {restockAlerts.length > 0 && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-md p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-xs font-bold text-amber-900">
                        Stock alert — {lowStockCount > 0 && `${lowStockCount} running low`}
                        {lowStockCount > 0 && emptyShelfCount > 0 && ' · '}
                        {emptyShelfCount > 0 && `${emptyShelfCount} out of stock`}
                      </div>
                      <p className="text-[11px] text-amber-800 mt-0.5">
                        {restockAlerts.slice(0, 4).map((a) => `${a.name} (${a.quantity} left${a.reorder_level != null ? `, alert at ${a.reorder_level}` : ''})`).join(' · ')}
                        {restockAlerts.length > 4 ? ` · +${restockAlerts.length - 4} more` : ''}
                      </p>
                    </div>
                  </div>
                  <Link to="/agent/asset-reports" className="px-3 py-1.5 bg-white border border-amber-300 rounded text-[11px] font-medium text-amber-800 hover:bg-amber-100 transition whitespace-nowrap">
                    View stock report →
                  </Link>
                </div>
              )}
              <div className="bg-white border border-slate-200 rounded-md shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase">
                    <tr>
                      <th className="py-3 px-4">Asset Name</th>
                      <th className="py-3 px-4">Category</th>
                      <th className="py-3 px-4">Serial Number</th>
                      <th className="py-3 px-4">Assigned User</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Stock on Hand</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {inventoryList.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50 transition">
                        <td className="py-3.5 px-4 font-semibold text-slate-800">{item.name}</td>
                        <td className="py-3.5 px-4">
                          {/* Recategorise in place (#asset-categories) — the
                              server validates against its published list. */}
                          <select value={item.category} onChange={(e) => handleUpdateAsset(item.id, { category: e.target.value })} title="Change asset category" className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                            {categoryOptions(enums.inventoryCategory, item.category).map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[#0052CC]">{item.serial_number}</td>
                        <td className="py-3.5 px-4">
                          <select value={item.assigned_to_id || (item.assigned_to && item.assigned_to !== UNASSIGNED ? LEGACY_ASSIGNEE : UNASSIGNED)} onChange={(e) => handleUpdateAsset(item.id, { ...assigneePayload(e.target.value), status: e.target.value === UNASSIGNED ? 'In Stock' : 'Assigned' })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                            {assigneeOptions(assignablePeople, item).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td className="py-3.5 px-4">
                          <select value={item.status} onChange={(e) => handleUpdateAsset(item.id, { status: e.target.value })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                            {enums.inventoryStatus.map((s) => (
                              <option key={s} value={s}>{statusLabel(s)}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3.5 px-4">
                          {/* Stock tracker: only lines on the store-room shelf
                              carry a count. −/+ adjust it in place; the alert
                              level is the "reorder at" threshold (blank = off). */}
                          {item.status === 'In Stock' ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleUpdateAsset(item.id, { quantity: Math.max(0, (item.quantity ?? 1) - 1) })}
                                  disabled={(item.quantity ?? 1) <= 0}
                                  title="One fewer in stock"
                                  className="w-5 h-5 flex items-center justify-center rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                                >−</button>
                                <span className="w-7 text-center font-semibold text-slate-800">{item.quantity ?? 1}</span>
                                <button
                                  onClick={() => handleUpdateAsset(item.id, { quantity: (item.quantity ?? 1) + 1 })}
                                  title="One more in stock"
                                  className="w-5 h-5 flex items-center justify-center rounded border border-slate-300 text-slate-600 hover:bg-slate-100 transition"
                                >+</button>
                                <input
                                  key={`${item.id}-lvl-${item.reorder_level == null ? 'off' : item.reorder_level}`}
                                  type="number"
                                  min="0"
                                  defaultValue={item.reorder_level == null ? '' : item.reorder_level}
                                  placeholder="—"
                                  onBlur={(e) => {
                                    const v = e.target.value.trim();
                                    const current = item.reorder_level == null ? '' : String(item.reorder_level);
                                    if (v === current) return;
                                    handleUpdateAsset(item.id, { reorder_level: v === '' ? null : Number(v) });
                                  }}
                                  title="Low-stock alert level — warn when stock falls to this number (blank = no alert)"
                                  className="w-14 border border-slate-300 rounded p-1 text-xs focus:outline-none focus:border-[#0052CC]"
                                />
                              </div>
                              <StockStateBadge state={item.stock_state} />
                            </div>
                          ) : (
                            <span className="text-slate-400" title="Not on the store-room shelf">—</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <button onClick={() => handleDeleteAsset(item.id)} className="p-1 text-slate-400 hover:text-red-600 transition">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </div>
            </div>
          )}

          {currentTab === 'users' && superAdmin && (
            <div className="bg-white border border-slate-200 rounded-md shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase">
                    <tr>
                      <th className="py-3 px-4">User Name</th>
                      <th className="py-3 px-4">Email Address</th>
                      <th className="py-3 px-4">Role</th>
                      <th className="py-3 px-4">Ticket Access</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {usersList.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50 transition">
                        <td className="py-3.5 px-4 font-semibold text-slate-800">{u.name}</td>
                        <td className="py-3.5 px-4 text-slate-600">{u.email}</td>
                        <td className="py-3.5 px-4">
                          {u.email === user.email ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${u.role === 'agent' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'}`}>
                              {u.role === 'agent' ? 'IT Agent' : 'Employee'} (you)
                            </span>
                          ) : (
                            <select value={u.role} onChange={(e) => handleUpdateUserRole(u.id, e.target.value)} title="Assign role" className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                              <option value="user">Employee</option>
                              <option value="agent">IT Agent</option>
                            </select>
                          )}
                        </td>
                        <td className="py-3.5 px-4">
                          {/* #36: super admins see every ticket and dispatch work;
                              regular agents only ever see their own queue. */}
                          {u.role !== 'agent' ? (
                            <span className="text-slate-400 text-[11px]">Own requests only</span>
                          ) : u.email === user.email ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-800">
                              {u.super_admin ? 'Super admin (you)' : 'Agent (you)'}
                            </span>
                          ) : (
                            <select
                              value={u.super_admin ? 'super' : 'agent'}
                              onChange={(e) => handleUpdateUserAccess(u.id, e.target.value === 'super')}
                              title="Ticket access level"
                              className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]"
                            >
                              <option value="agent">Agent — own tickets</option>
                              <option value="super">Super admin — all tickets</option>
                            </select>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          {u.email !== user.email && (
                            <button onClick={() => handleDeleteUser(u.id)} className="p-1 text-slate-400 hover:text-red-600 transition">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {isAssetModalOpen && (
            <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
              <div className="bg-white border border-slate-200 rounded-lg shadow-xl p-6 w-full max-w-md text-slate-800">
                <h2 className="text-base font-bold mb-4 text-slate-900 border-b border-slate-100 pb-2">Add New IT Asset</h2>
                <form onSubmit={handleCreateAsset} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Asset Name / Model</label>
                    <input required type="text" placeholder="MacBook Pro 16 M2" value={newAsset.name} onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Serial Number / Tag</label>
                    <input required type="text" placeholder="SN-8942-X1" value={newAsset.serial_number} onChange={(e) => setNewAsset({ ...newAsset, serial_number: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                      <select value={newAsset.category} onChange={(e) => setNewAsset({ ...newAsset, category: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                        {/* Server-owned pick list (#asset-categories): laptops,
                            desktops, printers & consumables, IP / solar PTZ
                            cameras, NVRs, storage, and so on. */}
                        {categoryOptions(enums.inventoryCategory, newAsset.category).map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Status</label>
                      <select value={newAsset.status} onChange={(e) => setNewAsset({ ...newAsset, status: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                        {enums.inventoryStatus.map((s) => (
                          <option key={s} value={s}>{statusLabel(s)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Assign to Employee</label>
                    <select value={newAsset.assigned_to_id} onChange={(e) => setNewAsset({ ...newAsset, assigned_to_id: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                      <option value={UNASSIGNED}>Unassigned</option>
                      {assignablePeople.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Quantity in Stock</label>
                      <input
                        required
                        type="number"
                        min="0"
                        value={newAsset.quantity}
                        onChange={(e) => setNewAsset({ ...newAsset, quantity: e.target.value === '' ? '' : Number(e.target.value) })}
                        title="How many of this item are on the store-room shelf"
                        className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Low-stock Alert At <span className="font-normal text-slate-400">(optional)</span></label>
                      <input
                        type="number"
                        min="0"
                        value={newAsset.reorder_level}
                        placeholder="e.g. 5"
                        onChange={(e) => setNewAsset({ ...newAsset, reorder_level: e.target.value === '' ? '' : Number(e.target.value) })}
                        title="Warn when the quantity falls to this level — for consumables like toners and cartridges"
                        className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none"
                      />
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 -mt-1">
                    Single units stay at quantity 1. For consumables (toners, cartridges, drives…), set an alert
                    level — the stock report and the low-stock watchlist flag them when they run low.
                  </p>
                  <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                    <button type="button" onClick={() => setIsAssetModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
                    <button type="submit" className="px-4 py-1.5 bg-[#0052CC] hover:bg-blue-700 text-white font-medium text-xs rounded shadow-sm">Save Asset</button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {isInviteModalOpen && (
            <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
              <div className="bg-white border border-slate-200 rounded-lg shadow-xl p-6 w-full max-w-md text-slate-800">
                <h2 className="text-base font-bold mb-4 text-slate-900 border-b border-slate-100 pb-2">Send Registration Invitation</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Target Email</label>
                    <input type="email" placeholder="colleague@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Generated Invite Link</label>
                    <div className="flex gap-2">
                      <input readOnly value={`${window.location.origin}?invite=${encodeURIComponent(inviteEmail || 'user')}`} className="w-full bg-slate-50 border border-slate-300 rounded p-2 text-xs text-slate-600 focus:outline-none" />
                      <button onClick={copyInviteLink} className="flex items-center gap-1 px-3 py-1.5 bg-[#0052CC] hover:bg-blue-700 text-white rounded text-xs font-medium transition">
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                    <button type="button" onClick={() => setIsInviteModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded">Close</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {selectedImage && (
            <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
              <div className="bg-white border border-slate-200 rounded-lg p-4 max-w-2xl w-full flex flex-col items-center shadow-2xl">
                <div className="w-full flex justify-between items-center mb-3 border-b border-slate-100 pb-2">
                  <span className="text-sm font-semibold text-slate-800">Ticket Screenshot</span>
                  <button onClick={() => setSelectedImage(null)} className="text-slate-400 hover:text-slate-600">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <img src={selectedImage} alt="Attachment" className="max-h-[70vh] rounded object-contain border border-slate-200" />
              </div>
            </div>
          )}

          {chatTicketId && (() => {
            const t = tickets.find((x) => x.id === chatTicketId);
            return t ? (
              <TicketChatModal
                ticket={t}
                sender="agent"
                senderName={user.name}
                onClose={() => { openTicketChat(null); fetchTickets(); }}
                onMessagesChanged={fetchTickets}
                token={token}
              />
            ) : null;
          })()}
        </main>
      </div>

      <div className="fixed bottom-6 right-6 z-50">
        {!isChatOpen ? (
          <button 
            onClick={() => setIsChatOpen(type => !type)}
            className="bg-[#0052CC] hover:bg-blue-700 text-white p-3.5 rounded-full shadow-lg flex items-center gap-2 transition transform hover:scale-105"
          >
            <MessageSquare className="h-5 w-5" />
            <span className="text-xs font-semibold pr-1">Live Chat Console</span>
          </button>
        ) : (
          <div className="bg-white border border-slate-200 rounded-lg shadow-2xl w-80 sm:w-96 flex flex-col h-[420px] overflow-hidden">
            <div className="bg-[#0052CC] text-white px-4 py-3 flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></div>
                <span className="text-xs font-semibold">Agent Live Response Console</span>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-blue-100 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 p-3 overflow-y-auto space-y-3 bg-slate-50 text-xs">
              {chatMessages.length === 0 && (
                <div className="h-full flex items-center justify-center text-slate-400 text-[11px] text-center px-4">
                  No live messages yet. Messages from employees appear here in real time.
                </div>
              )}
              {chatMessages.map((msg, index) => (
                <div key={index} className={`flex flex-col ${msg.sender === 'agent' ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] p-2.5 rounded-lg ${msg.sender === 'agent' ? 'bg-[#0052CC] text-white rounded-br-none' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-none shadow-xs'}`}>
                    <span className="block text-[9px] font-bold text-slate-300 mb-0.5">{msg.sender === 'agent' ? 'You (IT Agent)' : `Employee (${msg.senderName || 'User'})`}</span>
                    {msg.text}
                  </div>
                  <span className="text-[10px] text-slate-400 mt-0.5 px-1">{msg.time}</span>
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>

            <form onSubmit={handleSendChatMessage} className="p-3 bg-white border-t border-slate-200 flex gap-2">
              <input 
                type="text" 
                placeholder="Type reply as IT Agent..." 
                value={chatInput} 
                onChange={(e) => setChatInput(e.target.value)} 
                className="flex-1 bg-slate-100 border border-slate-200 rounded px-3 py-2 text-xs focus:bg-white focus:border-[#0052CC] focus:outline-none" 
              />
              <button type="submit" className="bg-[#0052CC] hover:bg-blue-700 text-white px-3 py-2 rounded transition flex items-center justify-center">
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        )}
      </div>

      <footer className="text-center py-3 text-xs text-slate-400 border-t border-slate-200 bg-white">
        Powered by Jira Service Management
      </footer>
    </div>
  );
}