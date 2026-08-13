'use client';

import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { api } from '@/lib/api';
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
} from '@/components/ui';

/** Same brand blue used across the app's charts, just the one series here. */
const LINE = { light: '#2a78d6', dark: '#3987e5' };
const GRID = { light: '#e2e8f0', dark: '#26303c' };
const AXIS = { light: '#64748b', dark: '#8a97a6' };

export default function StudentProgressPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'profile'],
    queryFn: api.studentPortalProfile,
  });
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const last30 = data.heatmap.slice(-30).map((d) => ({
    date: new Date(`${d.dayKey}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    solved: d.solvedCount,
  }));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">My Progress</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Level {data.levelProgress.level} · {data.levelProgress.xp} XP
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total solved" value={data.totalSolved} hint="Lifetime, from LeetCode" />
        <StatTile
          label="Current streak"
          value={<StreakFlame streak={data.currentStreak} />}
          hint={`Longest: ${data.longestStreak} days`}
        />
        <StatTile
          label="Assignment completion"
          value={`${Math.round(data.weeklyCompletionPercent)}%`}
          hint="This week"
        />
        <StatTile
          label="Max belt level"
          value={data.maxBeltLevel ?? '—'}
          hint={data.batchName ?? undefined}
        />
      </div>

      <Card>
        <CardHeader title="Problems solved per day" description="Last 30 days" />
        {last30.length === 0 ? (
          <EmptyState
            title="No solved-problem history yet"
            description="This fills in once your LeetCode account has synced at least one day of activity."
          />
        ) : (
        <div className="h-64 px-2 pb-4 pt-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={last30} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id="solvedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={dark ? LINE.dark : LINE.light} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={dark ? LINE.dark : LINE.light} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke={dark ? GRID.dark : GRID.light}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: dark ? AXIS.dark : AXIS.light }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: dark ? AXIS.dark : AXIS.light }}
                tickLine={false}
                axisLine={false}
                width={28}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 8,
                  border: `1px solid ${dark ? GRID.dark : GRID.light}`,
                  background: dark ? '#141a22' : '#ffffff',
                }}
              />
              <Area
                type="monotone"
                dataKey="solved"
                name="Solved"
                stroke={dark ? LINE.dark : LINE.light}
                fill="url(#solvedFill)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="This week vs this month" />
          <div className="space-y-4 p-5">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-[var(--color-fg-muted)]">
                <span>Weekly completion</span>
                <span className="tabular-nums">{Math.round(data.weeklyCompletionPercent)}%</span>
              </div>
              <ProgressBar value={data.weeklyCompletionPercent} label="Weekly completion" />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-[var(--color-fg-muted)]">
                <span>Monthly completion</span>
                <span className="tabular-nums">{Math.round(data.monthlyCompletionPercent)}%</span>
              </div>
              <ProgressBar value={data.monthlyCompletionPercent} label="Monthly completion" />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Achievements" description={`${data.achievements.filter((a) => a.earned).length} earned`} />
          <ul className="max-h-56 space-y-2 overflow-y-auto p-4">
            {data.achievements.map((a) => (
              <li
                key={a.code}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="truncate text-xs text-[var(--color-fg-subtle)]">{a.description}</p>
                </div>
                <Badge tone={a.earned ? 'success' : 'neutral'}>{a.earned ? 'Earned' : `${a.current}/${a.target}`}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
