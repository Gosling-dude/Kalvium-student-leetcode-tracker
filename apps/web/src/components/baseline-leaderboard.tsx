'use client';

/**
 * The student-wise baseline leaderboard.
 *
 * Kept separate from the daily assignment leaderboard on purpose. A baseline measures what
 * a student could do on one day; the daily board measures whether they are keeping up.
 * Merging them would let a strong baseline paper over a fortnight of missed assignments,
 * which is precisely the signal a mentor is looking for.
 *
 * `rank` comes from the server and is computed across the whole eligible cohort *before*
 * any filter is applied, so searching or narrowing to one squad never renumbers anyone —
 * rank means "how many students did better", not "which row is this".
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Download, Search, X } from 'lucide-react';
import type { BaselineLeaderboardRow } from '@dsa/shared';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Modal,
  StatTile,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from './ui';

type SortKey = 'rank' | 'name' | 'squad' | 'solved' | 'percent';

const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  EXPIRED: 'Expired',
  NOT_STARTED: 'Absent',
};

/** Green at the top, amber in the middle, red at the bottom — the usual reading order. */
function toneFor(percent: number, attempted: boolean): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!attempted) return 'neutral';
  if (percent >= 75) return 'success';
  if (percent >= 40) return 'warning';
  return 'danger';
}

