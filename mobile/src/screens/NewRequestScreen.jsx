import { useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Image as ImageIcon, Plus, X } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { useTickets } from '../context/TicketsContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../lib/api.js';
import { BusyButton, ErrorBanner } from '../components/ui.jsx';

const UNASSIGNED = 'Unassigned';
// The API stores attachments inline and rejects anything over ~2 MB of
// base64 — refuse it up front instead of failing after submit (as desktop).
const MAX_IMAGE_BYTES = 1_500_000;

const inputClass =
  'w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-base text-slate-800 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/20 transition';

/**
 * Full-screen "new request" sheet. Opened from the tab bar's centre button or
 * a Home quick action (location.state = { title, category } pre-fills the
 * form). On success you land on the new ticket's detail screen.
 */
export default function NewRequestScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { user, token, logout } = useSession();
  const { agents, enums, refresh } = useTickets();

  const prefill = location.state || {};
  const [form, setForm] = useState({
    title: prefill.title || '',
    description: '',
    category: enums.ticketCategory.includes(prefill.category) ? prefill.category : 'Hardware',
    priority: 'Medium',
    agent: UNASSIGNED,
    image: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const fileRef = useRef(null);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const categories = useMemo(
    () => (enums.ticketCategory?.length ? enums.ticketCategory : ['Hardware', 'Software', 'Network', 'Access/Security', 'Account', 'Other']),
    [enums.ticketCategory],
  );
  const priorities = enums.ticketPriority?.length ? enums.ticketPriority : ['Low', 'Medium', 'High', 'Urgent'];

  const onPickImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError(
        `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 1.5 MB. Please choose a smaller screenshot.`,
      );
      e.target.value = '';
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onloadend = () => set('image')(reader.result);
    reader.readAsDataURL(file);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      category: form.category,
      priority: form.priority,
      image: form.image,
      // Assignment is keyed by user id; the 'Unassigned' sentinel means any
      // available agent (same contract as the desktop portal).
      assigned_to_id: form.agent === UNASSIGNED ? UNASSIGNED : form.agent,
    };
    const r = await api('/api/tickets', { method: 'POST', token, body });
    setLoading(false);
    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      setError(r.data?.error || 'Could not create the request. Your draft is still here — try again.');
      return;
    }
    // Refresh the shared list first so the detail screen (which reads its
    // ticket from the list) finds the new ticket on arrival.
    await refresh(true);
    toast('Request sent to IT');
    navigate(`/requests/${r.data.id}`, { replace: true });
  };

  const selectedAgent = agents.find((a) => a.id === form.agent);

  return (
    <div className="animate-sheet flex h-full flex-col bg-slate-50">
      {/* Grabber + header */}
      <div className="border-b border-slate-100 bg-white px-4 pb-3 pt-2 safe-top">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-200" />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[18px] font-bold tracking-tight text-slate-900">New request</h1>
            <p className="text-[12px] text-slate-400">Signed in as {user?.name}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Close"
            className="pressable flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-500 active:bg-slate-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <form onSubmit={submit} className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-8 pt-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}

        <div>
          <label htmlFor="title" className="mb-1.5 block text-[13px] font-semibold text-slate-600">
            Summary <span className="text-red-500">*</span>
          </label>
          <input
            id="title"
            required
            maxLength={200}
            type="text"
            placeholder="e.g. Laptop won't connect to Wi-Fi"
            className={inputClass}
            value={form.title}
            onChange={(e) => set('title')(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="description" className="mb-1.5 block text-[13px] font-semibold text-slate-600">
            Details <span className="text-red-500">*</span>
          </label>
          <textarea
            id="description"
            required
            rows={4}
            placeholder="What happened? When did it start? Anything you already tried?"
            className={`${inputClass} resize-none`}
            value={form.description}
            onChange={(e) => set('description')(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="category" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Category</label>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set('category')(c)}
                className={`shrink-0 rounded-full px-3.5 py-2 text-[13px] font-semibold transition ${
                  form.category === c ? 'bg-brand text-white shadow-sm shadow-brand/30' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-semibold text-slate-600">Urgency</label>
          <div className="grid grid-cols-4 gap-2">
            {priorities.map((p) => {
              const selected = form.priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => set('priority')(p)}
                  className={`rounded-xl border py-2.5 text-[13px] font-semibold transition ${
                    selected
                      ? p === 'Urgent'
                        ? 'border-red-500 bg-red-50 text-red-600'
                        : p === 'High'
                          ? 'border-orange-500 bg-orange-50 text-orange-600'
                          : 'border-brand bg-blue-50 text-brand'
                      : 'border-slate-200 bg-white text-slate-500'
                  }`}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>

        {/* Direct request to a specific agent (id-keyed, same as desktop) */}
        <div className="relative">
          <label className="mb-1.5 block text-[13px] font-semibold text-slate-600">
            Direct request to agent <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <button
            type="button"
            onClick={() => setAgentPickerOpen((v) => !v)}
            className={`${inputClass} flex items-center justify-between text-left`}
          >
            <span className={form.agent === UNASSIGNED ? 'text-slate-500' : 'text-slate-800'}>
              {form.agent === UNASSIGNED ? 'Any available IT agent' : selectedAgent?.name || 'Selected agent'}
            </span>
            <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${agentPickerOpen ? 'rotate-180' : ''}`} />
          </button>
          {agentPickerOpen && (
            <div className="animate-fade absolute inset-x-0 top-full z-20 mt-1 max-h-60 divide-y divide-slate-50 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
              {[{ id: UNASSIGNED, name: 'Any available IT agent' }, ...agents].map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { set('agent')(a.id); setAgentPickerOpen(false); }}
                  className={`block w-full px-4 py-3 text-left text-[14px] ${
                    form.agent === a.id ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700'
                  }`}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Attachment */}
        <div>
          <span className="mb-1.5 block text-[13px] font-semibold text-slate-600">Attachment (screenshot)</span>
          {form.image ? (
            <div className="relative overflow-hidden rounded-xl border border-slate-200">
              <img src={form.image} alt="Attachment preview" className="max-h-44 w-full object-cover" />
              <button
                type="button"
                onClick={() => set('image')('')}
                aria-label="Remove attachment"
                className="pressable absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-white py-5 text-[14px] font-medium text-slate-500 active:bg-slate-50"
            >
              <ImageIcon className="h-5 w-5 text-slate-400" />
              Attach a photo or screenshot
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
        </div>

        <BusyButton
          busy={loading}
          className="w-full rounded-2xl bg-brand py-4 text-[16px] text-white shadow-lg shadow-brand/30 active:bg-brand-dark"
        >
          {loading ? (
            'Sending…'
          ) : (
            <>
              <Plus className="h-4.5 w-4.5" strokeWidth={2.5} />
              Send to IT
            </>
          )}
        </BusyButton>
        <p className="text-center text-[12px] text-slate-400">
          You'll be able to chat with the assigned agent and follow every update right here.
        </p>
      </form>
    </div>
  );
}
