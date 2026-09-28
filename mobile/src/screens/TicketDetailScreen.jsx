import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Image as ImageIcon, Inbox, Send, TriangleAlert } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { useTickets } from '../context/TicketsContext.jsx';
import { api, socket } from '../lib/api.js';
import { ticketElapsed, timeAgo } from '../lib/format.js';
import { BusyButton, ConfirmSheet, ErrorBanner, PriorityTag, SkeletonCard, StatusChip } from '../components/ui.jsx';
import { useToast } from '../context/ToastContext.jsx';

/**
 * Full-screen ticket view (slides in over the tab bar): details on one tab,
 * the live per-ticket chat thread on the other. Messages send over REST so
 * they persist even if the socket is mid-reconnect, and arrive in real time
 * over the ticket's socket room — same contract as the desktop chat modal.
 */
export default function TicketDetailScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, token, logout } = useSession();
  const { tickets, loading, refresh } = useTickets();

  const ticket = tickets.find((t) => t.id === id);

  const [tab, setTab] = useState('details');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const bottomRef = useRef(null);

  // Start from the ticket's persisted history; live + sent messages append on
  // top (de-duplicated by id). Reset when a different ticket is opened.
  useEffect(() => {
    setMessages(ticket?.messages ? [...ticket.messages] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Live receive path: join this ticket's room; leave on the way out.
  useEffect(() => {
    if (!token) return undefined;
    socket.emit('join_ticket', id);
    const handler = (payload) => {
      if (payload.ticketId !== id) return;
      setMessages((prev) =>
        prev.some((m) => m.id === payload.message.id) ? prev : [...prev, payload.message],
      );
    };
    socket.on('receive_ticket_message', handler);
    return () => {
      socket.off('receive_ticket_message', handler);
      socket.emit('leave_ticket', id);
    };
  }, [id, token]);

  useEffect(() => {
    if (tab === 'chat') bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, tab]);

  const send = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSendError('');
    setSending(true);
    const r = await api(`/api/tickets/${id}/messages`, { method: 'POST', token, body: { text } });
    setSending(false);
    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      setInput(text);
      setSendError(r.data?.error || 'Could not send your message. Check your connection and try again.');
      return;
    }
    setMessages((prev) => (prev.some((m) => m.id === r.data.id) ? prev : [...prev, r.data]));
  };

  const canCancel =
    ticket &&
    user?.role !== 'agent' &&
    ticket.created_by === user?.id &&
    ticket.status !== 'Closed' &&
    ticket.status !== 'Cancelled';

  const cancelTicket = async () => {
    setCancelling(true);
    const r = await api(`/api/tickets/${id}`, { method: 'PATCH', token, body: { status: 'Cancelled' } });
    setCancelling(false);
    setConfirmCancel(false);
    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      toast(r.data?.error || 'Could not cancel this request.', 'error');
      return;
    }
    toast('Request cancelled');
    refresh(true);
  };

  if (!ticket) {
    return (
      <div className="flex h-full flex-col bg-slate-50">
        <DetailHeader title="Request" onBack={() => navigate(-1)} />
        {loading ? (
          <div className="space-y-3 p-4">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <Inbox className="mb-3 h-10 w-10 text-slate-300" />
            <p className="text-[15px] font-semibold text-slate-700">Request not found</p>
            <p className="mt-1 text-[13px] text-slate-400">It may have been removed, or the link is out of date.</p>
            <button
              type="button"
              onClick={() => navigate('/requests', { replace: true })}
              className="pressable mt-5 rounded-xl bg-brand px-5 py-3 text-[14px] font-semibold text-white active:bg-brand-dark"
            >
              Back to My Requests
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="animate-push flex h-full flex-col bg-slate-50">
      <DetailHeader
        title={ticket.title}
        status={<StatusChip status={ticket.status} />}
        onBack={() => navigate('/requests')}
      />

      {/* Tabs */}
      <div className="border-b border-slate-200 bg-white px-4">
        <div className="mx-auto flex max-w-md">
          {[
            { key: 'details', label: 'Details' },
            { key: 'chat', label: `Messages${messages.length ? ` (${messages.length})` : ''}` },
          ].map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative flex-1 py-3 text-[14px] font-semibold transition ${
                tab === key ? 'text-brand' : 'text-slate-400'
              }`}
            >
              {label}
              {tab === key && <span className="absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-brand" />}
            </button>
          ))}
        </div>
      </div>

      {tab === 'details' ? (
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-28 pt-4">
          <div className="animate-fade space-y-4">
            {/* Description card */}
            <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
              <h2 className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-slate-400">Description</h2>
              <p className="whitespace-pre-wrap text-[14px] leading-6 text-slate-700">{ticket.description}</p>
            </div>

            {/* Meta card */}
            <div className="divide-y divide-slate-50 rounded-2xl border border-slate-100 bg-white shadow-sm">
              <Row label="Category" value={ticket.category} />
              <Row label="Priority" value={<PriorityTag priority={ticket.priority} />} />
              <Row
                label="Assigned to"
                value={
                  ticket.assigned_to && ticket.assigned_to !== 'Unassigned'
                    ? ticket.assigned_to
                    : 'Awaiting assignment'
                }
              />
              <Row label="Raised" value={timeAgo(ticket.created_at)} />
              <Row label="Timing" value={ticketElapsed(ticket) || '—'} />
            </div>

            {/* Attachment */}
            {ticket.image && (
              <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm">
                <h2 className="px-4 pb-2 pt-3.5 text-[12px] font-bold uppercase tracking-wide text-slate-400">
                  Attachment
                </h2>
                <button type="button" onClick={() => setLightbox(true)} className="block w-full">
                  <img src={ticket.image} alt="Ticket attachment" className="max-h-64 w-full object-cover" />
                </button>
              </div>
            )}

            {canCancel && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                className="pressable w-full rounded-2xl border border-red-200 bg-white py-3.5 text-[14px] font-semibold text-red-600 active:bg-red-50"
              >
                Cancel this request
              </button>
            )}

            <p className="pb-2 text-center text-[12px] text-slate-400">
              Ticket #{String(ticket.id || '').replace(/^tkt-?/i, '').slice(-6).toUpperCase()}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain bg-slate-100/60 px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm">
                  <Send className="h-5 w-5 text-brand" />
                </span>
                <p className="text-[14px] font-semibold text-slate-700">No messages yet</p>
                <p className="mt-1 text-[13px] leading-5 text-slate-400">
                  Say hello below — the IT agent working on this request will reply here in real time.
                </p>
              </div>
            ) : (
              messages.map((m) => {
                const mine = m.sender === (user?.role === 'agent' ? 'agent' : 'user');
                return (
                  <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-5 shadow-sm ${
                        mine
                          ? 'rounded-br-md bg-brand text-white'
                          : 'rounded-bl-md border border-slate-100 bg-white text-slate-800'
                      }`}
                    >
                      {!mine && (
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-400">
                          {m.senderName || 'IT agent'}
                        </span>
                      )}
                      <span className="whitespace-pre-wrap">{m.text}</span>
                    </div>
                    <span className="mt-1 px-1 text-[10px] text-slate-400">{m.time}</span>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>

          {sendError && (
            <div className="border-t border-red-100 bg-red-50 px-4 py-2">
              <ErrorBanner className="border-0 bg-transparent px-0 py-0">
                <span className="inline-flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {sendError}
                </span>
              </ErrorBanner>
            </div>
          )}

          <form onSubmit={send} className="flex items-end gap-2 border-t border-slate-200 bg-white px-3 py-2.5 safe-bottom">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message IT…"
              className="max-h-32 flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[15px] text-slate-800 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              aria-label="Send message"
              className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-md shadow-brand/30 transition disabled:opacity-40 active:bg-brand-dark"
            >
              <Send className="h-4.5 w-4.5" />
            </button>
          </form>
        </div>
      )}

      <ConfirmSheet
        open={confirmCancel}
        busy={cancelling}
        danger
        title="Cancel this request?"
        message="The IT team will be notified that you no longer need help with this."
        confirmLabel="Yes, cancel it"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={cancelTicket}
      />

      {lightbox && ticket.image && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90 p-4 animate-fade"
          onClick={() => setLightbox(false)}
        >
          <img src={ticket.image} alt="Ticket attachment" className="max-h-full max-w-full object-contain" />
          <button type="button" aria-label="Close attachment" className="absolute right-4 top-4 text-white/80">
            <ImageIcon className="h-6 w-6" />
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-[13px] font-medium text-slate-400">{label}</span>
      <span className="text-right text-[14px] font-semibold text-slate-700">{value}</span>
    </div>
  );
}

function DetailHeader({ title, status, onBack }) {
  return (
    <div className="bg-gradient-to-r from-brand to-brand-deep px-2 pb-3.5 pt-2 text-white shadow-md safe-top">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Go back"
          className="pressable flex h-10 w-10 items-center justify-center rounded-full active:bg-white/10"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <span className="text-[15px] font-semibold">SayedFarms IT</span>
        {status && <span className="ml-auto pr-3">{status}</span>}
      </div>
      {title && <h1 className="line-clamp-2 px-3.5 pt-1.5 text-[17px] font-bold leading-6">{title}</h1>}
    </div>
  );
}
