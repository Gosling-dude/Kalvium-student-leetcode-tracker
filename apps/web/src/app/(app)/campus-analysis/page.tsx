'use client';

/**
 * Campus analysis.
 *
 * Three levels, each opening the one below it and all three reading the same endpoint
 * family: campus -> category -> student, and under a student, day by day and question by
 * question with the date the accepted submission is dated.
 *
 * Deliberately plain. This is the screen that replaces a spreadsheet a head of programme
 * reads on a Monday, and the useful properties of that spreadsheet are density and the
 * ability to check a number rather than admire it. No charts, no colour coding of
 * performance — a row is a row, and the two states that are not performance verdicts
 * (Not Observed, Data Unavailable) are separated out under their own heading so nobody
 * reads them as a score.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronRight, ExternalLink, Pencil } from 'lucide-react';
import type { CampusCategory } from '@dsa/shared';

import { api } from '@/lib/api';
import { formatPercent } from '@/lib/utils';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Skeleton,
  TableShell,
  Td,
  Th,
} from '@/components/ui';
import { EditStudentDialog, type EditableStudent } from '@/components/edit-student-dialog';

/** Categories that describe performance, against those that describe our own coverage. */
const PERFORMANCE: CampusCategory[] = [
  'CONSISTENT_SOLVER',
  'INCONSISTENT',
  'IMPROVING',
  'DECLINING',
  'NOT_PARTICIPATING',
];

/**
 * The API returns a share (0 to 1); `formatPercent` takes a number already scaled to 100.
 * Null is an em dash, never "0%": no questions assigned is not zero per cent solved.
 */
const percent = (value: number | null): string =>
  value === null ? '—' : formatPercent(value * 100);

