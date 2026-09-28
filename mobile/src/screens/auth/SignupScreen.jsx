import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../../context/SessionContext.jsx';
import { BusyButton, ErrorBanner } from '../../components/ui.jsx';
import { AuthShell, inputClass } from './LoginScreen.jsx';

export default function SignupScreen() {
  const { signup } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    const r = await signup(name.trim(), email.trim(), password);
    setLoading(false);
    if (!r.ok) {
      setError(r.data?.error || 'Could not create your account. Please try again.');
      return;
    }
    navigate('/home', { replace: true });
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Every signup is an employee account — IT agents are invited separately"
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-bold text-white underline underline-offset-2">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div>
          <label htmlFor="name" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Full name</label>
          <input
            id="name"
            required
            type="text"
            autoComplete="name"
            placeholder="Ada Obi"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signup-email" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Email address</label>
          <input
            id="signup-email"
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
          <label htmlFor="signup-password" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Password</label>
          <input
            id="signup-password"
            required
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <BusyButton
          busy={loading}
          className="w-full rounded-xl bg-brand py-3.5 text-[15px] text-white shadow-lg shadow-brand/30 active:bg-brand-dark"
        >
          {loading ? 'Creating account…' : 'Create Account'}
        </BusyButton>
      </form>
    </AuthShell>
  );
}