export function BaselineLeaderboard({ testId }: { testId: string }) {
  const [search, setSearch] = useState('');
  const [squad, setSquad] = useState('');
  const [status, setStatus] = useState('ALL');
  const [sort, setSort] = useState<SortKey>('rank');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<BaselineLeaderboardRow | null>(null);

  const board = useQuery({
    queryKey: ['baseline-leaderboard', testId, search, squad, status, sort, direction],
    queryFn: () => api.baselineLeaderboard(testId, { search, squad, status, sort, direction }),
  });

  const onSort = (key: SortKey): void => {
    if (sort === key) {
      setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(key);
    // Best-first for the numeric columns, A–Z for the text ones — what a reader expects
    // from a single click.
    setDirection(key === 'name' || key === 'squad' || key === 'rank' ? 'asc' : 'desc');
  };

  const sortable = (key: SortKey, label: string, align?: 'right') => (
    <Th className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onSort(key)}
        className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
        aria-sort={sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {sort === key ? <span aria-hidden>{direction === 'asc' ? '↑' : '↓'}</span> : null}
      </button>
    </Th>
  );

  // Squad options come from the board itself rather than a separate roster call: the only
  // squads worth offering are the ones with a student on this test.
  const squads = [
    ...new Set((board.data?.rows ?? []).map((row) => row.squadName).filter(Boolean)),
  ].sort() as string[];

  return (
    <Card>
      <CardHeader
        title="Student leaderboard"
        description="Every eligible student, ranked. Absent students are listed too — a board built only from attempts hides how many people skipped the test."
        action={
          <a
            href={`${process.env.NEXT_PUBLIC_API_URL ?? ''}/reports/export/baseline?testId=${testId}&format=CSV`}
            target="_blank"
            rel="noreferrer"
          >
            <Button variant="ghost">
              <Download className="size-3.5" aria-hidden /> CSV
            </Button>
          </a>
        }
      />

      {board.data ? (
        <div className="grid gap-3 border-b border-[var(--color-border)] p-5 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Students" value={board.data.totalStudents} />
          <StatTile label="Sat the test" value={board.data.attemptedStudents} />
          <StatTile label="Absent" value={board.data.notStartedStudents} />
          <StatTile label="Average" value={`${board.data.averagePercent}%`} />
          <StatTile
            label="Highest / lowest"
            value={`${board.data.highestPercent}% / ${board.data.lowestPercent}%`}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] p-5">
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]"
            aria-hidden
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or squad"
            aria-label="Search students"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-3 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </div>

        <select
          value={squad}
          onChange={(e) => setSquad(e.target.value)}
          aria-label="Filter by squad"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
        >
          <option value="">All squads</option>
          {squads.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by participation"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
        >
          <option value="ALL">Everyone</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="EXPIRED">Expired</option>
          <option value="NOT_STARTED">Absent</option>
        </select>
      </div>

      {board.isLoading ? (
        <div className="p-5">
          <TableSkeleton rows={8} cols={7} />
        </div>
      ) : board.error ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      ) : (board.data?.rows.length ?? 0) === 0 ? (
        <EmptyState
          title="No students match"
          description="Try clearing the search or the squad filter."
        />
      ) : (
        <TableShell>
          <thead>
            <tr>
              {sortable('rank', 'Rank')}
              {sortable('name', 'Student')}
              {sortable('squad', 'Squad')}
              <Th className="text-right">Total</Th>
              {sortable('solved', 'Solved', 'right')}
              <Th className="text-right">Not solved</Th>
              {sortable('percent', 'Score', 'right')}
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {board.data!.rows.map((row) => (
              <tr
                key={row.studentId}
                onClick={() => setSelected(row)}
                className="cursor-pointer hover:bg-[var(--color-surface-sunken)]"
              >
                <Td className="tabular-nums">
                  {row.attempted ? (
                    <span className={cn(row.isTied && 'text-[var(--color-fg-muted)]')}>
                      {row.rank}
                      {row.isTied ? '=' : ''}
                    </span>
                  ) : (
                    <span className="text-[var(--color-fg-subtle)]">—</span>
                  )}
                </Td>
                <Td>
                  <p className="font-medium">{row.studentName}</p>
                  <p className="text-xs text-[var(--color-fg-subtle)]">{row.studentEmail}</p>
                </Td>
                <Td>{row.squadName ?? '—'}</Td>
                <Td className="text-right tabular-nums">{row.totalQuestions}</Td>
                <Td className="text-right tabular-nums">{row.solvedCount}</Td>
                <Td className="text-right tabular-nums">{row.notSolvedCount}</Td>
                <Td className="text-right tabular-nums font-medium">{row.percent}%</Td>
                <Td>
                  <Badge tone={toneFor(row.percent, row.attempted)}>
                    {STATUS_LABELS[row.status] ?? row.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}

      <StudentBreakdown
        testId={testId}
        row={selected}
        onClose={() => setSelected(null)}
      />
    </Card>
  );
}

/** Which questions this student got, and which they did not. */
function StudentBreakdown({
  testId,
  row,
  onClose,
}: {
  testId: string;
  row: BaselineLeaderboardRow | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['baseline-student-result', testId, row?.studentId],
    queryFn: () => api.baselineStudentResult(testId, row!.studentId),
    enabled: row !== null,
  });

  if (!row) return null;

  return (
    <Modal open onClose={onClose} title={row.studentName} description={row.studentEmail} size="lg">
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Baseline test" value={`${row.totalQuestions} questions`} />
          <StatTile label="Solved" value={row.solvedCount} />
          <StatTile label="Not solved" value={row.notSolvedCount} />
          <StatTile label="Score" value={`${row.percent}%`} />
        </div>

        {detail.isLoading ? (
          <TableSkeleton rows={4} cols={2} />
        ) : detail.error ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {(detail.data?.problems ?? []).map((problem) => {
              const solved = problem.status === 'ACCEPTED';
              return (
                <li key={problem.testProblemId} className="flex items-center gap-3 px-3 py-2">
                  {solved ? (
                    <Check className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                  ) : (
                    <X className="size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
                  )}
                  <span className="sr-only">{solved ? 'Solved' : 'Not solved'}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{problem.title}</span>
                  {/* "Attempted but never accepted" is a different conversation from
                      "never opened it", so the two do not collapse into one ✗. */}
                  {!solved && problem.attempts > 0 ? (
                    <Badge tone="warning">
                      {problem.attempts} attempt{problem.attempts === 1 ? '' : 's'}
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
