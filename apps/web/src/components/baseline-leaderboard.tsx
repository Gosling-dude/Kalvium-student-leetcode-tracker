"use client";

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

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Download, Search, X } from "lucide-react";
import { toast } from "sonner";
import type { BaselineLeaderboardRow } from "@dsa/shared";

import { api, downloadFile } from "@/lib/api";
import { cn } from "@/lib/utils";
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
} from "./ui";

type SortKey = "rank" | "name" | "squad" | "solved" | "percent";

/** Participation labels. Deliberately never say "0 solved" — that is a different column. */
const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: "In progress",
  SUBMITTED: "Completed",
  EXPIRED: "Expired",
  NOT_STARTED: "Absent",
};

/** Green at the top, amber in the middle, red at the bottom — the usual reading order. */
function scoreTone(
  percent: number,
  known: boolean,
): "success" | "warning" | "danger" | "neutral" {
  // An unmeasured student is grey, never red: we hold no reading for them, and colouring
  // an absence of data as a bad result is the same false zero in a different medium.
  if (!known) return "neutral";
  if (percent >= 75) return "success";
  if (percent >= 40) return "warning";
  return "danger";
}

/** Participation is a fact about attendance, so it never borrows the score's colours. */
function participationTone(status: string): "info" | "success" | "neutral" {
  if (status === "SUBMITTED") return "success";
  if (status === "IN_PROGRESS" || status === "EXPIRED") return "info";
  return "neutral";
}

