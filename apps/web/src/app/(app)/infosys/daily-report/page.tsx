'use client';

/**
 * Infosys Preparation — Daily Report.
 *
 * One page, the whole date-wise submission matrix, exactly the shape of the existing
 * Coding-Hours manual report: Rank | Student | Campus | dates grouped by week | Total
 * Solved. Read entirely from `api.infosysDailyReport()`, which is the same materialised
 * `InfosysDailyStatus` data the dashboard and Student Analysis page already read (§13 —
 * no live LeetCode fetch here). Campus/category only narrow which rows are *shown*; the
 * "As of Date" is the one control that changes which day *columns* exist at all, since a
 * day with no `InfosysAssignment` (27 Sep) never becomes a column, in the UI or the
 * export, no matter what date range is selected.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { INFOSYS_CATEGORIES, INFOSYS_CATEGORY_LABELS } from '@dsa/shared';

import { api, downloadFile } from '@/lib/api';
import { cn, todayKey } from '@/lib/utils';
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, TableShell, Td } from '@/components/ui';

const HEADER_CELL =
  'sticky top-0 z-10 whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] ' +
  'px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)] align-bottom';

export default function InfosysDailyReportPage() {
  const [asOf, setAsOf] = useState(todayKey());
  const [campus, setCampus] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [exporting, setExporting] = useState(false);

  const report = useQuery({
    queryKey: ['infosys-daily-report', asOf, campus, category],
    queryFn: () =>
      api.infosysDailyReport({
        asOf,
        campus: campus === 'ALL' ? null : campus,
        category: category === 'ALL' ? null : (category as never),
      }),
  });

  const campusOptions = [...new Set((report.data?.rows ?? []).map((r) => r.campusName).filter((c): c is string => !!c))].sort();

  const handleExport = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadFile(
        api.infosysDailyReportExportPath({
          asOf,
          campus: campus === 'ALL' ? null : campus,
          category: category === 'ALL' ? null : (category as never),
        }),
        `infosys-daily-report-${asOf}.xlsx`,
      );
    } catch (error) {
      toast.error('Export failed', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setExporting(false);
    }
  };

  const selectClass =
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-brand)]';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Infosys Preparation — Daily Report</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Every assigned day from the tracking start date through the selected date, one row per active student.
          </p>
        </div>
        <Button variant="primary" onClick={() => void handleExport()} loading={exporting}>
          <Download className="size-3.5" aria-hidden />
          Export to Excel
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <label htmlFor="report-as-of" className="text-xs font-medium text-[var(--color-fg-muted)]">
              As of Date
            </label>
            <input
              id="report-as-of"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className={selectClass}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="report-campus" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Campus
            </label>
            <select id="report-campus" className={selectClass} value={campus} onChange={(e) => setCampus(e.target.value)}>
              <option value="ALL">All campuses</option>
              {campusOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="report-category" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Category
            </label>
            <select id="report-category" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="ALL">All categories</option>
              {INFOSYS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {INFOSYS_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {report.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !report.data || report.data.days.length === 0 ? (
        <EmptyState
          title="No Infosys assignment days on or before this date"
          description="Pick a later As of Date, or add the first Infosys assignment."
        />
      ) : (
        <Card>
          <CardHeader title={`${report.data.rows.length} students`} description={`As of ${asOf}`} />
          <div className="overflow-x-auto">
            <TableShell>
              <thead>
                {/* A custom two-row, merged-week header — the shared `Th` component is a
                    single-row `<th>` with no `rowSpan`/`colSpan` in its prop type, so this
                    table's header is built from plain `<th>` elements instead, styled to match. */}
                <tr>
                  <th rowSpan={2} className={HEADER_CELL}>
                    Rank
                  </th>
                  <th rowSpan={2} className={HEADER_CELL}>
                    Student
                  </th>
                  <th rowSpan={2} className={HEADER_CELL}>
                    Campus
                  </th>
                  {report.data.weeks.map((week) => (
                    <th key={week.weekNumber} colSpan={week.days.length} className={cn(HEADER_CELL, 'text-center')}>
                      {week.label}
                    </th>
                  ))}
                  <th rowSpan={2} className={cn(HEADER_CELL, 'text-right')}>
                    Total Solved
                  </th>
                </tr>
                <tr>
                  {report.data.days.map((day) => (
                    <th
                      key={day.dayKey}
                      className={cn(HEADER_CELL, 'text-right text-[10px] font-normal normal-case text-[var(--color-fg-subtle)]')}
                    >
                      {day.dayKey.slice(5)}
                      <br />
                      <span className="text-[9px]">{day.assignedCount}q</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.rows.map((row) => (
                  <tr key={row.studentId} className="hover:bg-[var(--color-surface-sunken)]">
                    <Td className="tabular-nums">{row.rank}</Td>
                    <Td className="font-medium">{row.name}</Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.campusName ?? '—'}</Td>
                    {report.data!.days.map((day) => (
                      <Td key={day.dayKey} className="text-right tabular-nums">
                        {row.daily[day.dayKey] ?? 0}
                      </Td>
                    ))}
                    <Td className="text-right font-semibold tabular-nums">{row.total}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        </Card>
      )}
    </div>
  );
}
