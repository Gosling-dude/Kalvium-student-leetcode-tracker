'use client';

/**
 * Baseline Tests — the admin/mentor list and the create form.
 *
 * A top-level section, deliberately not a tab inside Assignments. The separation is the
 * feature: a daily assignment measures practice and consistency, a baseline test measures
 * whether a student can solve something unaided, and nothing here feeds a streak, a
 * completion percentage or a leaderboard (§18, §25).
 *
 * The audience picker mirrors Create Assignment exactly — campus first, then that
 * campus's batches — so an admin who has learned one has learned the other.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BASELINE_TEST_STATUS_LABELS, type BaselineTestSummary } from '@dsa/shared';
import { CopyPlus, Plus } from 'lucide-react';

import { api } from '@/lib/api';
import { todayKey } from '@/lib/utils';
import { CampusChip, BatchChip, useScopeFilter, ScopeFilter } from '@/components/scope-filter';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

const DEFAULT_PROBLEM_SLOTS = 4;

/** Status → badge tone. `ACTIVE` is the only one that should draw the eye. */
const STATUS_TONE: Record<string, 'brand' | 'neutral' | 'success' | 'warning'> = {
  DRAFT: 'neutral',
  SCHEDULED: 'warning',
  ACTIVE: 'brand',
  CLOSED: 'success',
};

