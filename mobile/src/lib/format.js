// Formatting helpers shared by the mobile screens.

// `2026-09-28T07:15:00.000Z` -> "2h ago" / "Yesterday" / "21/09/2026"
export function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  const d = new Date(then);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Minutes -> "45m" / "3h 20m" / "2d 4h" (same format as the desktop MTTR view)
export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const m = Math.max(0, Math.round(Number(minutes)));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// One-line timing summary: how long resolution took, or how long the request
// has been open.
export function ticketElapsed(t) {
  if (!t) return null;
  if (t.resolution_minutes != null) return `Resolved in ${formatDuration(t.resolution_minutes)}`;
  if (t.status === 'Cancelled') return null;
  const created = Date.parse(t.created_at);
  if (!Number.isFinite(created)) return null;
  return `Open for ${formatDuration((Date.now() - created) / 60000)}`;
}

// Status chip colours (match the desktop portal's palette).
const STATUS_STYLES = {
  Open: 'bg-amber-100 text-amber-800',
  'In Progress': 'bg-blue-100 text-blue-800',
  Pending: 'bg-orange-100 text-orange-800',
  Resolved: 'bg-emerald-100 text-emerald-800',
  Closed: 'bg-slate-200 text-slate-700',
  Cancelled: 'bg-red-100 text-red-700',
};

export const statusChipClass = (status) =>
  STATUS_STYLES[status] || 'bg-slate-100 text-slate-600';

export const isClosedStatus = (status) => status === 'Closed' || status === 'Cancelled';

// Priority accent dot colours.
const PRIORITY_STYLES = {
  Low: 'bg-slate-400',
  Medium: 'bg-blue-500',
  High: 'bg-orange-500',
  Urgent: 'bg-red-500',
};

export const priorityDotClass = (priority) => PRIORITY_STYLES[priority] || 'bg-slate-400';

export const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

export function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return part + (name ? `, ${String(name).split(/\s+/)[0]}` : '');
}
