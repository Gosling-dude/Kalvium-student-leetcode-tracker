'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  BATCH_CHANGE_SOURCE_LABELS,
  SYNC_STATUS_LABELS,
  isTrustworthySync,
  UNASSIGNED_BATCH_LABEL,
  type BatchHistoryEntry,
  type CampusHistoryEntry,
} from '@dsa/shared';

import { api } from '@/lib/api';
import { cn, formatPercent, timeAgo } from '@/lib/utils';
import { BatchChip, CampusChip } from '@/components/scope-filter';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  ProgressBar,
  Skeleton,
  StatTile,
  StreakFlame,
  TableShell,
  Td,
  Th,
} from '@/components/ui';

/** Heatmap intensity → background. Level 0 (no assignment) reads as an empty slot. */
const INTENSITY: Record<number, string> = {
  0: 'bg-[var(--color-surface-sunken)]',
  1: 'bg-[var(--color-danger-soft)]',
  2: 'bg-[var(--color-brand-soft)]',
  3: 'bg-[var(--color-brand)] opacity-60',
  4: 'bg-[var(--color-brand)]',
};

export default function StudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', id, 'profile'],
    queryFn: () => api.studentProfile(id),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const untrusted = !isTrustworthySync(data.syncStatus);

  return (
    <div className="space-y-5">
      <Link
        href="/students"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All students
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{data.name}</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {data.email}
            {data.squadName ? ` · ${data.squadName}` : ''}
          </p>
          {/*
            Campus, batch, squad, cohort and belt are the student's current organisational
            placement — shown together and prominently, because they are what a mentor
            scanning this page is checking (§9, §11, §13).
          */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CampusChip code={data.campusCode} name={data.campusName} />
            <span className="text-sm">{data.campusName ?? 'No campus'}</span>
            <BatchChip code={data.batchCode} name={data.batchName} />
            <span className="text-sm">
              {data.batchName ?? UNASSIGNED_BATCH_LABEL}
            </span>
            {data.squadNumber !== null ? (
              <Badge tone="neutral">Squad {data.squadNumber}</Badge>
            ) : null}
            {data.cohort !== null ? <Badge tone="info">Cohort {data.cohort}</Badge> : null}
            {data.maxBeltLevel !== null ? (
              <Badge tone="brand">Max belt {data.maxBeltLevel}</Badge>
            ) : null}
            {data.status === 'ARCHIVED' ? (
              <Badge tone="neutral">
                Archived{data.archivedAt ? ` ${timeAgo(data.archivedAt)}` : ''}
              </Badge>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {data.leetcodeUsername ? (
              <a
                href={`https://leetcode.com/u/${data.leetcodeUsername}/`}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-mono text-xs text-[var(--color-brand)] hover:underline"
              >
                {data.leetcodeUsername}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              <span className="text-xs text-[var(--color-fg-subtle)]">
                No LeetCode account linked
              </span>
            )}
            {untrusted ? (
              <Badge tone="danger">{SYNC_STATUS_LABELS[data.syncStatus]}</Badge>
            ) : (
              <span className="text-xs text-[var(--color-fg-subtle)]">
                synced {timeAgo(data.lastSyncedAt)}
              </span>
            )}
          </div>
        </div>

        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
            Level {data.levelProgress.level}
          </p>
          <div className="mt-2 w-48">
            <ProgressBar value={data.levelProgress.progressPercent} label="Level progress" />
          </div>
          <p className="mt-1.5 text-xs tabular-nums text-[var(--color-fg-subtle)]">
            {data.levelProgress.xpIntoLevel} / {data.levelProgress.xpForNextLevel} XP
          </p>
        </Card>
      </header>

      {untrusted ? (
        <Card className="border-[var(--color-warning)] p-4 text-sm">
          This student&apos;s LeetCode data could not be read
          {`: ${SYNC_STATUS_LABELS[data.syncStatus].toLowerCase()}`}. The figures below are
          historical and may not reflect recent work — check the username is correct.
        </Card>
      ) : null}

      {/*
        Five distinct quantities, deliberately labelled so they cannot be read as one
        another. "Total LeetCode solved" is lifetime distinct problems across everything
        the student does; it is not — and previously was — today's assignment count.
      */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total LeetCode solved"
          value={data.metrics.totalLeetcodeSolved}
          hint="distinct problems, all time"
          tone="brand"
        />
        <StatTile
          label="Today's assignment"
          value={
            data.metrics.todayAssignment.hasAssignment
              ? `${data.metrics.todayAssignment.solvedCount} / ${data.metrics.todayAssignment.assignedCount}`
              : '—'
          }
          hint={
            data.metrics.todayAssignment.hasAssignment
              ? `${formatPercent(data.metrics.todayAssignment.completionPercent)} complete`
              : 'nothing assigned today'
          }
          tone="info"
        />
        <StatTile
          label="Current DSA streak"
          value={<StreakFlame streak={data.metrics.currentDsaStreak} />}
          hint={`Longest ${data.metrics.longestDsaStreak} days · ≥1 problem/day`}
          tone="warning"
        />
        <StatTile
          label="Assignment problems done"
          value={data.metrics.totalAssignmentProblemsCompleted}
          hint="across the programme"
          tone="success"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Total score" value={data.totalScore} tone="brand" />
        <StatTile
          label="This week"
          value={formatPercent(data.weeklyCompletionPercent)}
          hint="of assigned problems"
          tone="info"
        />
        <StatTile
          label="This month"
          value={formatPercent(data.monthlyCompletionPercent)}
          hint="of assigned problems"
          tone="success"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Activity"
            description="One cell per day. Empty cells are days with no assignment."
          />
          <div className="p-5">
            {data.heatmap.length === 0 ? (
              <EmptyState title="No history yet" />
            ) : (
              <div className="flex flex-wrap gap-1">
                {data.heatmap.map((cell) => (
                  <div
                    key={cell.dayKey}
                    title={`${cell.dayKey}: ${cell.solvedCount}/${cell.assignedCount} solved`}
                    className={cn(
                      'size-3.5 rounded-sm',
                      INTENSITY[cell.intensity] ?? INTENSITY[0],
                    )}
                  />
                ))}
              </div>
            )}
            <div className="mt-4 flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
              <span>Less</span>
              {[1, 2, 3, 4].map((level) => (
                <div key={level} className={cn('size-3 rounded-sm', INTENSITY[level])} />
              ))}
              <span>More</span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Difficulty split" description="All-time accepted submissions" />
          <div className="space-y-3 p-5">
            {(
              [
                ['Easy', data.difficultyBreakdown.easy],
                ['Medium', data.difficultyBreakdown.medium],
                ['Hard', data.difficultyBreakdown.hard],
              ] as const
            ).map(([label, count]) => {
              const total = Math.max(data.difficultyBreakdown.total, 1);
              return (
                <div key={label}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{label}</span>
                    <span className="tabular-nums text-[var(--color-fg-muted)]">{count}</span>
                  </div>
                  <ProgressBar value={(count / total) * 100} label={`${label} solved`} />
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Achievements" />
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {data.achievements.map((achievement) => (
            <div
              key={achievement.code}
              className={cn(
                'rounded-lg border p-3 transition',
                achievement.earned
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
                  : 'border-[var(--color-border)] opacity-60',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{achievement.name}</p>
                <Badge tone={achievement.earned ? 'brand' : 'neutral'}>{achievement.tier}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                {achievement.description}
              </p>
              {!achievement.earned ? (
                <div className="mt-2">
                  <ProgressBar
                    value={achievement.progressPercent}
                    label={`${achievement.name} progress`}
                  />
                  <p className="mt-1 text-xs tabular-nums text-[var(--color-fg-subtle)]">
                    {achievement.current} / {achievement.target}
                  </p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent days" />
        {data.recentDays.length === 0 ? (
          <EmptyState title="No recorded days yet" />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th className="text-right">Solved</Th>
                <Th>Completion</Th>
                <Th>Finished at</Th>
                <Th className="text-right">Score</Th>
              </tr>
            </thead>
            <tbody>
              {data.recentDays.map((day) => (
                <tr key={day.dayKey}>
                  <Td className="tabular-nums">{day.dayKey}</Td>
                  <Td className="text-right tabular-nums">
                    {day.solvedCount} / {day.assignedCount}
                  </Td>
                  <Td className="w-40">
                    <ProgressBar
                      value={
                        day.assignedCount > 0 ? (day.solvedCount / day.assignedCount) * 100 : 0
                      }
                      label={`${day.dayKey} completion`}
                    />
                  </Td>
                  <Td className="tabular-nums text-[var(--color-fg-muted)]">
                    {day.completionTime ?? '—'}
                  </Td>
                  <Td className="text-right font-medium tabular-nums">{day.score}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <CampusHistorySection history={data.campusHistory} currentCampusName={data.campusName} />

      <BatchHistorySection history={data.batchHistory} currentBatchName={data.batchName} />

      {data.notes.length > 0 ? (
        <Card>
          <CardHeader title="Mentor notes" />
          <ul className="divide-y divide-[var(--color-border)]">
            {data.notes.map((note) => (
              <li key={note.id} className="px-5 py-3">
                <p className="text-sm">{note.body}</p>
                <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                  {note.authorName} · {timeAgo(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Campus History (§16) — every campus this student has belonged to, newest first.
 *
 * Rendered only once there is something to say: a single founding placement is not a
 * history, and a section reading "Vels → Vels" would be noise on every profile.
 */
function CampusHistorySection({
  history,
  currentCampusName,
}: {
  history: CampusHistoryEntry[];
  currentCampusName: string | null;
}) {
  if (history.length <= 1) return null;

  return (
    <Card>
      <CardHeader
        title="Campus history"
        description="Past results stay recorded under the campus the student was at when they earned them."
      />
      <ol className="divide-y divide-[var(--color-border)]">
        {history.map((entry, index) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
            <span className="w-24 shrink-0 font-mono text-xs text-[var(--color-fg-muted)]">
              {entry.effectiveFromDayKey}
            </span>
            <span className="inline-flex items-center gap-1.5">
              {entry.fromCampusName ? (
                <>
                  <span className="text-[var(--color-fg-muted)]">{entry.fromCampusName}</span>
                  <span aria-hidden className="text-[var(--color-fg-subtle)]">
                    &rarr;
                  </span>
                </>
              ) : null}
              <CampusChip code={entry.toCampusCode} name={entry.toCampusName} />
              <span className="font-medium">{entry.toCampusName ?? 'No campus'}</span>
            </span>
            {index === 0 && entry.toCampusName === currentCampusName ? (
              <Badge tone="success">Current</Badge>
            ) : null}
            <Badge tone="neutral">{BATCH_CHANGE_SOURCE_LABELS[entry.source]}</Badge>
            {entry.changedByName ? (
              <span className="text-xs text-[var(--color-fg-subtle)]">
                by {entry.changedByName}
              </span>
            ) : null}
            {entry.reason ? (
              <span className="w-full text-xs text-[var(--color-fg-muted)] sm:w-auto">
                &ldquo;{entry.reason}&rdquo;
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * Batch History (§11) — every placement this student has had, newest first.
 *
 * Present because a mentor reading a past result needs to know which batch it was earned
 * in. A student who moved on 15 Aug was assessed against Foundation's questions on
 * 10 Aug, and this section is what makes that legible rather than surprising.
 */
function BatchHistorySection({
  history,
  currentBatchName,
}: {
  history: BatchHistoryEntry[];
  currentBatchName: string | null;
}) {
  if (history.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Batch history"
        description="Past results stay recorded under the batch the student was in at the time."
      />
      <ol className="divide-y divide-[var(--color-border)]">
        {history.map((entry, index) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
            <span className="w-24 shrink-0 font-mono text-xs text-[var(--color-fg-muted)]">
              {entry.effectiveFromDayKey}
            </span>
            <span className="inline-flex items-center gap-1.5">
              {entry.fromBatchName ? (
                <>
                  <span className="text-[var(--color-fg-muted)]">{entry.fromBatchName}</span>
                  <span aria-hidden className="text-[var(--color-fg-subtle)]">
                    &rarr;
                  </span>
                </>
              ) : null}
              <BatchChip code={entry.toBatchCode} name={entry.toBatchName} />
              <span className="font-medium">{entry.toBatchName ?? UNASSIGNED_BATCH_LABEL}</span>
            </span>
            {index === 0 && entry.toBatchName === currentBatchName ? (
              <Badge tone="success">Current</Badge>
            ) : null}
            <Badge tone="neutral">{BATCH_CHANGE_SOURCE_LABELS[entry.source]}</Badge>
            {entry.changedByName ? (
              <span className="text-xs text-[var(--color-fg-subtle)]">
                by {entry.changedByName}
              </span>
            ) : null}
            {entry.reason ? (
              <span className="w-full text-xs text-[var(--color-fg-muted)] sm:w-auto">
                &ldquo;{entry.reason}&rdquo;
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
