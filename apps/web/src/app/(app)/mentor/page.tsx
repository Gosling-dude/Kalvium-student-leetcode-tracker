'use client';

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  SYNC_STATUS_LABELS,
  isTrustworthySync,
  type MentorBatchSection,
  type MentorBucket,
  type MentorBucketRow,
} from '@dsa/shared';

import { api, downloadFile } from '@/lib/api';
import { todayKey } from '@/lib/utils';
import { ScopeChips, ScopeFilter, useScopeFilter } from '@/components/scope-filter';
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
  const { campus, batch } = useScopeFilter();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mentor', dayKey, campus, batch],
    queryFn: () => api.mentorDashboard(dayKey, undefined, campus ?? undefined, batch ?? undefined),
  });

  const onExport = async (): Promise<void> => {
    setExporting(true);
    try {
      // The export follows the filter: what you are looking at is what you download.
      const scope =
        (campus ? `&campus=${encodeURIComponent(campus)}` : '') +
        (batch ? `&batch=${encodeURIComponent(batch)}` : '');
      const suffix = [campus, batch].filter(Boolean).join('-');
      await downloadFile(
        `/reports/export/daily?dayKey=${dayKey}&format=XLSX${scope}`,
        `daily-report-${dayKey}${suffix ? `-${suffix}` : ''}.xlsx`,
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
          <ScopeFilter />
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

/**
 * One `Campus → Batch` heading plus its "solved N" tables.
 *
 * The heading names both halves. Two sections labelled "Foundation Level" on one screen —
 * one Vels, one SRM — would be indistinguishable, and a mentor acting on the wrong one is
 * a real cost, not a cosmetic one (§11).
 */
function BatchSectionTables({ section }: { section: MentorBatchSection }) {
  const heading = [section.campusName, section.batchName ?? 'No batch']
    .filter(Boolean)
    .join(' — ');
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2">
        <ScopeChips
          campusCode={section.campusCode}
          campusName={section.campusName}
          batchCode={section.batchCode}
          batchName={section.batchName}
        />
        <h2 className="text-base font-semibold">{heading}</h2>
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

/** "🟡 Attempted, Not Solved" / "🔴 Not Attempted" / "✅ Solved" — the mentor-facing labels. */
function problemStatusLabel(status: MentorBucketRow['problems'][number]['status']): string {
  switch (status) {
    case 'ACCEPTED':
      return '✅ Solved';
    case 'ATTEMPTED_NOT_ACCEPTED':
      return '🟡 Attempted, Not Solved';
    default:
      return '🔴 Not Attempted';
  }
}

function BucketTable({ bucket, assignedCount }: { bucket: MentorBucket; assignedCount: number }) {
  const isComplete = bucket.solvedCount === assignedCount;
  const isZero = bucket.solvedCount === 0;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (studentId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  // Did these students attempt and fail, or never open the problems at all? Only
  // meaningful outside the "completed everything" bucket, where the question does not
  // apply — nobody there has anything left to have attempted or not.
  const attemptBreakdown =
    !isComplete && bucket.students.length > 0
      ? [
          bucket.studentsAttemptedCount > 0 ? `${bucket.studentsAttemptedCount} attempted` : null,
          bucket.studentsNotAttemptedCount > 0
            ? `${bucket.studentsNotAttemptedCount} not attempted`
            : null,
        ]
          .filter(Boolean)
          .join(', ')
      : null;

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
            {attemptBreakdown ? (
              <span className="text-xs font-normal text-[var(--color-fg-muted)]">
                — {attemptBreakdown}
              </span>
            ) : null}
          </span>
        }
        description={
          isZero
            ? 'Every zero shows why — a data problem is not the same as a student who did not work.'
            : isComplete
              ? 'Ordered by completion time — earliest first.'
              : 'Click a student to see the per-problem breakdown — attempted and failed reads very differently from never opened.'
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
              {!isComplete ? <Th>{isZero ? 'Reason' : 'Solved / Attempted / Not attempted'}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {bucket.students.map((student) => {
              const untrusted = !isTrustworthySync(student.syncStatus);
              const isExpanded = expanded.has(student.studentId);
              return (
                <Fragment key={student.studentId}>
                  <tr className="transition hover:bg-[var(--color-surface-sunken)]">
                    <Td>
                      <button
                        type="button"
                        onClick={() => toggle(student.studentId)}
                        className="flex min-w-0 items-start gap-1.5 text-left"
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} per-problem breakdown for ${student.name}`}
                      >
                        {isExpanded ? (
                          <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]" aria-hidden />
                        ) : (
                          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]" aria-hidden />
                        )}
                        <span className="min-w-0">
                          <p className="truncate font-medium">{student.name}</p>
                          <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                            {student.email}
                          </p>
                        </span>
                      </button>
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
                        ) : null}
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-xs font-medium tabular-nums text-[var(--color-fg-muted)]">
                            {student.solvedCount}/{student.assignedCount}
                          </span>
                          {student.attemptedNotSolvedCount > 0 ? (
                            <Badge tone="warning">{student.attemptedNotSolvedCount} attempted</Badge>
                          ) : null}
                          {student.notAttemptedCount > 0 ? (
                            <Badge tone="danger">{student.notAttemptedCount} not attempted</Badge>
                          ) : null}
                        </div>
                      </Td>
                    ) : null}
                  </tr>
                  {isExpanded ? (
                    <tr className="bg-[var(--color-surface-sunken)]">
                      <td colSpan={isComplete ? 7 : 6} className="px-4 py-3">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                              <th className="pb-1.5 text-left font-medium">Problem</th>
                              <th className="pb-1.5 text-left font-medium">Status</th>
                              <th className="pb-1.5 text-right font-medium">Attempts</th>
                            </tr>
                          </thead>
                          <tbody>
                            {student.problems.map((problem) => (
                              <tr key={problem.problemId} className="border-t border-[var(--color-border)]">
                                <td className="py-1.5 pr-3">{problem.title}</td>
                                <td className="py-1.5 pr-3">{problemStatusLabel(problem.status)}</td>
                                <td className="py-1.5 text-right tabular-nums text-[var(--color-fg-muted)]">
                                  {problem.attempts}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </Card>
  );
}
