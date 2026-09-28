import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Search, SearchX } from 'lucide-react';
import { useTickets } from '../context/TicketsContext.jsx';
import { isClosedStatus, ticketElapsed, timeAgo } from '../lib/format.js';
import { EmptyState, PriorityTag, SkeletonCard, StatusChip } from '../components/ui.jsx';
import PullToRefresh from '../components/PullToRefresh.jsx';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'cancelled', label: 'Cancelled' },
];

const matchesFilter = (t, filter) => {
  if (filter === 'active') return !isClosedStatus(t.status);
  if (filter === 'resolved') return t.status === 'Resolved' || t.status === 'Closed';
  if (filter === 'cancelled') return t.status === 'Cancelled';
  return true;
};

const matchesSearch = (t, q) => {
  if (!q) return true;
  const hay = `${t.title} ${t.category} ${t.status} ${t.priority} ${t.assigned_to || ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
};

export default function RequestsScreen() {
  const { tickets, loading, error, refresh } = useTickets();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const visible = useMemo(
    () =>
      [...tickets]
        .filter((t) => matchesFilter(t, filter) && matchesSearch(t, query.trim()))
        .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)),
    [tickets, filter, query],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header + search + filter chips stay pinned; the list scrolls */}
      <div className="bg-white px-4 pb-3 pt-2 shadow-sm safe-top">
        <div className="flex items-baseline justify-between px-1 pb-3 pt-2">
          <h1 className="text-[20px] font-bold tracking-tight text-slate-900">My Requests</h1>
          <span className="text-[12px] font-semibold text-slate-400">{tickets.length} total</span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            inputMode="search"
            placeholder="Search requests…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-[15px] text-slate-800 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
        </div>
        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
          {FILTERS.map((f) => {
            const count = tickets.filter((t) => matchesFilter(t, f.key)).length;
            const activeFilter = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition ${
                  activeFilter ? 'bg-brand text-white shadow-sm shadow-brand/30' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {f.label}
                <span className={`ml-1.5 ${activeFilter ? 'text-blue-200' : 'text-slate-400'}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <PullToRefresh onRefresh={() => refresh()} className="min-h-0 flex-1">
        <div className="space-y-3 px-4 pb-28 pt-4">
          {error && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-600">{error}</p>
          )}
          {loading && tickets.length === 0 ? (
            <div className="space-y-3">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-2xl border border-slate-100 bg-white">
              <EmptyState
                icon={query.trim() ? SearchX : ClipboardList}
                title={query.trim() ? 'No matching requests' : filter === 'all' ? 'No requests yet' : `Nothing ${filter}`}
                hint={
                  query.trim()
                    ? 'Try a different search term or clear the filter.'
                    : 'Anything you raise will appear here with its live status.'
                }
              />
            </div>
          ) : (
            visible.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => navigate(`/requests/${t.id}`)}
                className="pressable flex w-full flex-col gap-2.5 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-[14px] font-semibold leading-5 text-slate-800">{t.title}</span>
                  <StatusChip status={t.status} className="mt-0.5 shrink-0" />
                </div>
                <div className="flex items-center gap-2 text-[12px] text-slate-400">
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">{t.category}</span>
                  <PriorityTag priority={t.priority} />
                </div>
                <div className="flex items-center justify-between border-t border-slate-50 pt-2.5 text-[12px]">
                  <span className="text-slate-400">{ticketElapsed(t) || timeAgo(t.created_at)}</span>
                  <span className="font-semibold text-brand">
                    {(t.messages?.length || 0) > 0
                      ? `${t.messages.length} message${t.messages.length > 1 ? 's' : ''}`
                      : 'View'}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}
