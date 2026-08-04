'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { todayKey } from '@/lib/utils';
import {
  Button,
  Card,
  CardHeader,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

const PROBLEMS_PER_DAY = 4;

export default function AssignmentsPage() {
  const queryClient = useQueryClient();
  const [dayKey, setDayKey] = useState(todayKey());
  const [topic, setTopic] = useState('');
  const [urls, setUrls] = useState<string[]>(Array(PROBLEMS_PER_DAY).fill(''));
  const [creating, setCreating] = useState(false);

  const history = useQuery({
    queryKey: ['assignments'],
    queryFn: () => api.assignments({ page: 1, pageSize: 30 }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createAssignment({
        dayKey,
        topic: topic || undefined,
        problemUrls: urls.map((url) => url.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('Assignment created');
      setUrls(Array(PROBLEMS_PER_DAY).fill(''));
      setTopic('');
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['assignments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error: Error) =>
      toast.error('Could not create assignment', { description: error.message }),
  });

  const filledCount = urls.filter((url) => url.trim()).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Assignments</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Problem titles, difficulty and tags are fetched from LeetCode automatically.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating((open) => !open)}>
          <Plus className="size-3.5" aria-hidden />
          New assignment
        </Button>
      </header>

      {creating ? (
        <Card>
          <CardHeader
            title="Create assignment"
            description="Paste LeetCode problem URLs. Slugs also work."
          />
          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="date" className="mb-1.5 block text-xs font-medium">
                  Date
                </label>
                <input
                  id="date"
                  type="date"
                  value={dayKey}
                  onChange={(event) => setDayKey(event.target.value)}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </div>
              <div>
                <label htmlFor="topic" className="mb-1.5 block text-xs font-medium">
                  Topic (optional)
                </label>
                <input
                  id="topic"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="Sliding Window"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </div>
            </div>

            {urls.map((url, index) => (
              <div key={index}>
                <label htmlFor={`problem-${index}`} className="mb-1.5 block text-xs font-medium">
                  Problem {index + 1}
                </label>
                <input
                  id={`problem-${index}`}
                  value={url}
                  onChange={(event) => {
                    const next = [...urls];
                    next[index] = event.target.value;
                    setUrls(next);
                  }}
                  placeholder="https://leetcode.com/problems/two-sum/"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-brand)]"
                />
              </div>
            ))}

            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={() => create.mutate()}
                loading={create.isPending}
                disabled={filledCount === 0}
              >
                Create assignment
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <p className="text-xs text-[var(--color-fg-subtle)]">
                {filledCount} of {PROBLEMS_PER_DAY} problems entered
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Assignment history" />
        {history.isLoading ? (
          <TableSkeleton rows={8} cols={4} />
        ) : history.error ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : !history.data || history.data.items.length === 0 ? (
          <EmptyState
            title="No assignments yet"
            description="Create the first one so the sync engine knows what to check."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Topic</Th>
                <Th>Problems</Th>
                <Th className="text-right">Count</Th>
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((assignment) => (
                <tr key={assignment.id} className="transition hover:bg-[var(--color-surface-sunken)]">
                  <Td className="font-medium tabular-nums">{assignment.dayKey}</Td>
                  <Td className="text-[var(--color-fg-muted)]">{assignment.topic ?? '—'}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {assignment.problems.map((problem) => (
                        <a
                          key={problem.id}
                          href={problem.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs hover:border-[var(--color-brand)]"
                        >
                          {problem.title}
                          <DifficultyBadge difficulty={problem.difficulty} />
                        </a>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-right tabular-nums">{assignment.problems.length}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
