import { useNavigate } from 'react-router-dom';
import { ChevronRight, CircleCheck, LifeBuoy, Monitor, KeyRound, TriangleAlert, Inbox } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { useTickets } from '../context/TicketsContext.jsx';
import { greeting, isClosedStatus, timeAgo } from '../lib/format.js';
import { Avatar, EmptyState, SkeletonCard, StatusChip } from '../components/ui.jsx';
import PullToRefresh from '../components/PullToRefresh.jsx';

// Quick actions mirror the desktop portal's request types, with the same
// default categories.
const QUICK_ACTIONS = [
  { title: 'Get IT help', category: 'Other', Icon: LifeBuoy, tint: 'bg-blue-50 text-brand' },
  { title: 'New account / access', category: 'Account', Icon: KeyRound, tint: 'bg-violet-50 text-violet-600' },
  { title: 'Report a system problem', category: 'Software', Icon: TriangleAlert, tint: 'bg-amber-50 text-amber-600' },
  { title: 'Report broken hardware', category: 'Hardware', Icon: Monitor, tint: 'bg-rose-50 text-rose-600' },
];

export default function HomeScreen() {
  const { user } = useSession();
  const { tickets, loading, error, refresh } = useTickets();
  const navigate = useNavigate();

  const active = tickets.filter((t) => !isClosedStatus(t.status));
  const inProgress = tickets.filter((t) => t.status === 'In Progress');
  const resolved = tickets.filter((t) => t.status === 'Resolved' || t.status === 'Closed');
  const recent = [...tickets]
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
    .slice(0, 3);

  const stats = [
    { label: 'Active', value: active.length, className: 'text-brand' },
    { label: 'In progress', value: inProgress.length, className: 'text-blue-600' },
    { label: 'Resolved', value: resolved.length, className: 'text-emerald-600' },
  ];

  return (
    <PullToRefresh onRefresh={() => refresh()} className="h-full">
      {/* Header */}
      <div className="bg-gradient-to-b from-brand to-brand-deep px-5 pb-14 pt-2 text-white safe-top">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-blue-100">{greeting()}</p>
            <h1 className="text-[20px] font-bold tracking-tight">{user?.name}</h1>
          </div>
          <button type="button" onClick={() => navigate('/profile')} aria-label="Open profile">
            <Avatar name={user?.name} className="h-10 w-10 text-sm ring-2 ring-white/40" />
          </button>
        </div>
        <p className="mt-5 text-[13px] leading-5 text-blue-100">
          Need something from IT? Raise a request and follow it right here — every update lands on your phone instantly.
        </p>
      </div>

      <div className="-mt-10 space-y-6 px-4 pb-28 pt-1">
        {/* Summary card */}
        <div className="grid grid-cols-3 divide-x divide-slate-100 rounded-2xl border border-slate-100 bg-white shadow-sm">
          {stats.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => navigate('/requests')}
              className="pressable flex flex-col items-center gap-0.5 rounded-2xl py-4"
            >
              <span className={`text-[22px] font-bold leading-none ${s.className}`}>{loading && !error ? '…' : s.value}</span>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{s.label}</span>
            </button>
          ))}
        </div>

        {/* Quick actions */}
        <section>
          <h2 className="mb-2.5 px-1 text-[15px] font-bold text-slate-800">Raise a request</h2>
          <div className="grid grid-cols-2 gap-3">
            {QUICK_ACTIONS.map(({ title, category, Icon, tint }) => (
              <button
                key={title}
                type="button"
                onClick={() => navigate('/new', { state: { title, category } })}
                className="pressable flex flex-col items-start gap-2.5 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"
              >
                <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tint}`}>
                  <Icon className="h-4.5 w-4.5" strokeWidth={2.2} />
                </span>
                <span className="text-[13px] font-semibold leading-4 text-slate-700">{title}</span>
                <span className="text-[11px] text-slate-400">{category}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Recent requests */}
        <section>
          <div className="mb-2.5 flex items-center justify-between px-1">
            <h2 className="text-[15px] font-bold text-slate-800">Recent requests</h2>
            <button
              type="button"
              onClick={() => navigate('/requests')}
              className="flex items-center text-[12px] font-semibold text-brand"
            >
              See all
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {error && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-600">{error}</p>
          )}
          {loading && tickets.length === 0 ? (
            <div className="space-y-3">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : recent.length === 0 ? (
            <div className="rounded-2xl border border-slate-100 bg-white">
              <EmptyState
                icon={Inbox}
                title="No requests yet"
                hint="When you raise your first request it will show up here with live status updates."
              >
                <button
                  type="button"
                  onClick={() => navigate('/new')}
                  className="pressable mt-2 rounded-xl bg-brand px-5 py-3 text-[14px] font-semibold text-white active:bg-brand-dark"
                >
                  Raise your first request
                </button>
              </EmptyState>
            </div>
          ) : (
            <div className="space-y-3">
              {recent.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigate(`/requests/${t.id}`)}
                  className="pressable flex w-full flex-col gap-2 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="line-clamp-1 text-[14px] font-semibold text-slate-800">{t.title}</span>
                    <StatusChip status={t.status} />
                  </div>
                  <div className="flex items-center justify-between text-[12px] text-slate-400">
                    <span>{t.category}</span>
                    <span className="inline-flex items-center gap-1">
                      {t.status === 'Resolved' && <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />}
                      {timeAgo(t.created_at)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </PullToRefresh>
  );
}
