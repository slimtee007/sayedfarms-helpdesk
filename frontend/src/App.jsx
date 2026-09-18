import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, Navigate, Link, useLocation } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Activity, Plus, ShieldCheck, User, LogOut, Image as ImageIcon, X, Paperclip, Users, Ticket, UserPlus, Copy, Check, Trash2, Box, PackagePlus, ChevronRight, Search, Headphones, KeyRound, AlertCircle, Monitor, Laptop, FilePlus, ChevronDown, Filter, MessageSquare, Send } from 'lucide-react';
import ForgotPassword from './pages/ForgotPassword.jsx';

// Same-origin by default: in dev, Vite proxies /api and /socket.io to the
// backend; in production the frontend is expected to be served from the same
// origin as the backend. Override with VITE_API_URL if hosted elsewhere.
const API_URL = import.meta.env.VITE_API_URL || '';
// Connected explicitly once a session exists (see MainRouter): the server
// ignores chat/join emits from unauthenticated sockets.
const socket = io(API_URL, { autoConnect: false });

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
  const [inventoryList, setInventoryList] = useState([]);
  
  const navigate = useNavigate();

  // Single source of truth for "is there a usable session?". A token with a
  // missing/corrupt/role-less user (e.g. half-cleared localStorage) used to
  // bounce /portal -> /login -> /portal forever and render nothing at all.
  const loggedIn = Boolean(token && user && (user.role === 'agent' || user.role === 'user'));

  useEffect(() => {
    if (loggedIn) {
      fetchTickets();
      // The full user directory is agent-only; employees get the trimmed
      // agent picker for the "direct request" dropdown.
      if (user?.role === 'agent') {
        fetchUsers();
        fetchInventory();
      } else {
        fetchAgents();
      }
    }
  }, [loggedIn]);

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

  // A 401 means the session is invalid or expired — drop it and bounce to login.
  const handleUnauthorized = (res) => {
    if (res.status === 401) {
      handleLogout();
      return true;
    }
    return false;
  };

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

