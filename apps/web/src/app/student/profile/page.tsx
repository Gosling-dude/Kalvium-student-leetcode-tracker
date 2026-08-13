'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardHeader, ErrorState, Skeleton } from '@/components/ui';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}

export default function StudentProfilePage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'profile'],
    queryFn: api.studentPortalProfile,
  });

  if (isLoading) return <Skeleton className="h-96" />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Your identity and program details — batch, cohort and belt are set by your program team.
        </p>
      </header>

      <Card>
        <CardHeader title="Identity" />
        <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-3">
          <Field label="Name" value={data.name} />
          <Field label="Email" value={data.email} />
          <Field label="Batch" value={data.batchName ?? '—'} />
          <Field label="Cohort" value={data.cohort ?? '—'} />
          <Field label="Max belt" value={data.maxBeltLevel ?? '—'} />
          <Field
            label="Status"
            value={<Badge tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{data.status}</Badge>}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="LeetCode" />
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="text-sm font-medium">{data.leetcodeUsername ?? 'Not linked yet'}</p>
            <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
              Total solved: <span className="tabular-nums">{data.totalSolved}</span> · synced from LeetCode,
              separate from today&apos;s assignment
            </p>
          </div>
          {data.leetcodeUsername ? (
            <a
              href={`https://leetcode.com/u/${data.leetcodeUsername}/`}
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="secondary">
                View LeetCode profile <ExternalLink className="size-3.5" aria-hidden />
              </Button>
            </a>
          ) : null}
        </div>
      </Card>

      <ChangePasswordCard />
    </div>
  );
}

function ChangePasswordCard() {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const change = useMutation({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      toast.success('Password changed', { description: 'Please sign in again with your new password.' });
      setCurrentPassword('');
      setNewPassword('');
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: Error) =>
      toast.error('Could not change password', {
        description: err instanceof ApiError ? err.message : 'Something went wrong.',
      }),
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    change.mutate();
  };

  return (
    <Card>
      <CardHeader title="Change password" description="Min 10 characters, with an upper, lower and a digit." />
      <form onSubmit={onSubmit} className="space-y-3 p-5">
        <div>
          <label htmlFor="currentPassword" className="mb-1.5 block text-xs font-medium">
            Current password
          </label>
          <input
            id="currentPassword"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </div>
        <div>
          <label htmlFor="newPassword" className="mb-1.5 block text-xs font-medium">
            New password
          </label>
          <input
            id="newPassword"
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </div>
        <Button type="submit" variant="primary" loading={change.isPending}>
          Change password
        </Button>
      </form>
    </Card>
  );
}
