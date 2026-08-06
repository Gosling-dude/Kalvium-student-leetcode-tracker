'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Flame,
  Percent,
  TrendingUp,
  Users,
} from 'lucide-react';
import { SYNC_STATUS_LABELS, type SyncStatus } from '@dsa/shared';

import { api } from '@/lib/api';
import { formatPercent, timeAgo } from '@/lib/utils';
import {
  Badge,
  Card,
  CardHeader,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  ProgressBar,
  Skeleton,
  StatTile,
} from '@/components/ui';

export default function DashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.dashboard(),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const bucket = (n: number): number => data.solvedBuckets[n] ?? 0;
  const assignedCount = data.assignment?.problems.length ?? 4;

  const unreliable = Object.entries(data.unreliableSyncCounts) as [SyncStatus, number][];
  const unreliableTotal = unreliable.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {data.dayKey} · last synced {timeAgo(data.lastSyncAt)}
          </p>
        </div>
        {data.lastSyncStatus === 'COMPLETED_WITH_ERRORS' ? (
          <Badge tone="warning">
            <AlertTriangle className="size-3" aria-hidden />
            Last sync had errors
          </Badge>
        ) : null}
      </header>

      {/*
        Data-quality banner. A zero caused by a bad username is not the same as a
        student who did nothing, and the headline numbers must not imply otherwise.
      */}
      {unreliableTotal > 0 ? (
        <Card className="border-[var(--color-warning)] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <AlertTriangle className="size-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
            <p className="text-sm">
              <strong className="font-semibold">{unreliableTotal}</strong> student
              {unreliableTotal === 1 ? "'s" : "s'"} data could not be read this sync, so their
              figures below are not reliable.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {unreliable.map(([status, count]) => (
                <Badge key={status} tone="warning">
                  {SYNC_STATUS_LABELS[status]}: {count}
                </Badge>
              ))}
            </div>
            <Link
              href="/students?syncStatus=USER_NOT_FOUND"
              className="ml-auto text-sm font-medium text-[var(--color-brand)] underline-offset-2 hover:underline"
            >
              Review students
            </Link>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total Students"
          value={data.totalStudents}
          hint={`${data.activeStudents} with a record today`}
          icon={<Users className="size-4" />}
          tone="brand"
        />
        <StatTile
          label="Completion"
          value={formatPercent(data.completionPercent)}
          hint={`${assignedCount} problems assigned`}
          icon={<Percent className="size-4" />}
          tone="info"
        />
        <StatTile
          label="Avg. Problems Solved"
          value={data.averageProblemsSolved.toFixed(2)}
          hint="per active student"
          icon={<TrendingUp className="size-4" />}
          tone="success"
        />
        <StatTile
          label="Streak Champion"
          value={data.streakChampion ? `${data.streakChampion.streak}d` : '—'}
          hint={data.streakChampion?.name ?? 'No active streaks'}
          icon={<Flame className="size-4" />}
          tone="warning"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Today's completion breakdown"
            description="How many students cleared how much of the assignment"
            action={
              <Link
                href="/mentor"
                className="text-sm font-medium text-[var(--color-brand)] underline-offset-2 hover:underline"
              >
                Open mentor view
              </Link>
            }
          />
          <div className="space-y-3 p-5">
            {Array.from({ length: assignedCount + 1 }, (_, index) => assignedCount - index).map(
              (solved) => {
                const count = bucket(solved);
                const percent =
                  data.activeStudents > 0 ? (count / data.activeStudents) * 100 : 0;
                const isComplete = solved === assignedCount;
                return (
                  <div key={solved} className="flex items-center gap-3">
                    <div className="w-24 shrink-0 text-sm font-medium">
                      {isComplete ? (
                        <span className="inline-flex items-center gap-1.5 text-[var(--color-success)]">
                          <CheckCircle2 className="size-3.5" aria-hidden />
                          All {solved}
                        </span>
                      ) : (
                        `Solved ${solved}`
                      )}
                    </div>
                    <div className="flex-1">
                      <ProgressBar value={percent} label={`Solved ${solved}`} />
                    </div>
                    <div className="w-24 shrink-0 text-right text-sm tabular-nums text-[var(--color-fg-muted)]">
                      {count} · {formatPercent(percent)}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Today's assignment" description={data.assignment?.topic ?? undefined} />
          {data.assignment ? (
            <ul className="divide-y divide-[var(--color-border)]">
              {data.assignment.problems.map((problem) => (
                <li key={problem.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--color-surface-sunken)] text-xs font-semibold tabular-nums">
                    {problem.position}
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={problem.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block truncate text-sm font-medium hover:text-[var(--color-brand)]"
                    >
                      {problem.title}
                    </a>
                    <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                      {problem.topicTags.slice(0, 3).join(' · ') || 'No tags'}
                    </p>
                  </div>
                  <DifficultyBadge difficulty={problem.difficulty} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No assignment for today"
              description="Create today's four problems so the sync knows what to check."
              action={
                <Link
                  href="/assignments"
                  className="text-sm font-medium text-[var(--color-brand)] underline-offset-2 hover:underline"
                >
                  Create assignment
                </Link>
              }
            />
          )}
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
            Top performer
          </p>
          {data.topPerformer ? (
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <p className="truncate text-lg font-semibold">{data.topPerformer.name}</p>
              <p className="shrink-0 tabular-nums text-[var(--color-brand)]">
                {data.topPerformer.score} pts
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-fg-subtle)]">No scores recorded yet.</p>
          )}
        </Card>

        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
            Top squad
          </p>
          {data.topSquad ? (
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <p className="truncate text-lg font-semibold">{data.topSquad.name}</p>
              <p className="shrink-0 tabular-nums text-[var(--color-brand)]">
                {formatPercent(data.topSquad.averageCompletion)}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-fg-subtle)]">
              Squad rankings appear after the first sync.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
