'use client';

/**
 * "Change Assignment Target" (§9) — reconfigure which campus and batch an existing
 * assignment currently applies to.
 *
 * The campus half is chosen first and the batch list follows it, for the same reason the
 * create form works that way: both campuses have a "Foundation Level", so a flat list
 * would offer two identical labels meaning different cohorts.
 *
 * Mirrors `MoveBatchDialog`'s shape and the same instinct: state plainly what does and
 * does not change. What does not change is every day already scored against this
 * assignment — the backend freezes `DailyStatus.assignmentId` the first time a day is
 * computed, so retargeting can never silently rewrite a result that already exists.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AssignmentSummary, BatchSummary, CampusSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { Badge, Button, Modal } from '@/components/ui';

const BOTH = 'BOTH';
const ALL_CAMPUSES = 'ALL';

export function ChangeAssignmentTargetDialog({
  assignment,
  campuses,
  open,
  onClose,
}: {
  assignment: AssignmentSummary | null;
  campuses: CampusSummary[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [campus, setCampus] = useState<string>('');
  const [target, setTarget] = useState<string>('');
  const [reason, setReason] = useState('');

  const history = useQuery({
    queryKey: ['assignment-target-history', assignment?.id],
    queryFn: () => api.assignmentTargetHistory(assignment!.id),
    enabled: open && !!assignment,
  });

  // Batches for the campus being retargeted *to*, so the list can never offer a batch
  // that does not belong to it — which the backend would reject anyway, but only after
  // the admin had already chosen it.
  const campusBatches = useQuery({
    queryKey: ['campus-batches', campus],
    queryFn: () => api.campusBatches(campus),
    enabled: open && campus !== '' && campus !== ALL_CAMPUSES,
  });
  const batches: BatchSummary[] = campus === ALL_CAMPUSES ? [] : (campusBatches.data ?? []);

  const campusOptions = [
    { value: ALL_CAMPUSES, label: 'All campuses' },
    ...campuses.map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  const options = [
    { value: BOTH, label: 'All batches' },
    ...batches.map((batch) => ({ value: batch.id, label: batch.name })),
  ];

  const currentLabel = assignment?.audienceLabel ?? 'All campuses — All batches';
  const campusLabel = campusOptions.find((option) => option.value === campus)?.label ?? null;
  const batchLabel = options.find((option) => option.value === target)?.label ?? null;
  const targetLabel = campusLabel && batchLabel ? `${campusLabel} — ${batchLabel}` : null;
  const isNoop =
    campus !== '' &&
    campus === (assignment?.campusId ?? ALL_CAMPUSES) &&
    (target === '' || target === (assignment?.batchId ?? BOTH));

  const change = useMutation({
    mutationFn: () =>
      api.changeAssignmentTarget(
        assignment!.id,
        campus,
        target || BOTH,
        reason.trim() || undefined,
      ),
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
    setCampus('');
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
          {assignment.originalBatchId !== assignment.batchId ||
          assignment.originalCampusId !== assignment.campusId ||
          assignment.audienceChangedAt ? (
            <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
              Originally assigned to {assignment.originalCampusName ?? 'All campuses'} —{' '}
              {assignment.originalBatchName ?? 'All batches'}
              {assignment.audienceChangedAt
                ? ` · retargeted ${new Date(assignment.audienceChangedAt).toLocaleDateString()}`
                : ''}
              .
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Target campus</span>
          <div className="space-y-1.5">
            {campusOptions.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-brand)]"
              >
                <input
                  type="radio"
                  name="target-campus"
                  value={option.value}
                  checked={campus === option.value}
                  onChange={(event) => {
                    setCampus(event.target.value);
                    // A campus change invalidates the batch choice — ids belong to one
                    // campus, and keeping one would target the wrong cohort.
                    setTarget('');
                  }}
                />
                {option.label}
                {option.value === (assignment.campusId ?? ALL_CAMPUSES) ? (
                  <Badge tone="neutral" className="ml-auto">
                    current
                  </Badge>
                ) : null}
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1.5" hidden={campus === '' || campus === ALL_CAMPUSES}>
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
                  {entry.fromCampusName ?? 'All campuses'} —{' '}
                  {entry.fromBatchName ?? 'All batches'} → {entry.toCampusName ?? 'All campuses'} —{' '}
                  {entry.toBatchName ?? 'All batches'}
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
            disabled={campus === '' || isNoop}
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
