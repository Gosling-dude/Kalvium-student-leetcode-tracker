'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle, ExternalLink } from 'lucide-react';

import { api } from '@/lib/api';
import { Badge, Button, Card, CardHeader, DifficultyBadge, ErrorState, Skeleton } from '@/components/ui';

export default function StudentAssignmentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'assignment', params.id],
    queryFn: () => api.studentAssignment(params.id),
  });

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={() => router.back()} className="-ml-2">
        <ArrowLeft className="size-4" aria-hidden />
        Back
      </Button>

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : error || !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                {data.title ?? data.topic ?? 'Assignment'}
              </h1>
              {data.difficulty ? <DifficultyBadge difficulty={data.difficulty} /> : null}
            </div>
            <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
              {new Date(`${data.dayKey}T00:00:00`).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
              {data.batchName ? ` · ${data.batchName}` : ''}
            </p>

            {data.myOutcome ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={data.myOutcome.isPerfect ? 'success' : 'neutral'}>
                  {data.myOutcome.solvedCount}/{data.myOutcome.assignedCount} completed
                </Badge>
                {data.myOutcome.completedAt ? (
                  <span className="text-xs text-[var(--color-fg-subtle)]">
                    Finished at {data.myOutcome.completedAt}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">
                Not yet synced — your result for this day will appear after the next sync.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title={`${data.problems.length} problem${data.problems.length === 1 ? '' : 's'}`} />
            <ul className="divide-y divide-[var(--color-border)]">
              {data.problems.map((problem) => {
                const outcome = data.myOutcome?.problems.find((p) => p.problemId === problem.problemId);
                const solved = outcome?.status === 'ACCEPTED';
                return (
                  <li key={problem.id} className="flex items-center gap-3 px-5 py-3.5">
                    {solved ? (
                      <CheckCircle2 className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                    ) : (
                      <Circle className="size-4 shrink-0 text-[var(--color-fg-subtle)]" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {problem.position}. {problem.title}
                      </span>
                      {problem.topicTags.length > 0 ? (
                        <span className="mt-0.5 block truncate text-xs text-[var(--color-fg-subtle)]">
                          {problem.topicTags.join(', ')}
                        </span>
                      ) : null}
                    </span>
                    <DifficultyBadge difficulty={problem.difficulty} />
                    <a
                      href={problem.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline"
                    >
                      Open on LeetCode <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
