'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AssignmentSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { todayKey } from '@/lib/utils';
import { BatchChip, BatchFilter, useBatchFilter } from '@/components/batch-filter';
import { ChangeAssignmentTargetDialog } from '@/components/change-assignment-target-dialog';
import {
  Badge,
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

/**
 * The default number of problem inputs shown, not a limit.
 *
 * The programme assigns four a day, but nothing downstream assumes it: a batch can be
 * given any number, and every completion figure is computed against that batch's actual
 * count (§10).
 */
const DEFAULT_PROBLEM_SLOTS = 4;

export default function AssignmentsPage() {
  const queryClient = useQueryClient();
  const [dayKey, setDayKey] = useState(todayKey());
  const [topic, setTopic] = useState('');
  const [urls, setUrls] = useState<string[]>(Array(DEFAULT_PROBLEM_SLOTS).fill(''));
  const [creating, setCreating] = useState(false);

  const { selected: batchFilter, batches } = useBatchFilter();

  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const isAdmin = me.data?.role === 'ADMIN';
  const [retargeting, setRetargeting] = useState<AssignmentSummary | null>(null);

  /**
   * Which batches receive this problem set. Empty means every batch.
   *
   * Assigning different questions to each batch on the same date is two saves, one per
   * batch — which is exactly how the batches are meant to diverge (§20).
   */
  const [targetBatchIds, setTargetBatchIds] = useState<string[]>([]);

  const history = useQuery({
    queryKey: ['assignments', batchFilter],
    queryFn: () => api.assignments({ page: 1, pageSize: 30, batch: batchFilter ?? undefined }),
  });

  // What already exists for the chosen date, so the form can refuse a duplicate before
  // the request rather than surfacing a server error afterwards (§20).
  const existingForDay = useQuery({
    queryKey: ['assignments', 'day', dayKey],
    queryFn: () => api.assignmentsForDay(dayKey),
    enabled: creating,
  });

  const takenBatchIds = new Set((existingForDay.data ?? []).map((a) => a.batchId));

  const create = useMutation({
    mutationFn: () =>
      api.createAssignment({
        dayKey,
        topic: topic || undefined,
        batches: targetBatchIds.length > 0 ? targetBatchIds : undefined,
        problemUrls: urls.map((url) => url.trim()).filter(Boolean),
      }),
    onSuccess: (created) => {
      toast.success(
        created.length === 1
          ? `Assignment created for ${created[0]!.batchName ?? 'all students'}`
          : `Assignment created for ${created.length} batches`,
      );
      setUrls(Array(DEFAULT_PROBLEM_SLOTS).fill(''));
      setTopic('');
      setTargetBatchIds([]);
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ['assignments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['mentor'] });
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
        <div className="flex flex-wrap items-center gap-2">
          <BatchFilter />
          <Button variant="primary" onClick={() => setCreating((open) => !open)}>
            <Plus className="size-3.5" aria-hidden />
            New assignment
          </Button>
        </div>
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

            {/*
              Batch targeting. "All batches" creates one assignment per batch rather than
              a single shared row, so either batch's questions can later be edited without
              touching the other's.
            */}
            {batches.length > 0 ? (
              <div>
                <span className="mb-1.5 block text-xs font-medium">Batch</span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-pressed={targetBatchIds.length === 0}
                    onClick={() => setTargetBatchIds([])}
                    className={
                      targetBatchIds.length === 0
                        ? 'rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]'
                        : 'rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                    }
                  >
                    All batches
                  </button>
                  {batches.map((batch) => {
                    const isSelected = targetBatchIds.includes(batch.id);
                    const isTaken = takenBatchIds.has(batch.id);
                    return (
                      <button
                        key={batch.id}
                        type="button"
                        aria-pressed={isSelected}
                        disabled={isTaken}
                        title={
                          isTaken
                            ? `${batch.name} already has an assignment on ${dayKey}`
                            : undefined
                        }
                        onClick={() =>
                          setTargetBatchIds((current) =>
                            current.includes(batch.id)
                              ? current.filter((id) => id !== batch.id)
                              : [...current, batch.id],
                          )
                        }
                        className={
                          isSelected
                            ? 'rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]'
                            : 'rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-50'
                        }
                      >
                        {batch.name}
                        {isTaken ? ' · already set' : ''}
                      </button>
                    );
                  })}
                </div>
                {takenBatchIds.size > 0 ? (
                  <p className="mt-1.5 text-xs text-[var(--color-warning)]">
                    {dayKey} already has an assignment for{' '}
                    {(existingForDay.data ?? [])
                      .map((a) => a.batchName ?? 'all students')
                      .join(', ')}
                    . Pick another batch or edit the existing one.
                  </p>
                ) : null}
              </div>
            ) : null}

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

            {/* A plain statement of what is about to be saved, before it is saved (§20). */}
            {filledCount > 0 ? (
              <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
                <p className="font-medium">Preview</p>
                <p className="mt-1 text-[var(--color-fg-muted)]">
                  {filledCount} problem{filledCount === 1 ? '' : 's'} on {dayKey} for{' '}
                  {targetBatchIds.length === 0
                    ? `every batch (${batches.length || 1} assignment${batches.length === 1 ? '' : 's'})`
                    : batches
                        .filter((batch) => targetBatchIds.includes(batch.id))
                        .map((batch) => batch.name)
                        .join(', ')}
                  .
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() => create.mutate()}
                loading={create.isPending}
                disabled={
                  filledCount === 0 ||
                  targetBatchIds.some((id) => takenBatchIds.has(id)) ||
                  (targetBatchIds.length === 0 && takenBatchIds.size > 0)
                }
              >
                Create assignment
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                onClick={() => setUrls((current) => [...current, ''])}
                className="text-xs"
              >
                Add another problem
              </Button>
              <p className="text-xs text-[var(--color-fg-subtle)]">
                {filledCount} problem{filledCount === 1 ? '' : 's'} entered
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
                <Th>Batch</Th>
                <Th>Topic</Th>
                <Th>Problems</Th>
                <Th className="text-right">Count</Th>
                {isAdmin ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </thead>
            <tbody>
              {history.data.items.map((assignment) => (
                <tr key={assignment.id} className="transition hover:bg-[var(--color-surface-sunken)]">
                  <Td className="font-medium tabular-nums">{assignment.dayKey}</Td>
                  <Td>
                    {assignment.batchCode ? (
                      <span className="inline-flex items-center gap-1.5">
                        <BatchChip code={assignment.batchCode} name={assignment.batchName} />
                        <span className="text-xs text-[var(--color-fg-muted)]">
                          {assignment.batchName}
                        </span>
                      </span>
                    ) : (
                      <Badge tone="neutral">All students</Badge>
                    )}
                    {/* Distinguishes a retargeted row from one that has always been what it
                        says (§9) — never silently presented as if it always applied here. */}
                    {assignment.audienceChangedAt ? (
                      <span
                        className="ml-1.5 text-xs text-[var(--color-fg-subtle)]"
                        title={`Originally ${assignment.originalBatchId ? (assignment.originalBatchName ?? 'a batch') : 'All students'}`}
                      >
                        (retargeted)
                      </span>
                    ) : null}
                  </Td>
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
                  {isAdmin ? (
                    <Td className="text-right">
                      <Button
                        variant="ghost"
                        className="text-xs"
                        onClick={() => setRetargeting(assignment)}
                      >
                        <Settings2 className="size-3.5" aria-hidden />
                        Change target
                      </Button>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <ChangeAssignmentTargetDialog
        assignment={retargeting}
        batches={batches}
        open={!!retargeting}
        onClose={() => setRetargeting(null)}
      />
    </div>
  );
}
