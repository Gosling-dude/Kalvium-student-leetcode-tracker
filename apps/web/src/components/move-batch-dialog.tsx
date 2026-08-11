'use client';

/**
 * "Move Abishek R V from Foundation to Intermediate?" — the confirmation step for a
 * batch move (§6).
 *
 * The dialog states plainly what is about to change *and* what is not, because the
 * question a mentor actually has before clicking is "does this wipe their history?".
 * The answer is no, and saying so here is cheaper than an explanation after the fact.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BatchSummary, StudentSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { Button, Modal } from '@/components/ui';

export function MoveBatchDialog({
  student,
  batches,
  open,
  onClose,
}: {
  student: Pick<StudentSummary, 'id' | 'name' | 'batchId' | 'batchName'> | null;
  batches: BatchSummary[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [toBatchId, setToBatchId] = useState('');
  const [reason, setReason] = useState('');

  const destinations = batches.filter((batch) => batch.id !== student?.batchId);
  const target = destinations.find((batch) => batch.id === toBatchId) ?? null;

  const move = useMutation({
    mutationFn: () => api.moveStudentBatch(student!.id, toBatchId, reason.trim() || undefined),
    onSuccess: (result) => {
      toast.success(`${result.name} moved to ${target?.name ?? 'the new batch'}`, {
        description: 'All history, streaks and past results were preserved.',
      });
      // Every batch-scoped view is now stale: the student has left one and joined another.
      void queryClient.invalidateQueries({ queryKey: ['students'] });
      void queryClient.invalidateQueries({ queryKey: ['student'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['batch-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['mentor'] });
      void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
      reset();
      onClose();
    },
    onError: (error: Error) => toast.error('Could not move student', { description: error.message }),
  });

  const reset = (): void => {
    setToBatchId('');
    setReason('');
  };

  if (!student) return null;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Move student to another batch"
    >
      <div className="space-y-4 p-5">
        <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
          <p className="font-medium">{student.name}</p>
          <p className="text-[var(--color-fg-muted)]">
            Current batch: {student.batchName ?? 'None'}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="toBatch" className="text-sm font-medium">
            Move to
          </label>
          <select
            id="toBatch"
            value={toBatchId}
            onChange={(event) => setToBatchId(event.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          >
            <option value="">Select a batch…</option>
            {destinations.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="reason" className="text-sm font-medium">
            Reason <span className="font-normal text-[var(--color-fg-subtle)]">(optional)</span>
          </label>
          <textarea
            id="reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Consistently completing Foundation work early"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Recorded in the student&rsquo;s batch history alongside who made the change.
          </p>
        </div>

        {target ? (
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
            <p className="font-medium">
              Move {student.name} from {student.batchName ?? 'no batch'} to {target.name}?
            </p>
            <p className="mt-1 text-[var(--color-fg-muted)]">
              From today onwards they are assessed against {target.name}&rsquo;s questions.
              Their past assignments, results, streak, leaderboard history and LeetCode data
              are all kept exactly as they are, and earlier days stay recorded under{' '}
              {student.batchName ?? 'their previous batch'}.
            </p>
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
            disabled={!toBatchId}
            loading={move.isPending}
            onClick={() => move.mutate()}
          >
            Move student
          </Button>
        </div>
      </div>
    </Modal>
  );
}
