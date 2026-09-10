import React, { useState } from 'react';
import ForgotPassword from './ForgotPassword';

const AuthScreen = ({ onLoginSuccess }) => {
  const [view, setView] = useState('login'); // 'login', 'signup', 'forgot'
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    role: 'user',
  });
  
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.email, password: formData.password }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Login failed');

      if (onLoginSuccess) onLoginSuccess(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Signup failed');

      if (onLoginSuccess) onLoginSuccess(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      {view === 'forgot' ? (
        <ForgotPassword onBackToLogin={() => setView('login')} />
      ) : (
        <div style={styles.card}>
          <div style={styles.header}>
            <div style={styles.logoBadge}>⚡</div>
            <h2 style={styles.title}>Help Desk</h2>
          </div>

          <div style={styles.tabContainer}>
            <button
              style={{
                ...styles.tabButton,
                borderBottom: view === 'login' ? '2px solid #0284c7' : 'none',
                color: view === 'login' ? '#0284c7' : '#64748b',
                fontWeight: view === 'login' ? '600' : 'normal',
              }}
              onClick={() => {
                setView('login');
                setError('');
              }}
            >
              Sign In
            </button>
            <button
              style={{
                ...styles.tabButton,
                borderBottom: view === 'signup' ? '2px solid #0284c7' : 'none',
                color: view === 'signup' ? '#0284c7' : '#64748b',
                fontWeight: view === 'signup' ? '600' : 'normal',
              }}
              onClick={() => {
                setView('signup');
                setError('');
              }}
            >
              Create Account
            </button>
          </div>

          {error && <div style={styles.errorBox}>{error}</div>}

          {view === 'login' ? (
            <form onSubmit={handleLogin}>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Email Address</label>
                <input
                  type="email"
                  name="email"
                  placeholder="name@sayedfarm.com"
                  value={formData.email}
                  onChange={handleChange}
                  style={styles.input}
                  required
                />
              </div>

              <div style={styles.fieldGroup}>
                <div style={styles.flexRowBetween}>
                  <label style={styles.label}>Password</label>
                  <button
                    type="button"
                    onClick={() => setView('forgot')}
                    style={styles.linkButton}
                  >
                    Forgot Password?
                  </button>
                </div>
                <input
                  type="password"
                  name="password"
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={handleChange}
                  style={styles.input}
                  required
                />
              </div>

              <button type="submit" disabled={loading} style={styles.primaryButton}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSignup}>
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Full Name</label>
                <input
                  type="text"
                  name="name"
                  placeholder="John Doe"
                  value={formData.name}
                  onChange={handleChange}
                  style={styles.input}
                  required
                />
              </div>

              <div style={styles.fieldGroup}>
                <label style={styles.label}>Email Address</label>
                <input
                  type="email"
                  name="email"
                  placeholder="name@sayedfarm.com"
                  value={formData.email}
                  onChange={handleChange}
                  style={styles.input}
                  required
                />
              </div>

              <div style={styles.fieldGroup}>
                <label style={styles.label}>Password</label>
                <input
                  type="password"
                  name="password"
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={handleChange}
                  style={styles.input}
                  required
                />
              </div>

              <div style={styles.fieldGroup}>
                <label style={styles.label}>Role</label>
                <select
                  name="role"
                  value={formData.role}
                  onChange={handleChange}
                  style={styles.input}
                >
                  <option value="user">Employee / User</option>
                  <option value="agent">IT Agent / Admin</option>
                </select>
              </div>

              <button type="submit" disabled={loading} style={styles.primaryButton}>
                {loading ? 'Creating Account...' : 'Sign Up'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

const styles = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    backgroundColor: '#f8fafc',
    padding: '20px',
  },
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
    marginBottom: '24px',
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
  tabContainer: {
    display: 'flex',
    borderBottom: '1px solid #e2e8f0',
    marginBottom: '20px',
  },
  tabButton: {
    flex: 1,
    padding: '10px',
    background: 'none',
    border: 'none',
    fontSize: '14px',
    cursor: 'pointer',
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
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    padding: 0,
  },
  flexRowBetween: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
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
};

export default AuthScreen;