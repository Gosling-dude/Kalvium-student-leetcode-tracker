'use client';

/**
 * Campus Analysis — Attempts Analysis.
 *
 * Which students submitted an assigned Coding-Hours problem on its assignment day and
 * still have no accepted solution. Everything shown — the summary, the table, the
 * student drill-down and both Excel exports — is `api.campusAttempts*`, one server
 * computation over the mirrored submissions (see `campus-attempts.service.ts`). This page
 * only chooses filters and renders; it never counts anything itself.
 */

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import {
  ATTEMPT_OUTCOME_LABELS,
  ATTEMPT_VIEW_LABELS,
  ATTEMPT_VIEWS,
  DEFAULT_ATTEMPT_VIEW,
  MIN_ATTEMPT_OPTIONS,
  type AttemptRow,
  type AttemptView,
} from '@dsa/shared';

import { api, downloadFile, type CampusAttemptsParams } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  Modal,
  Skeleton,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(dayKey: string): string {
  const [, month, day] = dayKey.split('-');
  return `${day} ${MONTHS[Number(month) - 1]}`;
}

/** "20 Sep 10:12", in program time — the same shape the Excel export writes. */
function formatAttempt(iso: string | null): string {
  if (!iso) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

function formatSeconds(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

const STATUS_LABELS: Record<string, string> = {
  ACCEPTED: 'Accepted',
  ATTEMPTED_NOT_ACCEPTED: 'Not accepted',
  UNKNOWN: 'No verdict reported',
};

function ProfileLink({ username, url }: { username: string | null; url: string | null }) {
  if (!url) return <span className="text-xs font-normal text-[var(--color-fg-subtle)]">Profile not linked</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="text-xs font-normal text-[var(--color-brand)] hover:underline">
      {username}
    </a>
  );
}

function OutcomeBadge({ row }: { row: Pick<AttemptRow, 'outcome'> }) {
  const tone = row.outcome === 'SOLVED_AFTER_ATTEMPTS' ? 'success' : row.outcome === 'ATTEMPTED_NOT_SOLVED' ? 'danger' : 'neutral';
  return <Badge tone={tone}>{ATTEMPT_OUTCOME_LABELS[row.outcome]}</Badge>;
}

function StudentDrillDown({
  studentId,
  from,
  to,
  onClose,
}: {
  studentId: string;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['campus-attempts-student', studentId, from, to],
    queryFn: () => api.campusAttemptsStudent(studentId, { from: from || null, to: to || null }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={detail.data ? `Student: ${detail.data.student.name}` : 'Student'}
      description={
        detail.data ? (
          <span>
            {[detail.data.student.campusCode, detail.data.student.batch, detail.data.student.squad].filter(Boolean).join(' · ')}
            {' · '}
            <ProfileLink username={detail.data.student.leetcodeUsername} url={detail.data.student.leetcodeUrl} />
          </span>
        ) : undefined
      }
    >
      {detail.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !detail.data || detail.data.rows.length === 0 ? (
        <EmptyState title="No attempts" description="This student made no submission to an assigned problem on its assignment day in this period." />
      ) : (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs text-[var(--color-fg-muted)]">Click a problem to see the submissions behind it.</p>
          <TableShell>
            <thead>
              <tr>
                <Th>Problem</Th>
                <Th>Assignment Date</Th>
                <Th className="text-right">Attempts</Th>
                <Th>Solved</Th>
                <Th className="text-right">Failed</Th>
              </tr>
            </thead>
            <tbody>
              {detail.data.rows.map((row) => {
                const key = `${row.dayKey}|${row.titleSlug}`;
                const open = expanded === key;
                return (
                  <Fragment key={key}>
                    <tr
                      className="cursor-pointer hover:bg-[var(--color-surface-sunken)]"
                      onClick={() => setExpanded(open ? null : key)}
                      aria-expanded={open}
                    >
                      <Td className="font-medium">{row.title}</Td>
                      <Td>{formatDay(row.dayKey)}</Td>
                      <Td className="text-right tabular-nums">{row.attempts}</Td>
                      <Td>{row.solved ? 'Yes' : 'No'}</Td>
                      <Td className="text-right tabular-nums">{row.failedAttempts}</Td>
                    </tr>
                    {open ? (
                      <tr>
                        <td colSpan={5} className="bg-[var(--color-surface-sunken)] px-4 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-[var(--color-fg-muted)]">
                                <th className="py-1 pr-4 font-medium">#</th>
                                <th className="py-1 pr-4 font-medium">Submission time</th>
                                <th className="py-1 pr-4 font-medium">Result</th>
                                <th className="py-1 pr-4 font-medium">Language</th>
                                <th className="py-1 font-medium">Submission ID</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.submissions.map((s, i) => (
                                <tr key={s.providerSubmissionId}>
                                  <td className="py-1 pr-4 tabular-nums">{i + 1}</td>
                                  <td className="py-1 pr-4 tabular-nums">{formatSeconds(s.submittedAt)}</td>
                                  <td className="py-1 pr-4">{STATUS_LABELS[s.status] ?? s.status}</td>
                                  <td className="py-1 pr-4">{s.language ?? '—'}</td>
                                  <td className="py-1 tabular-nums">{s.providerSubmissionId}</td>
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
        </div>
      )}
    </Modal>
  );
}

export default function CampusAttemptsPage() {
  const [campus, setCampus] = useState('ALL');
  const [batch, setBatch] = useState('ALL');
  const [squad, setSquad] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [problem, setProblem] = useState('ALL');
  const [difficulty, setDifficulty] = useState('ALL');
  const [view, setView] = useState<AttemptView>(DEFAULT_ATTEMPT_VIEW);
  const [minAttempts, setMinAttempts] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'view' | 'unsolved' | null>(null);

  const campusOptions = useQuery({ queryKey: ['campuses', 'coding-hours-activity'], queryFn: () => api.campuses(true) });
  const studentFilters = useQuery({ queryKey: ['students', 'filters'], queryFn: api.studentFilters });

  const params: CampusAttemptsParams = {
    campus: campus === 'ALL' ? null : campus,
    batch: batch === 'ALL' ? null : batch,
    squad: squad === 'ALL' ? null : squad,
    from: from || null,
    to: to || null,
    problem: problem === 'ALL' ? null : problem,
    difficulty: difficulty === 'ALL' ? null : difficulty,
    view,
    minAttempts: view === 'NOT_ATTEMPTED' ? null : minAttempts,
    search: search || null,
  };

  const report = useQuery({
    queryKey: ['campus-attempts', params],
    queryFn: () => api.campusAttempts(params),
  });

  const batchOptions = (studentFilters.data?.batches ?? []).filter((b) => campus === 'ALL' || b.campusId === campus);
  const squadOptions = (studentFilters.data?.squads ?? []).filter((s) => campus === 'ALL' || s.campusId === campus);

  const handleExport = async (mode: 'view' | 'unsolved'): Promise<void> => {
    setExporting(mode);
    try {
      await downloadFile(
        api.campusAttemptsExportPath(params, mode),
        mode === 'unsolved' ? 'unsolved-attempts.xlsx' : 'attempts-analysis.xlsx',
      );
    } catch (error) {
      toast.error('Export failed', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setExporting(null);
    }
  };

  const selectClass =
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-brand)]';
  const labelClass = 'text-xs font-medium text-[var(--color-fg-muted)]';
  const summary = report.data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-[var(--color-fg-muted)]">
            <Link href="/campus-analysis" className="hover:underline">
              Campus Analysis
            </Link>{' '}
            /
          </p>
          <h1 className="text-lg font-semibold tracking-tight">Attempts Analysis</h1>
          <p className="mt-1 max-w-2xl text-xs text-[var(--color-fg-muted)]">
            Submissions to each assigned Coding-Hours problem on its assignment day, from the mirrored LeetCode
            data. Failed attempts are the non-accepted submissions before the first accepted one.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void handleExport('view')} loading={exporting === 'view'}>
            <Download className="size-3.5" aria-hidden />
            Export to Excel
          </Button>
          <Button onClick={() => void handleExport('unsolved')} loading={exporting === 'unsolved'}>
            <Download className="size-3.5" aria-hidden />
            Export Unsolved Attempts
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Students attempted but not solved" value={summary?.studentsAttemptedNotSolved ?? '—'} />
        <StatTile label="Assigned problems attempted" value={summary?.assignedProblemsAttempted ?? '—'} hint="Student × problem" />
        <StatTile label="Total failed attempts" value={summary?.totalFailedAttempts ?? '—'} />
        <StatTile label="Students with 3+ attempts, no AC" value={summary?.studentsWith3PlusNoAc ?? '—'} />
        <StatTile label="Students with 5+ attempts, no AC" value={summary?.studentsWith5PlusNoAc ?? '—'} />
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <label htmlFor="att-view" className={labelClass}>
              Outcome
            </label>
            <select id="att-view" className={selectClass} value={view} onChange={(e) => setView(e.target.value as AttemptView)}>
              {ATTEMPT_VIEWS.map((v) => (
                <option key={v} value={v}>
                  {ATTEMPT_VIEW_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="att-min" className={labelClass}>
              Minimum Attempts
            </label>
            <select
              id="att-min"
              className={selectClass}
              value={minAttempts}
              disabled={view === 'NOT_ATTEMPTED'}
              onChange={(e) => setMinAttempts(Number(e.target.value))}
            >
              {MIN_ATTEMPT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}+
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="att-campus" className={labelClass}>
              Campus
            </label>
            <select
              id="att-campus"
              className={selectClass}
              value={campus}
              onChange={(e) => {
                setCampus(e.target.value);
                setBatch('ALL');
                setSquad('ALL');
                setProblem('ALL');
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
            <label htmlFor="att-batch" className={labelClass}>
              Batch
            </label>
            <select id="att-batch" className={selectClass} value={batch} onChange={(e) => setBatch(e.target.value)}>
              <option value="ALL">All</option>
              {batchOptions.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="att-squad" className={labelClass}>
              Squad
            </label>
            <select id="att-squad" className={selectClass} value={squad} onChange={(e) => setSquad(e.target.value)}>
              <option value="ALL">All</option>
              {squadOptions.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="att-from" className={labelClass}>
              Assignment date from
            </label>
            <input id="att-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={selectClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor="att-to" className={labelClass}>
              to
            </label>
            <input id="att-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={selectClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor="att-problem" className={labelClass}>
              Problem
            </label>
            <select id="att-problem" className={`${selectClass} max-w-56`} value={problem} onChange={(e) => setProblem(e.target.value)}>
              <option value="ALL">All</option>
              {(report.data?.problems ?? []).map((p) => (
                <option key={p.titleSlug} value={p.titleSlug}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="att-difficulty" className={labelClass}>
              Difficulty
            </label>
            <select id="att-difficulty" className={selectClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option value="ALL">All</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="att-search" className={labelClass}>
              Student search
            </label>
            <input
              id="att-search"
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
      ) : !report.data || report.data.rows.length === 0 ? (
        <EmptyState title="No rows" description="Nothing matches these filters." />
      ) : (
        <Card>
          <CardHeader
            title={`${report.data.rows.length} rows · ${ATTEMPT_VIEW_LABELS[view]}`}
            description="Sorted by failed attempts, then attempts, then student name. Click a student for their problems."
          />
          <div className="overflow-x-auto">
            <TableShell>
              <thead>
                <tr>
                  <Th>Student</Th>
                  <Th>Campus</Th>
                  <Th>Batch</Th>
                  <Th>Squad</Th>
                  <Th>Problem</Th>
                  <Th>Difficulty</Th>
                  <Th>Assignment Date</Th>
                  <Th className="text-right">Attempts</Th>
                  <Th>Solved</Th>
                  <Th className="text-right">Failed Attempts</Th>
                  <Th>First Attempt</Th>
                  <Th>Last Attempt</Th>
                </tr>
              </thead>
              <tbody>
                {report.data.rows.map((row) => (
                  <tr key={`${row.studentId}|${row.dayKey}|${row.titleSlug}`} className="hover:bg-[var(--color-surface-sunken)]">
                    <Td className="font-medium">
                      <button
                        type="button"
                        className="text-left hover:text-[var(--color-brand)] hover:underline"
                        onClick={() => setSelectedStudent(row.studentId)}
                      >
                        {row.name}
                      </button>
                      <div>
                        <ProfileLink username={row.leetcodeUsername} url={row.leetcodeUrl} />
                      </div>
                    </Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.campusCode ?? '—'}</Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.batch ?? '—'}</Td>
                    <Td className="text-[var(--color-fg-subtle)]">{row.squad ?? '—'}</Td>
                    <Td>
                      <a
                        href={`https://leetcode.com/problems/${row.titleSlug}/`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:underline"
                      >
                        {row.title}
                      </a>
                    </Td>
                    <Td>{row.difficulty ? <DifficultyBadge difficulty={row.difficulty} /> : '—'}</Td>
                    <Td className="whitespace-nowrap">{formatDay(row.dayKey)}</Td>
                    <Td className="text-right tabular-nums">{row.attempts}</Td>
                    <Td>{row.attempts === 0 ? <OutcomeBadge row={row} /> : row.solved ? 'Yes' : 'No'}</Td>
                    <Td className="text-right font-semibold tabular-nums">{row.failedAttempts}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatAttempt(row.firstAttemptAt)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatAttempt(row.lastAttemptAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </div>
        </Card>
      )}

      {selectedStudent ? (
        <StudentDrillDown studentId={selectedStudent} from={from} to={to} onClose={() => setSelectedStudent(null)} />
      ) : null}
    </div>
  );
}
