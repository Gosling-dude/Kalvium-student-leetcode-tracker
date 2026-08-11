'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  SYNC_STATUS_LABELS,
  isTrustworthySync,
  type MentorBatchSection,
  type MentorBucket,
} from '@dsa/shared';

import { api, downloadFile } from '@/lib/api';
import { todayKey } from '@/lib/utils';
import { BatchChip, BatchFilter, useBatchFilter } from '@/components/batch-filter';
import {
  Badge,
  Button,
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

/**
 * The mentor's primary working view: one table per completion level, so "who solved 4"
 * and "who solved 0, and why" are each a single glance rather than a filter operation.
 */
export default function MentorPage() {
  const [dayKey, setDayKey] = useState(todayKey());
  const [exporting, setExporting] = useState(false);
  const { selected: batch } = useBatchFilter();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mentor', dayKey, batch],
    queryFn: () => api.mentorDashboard(dayKey, undefined, batch ?? undefined),
  });

  const onExport = async (): Promise<void> => {
    setExporting(true);
    try {
      // The export follows the filter: what you are looking at is what you download.
      const scope = batch ? `&batch=${encodeURIComponent(batch)}` : '';
      await downloadFile(
        `/reports/export/daily?dayKey=${dayKey}&format=XLSX${scope}`,
        `daily-report-${dayKey}${batch ? `-${batch}` : ''}.xlsx`,
      );
      toast.success('Report downloaded');
    } catch (err) {
      toast.error('Export failed', { description: (err as Error).message });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Mentor View</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {data?.assignment?.topic ? `${data.assignment.topic} · ` : ''}
            {data?.totalStudents ?? 0} students
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BatchFilter />
          <label htmlFor="dayKey" className="sr-only">
            Date
          </label>
          <input
            id="dayKey"
            type="date"
            value={dayKey}
            onChange={(event) => setDayKey(event.target.value)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
          <Button onClick={() => void onExport()} loading={exporting}>
            <Download className="size-3.5" aria-hidden />
            Export
          </Button>
        </div>
      </header>

      {isLoading ? (
        <Card>
          <TableSkeleton rows={8} cols={6} />
        </Card>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !data ? null : data.sections.filter((s) => s.assignedCount > 0).length === 0 ? (
        <Card>
          <EmptyState
            title={`No assignment on ${dayKey}`}
            description="Nothing was assigned that day, so there is nothing to report. Pick another date."
          />
        </Card>
      ) : (
        /*
          One block per batch, each bucketed against its *own* problem count. A single
          merged list would report a student who cleared their batch's 4 problems as
          incomplete on a day the other batch was given 5 (§10).
        */
        data.sections
          .filter((section) => section.assignedCount > 0)
          .map((section) => <BatchSectionTables key={section.batchId ?? 'none'} section={section} />)
      )}
    </div>
  );
}

/** One batch's heading plus its "solved N" tables. */
function BatchSectionTables({ section }: { section: MentorBatchSection }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2">
        <BatchChip code={section.batchCode} name={section.batchName} />
        <h2 className="text-base font-semibold">{section.batchName ?? 'No batch'}</h2>
        <span className="text-sm text-[var(--color-fg-muted)]">
          {section.assignedCount} assigned · {section.totalStudents} student
          {section.totalStudents === 1 ? '' : 's'}
        </span>
      </div>
      {section.buckets.map((bucket) => (
        <BucketTable
          key={bucket.solvedCount}
          bucket={bucket}
          assignedCount={section.assignedCount}
        />
      ))}
    </section>
  );
}

function BucketTable({ bucket, assignedCount }: { bucket: MentorBucket; assignedCount: number }) {
  const isComplete = bucket.solvedCount === assignedCount;
  const isZero = bucket.solvedCount === 0;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {isComplete ? (
              <CheckCircle2 className="size-4 text-[var(--color-success)]" aria-hidden />
            ) : null}
            {bucket.label}
            <Badge tone={isComplete ? 'success' : isZero ? 'danger' : 'warning'}>
              {bucket.students.length}
            </Badge>
          </span>
        }
        description={
          isZero
            ? 'Every zero shows why — a data problem is not the same as a student who did not work.'
            : isComplete
              ? 'Ordered by completion time — earliest first.'
              : 'Outstanding questions are listed per student.'
        }
      />

      {bucket.students.length === 0 ? (
        <EmptyState title="Nobody in this squad" description="No students landed here today." />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>Student</Th>
              <Th>Squad</Th>
              <Th>LeetCode</Th>
              {isComplete ? <Th>Completed</Th> : null}
              <Th>Streak</Th>
              <Th className="text-right">Score</Th>
              {isComplete ? <Th className="text-right">Rank</Th> : null}
              {!isComplete ? <Th>{isZero ? 'Reason' : 'Missing questions'}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {bucket.students.map((student) => {
              const untrusted = !isTrustworthySync(student.syncStatus);
              return (
                <tr
                  key={student.studentId}
                  className="transition hover:bg-[var(--color-surface-sunken)]"
                >
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{student.name}</p>
                      <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                        {student.email}
                      </p>
                    </div>
                  </Td>
                  <Td className="text-[var(--color-fg-muted)]">{student.squadName ?? '—'}</Td>
                  <Td>
                    {student.leetcodeUsername ? (
                      <a
                        href={`https://leetcode.com/u/${student.leetcodeUsername}/`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-mono text-xs hover:text-[var(--color-brand)]"
                      >
                        {student.leetcodeUsername}
                      </a>
                    ) : (
                      <span className="text-xs text-[var(--color-fg-subtle)]">No handle linked</span>
                    )}
                    {untrusted ? (
                      <Badge tone="danger" className="ml-2">
                        {SYNC_STATUS_LABELS[student.syncStatus]}
                      </Badge>
                    ) : null}
                  </Td>
                  {isComplete ? (
                    <Td className="tabular-nums">{student.completionTime ?? '—'}</Td>
                  ) : null}
                  <Td>
                    <StreakFlame streak={student.currentStreak} />
                  </Td>
                  <Td className="text-right tabular-nums font-medium">{student.score}</Td>
                  {isComplete ? (
                    <Td className="text-right tabular-nums">{student.rank ?? '—'}</Td>
                  ) : null}
                  {!isComplete ? (
                    <Td className="max-w-xs">
                      {isZero ? (
                        <span
                          className={
                            untrusted
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-fg-muted)]'
                          }
                        >
                          {student.reason ?? 'Reason unknown'}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {student.missingProblems.map((title) => (
                            <Badge key={title} tone="neutral">
                              {title}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </Card>
  );
}
