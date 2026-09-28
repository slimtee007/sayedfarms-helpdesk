import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, TriangleAlert } from 'lucide-react';
import { useSession } from '../../context/SessionContext.jsx';
import { BusyButton, ErrorBanner } from '../../components/ui.jsx';

export function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-full flex-col bg-gradient-to-b from-brand to-brand-deep">
      <div className="safe-top" />
      <div className="flex flex-1 flex-col px-7 pb-10 pt-16">
        <div className="mb-10 flex flex-col items-center text-white">
          <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 backdrop-blur">
            <Activity className="h-8 w-8" />
          </span>
          <h1 className="text-[22px] font-bold tracking-tight">SayedFarms IT</h1>
          <p className="mt-1 text-[13px] text-blue-100">{title}</p>
          {subtitle && <p className="mt-0.5 text-[12px] text-blue-200/80">{subtitle}</p>}
        </div>
        <div className="animate-rise rounded-3xl bg-white p-6 shadow-2xl shadow-black/20">{children}</div>
        <div className="mt-6 text-center text-[13px] text-blue-100">{footer}</div>
      </div>
    </div>
  );
}

export const inputClass =
  'w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-base text-slate-800 placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/20 transition';

export default function LoginScreen() {
  const { login } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const r = await login(email.trim(), password);
    setLoading(false);
    if (!r.ok) {
      setError(r.data?.error || 'Sign-in failed. Please try again.');
      return;
    }
    navigate('/home', { replace: true });
  };

  return (
    <AuthShell
      title="Helpdesk"
      subtitle="Sign in to raise and track IT requests"
      footer={
        <>
          Need an account?{' '}
          <Link to="/signup" className="font-bold text-white underline underline-offset-2">
            Sign up
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <ErrorBanner>
            <span className="inline-flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </span>
          </ErrorBanner>
        )}
        <div>
          <label htmlFor="email" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Email address</label>
          <input
            id="email"
            required
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@sayedfarms.com"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="password" className="text-[13px] font-semibold text-slate-600">Password</label>
            <Link to="/forgot-password" className="text-[12px] font-semibold text-brand">
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            required
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <BusyButton
          busy={loading}
          className="w-full rounded-xl bg-brand py-3.5 text-[15px] text-white shadow-lg shadow-brand/30 active:bg-brand-dark"
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </BusyButton>
      </form>
    </AuthShell>
  );
}
