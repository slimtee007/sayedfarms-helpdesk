// frontend/src/App.jsx
import React, { useState, useEffect } from 'react';
import { Activity, Plus, ShieldCheck, User, LogOut, Clock, CheckCircle, AlertCircle } from 'lucide-react';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user') || 'null'));
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'signup'
  
  // Auth Form State
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '', role: 'user' });
  const [error, setError] = useState('');

  // Tickets State
  const [tickets, setTickets] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTicket, setNewTicket] = useState({ title: '', description: '', category: 'Hardware', priority: 'Medium' });

  useEffect(() => {
    if (token) fetchTickets();
  }, [token]);

  const fetchTickets = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/tickets', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) setTickets(data);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    
    const res = await fetch(`http://localhost:5000${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authForm)
    });
    const data = await res.json();

    if (!res.ok) return setError(data.error);

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  };

  const handleLogout = () => {
    localStorage.clear();
    setToken('');
    setUser(null);
  };

  const handleCreateTicket = async (e) => {
    e.preventDefault();
    await fetch('http://localhost:5000/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(newTicket)
    });
    setIsModalOpen(false);
    setNewTicket({ title: '', description: '', category: 'Hardware', priority: 'Medium' });
    fetchTickets();
  };

  const handleAgentUpdate = async (id, updates) => {
    await fetch(`http://localhost:5000/api/tickets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updates)
    });
    fetchTickets();
  };

  // --- AUTH SCREEN ---
  if (!token) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 font-sans">
        <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl w-full max-w-md shadow-2xl">
          <div className="flex items-center gap-3 mb-6 justify-center">
            <div className="p-2.5 bg-indigo-600 rounded-xl text-white">
              <Activity className="h-6 w-6" />
            </div>
            <span className="font-bold text-2xl tracking-wide">OmniDesk</span>
          </div>

          {error && <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm rounded-lg">{error}</div>}

          <form onSubmit={handleAuth} className="space-y-4">
            {authMode === 'signup' && (
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Full Name</label>
                <input required type="text" className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Email Address</label>
              <input required type="email" className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
              <input required type="password" className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} />
            </div>

            {authMode === 'signup' && (
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Account Type</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" onChange={(e) => setAuthForm({ ...authForm, role: e.target.value })}>
                  <option value="user">Employee (User Portal)</option>
                  <option value="agent">IT Staff (Agent Portal)</option>
                </select>
              </div>
            )}

            <button type="submit" className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 font-semibold text-sm rounded-lg transition shadow-lg shadow-indigo-600/20">
              {authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          <div className="mt-6 text-center text-xs text-slate-400">
            {authMode === 'login' ? (
              <p>Need an account? <button onClick={() => setAuthMode('signup')} className="text-indigo-400 hover:underline">Sign up</button></p>
            ) : (
              <p>Already registered? <button onClick={() => setAuthMode('login')} className="text-indigo-400 hover:underline">Log in</button></p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- DASHBOARD (USER & AGENT PORTALS) ---
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex font-sans">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 bg-slate-900/50 p-6 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 mb-8">
            <div className="p-2 bg-indigo-600 rounded-lg text-white">
              <Activity className="h-6 w-6" />
            </div>
            <span className="font-bold text-xl tracking-wide">OmniDesk</span>
          </div>
          
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 mb-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              {user.role === 'agent' ? <ShieldCheck className="text-indigo-400 h-4 w-4" /> : <User className="text-emerald-400 h-4 w-4" />}
              {user.name}
            </div>
            <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold mt-1 block">
              {user.role === 'agent' ? 'IT Agent Portal' : 'User Portal'}
            </span>
          </div>
        </div>

        <button onClick={handleLogout} className="flex items-center gap-2 text-slate-400 hover:text-rose-400 text-sm font-medium transition">
          <LogOut className="h-4 w-4" /> Sign Out
        </button>
      </aside>

      {/* Main View */}
      <main className="flex-1 p-8 overflow-y-auto">
        <header className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold">{user.role === 'agent' ? 'IT Ticket Management Console' : 'My Support Tickets'}</h1>
            <p className="text-slate-400 text-sm">
              {user.role === 'agent' ? 'Resolve user tickets, assign technicians, and track SLAs.' : 'Track the resolution status of your reported issues.'}
            </p>
          </div>
          {user.role === 'user' && (
            <button onClick={() => setIsModalOpen(true)} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 rounded-lg text-sm font-medium transition shadow-lg shadow-indigo-600/20">
              <Plus className="h-4 w-4" /> Submit New Ticket
            </button>
          )}
        </header>

        {/* Tickets Table */}
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-400">
              <thead className="border-b border-slate-800 text-xs uppercase text-slate-500">
                <tr>
                  <th className="pb-3">Ticket Details</th>
                  <th className="pb-3">Category</th>
                  <th className="pb-3">Priority</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3">Assigned Tech</th>
                  {user.role === 'agent' && <th className="pb-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {tickets.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-800/20">
                    <td className="py-4">
                      <div className="font-medium text-slate-200">{t.title}</div>
                      <div className="text-xs text-slate-500">{t.description}</div>
                      <div className="text-xs text-indigo-400 mt-1">Requested by: {t.created_by_name}</div>
                    </td>
                    <td className="py-4">{t.category}</td>
                    <td className="py-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${t.priority === 'High' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-slate-800 text-slate-400'}`}>
                        {t.priority}
                      </span>
                    </td>
                    <td className="py-4">
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${t.status === 'Open' ? 'bg-yellow-500/10 text-yellow-400' : t.status === 'In Progress' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                        {t.status}
                      </span>
                    </td>
                    <td className="py-4 text-slate-300">{t.assigned_to}</td>
                    
                    {/* IT Agent Workflow Tools */}
                    {user.role === 'agent' && (
                      <td className="py-4 text-right space-x-2">
                        {t.status === 'Open' && (
                          <button onClick={() => handleAgentUpdate(t.id, { status: 'In Progress', assigned_to: user.name })} className="px-3 py-1 text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20">
                            Assign to Me
                          </button>
                        )}
                        {t.status !== 'Closed' && (
                          <button onClick={() => handleAgentUpdate(t.id, { status: 'Closed' })} className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20">
                            Mark Resolved
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Create Ticket Modal for Users */}
        {isModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md">
              <h2 className="text-lg font-bold mb-4">Submit IT Support Request</h2>
              <form onSubmit={handleCreateTicket} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Issue Title</label>
                  <input required type="text" value={newTicket.title} onChange={(e) => setNewTicket({ ...newTicket, title: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Description</label>
                  <textarea required value={newTicket.description} onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none h-24" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Category</label>
                    <select value={newTicket.category} onChange={(e) => setNewTicket({ ...newTicket, category: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                      <option>Hardware</option>
                      <option>Software</option>
                      <option>Network</option>
                      <option>Access/Security</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Priority</label>
                    <select value={newTicket.priority} onChange={(e) => setNewTicket({ ...newTicket, priority: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                      <option>Low</option>
                      <option>Medium</option>
                      <option>High</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
                  <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm font-medium rounded-lg">Submit Ticket</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}