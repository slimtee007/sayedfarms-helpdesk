import React, { useState, useEffect } from 'react';

const ForgotPassword = ({ onBackToLogin }) => {
  const [step, setStep] = useState(1); // 1: Send OTP, 2: Verify OTP & Reset
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);

  // Countdown timer for resend OTP cooldown
  useEffect(() => {
    let timer;
    if (resendCooldown > 0) {
      timer = setInterval(() => {
        setResendCooldown((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Step 1: Request OTP
  const handleSendOtp = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed to send verification code.');

      setMessage('Verification code sent! Check your inbox or terminal.');
      setStep(2);
      setResendCooldown(30);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Resend OTP
  const handleResendOtp = async () => {
    setError('');
    setMessage('');
    setIsResending(true);

    try {
      const res = await fetch('/api/auth/resend-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed to resend OTP.');

      setMessage('A new verification code has been generated!');
      setResendCooldown(30);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsResending(false);
    }
  };

  // Step 3: Verify OTP & Reset Password
  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp, password: newPassword }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed to reset password.');

      setMessage('Password updated successfully! Redirecting to sign in...');
      setTimeout(() => {
        if (onBackToLogin) onBackToLogin();
      }, 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.logoBadge}>⚡</div>
        <h2 style={styles.title}>Help Desk</h2>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}
      {message && <div style={styles.successBox}>{message}</div>}

      {step === 1 ? (
        <form onSubmit={handleSendOtp}>
          <p style={styles.subtitle}>
            Enter your email address to receive a 6-digit verification code.
          </p>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Email Address</label>
            <input
              type="email"
              placeholder="name@sayedfarm.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              required
            />
          </div>

          <button type="submit" disabled={loading} style={styles.primaryButton}>
            {loading ? 'Sending Code...' : 'Send Verification Code'}
          </button>

          <div style={{ textAlign: 'center', marginTop: '16px' }}>
            <button
              type="button"
              onClick={onBackToLogin}
              style={styles.linkButton}
            >
              Back to Sign In
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleResetPassword}>
          <p style={styles.subtitle}>
            Enter the verification code sent to <b>{email}</b> along with your new password.
          </p>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Verification Code (OTP)</label>
            <input
              type="text"
              placeholder="Enter 6-digit OTP"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              style={styles.input}
              maxLength="6"
              required
            />
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>New Password</label>
            <input
              type="password"
              placeholder="Enter new password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={styles.input}
              required
            />
          </div>

          <button type="submit" disabled={loading} style={styles.primaryButton}>
            {loading ? 'Resetting Password...' : 'Reset Password'}
          </button>

          {/* Action Row containing Change Email and Resend OTP side-by-side */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setError('');
                setMessage('');
              }}
              style={styles.linkButton}
            >
              Change Email
            </button>

            <button
              type="button"
              onClick={handleResendOtp}
              disabled={resendCooldown > 0 || isResending}
              style={{
                ...styles.linkButton,
                color: resendCooldown > 0 ? '#94a3b8' : '#0284c7',
                cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer',
                fontWeight: '600',
              }}
            >
              {resendCooldown > 0
                ? `Resend OTP in ${resendCooldown}s`
                : isResending
                ? 'Resending...'
                : 'Resend OTP'}
            </button>
          </div>

          <div style={{ textAlign: 'center', marginTop: '16px' }}>
            <button
              type="button"
              onClick={onBackToLogin}
              style={{ ...styles.linkButton, color: '#64748b' }}
            >
              Back to Sign In
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

const styles = {
  card: {
    width: '100%',
    maxWidth: '440px',
    backgroundColor: '#ffffff',
    borderRadius: '12px',
    padding: '32px',
    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    marginBottom: '20px',
  },
  logoBadge: {
    backgroundColor: '#0284c7',
    color: '#fff',
    width: '36px',
    height: '36px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '20px',
    fontWeight: 'bold',
  },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: '700',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: '14px',
    color: '#64748b',
    marginBottom: '20px',
    lineHeight: '1.5',
  },
  fieldGroup: {
    marginBottom: '16px',
  },
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: '600',
    color: '#334155',
    marginBottom: '6px',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '6px',
    border: '1px solid #cbd5e1',
    fontSize: '14px',
    boxSizing: 'border-box',
    outline: 'none',
  },
  primaryButton: {
    width: '100%',
    padding: '12px',
    backgroundColor: '#0284c7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    marginTop: '8px',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: '#0284c7',
    fontSize: '13px',
    fontWeight: '500',
    cursor: 'pointer',
    padding: 0,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    color: '#dc2626',
    border: '1px solid #fecaca',
    padding: '10px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    marginBottom: '16px',
  },
  successBox: {
    backgroundColor: '#f0fdf4',
    color: '#16a34a',
    border: '1px solid #bbf7d0',
    padding: '10px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    marginBottom: '16px',
  },
};

export default ForgotPassword;