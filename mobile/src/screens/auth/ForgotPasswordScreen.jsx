import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, KeyRound, MailCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { BusyButton, ErrorBanner } from '../../components/ui.jsx';
import { AuthShell, inputClass } from './LoginScreen.jsx';

/**
 * Password reset with the server's OTP flow (same contract as the desktop
 * ForgotPassword page): request an OTP, then reset with the emailed code.
 * When SMTP is not configured the server answers with a `devOtp` so the
 * flow still works in development — it is shown in a callout.
 */
export default function ForgotPasswordScreen() {
  const [step, setStep] = useState('request'); // request -> verify
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const requestCode = async (resend = false) => {
    setError('');
    setInfo('');
    setLoading(true);
    const r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: email.trim() } });
    if (!resend) setLoading(false);
    if (!r.ok) {
      setLoading(false);
      setError(r.data?.error || 'Could not send the reset code.');
      return;
    }
    setStep('verify');
    if (r.data?.devOtp) setDevOtp(r.data.devOtp);
    setInfo(r.data?.message || 'If the address is registered, a reset code is on its way.');
  };

  const resendCode = async () => {
    setLoading(true);
    const r = await api('/api/auth/resend-otp', { method: 'POST', body: { email: email.trim() } });
    setLoading(false);
    if (!r.ok) {
      setError(r.data?.error || 'Could not resend the code.');
      return;
    }
    if (r.data?.devOtp) setDevOtp(r.data.devOtp);
    setInfo('A new code has been sent.');
  };

  const resetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const r = await api('/api/auth/reset-password', {
      method: 'POST',
      body: { email: email.trim(), otp: otp.trim(), password },
    });
    setLoading(false);
    if (!r.ok) {
      setError(r.data?.error || 'Could not reset the password.');
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <AuthShell title="Password updated" footer={<Link to="/login" className="font-bold text-white underline underline-offset-2">Back to sign in</Link>}>
        <div className="flex flex-col items-center py-6 text-center">
          <CircleCheck className="mb-3 h-12 w-12 text-emerald-500" />
          <p className="text-[15px] font-semibold text-slate-800">Your password has been reset</p>
          <p className="mt-1 text-[13px] text-slate-500">You can sign in with your new password now.</p>
          <Link
            to="/login"
            className="pressable mt-6 w-full rounded-xl bg-brand py-3.5 text-center text-[15px] font-semibold text-white active:bg-brand-dark"
          >
            Sign In
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={step === 'request' ? 'Reset your password' : 'Check your email'}
      subtitle={step === 'request' ? "We'll send you a one-time reset code" : `Code sent to ${email}`}
      footer={<Link to="/login" className="font-bold text-white underline underline-offset-2">Back to sign in</Link>}
    >
      {step === 'request' ? (
        <form
          onSubmit={(e) => { e.preventDefault(); requestCode(); }}
          className="space-y-4"
        >
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <div>
            <label htmlFor="reset-email" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Email address</label>
            <input
              id="reset-email"
              required
              type="email"
              inputMode="email"
              autoCapitalize="none"
              placeholder="you@sayedfarms.com"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <BusyButton
            busy={loading}
            className="w-full rounded-xl bg-brand py-3.5 text-[15px] text-white active:bg-brand-dark"
          >
            {loading ? 'Sending…' : 'Send reset code'}
          </BusyButton>
        </form>
      ) : (
        <form onSubmit={resetPassword} className="space-y-4">
          {error && <ErrorBanner>{error}</ErrorBanner>}
          {info && (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13px] leading-5 text-emerald-700">
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
              {info}
            </div>
          )}
          {devOtp && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-5 text-amber-800">
              <span className="font-semibold">Development mode:</span> no SMTP configured, so here is your code —{' '}
              <span className="font-mono text-base font-bold tracking-widest">{devOtp}</span>
            </div>
          )}
          <div>
            <label htmlFor="otp" className="mb-1.5 block text-[13px] font-semibold text-slate-600">Reset code</label>
            <input
              id="otp"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              className={`${inputClass} text-center font-mono text-lg tracking-[0.4em]`}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="new-password" className="mb-1.5 block text-[13px] font-semibold text-slate-600">New password</label>
            <input
              id="new-password"
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
            className="w-full rounded-xl bg-brand py-3.5 text-[15px] text-white active:bg-brand-dark"
          >
            <KeyRound className="h-4 w-4" />
            {loading ? 'Resetting…' : 'Reset password'}
          </BusyButton>
          <button
            type="button"
            onClick={resendCode}
            disabled={loading}
            className="w-full text-center text-[13px] font-semibold text-brand disabled:opacity-50"
          >
            Resend code
          </button>
        </form>
      )}
    </AuthShell>
  );
}
