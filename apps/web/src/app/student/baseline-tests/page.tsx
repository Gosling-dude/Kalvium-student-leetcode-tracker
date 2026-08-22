'use client';

/**
 * The student's baseline tests.
 *
 * Everything on this page comes from `/student/baseline-tests`, which resolves the
 * audience from the session — there is no campus or batch parameter for a student to
 * change, so a test belonging to another campus is not merely hidden, it is unreachable
 * (§22, §40).
 *
 * Deliberately absent: any risk score, any review status, any mention of how anyone else
 * did. The student type has no such fields, so none of it can leak by oversight (§23).
 */

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BASELINE_TEST_STATUS_LABELS, type StudentBaselineTest } from '@dsa/shared';
import { Clock, ListChecks } from 'lucide-react';

import { api } from '@/lib/api';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';

export default function StudentBaselineTestsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'baseline-tests'],
    queryFn: api.studentBaselineTests,
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Baseline Tests</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Weekly checks of what you can solve on your own. These are separate from your
          daily assignments — they don&rsquo;t affect your streak or your daily score.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          title="No baseline tests yet"
          description="When your mentors schedule one, it will appear here."
        />
      ) : (
        <div className="space-y-3">
          {(data ?? []).map((test) => (
            <TestCard key={test.id} test={test} />
          ))}
        </div>
      )}
    </div>
  );
}

function TestCard({ test }: { test: StudentBaselineTest }) {
  const attempt = test.attempt;
  const solved = attempt?.solvedCount ?? 0;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{test.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-[var(--color-fg-muted)]">
            <span>{test.dayKey}</span>
            <span className="inline-flex items-center gap-1">
              <ListChecks className="size-3.5" aria-hidden />
              {test.problemCount} problem{test.problemCount === 1 ? '' : 's'}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden />
              {test.durationMinutes} minutes
            </span>
            <Badge tone="neutral">{BASELINE_TEST_STATUS_LABELS[test.status]}</Badge>
          </div>
          {test.description ? (
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{test.description}</p>
          ) : null}
        </div>

        <div className="text-right">
          {attempt ? (
            <>
              <p className="text-sm font-medium">
                {attempt.status === 'SUBMITTED'
                  ? 'Submitted'
                  : attempt.status === 'EXPIRED'
                    ? 'Time up'
                    : 'In progress'}
              </p>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {solved} of {test.problemCount} solved · {attempt.score}/{attempt.maxScore} points
              </p>
              <Link
                href={`/student/baseline-tests/${test.id}`}
                className="mt-2 inline-flex rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]"
              >
                {attempt.status === 'IN_PROGRESS' ? 'Continue' : 'View'}
              </Link>
            </>
          ) : test.canStart ? (
            <Link
              href={`/student/baseline-tests/${test.id}`}
              className="inline-flex rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]"
            >
              Start test
            </Link>
          ) : (
            // Says *why* rather than showing a dead button — an unexplained disabled
            // control reads as a bug.
            <p className="text-xs text-[var(--color-fg-subtle)]">
              {test.blockedReason ?? 'Not available yet'}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
