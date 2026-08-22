'use client';

/**
 * One baseline test, from the student's side: start it, work through the problems on
 * LeetCode, hand it in.
 *
 * Results are read from the same LeetCode sync everything else uses, so a problem shows
 * as solved once the sync has seen the accepted submission — which is why the page says
 * so plainly rather than letting a student think their work was lost.
 *
 * Nothing here shows a risk score, a review status, or another student's result. Those
 * fields do not exist on the type this page receives (§23, §35).
 */

import { use } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, ExternalLink } from 'lucide-react';

import { api } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DifficultyBadge,
  ErrorState,
  ProgressBar,
  Skeleton,
} from '@/components/ui';

export default function StudentBaselineTestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'baseline-test', id],
    queryFn: () => api.studentBaselineTest(id),
    // While an attempt is running, the page polls so a solve shows up shortly after the
    // sync mirrors it, rather than leaving the student wondering.
    refetchInterval: (query) =>
      query.state.data?.attempt?.status === 'IN_PROGRESS' ? 60_000 : false,
  });

  const start = useMutation({
    mutationFn: () => api.startBaselineTest(id),
    onSuccess: () => {
      toast.success('Test started — good luck.');
      void queryClient.invalidateQueries({ queryKey: ['student', 'baseline-test', id] });
    },
    onError: (err: Error) => toast.error('Could not start', { description: err.message }),
  });

  const submit = useMutation({
    mutationFn: () => api.submitBaselineTest(id),
    onSuccess: () => {
      toast.success('Submitted', {
        description: 'Your solved problems have been recorded.',
      });
      void queryClient.invalidateQueries({ queryKey: ['student', 'baseline-test', id] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'baseline-tests'] });
    },
    onError: (err: Error) => toast.error('Could not submit', { description: err.message }),
  });

  if (isLoading) return <Skeleton className="h-64" />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const attempt = data.attempt;

  return (
    <div className="space-y-4">
      <header>
        <Link
          href="/student/baseline-tests"
          className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← All baseline tests
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{data.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-[var(--color-fg-muted)]">
          <span>{data.dayKey}</span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            {data.durationMinutes} minutes
          </span>
          <span>
            {data.problemCount} problem{data.problemCount === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {data.instructions ? (
        <Card className="p-4 text-sm">
          <p className="font-medium">Instructions</p>
          <p className="mt-1 whitespace-pre-line text-[var(--color-fg-muted)]">
            {data.instructions}
          </p>
        </Card>
      ) : null}

      {!attempt ? (
        <Card className="p-5">
          <p className="text-sm text-[var(--color-fg-muted)]">
            The problems are revealed when you start, and your {data.durationMinutes}-minute
            window begins then. Solve them on LeetCode with the account linked to your
            profile — that is how your results are picked up.
          </p>
          <div className="mt-4">
            <Button
              variant="primary"
              disabled={!data.canStart}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              Start test
            </Button>
            {!data.canStart && data.blockedReason ? (
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">{data.blockedReason}</p>
            ) : null}
          </div>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {attempt.status === 'SUBMITTED'
                    ? 'Submitted'
                    : attempt.status === 'EXPIRED'
                      ? 'Your window has closed'
                      : 'In progress'}
                </p>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {attempt.solvedCount} of {data.problemCount} solved · {attempt.score}/
                  {attempt.maxScore} points
                  {attempt.expiresAt && attempt.status === 'IN_PROGRESS'
                    ? ` · closes ${new Date(attempt.expiresAt).toLocaleTimeString()}`
                    : ''}
                </p>
              </div>
              {attempt.status === 'IN_PROGRESS' ? (
                <Button variant="primary" loading={submit.isPending} onClick={() => submit.mutate()}>
                  Submit test
                </Button>
              ) : null}
            </div>
            <div className="mt-3">
              <ProgressBar
                value={data.problemCount > 0 ? (attempt.solvedCount / data.problemCount) * 100 : 0}
                label="Baseline progress"
              />
            </div>
            <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">
              Solved problems appear here shortly after the LeetCode sync picks them up, not
              instantly. Nothing is lost in the meantime.
            </p>
          </Card>

          <Card>
            <CardHeader title="Problems" description="Open each one on LeetCode and solve it." />
            <div className="divide-y divide-[var(--color-border)]">
              {(attempt.results ?? []).map((result) => (
                <div
                  key={result.testProblemId}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm tabular-nums text-[var(--color-fg-subtle)]">
                      {result.position}.
                    </span>
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 text-sm font-medium hover:text-[var(--color-brand)]"
                    >
                      {result.title}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                    <DifficultyBadge difficulty={result.difficulty} />
                  </div>
                  <Badge
                    tone={
                      result.status === 'ACCEPTED'
                        ? 'success'
                        : result.status === 'ATTEMPTED_NOT_ACCEPTED'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {result.status === 'ACCEPTED'
                      ? 'Solved'
                      : result.status === 'ATTEMPTED_NOT_ACCEPTED'
                        ? 'Attempted'
                        : 'Not attempted'}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
