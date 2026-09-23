'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/client';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setBusy(false);
    } else {
      router.push('/');
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={signIn}>
        <div className="auth-mark">n</div>
        <h1>Welcome back</h1>
        <p className="lede">Sign in to pick up conversations your bot has handed over.</p>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required
                 placeholder="you@company.com"
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required
                 placeholder="••••••••"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>

        {error && <p className="err">{error}</p>}

        <p className="foot">namici-ci</p>
      </form>
    </main>
  );
}
