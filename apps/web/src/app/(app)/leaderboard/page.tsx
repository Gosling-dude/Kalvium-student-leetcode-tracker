'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import { api } from '@/lib/api';
import { cn, formatPercent } from '@/lib/utils';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  StreakFlame,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

type Period = 'DAILY' | 'WEEKLY' | 'MONTHLY';
type Scope = 'students' | 'squads';

const PERIODS: Period[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>('DAILY');
  const [scope, setScope] = useState<Scope>('students');

  const students = useQuery({
    queryKey: ['leaderboard', 'students', period],
    queryFn: () => api.leaderboard({ period }),
    enabled: scope === 'students',
  });

  const squads = useQuery({
    queryKey: ['leaderboard', 'squads', period],
    queryFn: () => api.squadLeaderboard({ period }),
    enabled: scope === 'squads',
  });

  const active = scope === 'students' ? students : squads;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Ranked by score, then problems solved, then earliest completion.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            options={[
              { value: 'students', label: 'Students' },
              { value: 'squads', label: 'Squads' },
            ]}
            value={scope}
            onChange={(value) => setScope(value as Scope)}
          />
          <SegmentedControl
            options={PERIODS.map((value) => ({
              value,
              label: value.charAt(0) + value.slice(1).toLowerCase(),
            }))}
            value={period}
            onChange={(value) => setPeriod(value as Period)}
          />
        </div>
      </header>

      <Card>
        <CardHeader
          title={scope === 'students' ? 'Student rankings' : 'Squad rankings'}
          description={
            scope === 'squads'
              ? 'Squads are compared on averages, so unequal squad sizes rank fairly.'
              : undefined
          }
        />

        {active.isLoading ? (
          <TableSkeleton rows={10} cols={7} />
        ) : active.error ? (
          <ErrorState error={active.error} onRetry={() => void active.refetch()} />
        ) : scope === 'students' ? (
          !students.data || students.data.length === 0 ? (
            <EmptyState
              title="No rankings yet"
              description="Leaderboards are built after the first sync of the period."
            />
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <Th className="w-16">Rank</Th>
                  <Th>Student</Th>
                  <Th>Squad</Th>
                  <Th className="text-right">Solved</Th>
                  <Th>Streak</Th>
                  <Th className="text-right">Score</Th>
                  <Th>Completed</Th>
                  <Th>Badges</Th>
                </tr>
              </thead>
              <tbody>
                {students.data.map((row) => (
                  <tr
                    key={row.studentId}
                    className="transition hover:bg-[var(--color-surface-sunken)]"
                  >
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'grid size-7 place-items-center rounded-md text-xs font-bold tabular-nums',
                            row.rank === 1 && 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
                            row.rank === 2 && 'bg-[var(--color-surface-sunken)]',
                            row.rank === 3 && 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
                            row.rank > 3 && 'text-[var(--color-fg-muted)]',
                          )}
                        >
                          {row.rank}
                        </span>
                        {row.isTied ? (
                          <span
                            className="text-xs text-[var(--color-fg-subtle)]"
                            title="Tied with another student"
                          >
                            =
                          </span>
                        ) : null}
                        <RankDelta delta={row.rankDelta} />
                      </div>
                    </Td>
                    <Td>
                      <p className="truncate font-medium">{row.name}</p>
                      <p className="text-xs text-[var(--color-fg-subtle)]">Level {row.level}</p>
                    </Td>
                    <Td className="text-[var(--color-fg-muted)]">{row.squadName ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{row.solvedCount}</Td>
                    <Td>
                      <StreakFlame streak={row.currentStreak} />
                    </Td>
                    <Td className="text-right font-semibold tabular-nums">{row.score}</Td>
                    <Td className="tabular-nums text-[var(--color-fg-muted)]">
                      {row.completionTime ?? '—'}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {row.badges.length === 0 ? (
                          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
                        ) : (
                          row.badges.map((badge) => (
                            <Badge key={badge.code} tone="brand" className="whitespace-nowrap">
                              {badge.name}
                            </Badge>
                          ))
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )
        ) : !squads.data || squads.data.length === 0 ? (
          <EmptyState title="No squad rankings yet" />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th className="w-16">Rank</Th>
                <Th>Squad</Th>
                <Th className="text-right">Members</Th>
                <Th className="text-right">Avg. completion</Th>
                <Th className="text-right">Total solved</Th>
                <Th className="text-right">Avg. streak</Th>
                <Th className="text-right">Avg. score</Th>
              </tr>
            </thead>
            <tbody>
              {squads.data.map((row) => (
                <tr key={row.squadId} className="transition hover:bg-[var(--color-surface-sunken)]">
                  <Td className="font-bold tabular-nums">{row.rank}</Td>
                  <Td className="font-medium">{row.name}</Td>
                  <Td className="text-right tabular-nums">{row.memberCount}</Td>
                  <Td className="text-right tabular-nums">
                    {formatPercent(row.averageCompletion)}
                  </Td>
                  <Td className="text-right tabular-nums">{row.totalSolved}</Td>
                  <Td className="text-right tabular-nums">{row.averageStreak.toFixed(1)}</Td>
                  <Td className="text-right font-semibold tabular-nums">
                    {row.averageScore.toFixed(1)}
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

function RankDelta({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) {
    return <Minus className="size-3 text-[var(--color-fg-subtle)]" aria-label="No change" />;
  }
  const improved = delta > 0;
  const Icon = improved ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'inline-flex items-center text-xs tabular-nums',
        improved ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]',
      )}
      title={improved ? `Up ${delta} places` : `Down ${Math.abs(delta)} places`}
    >
      <Icon className="size-3" aria-hidden />
      {Math.abs(delta)}
    </span>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition',
            value === option.value
              ? 'bg-[var(--color-brand)] text-[var(--color-brand-fg)]'
              : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
