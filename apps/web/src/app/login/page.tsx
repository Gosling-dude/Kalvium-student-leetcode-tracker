'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';

import { api, tokenStore } from '@/lib/api';
import { Button, Card } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (data) => {
      tokenStore.set(data.accessToken, data.refreshToken);
      router.replace('/');
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-[var(--color-brand)] text-sm font-bold text-[var(--color-brand-fg)]">
            DS
          </div>
          <div>
            <h1 className="text-base font-semibold">DSA Tracker</h1>
            <p className="text-xs text-[var(--color-fg-subtle)]">Kalvium mentor console</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-xs font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
              placeholder="admin@kalvium.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
              placeholder="••••••••"
            />
          </div>

          {login.isError ? (
            // role="alert" so screen readers announce a failed sign-in immediately.
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {(login.error as Error).message}
            </p>
          ) : null}

          <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
