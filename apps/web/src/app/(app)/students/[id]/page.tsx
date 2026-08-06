'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { SYNC_STATUS_LABELS, isTrustworthySync } from '@dsa/shared';

import { api } from '@/lib/api';
import { cn, formatPercent, timeAgo } from '@/lib/utils';
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
            {data.batchName ? ` · ${data.batchName}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={`https://leetcode.com/u/${data.leetcodeUsername}/`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 font-mono text-xs text-[var(--color-brand)] hover:underline"
            >
              {data.leetcodeUsername}
              <ExternalLink className="size-3" aria-hidden />
            </a>
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Current streak"
          value={<StreakFlame streak={data.currentStreak} />}
          hint={`Longest ${data.longestStreak} days`}
          tone="warning"
        />
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