export default function BaselineTestsPage() {
  const queryClient = useQueryClient();
  const { campus, batch, campuses } = useScopeFilter();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [dayKey, setDayKey] = useState(todayKey());
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [instructions, setInstructions] = useState('');
  const [urls, setUrls] = useState<string[]>(Array(DEFAULT_PROBLEM_SLOTS).fill(''));

  // Held separately from the page filter, for the same reason the assignment form does:
  // browsing one campus's tests while writing another's is normal, and inheriting the
  // filter would make the target depend on where the admin happened to be looking.
  const [targetCampusId, setTargetCampusId] = useState<string | null>(null);
  const [campusChoiceMade, setCampusChoiceMade] = useState(false);
  const [targetBatchId, setTargetBatchId] = useState<string | null>(null);
  const [batchChoiceMade, setBatchChoiceMade] = useState(false);

  const tests = useQuery({
    queryKey: ['baseline-tests', campus, batch],
    queryFn: () =>
      api.baselineTests({ campus: campus ?? undefined, batch: batch ?? undefined }),
  });

  const targetBatches = useQuery({
    queryKey: ['campus-batches', targetCampusId],
    queryFn: () => api.campusBatches(targetCampusId!),
    enabled: targetCampusId !== null,
    staleTime: 5 * 60_000,
  });
  const batches = targetBatches.data ?? [];

  const targetCampusName =
    campuses.find((entry) => entry.id === targetCampusId)?.name ?? 'All campuses';
  const targetBatchName =
    batches.find((entry) => entry.id === targetBatchId)?.name ?? 'All batches';

  const reset = (): void => {
    setName('');
    setUrls(Array(DEFAULT_PROBLEM_SLOTS).fill(''));
    setInstructions('');
    setTargetCampusId(null);
    setCampusChoiceMade(false);
    setTargetBatchId(null);
    setBatchChoiceMade(false);
    setCreating(false);
  };

  const create = useMutation({
    mutationFn: () =>
      api.createBaselineTest({
        name,
        dayKey,
        durationMinutes,
        instructions: instructions || undefined,
        campus: targetCampusId ?? undefined,
        batch: targetBatchId ?? undefined,
        problems: urls
          .map((url) => url.trim())
          .filter(Boolean)
          .map((url) => ({ url })),
      }),
    onSuccess: (created) => {
      toast.success(`"${created.name}" created as a draft`, {
        description: 'Publish it when you are ready for students to start.',
      });
      reset();
      void queryClient.invalidateQueries({ queryKey: ['baseline-tests'] });
    },
    onError: (error: Error) =>
      toast.error('Could not create the test', { description: error.message }),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateBaselineTest(id),
    onSuccess: (copy) => {
      toast.success(`Duplicated as "${copy.name}"`);
      void queryClient.invalidateQueries({ queryKey: ['baseline-tests'] });
    },
    onError: (error: Error) => toast.error('Could not duplicate', { description: error.message }),
  });

  const filledCount = urls.filter((url) => url.trim()).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Baseline Tests</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Weekly assessments of independent problem-solving. Separate from daily
            assignments — results never affect streaks, completion or leaderboards.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScopeFilter />
          <Button variant="primary" onClick={() => (creating ? reset() : setCreating(true))}>
            <Plus className="size-3.5" aria-hidden />
            Create test
          </Button>
        </div>
      </header>

      {creating ? (
        <Card>
          <CardHeader
            title="Create baseline test"
            description="Paste LeetCode problem URLs. Points default by difficulty: Easy 10, Medium 20, Hard 30."
          />
          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="bt-name" className="mb-1.5 block text-xs font-medium">
                  Name
                </label>
                <input
                  id="bt-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Baseline Test #1"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </div>
              <div>
                <label htmlFor="bt-date" className="mb-1.5 block text-xs font-medium">
                  Date
                </label>
                <input
                  id="bt-date"
                  type="date"
                  value={dayKey}
                  onChange={(event) => setDayKey(event.target.value)}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </div>
              <div>
                <label htmlFor="bt-duration" className="mb-1.5 block text-xs font-medium">
                  Duration (minutes)
                </label>
                <input
                  id="bt-duration"
                  type="number"
                  min={5}
                  max={600}
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(Number(event.target.value))}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-medium">
                Campus <span className="text-[var(--color-danger)]">*</span>
              </span>
              <div className="flex flex-wrap gap-2">
                <AudienceButton
                  selected={campusChoiceMade && targetCampusId === null}
                  onClick={() => {
                    setTargetCampusId(null);
                    setCampusChoiceMade(true);
                    setTargetBatchId(null);
                    setBatchChoiceMade(false);
                  }}
                >
                  All campuses
                </AudienceButton>
                {campuses.map((entry) => (
                  <AudienceButton
                    key={entry.id}
                    selected={campusChoiceMade && targetCampusId === entry.id}
                    onClick={() => {
                      setTargetCampusId(entry.id);
                      setCampusChoiceMade(true);
                      setTargetBatchId(null);
                      setBatchChoiceMade(false);
                    }}
                  >
                    {entry.name}
                  </AudienceButton>
                ))}
              </div>
            </div>

            {targetCampusId !== null && batches.length > 0 ? (
              <div>
                <span className="mb-1.5 block text-xs font-medium">
                  Batch <span className="text-[var(--color-danger)]">*</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  <AudienceButton
                    selected={batchChoiceMade && targetBatchId === null}
                    onClick={() => {
                      setTargetBatchId(null);
                      setBatchChoiceMade(true);
                    }}
                  >
                    All batches at {targetCampusName}
                  </AudienceButton>
                  {batches.map((entry) => (
                    <AudienceButton
                      key={entry.id}
                      selected={batchChoiceMade && targetBatchId === entry.id}
                      onClick={() => {
                        setTargetBatchId(entry.id);
                        setBatchChoiceMade(true);
                      }}
                    >
                      {entry.name}
                    </AudienceButton>
                  ))}
                </div>
              </div>
            ) : null}

            {urls.map((url, index) => (
              <div key={index}>
                <label htmlFor={`bt-problem-${index}`} className="mb-1.5 block text-xs font-medium">
                  Problem {index + 1}
                </label>
                <input
                  id={`bt-problem-${index}`}
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

            <div>
              <label htmlFor="bt-instructions" className="mb-1.5 block text-xs font-medium">
                Instructions for students (optional)
              </label>
              <textarea
                id="bt-instructions"
                rows={2}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Solve these independently. Do not look up solutions."
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
              />
            </div>

            {filledCount > 0 ? (
              <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
                <p className="font-medium">Preview</p>
                <p className="mt-1 text-[var(--color-fg-muted)]">
                  {!campusChoiceMade
                    ? 'Pick a target campus above to see what will be created.'
                    : `${filledCount} problem${filledCount === 1 ? '' : 's'}, ${durationMinutes} minutes, on ${dayKey} for ${targetCampusName} — ${targetBatchName}.`}
                </p>
                <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                  Created as a draft. Students see nothing until it is published.
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
                  name.trim() === '' ||
                  !campusChoiceMade ||
                  (targetCampusId !== null && batches.length > 0 && !batchChoiceMade)
                }
              >
                Create draft
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                onClick={() => setUrls((current) => [...current, ''])}
                className="text-xs"
              >
                Add another problem
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Tests" description="Newest first." />
        {tests.isLoading ? (
          <TableSkeleton rows={5} cols={7} />
        ) : tests.error ? (
          <ErrorState error={tests.error} onRetry={() => void tests.refetch()} />
        ) : (tests.data ?? []).length === 0 ? (
          <EmptyState
            title="No baseline tests yet"
            description="Create one to assess how students perform without help."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Test</Th>
                <Th>Date</Th>
                <Th>Campus</Th>
                <Th>Batch</Th>
                <Th className="text-right">Problems</Th>
                <Th className="text-right">Participation</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {(tests.data ?? []).map((test) => (
                <TestRow key={test.id} test={test} onDuplicate={() => duplicate.mutate(test.id)} />
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}

function AudienceButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={
        selected
          ? 'rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-[var(--color-brand-fg)]'
          : 'rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
      }
    >
      {children}
    </button>
  );
}

function TestRow({
  test,
  onDuplicate,
}: {
  test: BaselineTestSummary;
  onDuplicate: () => void;
}) {
  return (
    <tr className="transition hover:bg-[var(--color-surface-sunken)]">
      <Td>
        <Link
          href={`/baseline-tests/${test.id}`}
          className="font-medium hover:text-[var(--color-brand)]"
        >
          {test.name}
        </Link>
        {/* Mentor-only triage count. Phrased as a recommendation, never a verdict (§23). */}
        {test.reviewRequiredCount > 0 ? (
          <p className="text-xs text-[var(--color-warning)]">
            {test.reviewRequiredCount} attempt{test.reviewRequiredCount === 1 ? '' : 's'} to
            review
          </p>
        ) : null}
      </Td>
      <Td className="tabular-nums">{test.dayKey}</Td>
      <Td>
        {test.campusCode ? (
          <CampusChip code={test.campusCode} name={test.campusName} />
        ) : (
          <Badge tone="neutral">All</Badge>
        )}
      </Td>
      <Td>
        {test.batchCode ? (
          <BatchChip code={test.batchCode} name={test.batchName} />
        ) : (
          <Badge tone="neutral">All</Badge>
        )}
      </Td>
      <Td className="text-right tabular-nums">{test.problems.length}</Td>
      <Td className="text-right tabular-nums text-[var(--color-fg-muted)]">
        {test.startedCount} / {test.eligibleStudentCount}
      </Td>
      <Td>
        <Badge tone={STATUS_TONE[test.status] ?? 'neutral'}>
          {BASELINE_TEST_STATUS_LABELS[test.status]}
        </Badge>
      </Td>
      <Td className="text-right">
        <Button variant="ghost" className="text-xs" onClick={onDuplicate}>
          <CopyPlus className="size-3.5" aria-hidden />
          Duplicate
        </Button>
      </Td>
    </tr>
  );
}
