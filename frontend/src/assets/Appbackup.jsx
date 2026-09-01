import React, { useState, useEffect } from 'react';
import { 
  Activity, Plus, ShieldCheck, User, LogOut, Image as ImageIcon, 
  X, Paperclip, Users, Ticket, UserPlus, Copy, Check, Trash2, 
  Box, PackagePlus, ChevronRight, Search, Headphones, 
  KeyRound, AlertCircle, Monitor, Laptop, FilePlus, ChevronDown 
} from 'lucide-react';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user') || 'null'));
  const [authMode, setAuthMode] = useState('login');
  
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '', role: 'user' });
  const [error, setError] = useState('');

  const [activeTab, setActiveTab] = useState('tickets'); // 'tickets' | 'users' | 'inventory'
  const [customerView, setCustomerView] = useState('portal'); // 'portal' | 'mytickets'
  
  // Jira Navigation State
  const [selectedGroup, setSelectedGroup] = useState('all'); 
  
  const [tickets, setTickets] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [inventoryList, setInventoryList] = useState([]);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [isAssetModalOpen, setIsAssetModalOpen] = useState(false);
  
  const [inviteEmail, setInviteEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  
  const [newTicket, setNewTicket] = useState({ title: '', description: '', category: 'Hardware', priority: 'Medium', assigned_to: 'Unassigned', image: '' });
  const [newAsset, setNewAsset] = useState({ name: '', category: 'Laptop', serial_number: '', assigned_to: 'Unassigned', status: 'In Stock' });

  useEffect(() => {
    if (token) {
      if (activeTab === 'tickets') fetchTickets();
      fetchUsers();
      if (user?.role === 'agent' && activeTab === 'inventory') fetchInventory();
    }
  }, [token, activeTab]);

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

  const fetchUsers = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) setUsersList(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchInventory = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/inventory', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) setInventoryList(data);
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
    await fetch('http://localhost:5000/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(newTicket)
    });
    setIsModalOpen(false);
    setNewTicket({ title: '', description: '', category: 'Hardware', priority: 'Medium', assigned_to: 'Unassigned', image: '' });
    fetchTickets();
    setCustomerView('mytickets');
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
    setIsModalOpen(true);
  };

  const handleCreateAsset = async (e) => {
    e.preventDefault();
    const res = await fetch('http://localhost:5000/api/inventory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(newAsset)
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);

    setIsAssetModalOpen(false);
    setNewAsset({ name: '', category: 'Laptop', serial_number: '', assigned_to: 'Unassigned', status: 'In Stock' });
    fetchInventory();
  };

  const handleUpdateAsset = async (id, updates) => {
    await fetch(`http://localhost:5000/api/inventory/${id}`, {
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
    await fetch(`http://localhost:5000/api/inventory/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchInventory();
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

  const handleDeleteUser = async (id) => {
    if (!confirm('Are you sure you want to remove this account?')) return;
    await fetch(`http://localhost:5000/api/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    fetchUsers();
  };

  const handleCancelTicket = async (id) => {
    await fetch(`http://localhost:5000/api/tickets/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ status: 'Cancelled' })
    });
    fetchTickets();
  };

  const copyInviteLink = () => {
    const link = `${window.location.origin}?invite=${encodeURIComponent(inviteEmail)}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const agentsList = usersList.filter(u => u.role === 'agent');

  // --- LOGIN / SIGNUP SCREEN (LIGHT BLUE & WHITE THEME) ---
  if (!token) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 to-blue-100 text-slate-800 flex items-center justify-center p-4 font-sans">
        <div className="bg-white border border-slate-200 p-8 rounded-2xl w-full max-w-md shadow-xl">
          <div className="flex items-center gap-3 mb-6 justify-center">
            <div className="p-2.5 bg-blue-600 rounded-xl text-white shadow-md shadow-blue-500/20">
              <Activity className="h-6 w-6" />
            </div>
            <span className="font-bold text-2xl tracking-wide text-slate-900">Help Center</span>
          </div>

          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg">{error}</div>}

          <form onSubmit={handleAuth} className="space-y-4">
            {authMode === 'signup' && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Full Name</label>
                <input required type="text" value={authForm.name} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-sm focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition" onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Email Address</label>
              <input required type="email" value={authForm.email} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-sm focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition" onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Password</label>
              <input required type="password" value={authForm.password} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-sm focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition" onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} />
            </div>

            {authMode === 'signup' && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Account Type</label>
                <select value={authForm.role} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-sm focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition" onChange={(e) => setAuthForm({ ...authForm, role: e.target.value })}>
                  <option value="user">Employee (Customer Portal)</option>
                  <option value="agent">IT Staff (Agent Console)</option>
                </select>
              </div>
            )}

            <button type="submit" className="w-full py-3 bg-blue-600 hover:bg-blue-700 font-semibold text-sm text-white rounded-lg transition shadow-md shadow-blue-600/20">
              {authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          <div className="mt-6 text-center text-xs text-slate-500">
            {authMode === 'login' ? (
              <p>Need an account? <button onClick={() => { setAuthMode('signup'); setAuthForm({ name: '', email: '', password: '', role: 'user' }); }} className="text-blue-600 font-medium hover:underline">Sign up</button></p>
            ) : (
              <p>Already registered? <button onClick={() => setAuthMode('login')} className="text-blue-600 font-medium hover:underline">Log in</button></p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- EMPLOYEE / CUSTOMER PORTAL ---
  if (user.role === 'user') {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-800 font-sans flex flex-col">
        <header className="bg-[#0052CC] text-white px-8 py-3 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-6">
            <div className="font-semibold text-base flex items-center gap-2 tracking-tight cursor-pointer" onClick={() => { setSelectedGroup('all'); setCustomerView('portal'); }}>
              Help Center
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setCustomerView(customerView === 'portal' ? 'mytickets' : 'portal')} className="text-xs bg-blue-700 hover:bg-blue-800 px-3 py-1.5 rounded font-medium transition">
              {customerView === 'portal' ? `My Requests (${tickets.length})` : 'Raise a Request'}
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
          {selectedGroup === 'all' && (
            <div className="relative w-full max-w-4xl px-6">
              <div className="relative">
                <Search className="absolute left-4 top-3.5 h-4 w-4 text-slate-400" />
                <input type="text" placeholder="Search for help topics, articles, or request types..." className="w-full bg-white text-slate-800 pl-11 pr-4 py-3 rounded-md text-sm shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
            </div>
          )}
        </div>

        <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-6">
          <nav className="text-xs text-slate-500 flex items-center gap-1.5 mb-2">
            <button onClick={() => { setSelectedGroup('all'); setCustomerView('portal'); }} className="hover:underline text-blue-600">Help Center</button>
            <ChevronRight className="h-3 w-3" />
            <span>SayedFarm IT</span>
          </nav>

          <h1 className="text-2xl font-bold text-slate-900 mb-1">SayedFarm IT</h1>
          <p className="text-sm text-slate-600 mb-6">Welcome! You can raise a request for SayedFarm IT using the options provided.</p>

          {customerView === 'portal' ? (
            <div>
              <div className="mb-6">
                <label className="block text-xs text-slate-500 mb-1">Contact us about</label>
                <div className="relative w-full max-w-md">
                  <select 
                    value={selectedGroup} 
                    onChange={(e) => setSelectedGroup(e.target.value)} 
                    className="w-full bg-slate-100 border border-slate-200 text-slate-800 rounded px-3 py-2 text-sm focus:outline-none focus:bg-white focus:border-blue-500 appearance-none font-medium cursor-pointer"
                  >
                    <option value="all">Select a category...</option>
                    <option value="common">Common Requests</option>
                    <option value="computers">Computers</option>
                    <option value="logins">Logins and Accounts</option>
                    <option value="applications">Applications</option>
                    <option value="servers">Servers and Infrastructure</option>
                  </select>
                  <ChevronDown className="h-4 w-4 text-slate-500 absolute right-3 top-3 pointer-events-none" />
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
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.status === 'Open' ? 'bg-yellow-100 text-yellow-800' : t.status === 'In Progress' ? 'bg-blue-100 text-blue-800' : t.status === 'Cancelled' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="py-3 text-right">
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

        <footer className="text-center py-4 text-xs text-slate-400 border-t border-slate-200 mt-auto bg-white">
          Powered by Jira Service Management
        </footer>

        {isModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div className="bg-white border border-slate-200 rounded-lg shadow-2xl p-6 w-full max-w-lg text-slate-800">
              <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-900">{newTicket.title}</h2>
                <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleCreateTicket} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Summary / Issue Title *</label>
                  <input required type="text" value={newTicket.title} onChange={(e) => setNewTicket({ ...newTicket, title: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-blue-600 focus:outline-none" />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Details & Description *</label>
                  <textarea required placeholder="Provide extra detail about your issue..." value={newTicket.description} onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-blue-600 focus:outline-none h-24" />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Direct Request to Agent (Optional)</label>
                  <select value={newTicket.assigned_to} onChange={(e) => setNewTicket({ ...newTicket, assigned_to: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-blue-600 focus:outline-none">
                    <option value="Unassigned">Any Available IT Agent</option>
                    {agentsList.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                    <select value={newTicket.category} onChange={(e) => setNewTicket({ ...newTicket, category: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-blue-600 focus:outline-none">
                      <option>Hardware</option>
                      <option>Software</option>
                      <option>Network</option>
                      <option>Access/Security</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Urgency / Priority</label>
                    <select value={newTicket.priority} onChange={(e) => setNewTicket({ ...newTicket, priority: e.target.value })} className="w-full border border-slate-300 rounded p-2 text-xs focus:border-blue-600 focus:outline-none">
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
                  <button type="button" onClick={() => setIsModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
                  <button type="submit" className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs rounded shadow">Create Request</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- IT AGENT DASHBOARD & CONSOLE ---
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex font-sans">
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
              <ShieldCheck className="text-indigo-400 h-4 w-4" />
              {user.name}
            </div>
            <span className="text-xs text-slate-400 uppercase tracking-wider font-semibold mt-1 block">
              IT Agent Console
            </span>
          </div>

          <nav className="space-y-1 mb-6">
            <button onClick={() => setActiveTab('tickets')} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'tickets' ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}>
              <Ticket className="h-4 w-4" /> Support Tickets
            </button>
            <button onClick={() => setActiveTab('inventory')} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'inventory' ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}>
              <Box className="h-4 w-4" /> IT Inventory
            </button>
            <button onClick={() => setActiveTab('users')} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'users' ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}>
              <Users className="h-4 w-4" /> Manage Users
            </button>
          </nav>
        </div>

        <button onClick={handleLogout} className="flex items-center gap-2 text-slate-400 hover:text-rose-400 text-sm font-medium transition">
          <LogOut className="h-4 w-4" /> Sign Out
        </button>
      </aside>

      <main className="flex-1 p-8 overflow-y-auto">
        <header className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold">
              {activeTab === 'tickets' ? 'IT Ticket Management Console' : activeTab === 'inventory' ? 'IT Inventory & Asset Management' : 'User & Staff Directory'}
            </h1>
            <p className="text-slate-400 text-sm">
              {activeTab === 'tickets' ? 'Resolve, reassign, and track tickets.' : activeTab === 'inventory' ? 'Track company hardware and user assignments.' : 'View all registered employees and send invitations.'}
            </p>
          </div>
          {activeTab === 'users' && (
            <button onClick={() => setIsInviteModalOpen(true)} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 rounded-lg text-sm font-medium transition shadow-lg shadow-indigo-600/20">
              <UserPlus className="h-4 w-4" /> Invite User / Agent
            </button>
          )}
          {activeTab === 'inventory' && (
            <button onClick={() => setIsAssetModalOpen(true)} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 rounded-lg text-sm font-medium transition shadow-lg shadow-indigo-600/20">
              <PackagePlus className="h-4 w-4" /> Add IT Asset
            </button>
          )}
        </header>

        {activeTab === 'tickets' && (
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-400">
                <thead className="border-b border-slate-800 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="pb-3">Ticket Details</th>
                    <th className="pb-3">Attachment</th>
                    <th className="pb-3">Category</th>
                    <th className="pb-3">Priority</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3">Assigned Tech</th>
                    <th className="pb-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {tickets.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="py-8 text-center text-slate-500">No tickets found.</td>
                    </tr>
                  ) : (
                    tickets.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-800/20">
                        <td className="py-4">
                          <div className="font-medium text-slate-200">{t.title}</div>
                          <div className="text-xs text-slate-500">{t.description}</div>
                          <div className="text-xs text-indigo-400 mt-1">Requested by: {t.created_by_name}</div>
                        </td>
                        <td className="py-4">
                          {t.image ? (
                            <button onClick={() => setSelectedImage(t.image)} className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition">
                              <ImageIcon className="h-3.5 w-3.5 text-indigo-400" /> View Image
                            </button>
                          ) : (
                            <span className="text-xs text-slate-600">None</span>
                          )}
                        </td>
                        <td className="py-4">{t.category}</td>
                        <td className="py-4">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${t.priority === 'High' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-slate-800 text-slate-400'}`}>
                            {t.priority}
                          </span>
                        </td>
                        <td className="py-4">
                          <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${t.status === 'Open' ? 'bg-yellow-500/10 text-yellow-400' : t.status === 'In Progress' ? 'bg-indigo-500/10 text-indigo-400' : t.status === 'Cancelled' ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                            {t.status}
                          </span>
                        </td>
                        <td className="py-4 text-slate-300">
                          <select value={t.assigned_to} onChange={(e) => handleAgentUpdate(t.id, { assigned_to: e.target.value, status: e.target.value === 'Unassigned' ? 'Open' : 'In Progress' })} className="bg-slate-950 border border-slate-800 text-xs rounded-lg p-1.5 focus:outline-none focus:border-indigo-500">
                            <option value="Unassigned">Unassigned</option>
                            {agentsList.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                          </select>
                        </td>
                        <td className="py-4 text-right space-x-2">
                          {t.status !== 'Closed' && t.status !== 'Cancelled' && (
                            <button onClick={() => handleAgentUpdate(t.id, { status: 'Closed' })} className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20">
                              Mark Resolved
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

        {activeTab === 'inventory' && (
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-400">
                <thead className="border-b border-slate-800 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="pb-3">Asset Name</th>
                    <th className="pb-3">Category</th>
                    <th className="pb-3">Serial Number</th>
                    <th className="pb-3">Assigned User</th>
                    <th className="pb-3">Asset Status</th>
                    <th className="pb-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {inventoryList.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-800/20">
                      <td className="py-4 font-medium text-slate-200">{item.name}</td>
                      <td className="py-4">{item.category}</td>
                      <td className="py-4 text-xs font-mono text-indigo-400">{item.serial_number}</td>
                      <td className="py-4">
                        <select value={item.assigned_to} onChange={(e) => handleUpdateAsset(item.id, { assigned_to: e.target.value, status: e.target.value === 'Unassigned' ? 'In Stock' : 'Assigned' })} className="bg-slate-950 border border-slate-800 text-xs rounded-lg p-1.5 focus:outline-none">
                          <option value="Unassigned">Unassigned</option>
                          {usersList.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                        </select>
                      </td>
                      <td className="py-4">
                        <select value={item.status} onChange={(e) => handleUpdateAsset(item.id, { status: e.target.value })} className="bg-slate-950 border border-slate-800 text-xs rounded-lg p-1.5 focus:outline-none">
                          <option>In Stock</option>
                          <option>Assigned</option>
                          <option>Under Maintenance</option>
                          <option>Decommissioned</option>
                        </select>
                      </td>
                      <td className="py-4 text-right">
                        <button onClick={() => handleDeleteAsset(item.id)} className="p-1.5 text-slate-500 hover:text-rose-400 transition">
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

        {activeTab === 'users' && (
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-400">
                <thead className="border-b border-slate-800 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="pb-3 font-semibold">User</th>
                    <th className="pb-3 font-semibold">Email</th>
                    <th className="pb-3 font-semibold">Role</th>
                    <th className="pb-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {usersList.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-800/20">
                      <td className="py-4 font-medium text-slate-200">{u.name}</td>
                      <td className="py-4">{u.email}</td>
                      <td className="py-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${u.role === 'agent' ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
                          {u.role === 'agent' ? 'IT Agent' : 'Employee'}
                        </span>
                      </td>
                      <td className="py-4 text-right">
                        {u.email !== user.email && (
                          <button onClick={() => handleDeleteUser(u.id)} className="p-1.5 text-slate-500 hover:text-rose-400 transition">
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
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md">
              <h2 className="text-lg font-bold mb-4">Add New IT Asset</h2>
              <form onSubmit={handleCreateAsset} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Asset Name / Model</label>
                  <input required type="text" placeholder="MacBook Pro 16 M2" value={newAsset.name} onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Serial Number / Tag</label>
                  <input required type="text" placeholder="SN-8942-X1" value={newAsset.serial_number} onChange={(e) => setNewAsset({ ...newAsset, serial_number: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Category</label>
                    <select value={newAsset.category} onChange={(e) => setNewAsset({ ...newAsset, category: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                      <option>Laptop</option>
                      <option>Desktop</option>
                      <option>Monitor</option>
                      <option>Peripherals</option>
                      <option>Network Equipment</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Status</label>
                    <select value={newAsset.status} onChange={(e) => setNewAsset({ ...newAsset, status: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                      <option>In Stock</option>
                      <option>Assigned</option>
                      <option>Under Maintenance</option>
                      <option>Decommissioned</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Assign to Employee</label>
                  <select value={newAsset.assigned_to} onChange={(e) => setNewAsset({ ...newAsset, assigned_to: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                    <option value="Unassigned">Unassigned</option>
                    {usersList.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                  </select>
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button type="button" onClick={() => setIsAssetModalOpen(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
                  <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm font-medium rounded-lg">Save Asset</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {isInviteModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md">
              <h2 className="text-lg font-bold mb-4">Send Registration Invitation</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Target Email</label>
                  <input type="email" placeholder="colleague@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Generated Invite Link</label>
                  <div className="flex gap-2">
                    <input readOnly value={`${window.location.origin}?invite=${encodeURIComponent(inviteEmail || 'user')}`} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs text-slate-400 focus:outline-none" />
                    <button onClick={copyInviteLink} className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition">
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button type="button" onClick={() => setIsInviteModalOpen(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Close</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedImage && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 max-w-2xl w-full flex flex-col items-center">
              <div className="w-full flex justify-between items-center mb-3">
                <span className="text-sm font-semibold text-slate-300">Ticket Screenshot</span>
                <button onClick={() => setSelectedImage(null)} className="text-slate-400 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <img src={selectedImage} alt="Attachment" className="max-h-[70vh] rounded-lg object-contain border border-slate-800" />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