export default function CampusAnalysisPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [campusFilter, setCampusFilter] = useState('ALL');
  const [batchFilter, setBatchFilter] = useState('ALL');
  const [squadFilter, setSquadFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ campusId: string; category: CampusCategory } | null>(null);
  const [openWeek, setOpenWeek] = useState<{ campusId: string; weekNumber: number } | null>(null);
  const [student, setStudent] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditableStudent | null>(null);

  const range = { from: from || undefined, to: to || undefined };

  // Coding-Hours-active campuses only (`hasCodingHoursActivity`) — the same picker
  // every other Coding-Hours screen already uses, so it can never offer a campus this
  // page itself would then refuse (see `CampusAnalysisService.scopeFor`).
  const campusOptions = useQuery({ queryKey: ['campuses', 'coding-hours-activity'], queryFn: () => api.campuses(true) });
  const studentFilters = useQuery({ queryKey: ['students', 'filters'], queryFn: api.studentFilters });

  const batchOptions = useMemo(
    () => (studentFilters.data?.batches ?? []).filter((b) => campusFilter === 'ALL' || b.campusId === campusFilter),
    [studentFilters.data, campusFilter],
  );
  const squadOptions = useMemo(
    () => (studentFilters.data?.squads ?? []).filter((s) => campusFilter === 'ALL' || s.campusId === campusFilter),
    [studentFilters.data, campusFilter],
  );

  const summary = useQuery({
    queryKey: ['campus-analysis', from, to, campusFilter],
    queryFn: () => api.campusAnalysis({ ...range, campusId: campusFilter === 'ALL' ? undefined : campusFilter }),
  });

  if (summary.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (summary.error) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;

  const period = summary.data?.period;
  const campuses = summary.data?.campuses ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Campus analysis</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {period ? `${period.from} to ${period.to}` : null} · A question counts as solved if the
            student has ever solved it, whenever that was.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-[var(--color-fg-muted)]">
            Campus
            <select
              value={campusFilter}
              onChange={(e) => setCampusFilter(e.target.value)}
              className="mt-1 block rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
            >
              <option value="ALL">All</option>
              {(campusOptions.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-fg-muted)]">
            Batch
            <select
              value={batchFilter}
              onChange={(e) => setBatchFilter(e.target.value)}
              className="mt-1 block rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
            >
              <option value="ALL">All</option>
              {batchOptions.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-fg-muted)]">
            Squad
            <select
              value={squadFilter}
              onChange={(e) => setSquadFilter(e.target.value)}
              className="mt-1 block rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
            >
              <option value="ALL">All</option>
              {squadOptions.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--color-fg-muted)]">
            Student search
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or email"
              className="mt-1 block rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-[var(--color-fg-muted)]">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-[var(--color-fg-muted)]">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm"
            />
          </label>
          {(from || to || search || campusFilter !== 'ALL' || batchFilter !== 'ALL' || squadFilter !== 'ALL') && (
            <Button
              variant="ghost"
              onClick={() => {
                setFrom('');
                setTo('');
                setSearch('');
                setCampusFilter('ALL');
                setBatchFilter('ALL');
                setSquadFilter('ALL');
              }}
            >
              Reset
            </Button>
          )}
          <Link
            href="/campus-analysis/daily-report"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-surface-sunken)]"
          >
            Daily Report
          </Link>
          <Link
            href="/campus-analysis/attempts"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-surface-sunken)]"
          >
            Attempts Analysis
          </Link>
        </div>
      </div>

      {campuses.length === 0 ? (
        <EmptyState title="No campus to show" description="This account has no campus granted." />
      ) : null}

      {campuses.map((campus) => (
        <Card key={campus.campusId}>
          <CardHeader
            title={campus.campusName}
            description={
              `${campus.activeStudents} active students` +
              (campus.studentsWithUsableData < campus.activeStudents
                ? ` · ${campus.activeStudents - campus.studentsWithUsableData} without readable data`
                : '')
            }
          />

          {/*
            Questions, not student-question pairs. These are distinct LeetCode problems
            over the whole period, so a problem set in two weeks counts once here and once
            in each of those weeks — the weekly column does not add up to this, correctly.
          */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-b border-[var(--color-border)] px-5 py-4 sm:grid-cols-4">
            <Figure label="Questions assigned" value={campus.assigned} />
            <Figure label="Questions solved" value={campus.solved} />
            <Figure label="Solve rate" value={percent(campus.solvePercent)} />
            <Figure
              label="Avg student completion"
              value={percent(campus.studentCompletionPercent)}
              hint="Share of set work the average student completed"
            />
          </div>

          <div className="px-5 py-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              By week
            </h3>
            <TableShell>
              <thead>
                <tr>
                  <Th>Week</Th>
                  <Th className="text-right">Questions assigned</Th>
                  <Th className="text-right">Solved</Th>
                  <Th className="text-right">Attempted, not solved</Th>
                  <Th className="text-right">Not attempted</Th>
                  <Th className="text-right">Solve %</Th>
                  <Th className="text-right">Attempt %</Th>
                  <Th className="text-right">Not attempted %</Th>
                  <Th className="text-right">Avg student completion</Th>
                  <Th className="text-right">Students active</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {campus.weeks.map((week) => (
                  <tr key={week.weekNumber}>
                    <Td className="whitespace-nowrap">
                      <span className="font-medium">Week {week.weekNumber}</span>
                      <span className="ml-2 text-xs text-[var(--color-fg-muted)]">
                        {week.from} – {week.to}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{week.assigned}</Td>
                    <Td className="text-right tabular-nums">{week.solved}</Td>
                    <Td className="text-right tabular-nums">{week.attemptedNotSolved}</Td>
                    <Td className="text-right tabular-nums">{week.notAttempted}</Td>
                    <Td className="text-right tabular-nums">{percent(week.solvePercent)}</Td>
                    <Td className="text-right tabular-nums">{percent(week.attemptPercent)}</Td>
                    <Td className="text-right tabular-nums">{percent(week.notAttemptedPercent)}</Td>
                    <Td className="text-right tabular-nums">{percent(week.studentCompletionPercent)}</Td>
                    <Td className="text-right tabular-nums">
                      {week.studentsActive} / {week.studentsObserved}
                    </Td>
                    <Td className="w-px">
                      <Button
                        variant="ghost"
                        disabled={week.assigned === 0}
                        onClick={() =>
                          setOpenWeek(
                            openWeek?.campusId === campus.campusId && openWeek.weekNumber === week.weekNumber
                              ? null
                              : { campusId: campus.campusId, weekNumber: week.weekNumber },
                          )
                        }
                      >
                        {openWeek?.campusId === campus.campusId && openWeek.weekNumber === week.weekNumber
                          ? 'Hide'
                          : 'Questions'}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>

            {openWeek?.campusId === campus.campusId ? (
              <QuestionDetail campusId={campus.campusId} weekNumber={openWeek.weekNumber} range={range} />
            ) : null}
          </div>

          <div className="border-t border-[var(--color-border)] px-5 py-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              By category
            </h3>
            <TableShell>
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th>How it is decided</Th>
                  <Th className="text-right">Students</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {campus.categories
                  .filter((c) => PERFORMANCE.includes(c.category))
                  .map((card) => (
                    <CategoryRow
                      key={card.category}
                      card={card}
                      campusId={campus.campusId}
                      open={open}
                      setOpen={setOpen}
                    />
                  ))}
              </tbody>
            </TableShell>

            {/*
              Held apart from the verdicts above, and labelled as coverage rather than
              performance. Folding these into "Not Participating" is the exact mistake
              this screen exists to stop being made.
            */}
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              Not a verdict — what we could not measure
            </h3>
            <TableShell>
              <thead>
                <tr>
                  <Th>State</Th>
                  <Th>What it means</Th>
                  <Th className="text-right">Students</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {campus.categories
                  .filter((c) => !PERFORMANCE.includes(c.category))
                  .map((card) => (
                    <CategoryRow
                      key={card.category}
                      card={card}
                      campusId={campus.campusId}
                      open={open}
                      setOpen={setOpen}
                      useMeaning
                    />
                  ))}
              </tbody>
            </TableShell>
          </div>

          {open?.campusId === campus.campusId ? (
            <CategoryDetail
              campusId={campus.campusId}
              category={open.category}
              range={range}
              onPickStudent={setStudent}
              onEditStudent={setEditing}
              search={search}
              batchFilter={batchFilter}
              squadFilter={squadFilter}
            />
          ) : null}
        </Card>
      ))}

      {student ? (
        <StudentDetail studentId={student} range={range} onClose={() => setStudent(null)} />
      ) : null}

      <EditStudentDialog student={editing} open={editing !== null} onClose={() => setEditing(null)} />
    </div>
  );
}

/** A single figure with its label. Used for the four numbers in the campus header. */
function Figure({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{hint}</div> : null}
    </div>
  );
}

/**
 * The questions behind one week's row.
 *
 * Where the student numbers live. The week says "20 questions, 20 solved"; this says how
 * many of the students each question was set for actually solved it, which is the
 * difference between a campus that handled the week and one where a different single
 * student cleared each question.
 */
function QuestionDetail({
  campusId,
  weekNumber,
  range,
}: {
  campusId: string;
  weekNumber: number;
  range: { from?: string; to?: string };
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['campus-analysis-questions', campusId, weekNumber, range.from, range.to],
    queryFn: () => api.campusAnalysisQuestions(campusId, { ...range, weekNumber }),
  });

  if (isLoading) return <Skeleton className="mt-4 h-40 w-full" />;
  if (error) return <div className="mt-4"><ErrorState error={error} onRetry={() => void refetch()} /></div>;
  if (!data) return null;

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
        Week {weekNumber} — every question set
      </h4>
      <TableShell>
        <thead>
          <tr>
            <Th>Question</Th>
            <Th>Set on</Th>
            <Th>Outcome</Th>
            <Th className="text-right">Students set</Th>
            <Th className="text-right">Solved</Th>
            <Th className="text-right">Attempted, not solved</Th>
            <Th className="text-right">Not attempted</Th>
          </tr>
        </thead>
        <tbody>
          {data.questions.map((q) => (
            <tr key={q.slug}>
              <Td>
                <a
                  href={`https://leetcode.com/problems/${q.slug}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {q.title}
                </a>
              </Td>
              <Td className="whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                {q.dayKeys.join(', ')}
              </Td>
              <Td className="whitespace-nowrap text-xs">
                {q.outcome === 'SOLVED'
                  ? 'Solved'
                  : q.outcome === 'ATTEMPTED_NOT_SOLVED'
                    ? 'Attempted, not solved'
                    : 'Not attempted'}
              </Td>
              <Td className="text-right tabular-nums">{q.studentsAssigned}</Td>
              <Td className="text-right tabular-nums">{q.studentsSolved}</Td>
              <Td className="text-right tabular-nums">{q.studentsAttemptedNotSolved}</Td>
              <Td className="text-right tabular-nums">{q.studentsNotAttempted}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}

function CategoryRow({
  card,
  campusId,
  open,
  setOpen,
  useMeaning = false,
}: {
  card: {
    category: CampusCategory;
    label: string;
    meaning: string;
    rule: string;
    students: number;
  };
  campusId: string;
  open: { campusId: string; category: CampusCategory } | null;
  setOpen: (v: { campusId: string; category: CampusCategory } | null) => void;
  useMeaning?: boolean;
}) {
  const isOpen = open?.campusId === campusId && open.category === card.category;
  return (
    <tr>
      <Td className="whitespace-nowrap font-medium">{card.label}</Td>
      <Td className="text-xs text-[var(--color-fg-muted)]">{useMeaning ? card.meaning : card.rule}</Td>
      <Td className="text-right tabular-nums">{card.students}</Td>
      <Td className="w-px">
        <Button
          variant="ghost"
          // A category with nobody in it is still worth stating and not worth opening.
          disabled={card.students === 0}
          onClick={() => setOpen(isOpen ? null : { campusId, category: card.category })}
        >
          {isOpen ? 'Hide' : 'Open'}
          <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </Td>
    </tr>
  );
}

function CategoryDetail({
  campusId,
  category,
  range,
  onPickStudent,
  onEditStudent,
  search,
  batchFilter,
  squadFilter,
}: {
  campusId: string;
  category: CampusCategory;
  range: { from?: string; to?: string };
  onPickStudent: (id: string) => void;
  onEditStudent: (student: EditableStudent) => void;
  search: string;
  batchFilter: string;
  squadFilter: string;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['campus-analysis-category', campusId, category, range.from, range.to],
    queryFn: () => api.campusAnalysisCategory(campusId, category, range),
  });

  if (isLoading) return <div className="px-5 py-4"><Skeleton className="h-40 w-full" /></div>;
  if (error) return <div className="px-5 py-4"><ErrorState error={error} onRetry={() => void refetch()} /></div>;
  if (!data) return null;

  // Batch/squad/search narrow this drill-down's rows only — the query above still fetches
  // the whole category, so a summary card's count and this list agree with each other
  // (the invariant the file banner describes), even while fewer rows are shown.
  const needle = search.trim().toLowerCase();
  const students = data.students.filter((s) => {
    if (needle && !s.name.toLowerCase().includes(needle)) return false;
    if (batchFilter !== 'ALL' && s.batch !== batchFilter) return false;
    if (squadFilter !== 'ALL' && s.squad !== squadFilter) return false;
    return true;
  });

  const weekCount = data.students[0]?.weeks.length ?? 0;

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-5 py-4">
      <h3 className="text-sm font-semibold">{data.label}</h3>
      <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
        {data.rule} · showing {students.length} of {data.students.length}
      </p>

      <TableShell>
        <thead>
          <tr>
            <Th>Student</Th>
            <Th>Batch</Th>
            <Th>Squad</Th>
            {Array.from({ length: weekCount }, (_, i) => (
              <Th key={i} className="text-right">
                W{i + 1}
              </Th>
            ))}
            <Th className="text-right">Solved</Th>
            <Th className="text-right">Attempted</Th>
            <Th className="text-right">Not attempted</Th>
            <Th>Why</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.studentId}>
              <Td className="whitespace-nowrap">
                <span className="font-medium">{s.name}</span>
                {s.leetcodeUrl ? (
                  <a
                    href={s.leetcodeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 inline-flex items-center text-xs text-[var(--color-fg-muted)] hover:underline"
                  >
                    {s.leetcodeUsername}
                    <ExternalLink className="ml-1 h-3 w-3" />
                  </a>
                ) : (
                  <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">Profile not linked</span>
                )}
              </Td>
              <Td className="text-xs text-[var(--color-fg-muted)]">{s.batch ?? '—'}</Td>
              <Td className="text-xs text-[var(--color-fg-muted)]">{s.squad ?? '—'}</Td>
              {s.weeks.map((w) => (
                <Td key={w.weekNumber} className="text-right tabular-nums">
                  {/* An unobserved week is a dash, never a zero. */}
                  {w.observed ? `${w.solved}/${w.assigned}` : '—'}
                </Td>
              ))}
              <Td className="text-right tabular-nums">{s.solved}</Td>
              <Td className="text-right tabular-nums">{s.attemptedNotSolved}</Td>
              <Td className="text-right tabular-nums">{s.notAttempted}</Td>
              {/*
                A fixed minimum rather than a maximum: squeezed between eight week columns
                this wrapped to one word a line, which is the column a mentor reads to
                decide whether they agree with the verdict. The shell scrolls sideways.
              */}
              <Td className="min-w-[18rem] text-xs text-[var(--color-fg-muted)]">
                {s.dataAvailable ? s.verdict.because : s.dataIssue}
              </Td>
              <Td className="w-px whitespace-nowrap">
                <Button variant="ghost" onClick={() => onPickStudent(s.studentId)}>
                  Detail
                </Button>
                <button
                  type="button"
                  aria-label={`Edit ${s.name}`}
                  onClick={() => onEditStudent({ studentId: s.studentId, name: s.name })}
                  className="ml-1 rounded-md p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]"
                >
                  <Pencil className="size-3.5" aria-hidden />
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}

function StudentDetail({
  studentId,
  range,
  onClose,
}: {
  studentId: string;
  range: { from?: string; to?: string };
  onClose: () => void;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['campus-analysis-student', studentId, range.from, range.to],
    queryFn: () => api.campusAnalysisStudent(studentId, range),
  });

  return (
    <Card>
      <CardHeader
        title={data ? data.student.name : 'Student'}
        description={
          data
            ? `${data.student.campusCode ?? '—'} · squad ${data.student.squad ?? '—'} · ` +
              `${data.student.solved} of ${data.student.assigned} assigned solved · ` +
              `${data.student.totalSolvedAllTime} solved on LeetCode all time`
            : undefined
        }
        action={
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      />
      <div className="px-5 py-4">
        {isLoading ? <Skeleton className="h-48 w-full" /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {data ? (
          <TableShell>
            <thead>
              <tr>
                <Th>Assignment date</Th>
                <Th>Question</Th>
                <Th>Status</Th>
                <Th>Accepted on</Th>
                <Th className="text-right">Attempts</Th>
              </tr>
            </thead>
            <tbody>
              {data.days.flatMap((day) =>
                day.problems.map((p) => (
                  <tr key={`${day.dayKey}-${p.titleSlug}`}>
                    <Td className="whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                      {day.dayKey}
                    </Td>
                    <Td>
                      <a
                        href={`https://leetcode.com/problems/${p.titleSlug}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {p.title}
                      </a>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{p.status.replace(/_/g, ' ').toLowerCase()}</Td>
                    <Td className="whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                      {p.solvedAt ? p.solvedAt.slice(0, 10) : '—'}
                      {/*
                        The case that used to be scored as a miss. Stated on the row so a
                        mentor can see which solves a corrected total came from.
                      */}
                      {p.solvedBeforeAssignmentDate ? (
                        <span className="ml-2">(solved before it was set)</span>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{p.attempts}</Td>
                  </tr>
                )),
              )}
            </tbody>
          </TableShell>
        ) : null}
      </div>
    </Card>
  );
}
