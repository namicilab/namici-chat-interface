'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabase } from '@/lib/client';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    else router.push('/');
  }

  return (
    <form className="login" onSubmit={signIn}>
      <h1 style={{ fontSize: 18 }}>namici-ci</h1>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="password" type="password" value={password}
             onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Sign in</button>
      {error && <p style={{ color: '#c0392b', fontSize: 13 }}>{error}</p>}
    </form>
  );
}
