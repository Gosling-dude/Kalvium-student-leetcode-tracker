'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { BatchFilter, useBatchFilter } from '@/components/batch-filter';
import { formatPercent, todayKey } from '@/lib/utils';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  ProgressBar,
  Skeleton,
  TableShell,
  Td,
  Th,
} from '@/components/ui';
import { CompletionTrendChart, DifficultyChart, SquadComparisonChart } from './charts';

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

const RANGES = [
  { label: '7 days', days: 6 },
  { label: '30 days', days: 29 },
  { label: '90 days', days: 89 },
];

export default function AnalyticsPage() {
  const [range, setRange] = useState(RANGES[1]!);
  const { selected: batch } = useBatchFilter();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics', range.days, batch],
    queryFn: () => api.analytics(daysAgo(range.days), todayKey(), batch ?? undefined),
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {data ? `${data.range.from} → ${data.range.to}` : 'Loading range…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <BatchFilter />
        <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-0.5">
          {RANGES.map((option) => (
            <button
              key={option.label}
              onClick={() => setRange(option)}
              aria-pressed={range.label === option.label}
              className={
                range.label === option.label
                  ? 'rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]'
                  : 'rounded-md px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-72" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !data ? null : (
        <>
          <Card>
            <CardHeader
              title="Daily completion"
              description="Share of assigned problems solved each day across the whole programme"
            />
            <div className="p-4">
              <CompletionTrendChart data={data.daily} />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Completion by difficulty"
                description="Where students actually get stuck"
              />
              <div className="p-4">
                <DifficultyChart data={data.byDifficulty} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Squad comparison" description="Average completion per squad" />
              <div className="p-4">
                <SquadComparisonChart data={data.squadComparison} />
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Top improvers"
                description="Largest score gain versus the previous period"
              />
              {data.topImprovers.length === 0 ? (
                <EmptyState title="Not enough history yet" />
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {data.topImprovers.map((student) => (
                    <li
                      key={student.studentId}
                      className="flex items-center justify-between gap-3 px-5 py-2.5"
                    >
                      <span className="truncate text-sm">{student.name}</span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-success)]">
                        +{student.delta}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Needs attention"
                description="Lowest completion over the selected range"
              />
              {data.bottomPerformers.length === 0 ? (
                <EmptyState title="No data yet" />
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {data.bottomPerformers.map((student) => (
                    <li key={student.studentId} className="px-5 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm">{student.name}</span>
                        <span className="shrink-0 text-sm tabular-nums text-[var(--color-fg-muted)]">
                          {formatPercent(student.completionPercent)}
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <ProgressBar
                          value={student.completionPercent}
                          label={`${student.name} completion`}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Completion by topic"
              description="Ranked by how often the topic has been assigned"
            />
            {data.byTopic.length === 0 ? (
              <EmptyState title="No topic data yet" />
            ) : (
              <TableShell>
                <thead>
                  <tr>
                    <Th>Topic</Th>
                    <Th className="text-right">Assigned</Th>
                    <Th className="text-right">Solved</Th>
                    <Th className="w-56">Completion</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byTopic.map((topic) => (
                    <tr key={topic.topic}>
                      <Td className="font-medium">{topic.topic}</Td>
                      <Td className="text-right tabular-nums">{topic.assignedCount}</Td>
                      <Td className="text-right tabular-nums">{topic.solvedCount}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <ProgressBar
                            value={topic.completionPercent}
                            label={`${topic.topic} completion`}
                          />
                          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
                            {formatPercent(topic.completionPercent)}
                          </span>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
