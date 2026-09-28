import { useState } from 'react';
import { LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { useTickets } from '../context/TicketsContext.jsx';
import { Avatar, ConfirmSheet } from '../components/ui.jsx';

export default function ProfileScreen() {
  const { user, logout } = useSession();
  const { tickets } = useTickets();
  const [confirming, setConfirming] = useState(false);

  const isAgent = user?.role === 'agent';
  const isSuper = isAgent && user?.super_admin === true;
  const roleLabel = isSuper ? 'Super Admin' : isAgent ? 'IT Agent' : 'Employee';
  const total = tickets.length;
  const resolved = tickets.filter((t) => t.status === 'Resolved' || t.status === 'Closed').length;

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="bg-gradient-to-b from-brand to-brand-deep px-5 pb-16 pt-4 text-white safe-top">
        <div className="flex flex-col items-center pt-6">
          <Avatar name={user?.name} className="h-20 w-20 text-2xl ring-4 ring-white/25" />
          <h1 className="mt-3 text-[19px] font-bold tracking-tight">{user?.name}</h1>
          <p className="text-[13px] text-blue-100">{user?.email}</p>
          <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold ring-1 ring-white/25">
            {isSuper && <ShieldCheck className="h-3.5 w-3.5" />}
            {roleLabel}
          </span>
        </div>
      </div>

      <div className="-mt-10 space-y-4 px-4 pb-28">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-sm">
            <p className="text-[22px] font-bold leading-none text-slate-800">{total}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {isAgent ? 'Assigned' : 'Requests'}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-sm">
            <p className="text-[22px] font-bold leading-none text-emerald-600">{resolved}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Resolved</p>
          </div>
        </div>

        <div className="divide-y divide-slate-50 rounded-2xl border border-slate-100 bg-white shadow-sm">
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-brand">
              <Smartphone className="h-4.5 w-4.5" />
            </span>
            <div className="flex-1">
              <p className="text-[14px] font-semibold text-slate-700">SayedFarms Helpdesk Mobile</p>
              <p className="text-[12px] text-slate-400">Version 1.0.0 · Employee portal</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="pressable flex w-full items-center justify-center gap-2 rounded-2xl border border-red-200 bg-white py-3.5 text-[15px] font-semibold text-red-600 active:bg-red-50"
        >
          <LogOut className="h-4.5 w-4.5" />
          Sign out
        </button>

        <p className="pb-2 text-center text-[12px] text-slate-400">
          Powered by SayedFarms IT · Helpdesk OS
        </p>
      </div>

      <ConfirmSheet
        open={confirming}
        danger
        title="Sign out?"
        message="You'll need to sign in again to see your requests."
        confirmLabel="Sign out"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          logout();
        }}
      />
    </div>
  );
}
