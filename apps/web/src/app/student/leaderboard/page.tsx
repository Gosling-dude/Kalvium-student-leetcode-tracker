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

/**
 * The three boards a student may see (§14, §15).
 *
 * `scope` is the only thing the student varies — never a campus or batch id. The ids come
 * from their own record on the server, so this control cannot be used to look at another
 * campus's board (§40).
 */
const SCOPES = [
  { value: 'mine', label: 'My batch' },
  { value: 'campus', label: 'My campus' },
  { value: 'global', label: 'All campuses' },
] as const;

export default function StudentLeaderboardPage() {
  const [period, setPeriod] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY');
  const [scope, setScope] = useState<'mine' | 'campus' | 'global'>('campus');

  // A student with no batch yet has no batch board to look at. Offering "My batch" would
  // show them their campus's board under a label that is not true of them.
  const me = useQuery({ queryKey: ['student', 'me'], queryFn: api.studentMe });
  const hasBatch = me.data ? me.data.batchId !== null : true;
  const scopes = hasBatch ? SCOPES : SCOPES.filter((option) => option.value !== 'mine');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'leaderboard', period, scope],
    queryFn: () => api.studentLeaderboard(period, scope),
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {scope === 'global'
              ? 'Every student across every campus, ranked together.'
              : scope === 'campus'
                ? 'Everyone at your campus.'
                : 'Your batch.'}
          </p>
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
            {scopes.map((option) => (
              <button
                key={option.value}
                onClick={() => setScope(option.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition',
                  scope === option.value
                    ? 'bg-[var(--color-brand)] text-[var(--color-brand-fg)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                )}
              >
                {option.label}
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
                {/* The overall standing travels with every row, so narrowing to a batch
                    never hides where someone sits in the whole programme (§14). */}
                {scope !== 'global' ? <Th>Overall</Th> : null}
                <Th>Student</Th>
                <Th>Campus</Th>
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
                    {scope !== 'global' ? (
                      <Td className="tabular-nums text-[var(--color-fg-muted)]">
                        {row.globalRank !== null ? `#${row.globalRank}` : '—'}
                      </Td>
                    ) : null}
                    <Td className="font-medium">
                      {row.name}
                      {isYou ? (
                        <Badge tone="brand" className="ml-2">
                          You
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>{row.campusCode ?? '—'}</Td>
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