export function BaselineLeaderboard({ testId }: { testId: string }) {
  const [search, setSearch] = useState("");
  const [squad, setSquad] = useState("");
  const [status, setStatus] = useState("ALL");
  const [sort, setSort] = useState<SortKey>("rank");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<BaselineLeaderboardRow | null>(null);

  const [exporting, setExporting] = useState(false);

  const board = useQuery({
    queryKey: [
      "baseline-leaderboard",
      testId,
      search,
      squad,
      status,
      sort,
      direction,
    ],
    queryFn: () =>
      api.baselineLeaderboard(testId, {
        search,
        squad,
        status,
        sort,
        direction,
      }),
  });

  // The squad filter carries into the file, so what you exported is what you were
  // looking at.
  const download = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadFile(
        `/reports/export/baseline?testId=${testId}&format=CSV${squad ? `&squad=${encodeURIComponent(squad)}` : ""}`,
        `baseline-${testId}.csv`,
      );
    } catch {
      toast.error("Could not export", {
        description: "The download failed. Please try again.",
      });
    } finally {
      setExporting(false);
    }
  };

  const onSort = (key: SortKey): void => {
    if (sort === key) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    // Best-first for the numeric columns, A–Z for the text ones — what a reader expects
    // from a single click.
    setDirection(
      key === "name" || key === "squad" || key === "rank" ? "asc" : "desc",
    );
  };

  const sortable = (key: SortKey, label: string, align?: "right") => (
    <Th className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(key)}
        className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
        aria-sort={
          sort === key
            ? direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        {label}
        {sort === key ? (
          <span aria-hidden>{direction === "asc" ? "↑" : "↓"}</span>
        ) : null}
      </button>
    </Th>
  );

  // Squad options come from the board itself rather than a separate roster call: the only
  // squads worth offering are the ones with a student on this test.
  const squads = [
    ...new Set(
      (board.data?.rows ?? []).map((row) => row.squadName).filter(Boolean),
    ),
  ].sort() as string[];

  return (
    // The modal is a sibling of the Card, never a child. `Card` carries `animate-rise`,
    // whose `animation-fill-mode: both` leaves a transform applied for good — and a
    // transformed ancestor becomes the containing block for `position: fixed`, so a modal
    // nested inside one is trapped in the card instead of covering the page. Same shape as
    // the review dialog on this screen.
    <>
      <Card>
        <CardHeader
          title="Student leaderboard"
          description="Solved counts every accepted LeetCode solution for these problems, whenever it was written — not only those submitted during the test. Participation is tracked separately: a student can be Absent and still have solved most of the set."
          action={
            // Fetched with the access token and saved from a blob, not linked. The export
            // endpoint is authenticated, and a plain <a href> carries no Authorization
            // header — it would download a 401 body as a .csv file.
            <Button
              variant="ghost"
              onClick={() => void download()}
              loading={exporting}
            >
              <Download className="size-3.5" aria-hidden /> CSV
            </Button>
          }
        />

        {board.data ? (
          // Two blocks, labelled, never interleaved. "Absent" and "solved nothing" are
          // different facts about different things, and a single row of tiles mixing them
          // is how a mentor concludes that 64 students failed when 64 students simply did
          // not open the test.
          <div className="space-y-4 border-b border-[var(--color-border)] p-5">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                Test participation
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Eligible" value={board.data.totalStudents} />
                <StatTile label="Started" value={board.data.attemptedStudents} />
                <StatTile
                  label="Completed"
                  value={
                    board.data.rows.filter((row) => row.status === "SUBMITTED").length
                  }
                />
                <StatTile label="Absent" value={board.data.notStartedStudents} />
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                LeetCode performance{" "}
                <span className="font-normal normal-case tracking-normal">
                  — accepted solutions at any time, not only during the test
                </span>
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Average" value={`${board.data.averagePercent}%`} />
                <StatTile
                  label="Highest / lowest"
                  value={`${board.data.highestPercent}% / ${board.data.lowestPercent}%`}
                />
                <StatTile
                  label={`Solved all ${board.data.totalQuestions}`}
                  value={
                    board.data.performanceDistribution[board.data.totalQuestions] ?? 0
                  }
                />
                <StatTile
                  label="Not synced yet"
                  value={board.data.performanceUnknownStudents}
                />
              </div>

              {/* The full spread, so "how is the cohort doing" is answerable at a glance
                  rather than by counting rows. */}
              <div className="mt-3 flex flex-wrap gap-2">
                {board.data.performanceDistribution.map((count, solved) => (
                  <span
                    key={solved}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs"
                  >
                    <span className="font-medium">
                      {solved}/{board.data!.totalQuestions}
                    </span>{" "}
                    <span className="text-[var(--color-fg-muted)]">
                      {count} student{count === 1 ? "" : "s"}
                    </span>
                  </span>
                ))}
              </div>
            </div>
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
          <ErrorState
            error={board.error}
            onRetry={() => void board.refetch()}
          />
        ) : (board.data?.rows.length ?? 0) === 0 ? (
          <EmptyState
            title="No students match"
            description="Try clearing the search or the squad filter."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                {sortable("rank", "Rank")}
                {sortable("name", "Student")}
                {sortable("squad", "Squad")}
                <Th className="text-right">Total</Th>
                {sortable("solved", "Solved", "right")}
                <Th className="text-right">Not solved</Th>
                {sortable("percent", "Score", "right")}
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
                      <span
                        className={cn(
                          row.isTied && "text-[var(--color-fg-muted)]",
                        )}
                      >
                        {row.rank}
                        {row.isTied ? "=" : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--color-fg-subtle)]">—</span>
                    )}
                  </Td>
                  <Td>
                    <p className="font-medium">{row.studentName}</p>
                    <p className="text-xs text-[var(--color-fg-subtle)]">
                      {row.studentEmail}
                    </p>
                  </Td>
                  <Td>{row.squadName ?? "—"}</Td>
                  <Td className="text-right tabular-nums">
                    {row.totalQuestions}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {row.performanceKnown ? row.solvedCount : "—"}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {row.performanceKnown ? row.notSolvedCount : "—"}
                  </Td>
                  <Td className="text-right tabular-nums font-medium">
                    {row.performanceKnown ? (
                      <Badge tone={scoreTone(row.percent, true)}>{row.percent}%</Badge>
                    ) : (
                      // Never "0%" for a student we have never read. This column reports
                      // measurements, and there is none.
                      <span
                        className="text-xs text-[var(--color-fg-subtle)]"
                        title="No successful sync yet — we hold no submissions for this student"
                      >
                        Not synced
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={participationTone(row.status)}>
                      {STATUS_LABELS[row.status] ?? row.status}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-[var(--color-fg-subtle)]">
                    {row.lastSuccessfulSyncAt
                      ? new Date(row.lastSuccessfulSyncAt).toLocaleDateString()
                      : "—"}
                    {row.syncStatus && row.syncStatus !== "OK" ? (
                      <span className="ml-1 text-[var(--color-warning)]" title={row.syncStatus}>
                        ⚠
                      </span>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <StudentBreakdown
        testId={testId}
        row={selected}
        onClose={() => setSelected(null)}
      />
    </>
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
    queryKey: ["baseline-student-result", testId, row?.studentId],
    queryFn: () => api.baselineStudentResult(testId, row!.studentId),
    enabled: row !== null,
  });

  if (!row) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={row.studentName}
      description={row.studentEmail}
      size="lg"
    >
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Baseline test"
            value={`${row.totalQuestions} questions`}
          />
          <StatTile label="Solved (any time)" value={row.solvedCount} />
          <StatTile label="Not solved" value={row.notSolvedCount} />
          <StatTile label="Score" value={`${row.percent}%`} />
        </div>

        {/* What the sitting itself recorded, beside what the student can do now. Shown only
            when the two differ — when they agree there is nothing to explain, and a second
            identical number is just noise. */}
        {detail.data && detail.data.inWindowSolvedCount !== detail.data.solvedCount ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3 text-xs">
            <p>
              <span className="font-medium">During the test:</span>{" "}
              {detail.data.inWindowSolvedCount}/{detail.data.totalQuestions} —{" "}
              <span className="font-medium">now:</span> {detail.data.solvedCount}/
              {detail.data.totalQuestions}. The recorded test result does not change when a
              problem is solved later; the current figure does.
            </p>
          </div>
        ) : null}

        <p className="text-xs text-[var(--color-fg-muted)]">
          Participation:{" "}
          <span className="font-medium">
            {STATUS_LABELS[row.status] ?? row.status}
          </span>
          {row.lastSuccessfulSyncAt
            ? ` · last synced ${new Date(row.lastSuccessfulSyncAt).toLocaleString()}`
            : " · never synced"}
        </p>

        {detail.isLoading ? (
          <TableSkeleton rows={4} cols={2} />
        ) : detail.error ? (
          <ErrorState
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {(detail.data?.problems ?? []).map((problem) => {
              const solved = problem.status === "ACCEPTED";
              return (
                <li
                  key={problem.testProblemId}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  {solved ? (
                    <Check
                      className="size-4 shrink-0 text-[var(--color-success)]"
                      aria-hidden
                    />
                  ) : (
                    <X
                      className="size-4 shrink-0 text-[var(--color-danger)]"
                      aria-hidden
                    />
                  )}
                  <span className="sr-only">
                    {solved ? "Solved" : "Not solved"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {problem.title}
                  </span>
                  {/* When it was solved matters: a solution from three weeks before the
                      test is the evidence the old window-scoped view threw away. */}
                  {solved && problem.firstAcceptedAt ? (
                    <span className="shrink-0 text-xs text-[var(--color-fg-subtle)]">
                      {new Date(problem.firstAcceptedAt).toLocaleDateString()}
                    </span>
                  ) : null}
                  {/* "Attempted but never accepted" is a different conversation from
                      "never opened it", so the two do not collapse into one ✗. */}
                  {!solved && problem.attempts > 0 ? (
                    <Badge tone="warning">
                      {problem.attempts} attempt
                      {problem.attempts === 1 ? "" : "s"}
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
