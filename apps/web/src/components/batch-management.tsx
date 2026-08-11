'use client';

/**
 * Batch Management (§19) — one card per batch, with the figures an admin actually acts on.
 *
 * Deliberately reads `GET /batches/stats` rather than assembling the numbers from the
 * students list: average completion has to be computed against each batch's *own*
 * assignment for the day, which is a server-side join, and doing it here would produce a
 * second, subtly different definition of "completion".
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, ListChecks, Users } from 'lucide-react';

import { api, downloadFile } from '@/lib/api';
import { formatPercent, todayKey } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui';
import { BatchChip } from '@/components/batch-filter';

export function BatchManagement() {
  const dayKey = todayKey();

  const { data, isLoading } = useQuery({
    queryKey: ['batch-stats', dayKey],
    queryFn: () => api.batchStats(dayKey),
  });

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader title="Batch management" />
        <EmptyState
          title="No batches yet"
          description="Create a batch before importing students, so everyone has a placement."
        />
      </Card>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Batch management</h2>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Figures are for {dayKey}, each measured against that batch&rsquo;s own assignment.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {data.map((batch) => (
          <Card key={batch.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <BatchChip code={batch.code} name={batch.name} />
                  <h3 className="truncate text-base font-semibold">{batch.name}</h3>
                </div>
                {batch.description ? (
                  <p className="mt-0.5 truncate text-xs text-[var(--color-fg-subtle)]">
                    {batch.description}
                  </p>
                ) : null}
              </div>
              <Badge tone={batch.assignedCount > 0 ? 'success' : 'neutral'}>
                {batch.assignedCount} assigned today
              </Badge>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Students" value={batch.activeStudents} />
              <Figure
                label="Avg. completion"
                value={formatPercent(batch.averageCompletionPercent)}
              />
              <Figure
                label="Avg. belt"
                value={batch.averageBeltLevel !== null ? batch.averageBeltLevel.toFixed(1) : '—'}
              />
              <Figure label="Archived" value={batch.archivedStudents} />
            </dl>

            {batch.cohortCounts.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {batch.cohortCounts.map((entry) => (
                  <Badge key={entry.cohort ?? 'none'} tone="info">
                    Cohort {entry.cohort ?? '—'}: {entry.studentCount}
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/students?batch=${batch.code}`}>
                <Button className="text-xs">
                  <Users className="size-3.5" aria-hidden />
                  View students
                </Button>
              </Link>
              <Link href="/assignments">
                <Button className="text-xs">
                  <ListChecks className="size-3.5" aria-hidden />
                  Assign questions
                </Button>
              </Link>
              <Button
                className="text-xs"
                onClick={() =>
                  void downloadFile(
                    `/reports/export/daily?dayKey=${dayKey}&format=XLSX&batch=${batch.code}`,
                    `daily-report-${dayKey}-${batch.code}.xlsx`,
                  )
                }
              >
                <Download className="size-3.5" aria-hidden />
                Export
              </Button>
              <Link href="/email-reports">
                <Button className="text-xs">
                  <FileText className="size-3.5" aria-hidden />
                  Generate report
                </Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
