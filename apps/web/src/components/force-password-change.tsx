'use client';

/**
 * The screen an account sees while it is still on the password it was handed.
 *
 * Rendered *instead of* the portal by both shells, not as a dismissible modal over it:
 * the backend refuses every other route for such an account anyway
 * (`ForcePasswordChangeGuard` → `PASSWORD_CHANGE_REQUIRED`), so showing the portal
 * underneath would only paint a dashboard whose every request is about to 403.
 *
 * This is the client half of the rule; it is not the enforcement. The enforcement is
 * server-side, because a student who never opens the UI is exactly the case a UI gate
 * cannot cover.
 */

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { Button, Card, CardHeader } from './ui';

const FIELD =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]';

export function ForcePasswordChange({ name }: { name?: string }) {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Checked here as well as by the API so the mismatch is caught before a round trip —
  // the server never receives the confirmation field, so it cannot check this one.
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const reused = newPassword.length > 0 && newPassword === currentPassword;

  const change = useMutation({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      toast.success('Password changed', { description: 'Welcome in.' });
      // `mustChangePassword` is derived server-side from `passwordChangedAt`, so
      // re-reading identity is what lifts the gate.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: Error) =>
      toast.error('Could not change password', {
        description: err instanceof ApiError ? err.message : 'Something went wrong.',
      }),
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (mismatch || reused) return;
    change.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader
          title="Please change your password before continuing"
          description={
            name
              ? `${name}, this account is still using the password you were given. Choose your own to continue.`
              : 'This account is still using the password it was given. Choose your own to continue.'
          }
        />
        <form onSubmit={onSubmit} className="space-y-4 p-5">
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)]">
            <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Your new password needs at least 10 characters, including an uppercase
              letter, a lowercase letter and a digit.
            </p>
          </div>

          <div>
            <label htmlFor="fpc-current" className="mb-1.5 block text-xs font-medium">
              Current password
            </label>
            <input
              id="fpc-current"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={FIELD}
            />
          </div>

          <div>
            <label htmlFor="fpc-new" className="mb-1.5 block text-xs font-medium">
              New password
            </label>
            <input
              id="fpc-new"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              aria-invalid={reused || undefined}
              aria-describedby={reused ? 'fpc-reused' : undefined}
              className={FIELD}
            />
            {reused ? (
              <p id="fpc-reused" className="mt-1.5 text-xs text-[var(--color-danger)]">
                Choose a password different from the one you were given.
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="fpc-confirm" className="mb-1.5 block text-xs font-medium">
              Confirm new password
            </label>
            <input
              id="fpc-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? 'fpc-mismatch' : undefined}
              className={FIELD}
            />
            {mismatch ? (
              <p id="fpc-mismatch" className="mt-1.5 text-xs text-[var(--color-danger)]">
                Both new password fields must match.
              </p>
            ) : null}
          </div>

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            loading={change.isPending}
            disabled={mismatch || reused}
          >
            Change password and continue
          </Button>
        </form>
      </Card>
    </div>
  );
}
