'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  StatTile,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

export default function AdminPage() {
  const queryClient = useQueryClient();

  const queue = useQuery({
    queryKey: ['sync', 'queue'],
    queryFn: api.queueHealth,
    refetchInterval: 10_000,
  });

  const latest = useQuery({
    queryKey: ['sync', 'latest'],
    queryFn: api.latestSync,
    refetchInterval: 10_000,
  });

  const items = useQuery({
    queryKey: ['sync', 'items', latest.data?.id],
    queryFn: () => api.syncJobItems(latest.data!.id),
    enabled: Boolean(latest.data?.id),
  });

  const recompute = useMutation({
    mutationFn: () => api.recompute({}),
    onSuccess: (result) => {
      toast.success(`Recomputed ${result.days} days`, {
        description: 'Scores, streaks and leaderboards rebuilt from stored submissions.',
      });
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => toast.error('Recompute failed', { description: error.message }),
  });

  const retry = useMutation({
    mutationFn: api.retryFailedSync,
    onSuccess: (job) =>
      toast.success('Retrying failed students', {
        description: `${job.totalStudents} students queued.`,
      }),
    onError: (error: Error) => toast.error('Nothing to retry', { description: error.message }),
  });

  const failedItems = items.data?.filter((item) => item.status !== 'OK') ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Queue health, sync diagnostics and score recomputation.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Queue driver"
          value={queue.data?.driver ?? '—'}
          hint={queue.data?.connected ? 'Connected' : 'Not connected'}
          tone={queue.data?.connected ? 'success' : 'warning'}
        />
        <StatTile label="Waiting" value={queue.data?.waiting ?? 0} />
        <StatTile label="Active" value={queue.data?.active ?? 0} />
        <StatTile
          label="Failed"
          value={queue.data?.failed ?? 0}
          tone={(queue.data?.failed ?? 0) > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader
          title="Latest sync"
          description={
            latest.data
              ? `${latest.data.mode} · triggered ${latest.data.trigger.toLowerCase()} · ${timeAgo(
                  latest.data.createdAt,
                )}`
              : undefined
          }
          action={
            <div className="flex gap-2">
              <Button onClick={() => retry.mutate()} loading={retry.isPending}>
                Retry failed
              </Button>
              <Button
                variant="primary"
                onClick={() => recompute.mutate()}
                loading={recompute.isPending}
              >
                Recalculate scores
              </Button>
            </div>
          }
        />
        {latest.data ? (
          <div className="grid gap-3 p-5 sm:grid-cols-4">
            <Metric label="Students" value={latest.data.totalStudents} />
            <Metric label="Succeeded" value={latest.data.succeededStudents} />
            <Metric label="Failed" value={latest.data.failedStudents} />
            <Metric label="New submissions" value={latest.data.newSubmissions} />
          </div>
        ) : (
          <EmptyState title="No syncs recorded yet" description="Press Sync in the top bar." />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Students needing attention"
          description="Failures from the most recent sync, with the reason for each."
        />
        {items.isLoading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : failedItems.length === 0 ? (
          <EmptyState
            title="Every student synced cleanly"
            description="No usernames failed to resolve in the last run."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Student</Th>
                <Th>LeetCode handle</Th>
                <Th>Status</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {failedItems.map((item) => (
                <tr key={item.studentId}>
                  <Td className="font-medium">{item.name}</Td>
                  <Td className="font-mono text-xs">{item.leetcodeUsername}</Td>
                  <Td>
                    <Badge tone="danger">{item.status}</Badge>
                  </Td>
                  <Td className="max-w-md truncate text-[var(--color-fg-muted)]">
                    {item.error ?? '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
