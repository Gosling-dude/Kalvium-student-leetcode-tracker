'use client';

/**
 * Campus Analysis — Daily Report.
 *
 * The Coding-Hours counterpart to the Infosys Daily Report: a wide date-wise submission
 * matrix (Rank | Student | Campus | Batch | Squad | dates grouped by week | Total Solved),
 * read from `api.campusDailyReport()`, itself built from the same `DailyStatus` rows the
 * Campus Analysis summary/drill-down already read (§13/§17 — no live LeetCode fetch, no
 * re-derivation of "solved"). "As of Date" controls which day columns exist; campus,
 * batch, squad, category and search only narrow which rows are shown — never the
 * underlying data, and never a campus outside the three with real Coding-Hours activity
 * (the campus picker itself only ever offers those, same as everywhere else).
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { CAMPUS_CATEGORIES, CAMPUS_CATEGORY_LABELS } from '@dsa/shared';

import { api, downloadFile } from '@/lib/api';
import { cn, todayKey } from '@/lib/utils';
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, TableShell, Td } from '@/components/ui';

const HEADER_CELL =
  'sticky top-0 z-10 whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] ' +
  'px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)] align-bottom';

export default function CampusDailyReportPage() {
  const [asOf, setAsOf] = useState(todayKey());
  const [campus, setCampus] = useState('ALL');
  const [batch, setBatch] = useState('ALL');
  const [squad, setSquad] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const campusOptions = useQuery({ queryKey: ['campuses', 'coding-hours-activity'], queryFn: () => api.campuses(true) });
  const studentFilters = useQuery({ queryKey: ['students', 'filters'], queryFn: api.studentFilters });

  const params = {
    asOf,
    campus: campus === 'ALL' ? null : campus,
    batch: batch === 'ALL' ? null : batch,
    squad: squad === 'ALL' ? null : squad,
    category: category === 'ALL' ? null : (category as never),
    search: search || null,
  };

  const report = useQuery({
    queryKey: ['campus-daily-report', asOf, campus, batch, squad, category, search],
    queryFn: () => api.campusDailyReport(params),
  });

  const batchOptions = (studentFilters.data?.batches ?? []).filter((b) => campus === 'ALL' || b.campusId === campus);
  const squadOptions = (studentFilters.data?.squads ?? []).filter((s) => campus === 'ALL' || s.campusId === campus);

  const handleExport = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadFile(api.campusDailyReportExportPath(params), `campus-analysis-report-${asOf}.xlsx`);
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
          <h1 className="text-lg font-semibold tracking-tight">Campus Analysis — Daily Report</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Every day with real submission data, from the earliest through the selected date.
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
            <input id="report-as-of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={selectClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor="report-campus" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Campus
            </label>
            <select
              id="report-campus"
              className={selectClass}
              value={campus}
              onChange={(e) => {
                setCampus(e.target.value);
                setBatch('ALL');
                setSquad('ALL');
              }}
            >
              <option value="ALL">All</option>
              {(campusOptions.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="report-batch" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Batch
            </label>
            <select id="report-batch" className={selectClass} value={batch} onChange={(e) => setBatch(e.target.value)}>
              <option value="ALL">All</option>
              {batchOptions.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="report-squad" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Squad
            </label>
            <select id="report-squad" className={selectClass} value={squad} onChange={(e) => setSquad(e.target.value)}>
              <option value="ALL">All</option>
              {squadOptions.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="report-category" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Category
            </label>
            <select id="report-category" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="ALL">All</option>
              {CAMPUS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CAMPUS_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="report-search" className="text-xs font-medium text-[var(--color-fg-muted)]">
              Student search
            </label>
            <input
              id="report-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name"
              className={selectClass}
            />
          </div>
        </div>
      </Card>

      {report.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !report.data || report.data.days.length === 0 ? (
        <EmptyState title="No submission data on or before this date" description="Pick a later As of Date." />
      ) : (
        <Card>
          <CardHeader title={`${report.data.rows.length} students`} description={`As of ${asOf}`} />
          <div className="overflow-x-auto">
            <TableShell>
              <thead>
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
                  <th rowSpan={2} className={HEADER_CELL}>
                    Batch
                  </th>
                  <th rowSpan={2} className={HEADER_CELL}>
                    Squad
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
                    <Td className="font-medium">
                      {row.name}
                      {row.leetcodeUrl ? (
                        <a
                          href={row.leetcodeUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="ml-2 text-xs font-normal text-[var(--color-brand)] hover:underline"
                        >
                          {row.leetcodeUsername}
                        </a>
                      ) : (
                        <span className="ml-2 text-xs font-normal text-[var(--color-fg-subtle)]">Profile not linked</span>
                      )}
                    </Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.campusCode ?? '—'}</Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.batch ?? '—'}</Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.squad ?? '—'}</Td>
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
