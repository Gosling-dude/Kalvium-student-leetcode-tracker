'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, ExternalLink, Trophy } from 'lucide-react';

import { api } from '@/lib/api';
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
  StreakFlame,
} from '@/components/ui';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function StudentDashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'dashboard'],
    queryFn: api.studentDashboard,
  });

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-20" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const firstName = data.name.split(/\s+/)[0] ?? data.name;
  const today = data.todayAssignment;
  const solvedToday = today?.myOutcome?.solvedCount ?? 0;
  const assignedToday = today?.myOutcome?.assignedCount ?? today?.problems.length ?? 0;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h1 className="text-xl font-semibold tracking-tight">
          {greeting()}, {firstName} 👋
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg-muted)]">
          {data.batchName ? <Badge tone="brand">{data.batchName}</Badge> : null}
          {data.cohort !== null ? <Badge tone="neutral">Cohort {data.cohort}</Badge> : null}
          {data.maxBeltLevel !== null ? (
            <Badge tone="neutral">Max Belt Level: {data.maxBeltLevel}</Badge>
          ) : null}
        </div>

        {today ? (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-[var(--color-fg-muted)]">
              <span>Today&apos;s progress</span>
              <span className="tabular-nums">
                {solvedToday} / {assignedToday} completed
              </span>
            </div>
            <ProgressBar
              value={assignedToday > 0 ? (solvedToday / assignedToday) * 100 : 0}
              label="Today's progress"
            />
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Current streak"
          value={<StreakFlame streak={data.currentStreak} />}
          hint={`Longest: ${data.longestStreak} days`}
        />
        <StatTile label="Total solved" value={data.totalSolved} hint="Lifetime, from LeetCode" />
        <StatTile
          label="Current rank"
          value={data.currentRank ? `#${data.currentRank.rank}` : '—'}
          hint={data.currentRank ? `of ${data.currentRank.total} this week` : 'No leaderboard yet'}
          icon={<Trophy className="size-4" aria-hidden />}
          tone="brand"
        />
        <StatTile
          label="Weekly completion"
          value={`${Math.round(data.weeklyCompletionPercent)}%`}
          hint={`${data.weeklySolved} solved this week`}
        />
      </div>

      <Card>
        <CardHeader
          title="Today's assignment"
          description={today?.topic ?? today?.title ?? undefined}
          action={
            <Link
              href="/student/assignments"
              className="text-xs font-medium text-[var(--color-brand)] hover:underline"
            >
              View history
            </Link>
          }
        />
        {!today ? (
          <EmptyState
            title="No assignment today"
            description="Nothing has been assigned for your batch yet — check back soon."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {today.problems.map((problem) => {
              const outcome = today.myOutcome?.problems.find((p) => p.problemId === problem.problemId);
              const solved = outcome?.status === 'ACCEPTED';
              return (
                <li key={problem.id} className="flex items-center gap-3 px-5 py-3">
                  {solved ? (
                    <CheckCircle2 className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                  ) : (
                    <Circle className="size-4 shrink-0 text-[var(--color-fg-subtle)]" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {problem.position}. {problem.title}
                  </span>
                  <DifficultyBadge difficulty={problem.difficulty} />
                  <a
                    href={problem.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline"
                  >
                    Open <ExternalLink className="size-3" aria-hidden />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Your progress" />
          <div className="grid grid-cols-3 gap-3 p-5">
            <div>
              <p className="text-xs text-[var(--color-fg-muted)]">Solved this week</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{data.weeklySolved}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-fg-muted)]">Solved this month</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{data.monthlySolved}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-fg-muted)]">Completion rate</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {Math.round(data.monthlyCompletionPercent)}%
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          {data.recentDays.length === 0 ? (
            <EmptyState title="No activity yet" description="Your recent days will show up here." />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {data.recentDays.map((day) => (
                <li key={day.dayKey} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <span className="text-[var(--color-fg-muted)]">
                    {new Date(`${day.dayKey}T00:00:00`).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <span className="flex items-center gap-1.5 tabular-nums">
                    {day.isPerfect ? (
                      <CheckCircle2 className="size-3.5 text-[var(--color-success)]" aria-hidden />
                    ) : (
                      <Circle className="size-3.5 text-[var(--color-fg-subtle)]" aria-hidden />
                    )}
                    {day.solvedCount}/{day.assignedCount} completed
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
