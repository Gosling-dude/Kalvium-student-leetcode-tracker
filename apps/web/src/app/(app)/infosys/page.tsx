'use client';

/**
 * Infosys Preparation — the whole-cohort dashboard.
 *
 * Deliberately does not import `ScopeFilter` or read `useScopeFilter()` anywhere on
 * this page, and `api.infosysDashboard()` takes no campus argument — see
 * `InfosysAnalyticsService`'s header comment (apps/api/src/modules/infosys). An
 * earlier version of this feature reused the Coding-Hours campus picker here; it was
 * removed because Infosys treats every enrolled student as one cohort, full stop.
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, ListChecks, Users } from 'lucide-react';

import { api } from '@/lib/api';
import { formatPercent } from '@/lib/utils';
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, StatTile, TableShell, Td, Th } from '@/components/ui';

const percent = (value: number | null): string => (value === null ? '—' : formatPercent(value * 100));

export default function InfosysDashboardPage() {
  const dashboard = useQuery({ queryKey: ['infosys-dashboard'], queryFn: api.infosysDashboard });

  if (dashboard.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (dashboard.error) return <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />;

  const data = dashboard.data!;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Infosys Preparation</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {today} · {data.totalStudents} students · one cohort, no campus breakdown
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/infosys/assignments"
            className="rounded-lg bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-[var(--color-brand-fg)] hover:opacity-90"
          >
            Daily Assignments
          </Link>
          <Link
            href="/infosys/students"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-surface-sunken)]"
          >
            Student Analysis
          </Link>
          <Link
            href="/infosys/daily-report"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-surface-sunken)]"
          >
            Daily Report
          </Link>
        </div>
      </div>

      {data.weeks.length === 0 ? (
        <EmptyState
          title="No Infosys assignments yet"
          description="The dashboard fills in once the first daily assignment is added."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Total Students" value={data.totalStudents} icon={<Users className="size-4" />} />
            <StatTile
              label="Profiles Linked"
              value={`${data.profilesLinked} / ${data.totalStudents}`}
              icon={<CheckCircle2 className="size-4" />}
            />
            <StatTile
              label="Questions Assigned"
              value={data.assigned}
              hint="Distinct problems, not students × questions"
              icon={<ListChecks className="size-4" />}
            />
            <StatTile label="Solve %" value={percent(data.solvePercent)} icon={<CalendarDays className="size-4" />} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Questions Solved" value={data.solved} />
            <StatTile label="Attempted, Not Solved" value={data.attemptedNotSolved} />
            <StatTile label="Not Attempted" value={data.notAttempted} />
            <StatTile label="Attempt %" value={percent(data.attemptPercent)} />
          </div>

          <Card>
            <CardHeader title="Weekly progress" description="Whole cohort, every week since the tracking start date." />
            <TableShell>
              <thead>
                <tr>
                  <Th>Week</Th>
                  <Th>Date range</Th>
                  <Th className="text-right">Assigned</Th>
                  <Th className="text-right">Solved</Th>
                  <Th className="text-right">Attempted</Th>
                  <Th className="text-right">Not attempted</Th>
                  <Th className="text-right">Solve %</Th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((week) => (
                  <tr key={week.weekNumber}>
                    <Td>Week {week.weekNumber}</Td>
                    <Td className="text-[var(--color-fg-muted)]">
                      {week.from} – {week.to}
                    </Td>
                    <Td className="text-right tabular-nums">{week.assigned}</Td>
                    <Td className="text-right tabular-nums">{week.solved}</Td>
                    <Td className="text-right tabular-nums">{week.attemptedNotSolved}</Td>
                    <Td className="text-right tabular-nums">{week.notAttempted}</Td>
                    <Td className="text-right tabular-nums">{percent(week.solvePercent)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>

          <Card>
            <CardHeader title="Student categories" description="Every enrolled student, by behaviour pattern." />
            <TableShell>
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th className="text-right">Students</Th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.category}>
                    <Td>{c.category.replace(/_/g, ' ')}</Td>
                    <Td className="text-right tabular-nums">{c.students}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
        </>
      )}
    </div>
  );
}
