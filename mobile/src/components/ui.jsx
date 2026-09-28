import { Check, LoaderCircle } from 'lucide-react';
import { initials, priorityDotClass, statusChipClass } from '../lib/format.js';

/** Status pill — same palette as the desktop portal. */
export function StatusChip({ status, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusChipClass(status)} ${className}`}>
      {status}
    </span>
  );
}

/** Priority dot + label. */
export function PriorityTag({ priority }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
      <span className={`h-1.5 w-1.5 rounded-full ${priorityDotClass(priority)}`} />
      {priority}
    </span>
  );
}

/** Circular avatar with the user's initials. */
export function Avatar({ name, className = 'h-9 w-9 text-xs' }) {
  return (
    <span className={`inline-flex items-center justify-center rounded-full bg-brand-deep font-bold text-white ${className}`}>
      {initials(name)}
    </span>
  );
}

/** Centre of an empty list — icon, title, hint, optional action. */
export function EmptyState({ icon: Icon, title, hint, children }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
      {Icon && (
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
          <Icon className="h-6 w-6 text-slate-400" />
        </span>
      )}
      <p className="text-[15px] font-semibold text-slate-700">{title}</p>
      {hint && <p className="mt-1 text-[13px] leading-5 text-slate-400">{hint}</p>}
      {children}
    </div>
  );
}

/** Full-width inline error banner. */
export function ErrorBanner({ children, className = '' }) {
  return (
    <div className={`rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] leading-5 text-red-600 ${className}`}>
      {children}
    </div>
  );
}

/** Button with built-in busy state (spinner replaces the label). */
export function BusyButton({ busy, children, className = '', disabled, ...rest }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className={`flex items-center justify-center gap-2 font-semibold transition disabled:opacity-60 ${className}`}
      {...rest}
    >
      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : children}
    </button>
  );
}

/** Skeleton card shown while the first load is in flight. */
export function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-slate-100 bg-white p-4">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="h-3.5 w-2/3 rounded bg-slate-200" />
        <div className="h-5 w-16 rounded-full bg-slate-100" />
      </div>
      <div className="mb-3 h-3 w-1/3 rounded bg-slate-100" />
      <div className="flex items-center justify-between">
        <div className="h-3 w-24 rounded bg-slate-100" />
        <div className="h-3 w-14 rounded bg-slate-100" />
      </div>
    </div>
  );
}

/**
 * Bottom action sheet — the mobile-native replacement for confirm() dialogs.
 * Backdrop tap or Cancel dismisses; `danger` styles the confirm button red.
 */
export function ConfirmSheet({ open, title, message, confirmLabel = 'Confirm', danger = false, busy = false, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade bg-slate-900/50 backdrop-blur-[2px]" onClick={busy ? undefined : onCancel} />
      <div className="animate-sheet relative w-full rounded-t-3xl bg-white px-5 pb-5 pt-3 safe-bottom">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-200" />
        <h3 className="text-center text-[16px] font-bold text-slate-900">{title}</h3>
        {message && <p className="mt-1.5 text-center text-[13px] leading-5 text-slate-500">{message}</p>}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`pressable flex items-center justify-center gap-2 rounded-xl py-3.5 text-[15px] font-semibold text-white transition disabled:opacity-60 ${
              danger ? 'bg-red-600 active:bg-red-700' : 'bg-brand active:bg-brand-dark'
            }`}
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : confirmLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="pressable rounded-xl bg-slate-100 py-3.5 text-[15px] font-semibold text-slate-600 transition disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
