'use client';

/**
 * "Change Assignment Target" (§9) — reconfigure which batch(es) an existing assignment
 * currently applies to, most often a pre-batch legacy row ("All students") being scoped
 * to Foundation, Intermediate, or explicitly kept as "Both".
 *
 * Mirrors `MoveBatchDialog`'s shape and the same instinct: state plainly what does and
 * does not change. What does not change is every day already scored against this
 * assignment — the backend freezes `DailyStatus.assignmentId` the first time a day is
 * computed, so retargeting can never silently rewrite a result that already exists.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AssignmentSummary, BatchSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { Badge, Button, Modal } from '@/components/ui';

const BOTH = 'BOTH';

export function ChangeAssignmentTargetDialog({
  assignment,
  batches,
  open,
  onClose,
}: {
  assignment: AssignmentSummary | null;
  batches: BatchSummary[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string>('');
  const [reason, setReason] = useState('');

  const history = useQuery({
    queryKey: ['assignment-target-history', assignment?.id],
    queryFn: () => api.assignmentTargetHistory(assignment!.id),
    enabled: open && !!assignment,
  });

  const options = [
    { value: BOTH, label: 'Both (all batches)' },
    ...batches.map((batch) => ({ value: batch.id, label: batch.name })),
  ];
  const currentLabel = assignment?.batchId
    ? (assignment.batchName ?? 'that batch')
    : 'Both (all batches)';
  const targetLabel = options.find((option) => option.value === target)?.label ?? null;
  const isNoop = target !== '' && (target === (assignment?.batchId ?? BOTH));

  const change = useMutation({
    mutationFn: () => api.changeAssignmentTarget(assignment!.id, target, reason.trim() || undefined),
    onSuccess: () => {
      toast.success(`Target changed to ${targetLabel ?? 'the new audience'}`, {
        description: 'Days already scored keep the results they were actually computed with.',
      });
      void queryClient.invalidateQueries({ queryKey: ['assignments'] });
      void queryClient.invalidateQueries({ queryKey: ['assignment-target-history'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['mentor'] });
      reset();
      onClose();
    },
    onError: (error: Error) => toast.error('Could not change target', { description: error.message }),
  });

  const reset = (): void => {
    setTarget('');
    setReason('');
  };

  if (!assignment) return null;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Change assignment target"
    >
      <div className="space-y-4 p-5">
        <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
          <p className="font-medium">
            {assignment.dayKey} · {assignment.problems.length} problem
            {assignment.problems.length === 1 ? '' : 's'}
          </p>
          <p className="text-[var(--color-fg-muted)]">Currently targets: {currentLabel}</p>
          {assignment.originalBatchId !== assignment.batchId || assignment.audienceChangedAt ? (
            <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
              Originally assigned to{' '}
              {assignment.originalBatchId ? (assignment.originalBatchName ?? 'a batch') : 'Both (all batches)'}
              {assignment.audienceChangedAt
                ? ` · retargeted ${new Date(assignment.audienceChangedAt).toLocaleDateString()}`
                : ''}
              .
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Target batch</span>
          <div className="space-y-1.5">
            {options.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-brand)]"
              >
                <input
                  type="radio"
                  name="target-batch"
                  value={option.value}
                  checked={target === option.value}
                  onChange={(event) => setTarget(event.target.value)}
                />
                {option.label}
                {option.value === (assignment.batchId ?? BOTH) ? (
                  <Badge tone="neutral" className="ml-auto">
                    current
                  </Badge>
                ) : null}
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="target-reason" className="text-sm font-medium">
            Reason <span className="font-normal text-[var(--color-fg-subtle)]">(optional)</span>
          </label>
          <textarea
            id="target-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. This day's set was actually Foundation-only"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Recorded in the assignment&rsquo;s audience history alongside who made the change.
          </p>
        </div>

        {targetLabel ? (
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
            <p className="font-medium">
              Retarget {assignment.dayKey} from {currentLabel} to {targetLabel}?
            </p>
            <p className="mt-1 text-[var(--color-fg-muted)]">
              Days already computed against this assignment keep exactly the results they were
              scored with — this only changes who is evaluated against it going forward.
            </p>
          </div>
        ) : null}

        {!history.isLoading && history.data && history.data.length > 0 ? (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-[var(--color-fg-muted)]">
              Previous changes
            </span>
            <ul className="space-y-1 text-xs text-[var(--color-fg-subtle)]">
              {history.data.map((entry) => (
                <li key={entry.id}>
                  {new Date(entry.changedAt).toLocaleDateString()}:{' '}
                  {entry.fromBatchName ?? 'Both'} → {entry.toBatchName ?? 'Both'}
                  {entry.changedByName ? ` by ${entry.changedByName}` : ''}
                  {entry.reason ? ` — ${entry.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!target || isNoop}
            loading={change.isPending}
            onClick={() => change.mutate()}
          >
            Save target
          </Button>
        </div>
      </div>
    </Modal>
  );
}
