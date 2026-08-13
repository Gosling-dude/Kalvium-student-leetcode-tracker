'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  StreakFlame,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

const PERIODS = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
] as const;

export default function StudentLeaderboardPage() {
  const [period, setPeriod] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'leaderboard', period, scope],
    queryFn: () => api.studentLeaderboard(period, scope),
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">See where you stand.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition',
                  period === p.value
                    ? 'bg-[var(--color-brand)] text-[var(--color-brand-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-0.5">
            {(['mine', 'all'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition',
                  scope === s
                    ? 'bg-[var(--color-brand)] text-[var(--color-brand-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                )}
              >
                {s === 'mine' ? 'My batch' : 'All batches'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <Card>
        {isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : error || !data ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : data.rows.length === 0 ? (
          <EmptyState
            title="No rankings yet"
            description="Rankings appear once the leaderboard has been computed for this period."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Rank</Th>
                <Th>Student</Th>
                <Th>Batch</Th>
                <Th>Solved</Th>
                <Th>Streak</Th>
                <Th>Score</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const isYou = row.studentId === data.myStudentId;
                return (
                  <tr key={row.studentId} className={cn(isYou && 'bg-[var(--color-brand-soft)]')}>
                    <Td className="tabular-nums">#{row.rank}</Td>
                    <Td className="font-medium">
                      {row.name}
                      {isYou ? (
                        <Badge tone="brand" className="ml-2">
                          You
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>{row.batchCode ?? '—'}</Td>
                    <Td className="tabular-nums">{row.solvedCount}</Td>
                    <Td>
                      <StreakFlame streak={row.currentStreak} />
                    </Td>
                    <Td className="tabular-nums">{row.score}</Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
