import { MessageSquare, Plus, User, ClipboardList, House } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';

const TABS = [
  { to: '/home', label: 'Home', Icon: House },
  { to: '/requests', label: 'Requests', Icon: ClipboardList },
  { to: '/chat', label: 'Chat', Icon: MessageSquare },
  { to: '/profile', label: 'Profile', Icon: User },
];

/**
 * Bottom tab bar with a raised central "new request" action, safe-area aware.
 * Rendered by the shell route; detail screens render full-bleed without it.
 */
export default function TabBar() {
  const navigate = useNavigate();
  const linkClass = ({ isActive }) =>
    `flex flex-1 flex-col items-center gap-0.5 py-1 text-[10px] font-semibold transition ${
      isActive ? 'text-brand' : 'text-slate-400'
    }`;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur safe-bottom">
      <div className="mx-auto flex max-w-md items-stretch px-2">
        {TABS.slice(0, 2).map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className={linkClass}>
            <Icon className="h-5 w-5" strokeWidth={2.2} />
            {label}
          </NavLink>
        ))}

        <div className="relative flex w-16 justify-center">
          <button
            type="button"
            aria-label="Raise a new request"
            onClick={() => navigate('/new')}
            className="pressable absolute -top-6 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg shadow-brand/40 ring-4 ring-white transition active:bg-brand-dark"
          >
            <Plus className="h-6 w-6" strokeWidth={2.5} />
          </button>
        </div>

        {TABS.slice(2).map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className={linkClass}>
            <Icon className="h-5 w-5" strokeWidth={2.2} />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
