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

  const { selected: batchFilter, batches, isLoading: batchesLoading } = useBatchFilter();

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

  /**
   * Whether the mentor has *actually* touched the batch selector.
   *
   * "All batches" is a real, supported choice, but it must never be the thing a mentor
   * gets by default just because they never looked at the selector — that is exactly how
   * a Foundation-only assignment quietly becomes "every batch" (§20). The create button
   * stays disabled until a deliberate choice is made, one way or the other.
   */
  const [batchChoiceMade, setBatchChoiceMade] = useState(false);
  const batchSelectionRequired = !batchesLoading && batches.length > 0;

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
      setBatchChoiceMade(false);
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
          <Button
            variant="primary"
            onClick={() =>
              setCreating((open) => {
                // Reopening (or opening fresh) always starts with no batch choice made,
                // so a stale "All batches" selection from a previous session can never
                // carry forward silently.
                if (!open) {
                  setTargetBatchIds([]);
                  setBatchChoiceMade(false);
                }
                return !open;
              })
            }
          >
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
              Target Batch. Required, and never pre-selected: a mentor must actively pick
              Foundation, Intermediate, or explicitly "All batches" before they can create
              anything, so an assignment can never end up targeting every batch just
              because nobody looked at the selector (§20).
              "All batches" creates one assignment per batch rather than a single shared
              row, so either batch's questions can later be edited without touching the
              other's.
            */}
            {batchesLoading ? (
              <p className="text-xs text-[var(--color-fg-subtle)]">Loading batches…</p>
            ) : batches.length > 0 ? (
              <div>
                <span className="mb-1.5 block text-xs font-medium">
                  Target Batch <span className="text-[var(--color-danger)]">*</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-pressed={batchChoiceMade && targetBatchIds.length === 0}
                    onClick={() => {
                      setTargetBatchIds([]);
                      setBatchChoiceMade(true);
                    }}
                    className={
                      batchChoiceMade && targetBatchIds.length === 0
                        ? 'rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]'
                        : 'rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                    }
                  >
                    All batches
                  </button>
                  {batches.map((batch) => {
                    const isSelected = batchChoiceMade && targetBatchIds.includes(batch.id);
                    const isTaken = takenBatchIds.has(batch.id);
                    return (
                      <button
                        key={batch.id}
                        type="button"
                        aria-pressed={isSelected}
                        disabled={isTaken}
                        title={
                          isTaken
                            ? `${dayKey} already has an assignment for ${batch.name}.`
                            : undefined
                        }
                        onClick={() => {
                          setTargetBatchIds((current) =>
                            current.includes(batch.id)
                              ? current.filter((id) => id !== batch.id)
                              : [...current, batch.id],
                          );
                          setBatchChoiceMade(true);
                        }}
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
                {/* One line per taken batch — Foundation's message never mentions
                    Intermediate and vice versa, and neither blocks picking the other. */}
                {(existingForDay.data ?? []).map((a) => (
                  <p key={a.id} className="mt-1.5 text-xs text-[var(--color-warning)]">
                    {dayKey} already has an assignment for {a.batchName ?? 'all students'}. Edit
                    the existing assignment instead.
                  </p>
                ))}
                {!batchChoiceMade ? (
                  <p className="mt-1.5 text-xs text-[var(--color-fg-subtle)]">
                    Pick a target batch before adding problems.
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

            {/*
              A plain statement of what is about to be saved, before it is saved (§20).
              Never guesses a batch count: until the mentor has made an explicit choice,
              this says so rather than defaulting to "every batch".
            */}
            {filledCount > 0 ? (
              <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
                <p className="font-medium">Preview</p>
                <p className="mt-1 text-[var(--color-fg-muted)]">
                  {batchSelectionRequired && !batchChoiceMade
                    ? 'Pick a target batch above to see what will be created.'
                    : `${filledCount} problem${filledCount === 1 ? '' : 's'} on ${dayKey} for ${
                        targetBatchIds.length === 0
                          ? `every batch (${batches.length} assignment${batches.length === 1 ? '' : 's'}: ${batches
                              .map((batch) => batch.name)
                              .join(', ')})`
                          : batches
                              .filter((batch) => targetBatchIds.includes(batch.id))
                              .map((batch) => batch.name)
                              .join(', ')
                      }.`}
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
                  (batchSelectionRequired && !batchChoiceMade) ||
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
