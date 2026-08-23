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
import { SYNC_STATUS_LABELS, UNASSIGNED_BATCH_LABEL, type SyncStatus } from '@dsa/shared';

import { api } from '@/lib/api';
import { formatPercent, timeAgo } from '@/lib/utils';
import { ScopeFilter, useScopeFilter } from '@/components/scope-filter';
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
  const { campus, batch } = useScopeFilter();

  const { data, isLoading, error, refetch } = useQuery({
    // Both halves are part of the key, so switching filters refetches rather than showing
    // the previous campus's numbers under the new heading — a cross-campus leak of
    // exactly the kind §12 rules out, and an invisible one.
    queryKey: ['dashboard', campus, batch],
    queryFn: () => api.dashboard(undefined, campus ?? undefined, batch ?? undefined),
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

  // Never assume four. On a filtered view this is that batch's own count; unfiltered it
  // spans the largest assignment of the day so no student falls outside the chart (§10).
  const assignedCount =
    data.assignment?.problems.length ??
    (Math.max(0, ...data.batchBreakdown.map((b) => b.assignedCount)) ||
      Math.max(0, data.solvedBuckets.length - 1));

  const health = data.syncSummary;
  const unreliable = Object.entries(health.byStatus) as [SyncStatus, number][];
  /**
   * Statuses that mean a read was attempted and failed, kept apart from the roster gap.
   * `PROFILE_MISSING` and `NEVER_SYNCED` get their own sentences below, because
   * "add a handle" and "wait for the next run" are different instructions and neither is
   * "the sync is broken".
   */
  const failures = unreliable.filter(
    ([status]) => status !== 'PROFILE_MISSING' && status !== 'NEVER_SYNCED',
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {data.dayKey} · last synced {timeAgo(data.lastSyncAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScopeFilter />
          {/*
            Only a genuine failed read is an error. A roster with uncollected handles is
            reported in the summary below, not as a badge saying the sync broke — that
            badge sat on this page permanently while nothing was actually wrong (§6).
          */}
          {data.lastSyncStatus === 'COMPLETED_WITH_ERRORS' && health.failed > 0 ? (
            <Badge tone="warning">
              <AlertTriangle className="size-3" aria-hidden />
              Last sync had errors
            </Badge>
          ) : null}
        </div>
      </header>

      {/*
        Sync summary. A zero caused by a bad username is not the same as a student who
        did nothing, and neither is the same as a student nobody has collected a handle
        for — so all three are stated, with the count they each apply to.

        This replaces a single "N students' data could not be read" line that summed all
        of them. With 21 handles still uncollected it read as a system failure across a
        whole campus, which is the misreading §6 exists to prevent. Every chip links to
        the students it counts, so the sentence is checkable rather than just asserted.
      */}
      {health.synced < health.activeStudents ? (
        <Card
          className={
            health.failed > 0 ? 'border-[var(--color-warning)] p-4' : 'p-4'
          }
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {health.failed > 0 ? (
              <AlertTriangle
                className="size-4 shrink-0 text-[var(--color-warning)]"
                aria-hidden
              />
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
            )}
            <p className="text-sm">
              <strong className="font-semibold">{health.activeStudents}</strong> active
              student{health.activeStudents === 1 ? '' : 's'} ·{' '}
              <strong className="font-semibold">{health.synced}</strong> synced successfully
              {health.failed > 0 ? (
                <>
                  {' '}
                  · <strong className="font-semibold">{health.failed}</strong> could not be
                  read
                </>
              ) : null}
              {health.profileMissing > 0 ? (
                <>
                  {' '}
                  · <strong className="font-semibold">{health.profileMissing}</strong> waiting
                  on a LeetCode profile
                </>
              ) : null}
              {health.awaitingFirstSync > 0 ? (
                <>
                  {' '}
                  · <strong className="font-semibold">{health.awaitingFirstSync}</strong> not
                  synced yet
                </>
              ) : null}
              .
            </p>
            <div className="flex flex-wrap gap-1.5">
              {unreliable.map(([status, count]) => (
                <Link key={status} href={`/students?syncStatus=${status}`}>
                  <Badge tone={status === 'PROFILE_MISSING' ? 'neutral' : 'warning'}>
                    {SYNC_STATUS_LABELS[status]}: {count}
                  </Badge>
                </Link>
              ))}
            </div>
            <Link
              href={`/students?syncStatus=${failures[0]?.[0] ?? 'PROFILE_MISSING'}`}
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

      {/*
        Per-campus roll-up (§32). Shown above the batch cards because it answers the
        coarser question first: how is each campus doing, and how many of its students are
        still waiting to be placed.

        Every figure comes from the campus's own rows rather than from summing the batch
        cards below — a campus total has to count students in batches that had no
        assignment and students awaiting placement, and a sum over batch cards would
        quietly drop both.
      */}
      {data.campusBreakdown.length > 1 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.campusBreakdown.map((campusRow) => (
            <Card key={campusRow.campusId ?? 'none'} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    {campusRow.campusName ?? 'No campus'}
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {campusRow.activeStudents} active student
                    {campusRow.activeStudents === 1 ? '' : 's'}
                  </p>
                </div>
                <span className="text-lg font-semibold tabular-nums">
                  {formatPercent(campusRow.completionPercent)}
                </span>
              </div>
              {/*
                Each campus's own level split, so "Vels 15/16, SRM 0/0/99" is readable at
                a glance without opening the directory (§12).
              */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.batchBreakdown
                  .filter((b) => b.campusId === campusRow.campusId && b.batchId !== null)
                  .map((b) => (
                    <Badge key={b.batchId} tone="neutral">
                      {(b.batchName ?? '').replace(/\s*Level$/i, '')}: {b.activeStudents}
                    </Badge>
                  ))}
                {campusRow.unassignedStudents > 0 ? (
                  <Badge tone="warning">
                    {UNASSIGNED_BATCH_LABEL}: {campusRow.unassignedStudents}
                  </Badge>
                ) : null}
                {campusRow.assignedTotal === 0 ? (
                  <Badge tone="neutral">No assignment today</Badge>
                ) : (
                  <Badge tone="neutral">
                    {campusRow.solvedTotal}/{campusRow.assignedTotal} solved
                  </Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {/*
        Per campus + batch figures. Each group is measured against its own assignment, so a
        day where SRM Foundation had 4 problems and Vels Intermediate had 5 reads correctly
        instead of being averaged into one misleading denominator (§10, §32).
      */}
      {data.batchBreakdown.length > 1 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.batchBreakdown.map((batchRow) => (
            <Card key={`${batchRow.campusId ?? '-'}|${batchRow.batchId ?? '-'}`} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  {/* Both halves named. Two cards headed "Foundation Level" — one Vels,
                      one SRM — would be indistinguishable side by side (§32). */}
                  <p className="text-sm font-semibold">
                    {[batchRow.campusName, batchRow.batchName ?? UNASSIGNED_BATCH_LABEL]
                      .filter(Boolean)
                      .join(' — ')}
                  </p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {batchRow.activeStudents} student{batchRow.activeStudents === 1 ? '' : 's'} ·{' '}
                    {batchRow.assignedCount} assigned
                  </p>
                </div>
                <span className="text-lg font-semibold tabular-nums">
                  {formatPercent(batchRow.completionPercent)}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {batchRow.solvedBuckets
                  .map((count, solved) => ({ count, solved }))
                  .reverse()
                  .map(({ count, solved }) => (
                    <Badge
                      key={solved}
                      tone={solved === batchRow.assignedCount && solved > 0 ? 'success' : 'neutral'}
                    >
                      Solved {solved}: {count}
                    </Badge>
                  ))}
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Today's completion breakdown"
            description={
              data.attemptedNotSolvedStudents > 0 || data.notAttemptedStudents > 0
                ? `Of those who haven't finished: ${data.attemptedNotSolvedStudents} attempted, ${data.notAttemptedStudents} not attempted`
                : "How many students cleared how much of the assignment"
            }
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
