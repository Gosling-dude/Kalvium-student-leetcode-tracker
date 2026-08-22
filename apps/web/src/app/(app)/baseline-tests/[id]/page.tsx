'use client';

/**
 * One baseline test: its report, its attempts, and the review queue.
 *
 * The review section is the part that needed the most care. It shows *signals with their
 * evidence* and the phrase "review recommended" — never a conclusion about the student.
 * Solving four easy problems in nine minutes is genuinely what a strong student looks
 * like, so a screen that called that cheating would be wrong often enough to be worse
 * than useless (§23). What a mentor concludes is recorded separately, by them, with a note.
 */

import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BASELINE_REVIEW_STATUS_LABELS,
  BASELINE_TEST_STATUS_LABELS,
  type BaselineAttemptSummary,
} from '@dsa/shared';
import { RefreshCw, Send, ShieldAlert, Square } from 'lucide-react';

import { api } from '@/lib/api';
import { CampusChip, BatchChip } from '@/components/scope-filter';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Modal,
  Skeleton,
  StatTile,
  TableShell,
  Td,
  Th,
} from '@/components/ui';

export default function BaselineTestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<BaselineAttemptSummary | null>(null);

  const report = useQuery({
    queryKey: ['baseline-report', id],
    queryFn: () => api.baselineTestReport(id),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['baseline-report', id] });
    void queryClient.invalidateQueries({ queryKey: ['baseline-tests'] });
  };

  const publish = useMutation({
    mutationFn: () => api.publishBaselineTest(id),
    onSuccess: () => {
      toast.success('Published — students in the target audience can now start it.');
      invalidate();
    },
    onError: (error: Error) => toast.error('Could not publish', { description: error.message }),
  });

  const close = useMutation({
    mutationFn: () => api.closeBaselineTest(id),
    onSuccess: () => {
      toast.success('Closed and graded', {
        description: 'Every attempt was graded once more, so late submissions still counted.',
      });
      invalidate();
    },
    onError: (error: Error) => toast.error('Could not close', { description: error.message }),
  });

  const grade = useMutation({
    mutationFn: () => api.gradeBaselineTest(id),
    onSuccess: (result) => {
      toast.success(`Re-graded ${result.graded} attempt${result.graded === 1 ? '' : 's'}`);
      invalidate();
    },
    onError: (error: Error) => toast.error('Could not grade', { description: error.message }),
  });

  if (report.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (report.error || !report.data) {
    return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  }

  const { test } = report.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{test.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <span>{test.dayKey}</span>
            <span>·</span>
            <span>{test.audienceLabel}</span>
            <span>·</span>
            <span>{test.durationMinutes} min</span>
            <Badge tone="neutral">{BASELINE_TEST_STATUS_LABELS[test.status]}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => grade.mutate()} loading={grade.isPending}>
            <RefreshCw className="size-3.5" aria-hidden />
            Re-grade
          </Button>
          {test.status !== 'ACTIVE' && test.status !== 'CLOSED' ? (
            <Button variant="primary" onClick={() => publish.mutate()} loading={publish.isPending}>
              <Send className="size-3.5" aria-hidden />
              Publish
            </Button>
          ) : null}
          {test.status === 'ACTIVE' ? (
            <Button onClick={() => close.mutate()} loading={close.isPending}>
              <Square className="size-3.5" aria-hidden />
              Close
            </Button>
          ) : null}
        </div>
      </header>

      {/*
        Participation before scores, deliberately: "18 of 41 started" is the number that
        changes what a mentor does next, and an average score computed over a fifth of the
        cohort is a misleading headline (§24).
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Eligible" value={report.data.totalEligible} />
        <StatTile
          label="Started"
          value={report.data.started}
          hint={`${report.data.notStarted} not started`}
        />
        <StatTile label="Completed" value={report.data.completed} />
        <StatTile
          label="Average score"
          value={report.data.averageScore}
          hint={`Median ${report.data.medianScore} · ${report.data.averagePercent}%`}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Solved everything" value={report.data.solvedAll} />
        {/* The two states that must never be collapsed: trying and failing is a very
            different conversation from never opening the test (§24). */}
        <StatTile label="Attempted, solved none" value={report.data.attemptedNotSolved} />
        <StatTile label="Never attempted" value={report.data.notAttempted} />
      </div>

      <Card>
        <CardHeader
          title="Per-problem success"
          description="Solved, attempted-but-unsolved and not-attempted, out of everyone eligible."
        />
        <TableShell>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Problem</Th>
              <Th>Difficulty</Th>
              <Th className="text-right">Solved</Th>
              <Th className="text-right">Attempted</Th>
              <Th className="text-right">Not attempted</Th>
              <Th className="text-right">Success</Th>
              <Th className="text-right">Avg time</Th>
            </tr>
          </thead>
          <tbody>
            {report.data.problems.map((problem) => (
              <tr key={problem.testProblemId}>
                <Td className="tabular-nums">{problem.position}</Td>
                <Td className="font-medium">{problem.title}</Td>
                <Td>{problem.difficulty}</Td>
                <Td className="text-right tabular-nums">{problem.solvedCount}</Td>
                <Td className="text-right tabular-nums">{problem.attemptedNotSolvedCount}</Td>
                <Td className="text-right tabular-nums">{problem.notAttemptedCount}</Td>
                <Td className="text-right tabular-nums">{problem.successRatePercent}%</Td>
                <Td className="text-right tabular-nums text-[var(--color-fg-muted)]">
                  {problem.averageTimeToSolveSeconds !== null
                    ? `${Math.round(problem.averageTimeToSolveSeconds / 60)}m`
                    : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard
          title="By campus"
          description="Each campus's own participation and average — never pooled."
          rows={report.data.campusBreakdown}
        />
        <BreakdownCard
          title="By batch"
          description="Each batch's own participation and average."
          rows={report.data.batchBreakdown}
        />
      </div>

      <Card>
        <CardHeader
          title="Review recommended"
          description={
            'Timing patterns worth a look — never a conclusion about the student. Each flag ' +
            'is shown with the evidence that raised it.'
          }
        />
        {report.data.reviewQueue.length === 0 ? (
          <EmptyState
            title="Nothing flagged"
            description="No attempt showed a pattern worth reviewing."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Student</Th>
                <Th>Campus / Batch</Th>
                <Th className="text-right">Score</Th>
                <Th className="text-right">Time</Th>
                <Th>Signals</Th>
                <Th>Review</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {report.data.reviewQueue.map((attempt) => (
                <tr key={attempt.id}>
                  <Td>
                    <span className="font-medium">{attempt.studentName}</span>
                    <p className="text-xs text-[var(--color-fg-subtle)]">{attempt.studentEmail}</p>
                  </Td>
                  <Td>
                    <span className="inline-flex gap-1">
                      <CampusChip code={attempt.campusName ?? null} name={attempt.campusName} />
                      <BatchChip code={attempt.batchName ?? null} name={attempt.batchName} />
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {attempt.score}/{attempt.maxScore}
                  </Td>
                  <Td className="text-right tabular-nums text-[var(--color-fg-muted)]">
                    {attempt.timeTakenSeconds !== null
                      ? `${Math.round(attempt.timeTakenSeconds / 60)}m`
                      : '—'}
                  </Td>
                  <Td>
                    <ul className="space-y-0.5 text-xs text-[var(--color-fg-muted)]">
                      {attempt.riskEvidence.map((line) => (
                        <li key={line}>· {line}</li>
                      ))}
                    </ul>
                  </Td>
                  <Td>
                    <Badge
                      tone={attempt.reviewStatus === 'REVIEW_REQUIRED' ? 'warning' : 'neutral'}
                    >
                      {BASELINE_REVIEW_STATUS_LABELS[attempt.reviewStatus]}
                    </Badge>
                    {attempt.reviewNote ? (
                      <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                        {attempt.reviewNote}
                        {attempt.reviewedByName ? ` — ${attempt.reviewedByName}` : ''}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="text-right">
                    <Button variant="ghost" className="text-xs" onClick={() => setReviewing(attempt)}>
                      <ShieldAlert className="size-3.5" aria-hidden />
                      Record review
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <ReviewDialog
        attempt={reviewing}
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function BreakdownCard({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: { scopeId: string | null; scopeName: string; eligible: number; started: number; completed: number; notStarted: number; averageScore: number; averagePercent: number }[];
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <TableShell>
        <thead>
          <tr>
            <Th>Group</Th>
            <Th className="text-right">Eligible</Th>
            <Th className="text-right">Started</Th>
            <Th className="text-right">Completed</Th>
            <Th className="text-right">Avg</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.scopeId ?? row.scopeName}>
              <Td className="font-medium">{row.scopeName}</Td>
              <Td className="text-right tabular-nums">{row.eligible}</Td>
              <Td className="text-right tabular-nums">{row.started}</Td>
              <Td className="text-right tabular-nums">{row.completed}</Td>
              <Td className="text-right tabular-nums">
                {row.averageScore} ({row.averagePercent}%)
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </Card>
  );
}

/**
 * Where a mentor records what *they* concluded.
 *
 * The system raises the flag; a person resolves it. The note is what makes the trail worth
 * reading in six weeks, and it is the only place a judgement about a student is ever
 * written down — by the human who made it (§23).
 */
function ReviewDialog({
  attempt,
  open,
  onClose,
  onDone,
}: {
  attempt: BaselineAttemptSummary | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');

  const review = useMutation({
    mutationFn: (status: 'REVIEWED' | 'NOT_REVIEWED') =>
      api.reviewBaselineAttempt(attempt!.id, status, note.trim() || undefined),
    onSuccess: () => {
      toast.success('Review recorded');
      setNote('');
      onDone();
      onClose();
    },
    onError: (error: Error) => toast.error('Could not save', { description: error.message }),
  });

  if (!attempt) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Review — ${attempt.studentName}`}>
      <div className="space-y-4 p-5">
        <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
          <p className="font-medium">What was observed</p>
          <ul className="mt-1 space-y-0.5 text-[var(--color-fg-muted)]">
            {attempt.riskEvidence.map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
            These are timing observations, not conclusions. A fast, clean run is also what a
            strong student looks like — the point of this screen is to let you decide.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="review-note" className="text-sm font-medium">
            What did you conclude?
          </label>
          <textarea
            id="review-note"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. Spoke with the student; they had solved two of these last month."
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={review.isPending}
            onClick={() => review.mutate('REVIEWED')}
          >
            Mark reviewed
          </Button>
        </div>
      </div>
    </Modal>
  );
}