function CustomerPortal({ user, tickets, agentsList = [], fetchTickets, handleLogout, token }) {
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
    assigned_to: 'Unassigned',
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

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setNewTicket({ ...newTicket, image: reader.result });
      };
      reader.readAsDataURL(file);
    }
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
        body: JSON.stringify(newTicket)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Keep the modal open and the draft intact so nothing is lost (#19).
        return setTicketError(data.error || `Could not create the request (HTTP ${res.status}). Please try again.`);
      }
      setIsModalOpen(false);
      setTicketError('');
      setNewTicket({ title: '', description: '', category: 'Hardware', priority: 'Medium', assigned_to: 'Unassigned', image: '' });
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
      assigned_to: 'Unassigned',
      image: ''
    });
    setTicketError('');
    setIsModalOpen(true);
  };

  const handleCancelTicket = async (id) => {
    await fetch(`${API_URL}/api/tickets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ status: 'Cancelled' })
    });
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
                        <td className="py-3 font-medium text-slate-800">{t.title}</td>
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
                <select value={newTicket.assigned_to} onChange={(e) => setNewTicket({ ...newTicket, assigned_to: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                  <option value="Unassigned">Any Available IT Agent</option>
                  {agentsList.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                  <select value={newTicket.category} onChange={(e) => setNewTicket({ ...newTicket, category: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                    <option>Hardware</option>
                    <option>Software</option>
                    <option>Network</option>
                    <option>Access/Security</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Urgency / Priority</label>
                  <select value={newTicket.priority} onChange={(e) => setNewTicket({ ...newTicket, priority: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
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

function AgentConsole({ user, tickets, usersList, inventoryList, fetchTickets, fetchUsers, fetchInventory, handleLogout, token }) {
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  // Id of the ticket whose per-ticket chat thread is open (null = closed).
  // Without this declaration the console threw `chatTicketId is not defined`
  // on every render and the whole Agent Console was a blank page.
  const [chatTicketId, setChatTicketId] = useState(null);
  
  const [isChatOpen, setIsChatOpen] = useState(false);
  // No fabricated chat history (#21): starts empty, shows only real messages.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatBottomRef = useRef(null);

  const [newAsset, setNewAsset] = useState({
    name: '',
    category: 'Laptop',
    serial_number: '',
    assigned_to: 'Unassigned',
    status: 'In Stock'
  });

  const location = useLocation();
  const currentTab = location.pathname.includes('inventory') ? 'inventory' : location.pathname.includes('users') ? 'users' : 'tickets';

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
        body: JSON.stringify(newAsset)
      });
      // Never render a literal "undefined" dialog (#19): fall back to a real
      // message when the error body isn't JSON or has no `error` field.
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return alert(data.error || `Could not create the asset (HTTP ${res.status}). Please try again.`);
      }
      setIsAssetModalOpen(false);
      setNewAsset({ name: '', category: 'Laptop', serial_number: '', assigned_to: 'Unassigned', status: 'In Stock' });
      fetchInventory();
    } catch (err) {
      alert('Network error — could not reach the server. Please try again.');
    }
  };

  const handleUpdateAsset = async (id, updates) => {
    await fetch(`${API_URL}/api/inventory/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updates)
    });
    fetchInventory();
  };

  const handleDeleteAsset = async (id) => {
    if (!confirm('Are you sure you want to remove this asset?')) return;
    await fetch(`${API_URL}/api/inventory/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchInventory();
  };

  const handleAgentUpdate = async (id, updates) => {
    await fetch(`${API_URL}/api/tickets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updates)
    });
    fetchTickets();
  };

  const handleDeleteUser = async (id) => {
    if (!confirm('Are you sure you want to remove this account?')) return;
    await fetch(`${API_URL}/api/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
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
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 border-l border-blue-400/30 pl-4">
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
              <Link to="/agent/inventory" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'inventory' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`}>
                <Box className="h-4 w-4" /> IT Assets
              </Link>
              <Link to="/agent/users" className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition ${currentTab === 'users' ? 'bg-blue-50 text-[#0052CC] font-semibold border-l-2 border-[#0052CC]' : 'text-slate-600 hover:bg-slate-100'}`}>
                <Users className="h-4 w-4" /> User Management
              </Link>
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
                {currentTab === 'tickets' ? 'Service Desk Queues' : currentTab === 'inventory' ? 'Asset Inventory' : 'User Directory'}
              </h1>
              <p className="text-slate-500 text-xs mt-0.5">
                {currentTab === 'tickets' ? 'Manage, assign, and resolve incoming IT requests.' : currentTab === 'inventory' ? 'Track hardware assignments, serials, and equipment status.' : 'View registered users and invite agents or team members.'}
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
          </header>

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
                            <div className="font-semibold text-blue-600 hover:underline cursor-pointer">{t.title}</div>
                            <div className="text-slate-500 text-[11px] line-clamp-1">{t.description}</div>
                            <div className="text-slate-400 text-[10px] mt-0.5">Reporter: <span className="font-medium text-slate-600">{t.created_by_name}</span></div>
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
                              <option value="Open">Open</option>
                              <option value="In Progress">In Progress</option>
                              <option value="Pending">Pending / On Hold</option>
                              <option value="Resolved">Resolved</option>
                              <option value="Closed">Closed</option>
                              <option value="Cancelled">Cancelled</option>
                            </select>
                          </td>
                          <td className="py-3.5 px-4">
                            <select value={t.assigned_to} onChange={(e) => handleAgentUpdate(t.id, { assigned_to: e.target.value, status: e.target.value === 'Unassigned' ? 'Open' : 'In Progress' })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                              <option value="Unassigned">Unassigned</option>
                              {agentsList.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                            </select>
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <button
                              onClick={() => setChatTicketId(t.id)}
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
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {inventoryList.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50 transition">
                        <td className="py-3.5 px-4 font-semibold text-slate-800">{item.name}</td>
                        <td className="py-3.5 px-4 text-slate-600">{item.category}</td>
                        <td className="py-3.5 px-4 font-mono text-[#0052CC]">{item.serial_number}</td>
                        <td className="py-3.5 px-4">
                          <select value={item.assigned_to} onChange={(e) => handleUpdateAsset(item.id, { assigned_to: e.target.value, status: e.target.value === 'Unassigned' ? 'In Stock' : 'Assigned' })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                            <option value="Unassigned">Unassigned</option>
                            {usersList.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                          </select>
                        </td>
                        <td className="py-3.5 px-4">
                          <select value={item.status} onChange={(e) => handleUpdateAsset(item.id, { status: e.target.value })} className="bg-white border border-slate-300 text-slate-700 rounded text-xs p-1 focus:outline-none focus:border-[#0052CC]">
                            <option>In Stock</option>
                            <option>Assigned</option>
                            <option>Under Maintenance</option>
                            <option>Decommissioned</option>
                          </select>
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
          )}

          {currentTab === 'users' && (
            <div className="bg-white border border-slate-200 rounded-md shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase">
                    <tr>
                      <th className="py-3 px-4">User Name</th>
                      <th className="py-3 px-4">Email Address</th>
                      <th className="py-3 px-4">Role</th>
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
                        <option>Laptop</option>
                        <option>Desktop</option>
                        <option>Monitor</option>
                        <option>Peripherals</option>
                        <option>Network Equipment</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Status</label>
                      <select value={newAsset.status} onChange={(e) => setNewAsset({ ...newAsset, status: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                        <option>In Stock</option>
                        <option>Assigned</option>
                        <option>Under Maintenance</option>
                        <option>Decommissioned</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Assign to Employee</label>
                    <select value={newAsset.assigned_to} onChange={(e) => setNewAsset({ ...newAsset, assigned_to: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-[#0052CC] focus:outline-none">
                      <option value="Unassigned">Unassigned</option>
                      {usersList.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                    </select>
                  </div>
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
                onClose={() => { setChatTicketId(null); fetchTickets(); }}
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