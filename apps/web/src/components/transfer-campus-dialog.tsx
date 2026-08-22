'use client';

/**
 * "Transfer Asha from Vels to SRM?" — the confirmation step for a campus transfer (§16).
 *
 * Separate from `MoveBatchDialog` because the two operations differ in a way that matters:
 * a batch move stays inside a campus, while a transfer necessarily moves the batch too,
 * since batches belong to campuses. The backend writes both history rows in one
 * transaction; this dialog exists so the admin understands that before it happens.
 *
 * Like the batch dialog, it states plainly what does *not* change — because the question
 * anyone actually has before clicking is "does this wipe their history?". The answer is
 * no, and saying so here is cheaper than an explanation afterwards.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CampusSummary, StudentSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { Button, Modal } from '@/components/ui';

export function TransferCampusDialog({
  student,
  campuses,
  open,
  onClose,
}: {
  student: Pick<
    StudentSummary,
    'id' | 'name' | 'campusId' | 'campusName' | 'batchId' | 'batchName'
  > | null;
  campuses: CampusSummary[];
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [toCampusId, setToCampusId] = useState('');
  const [toBatchId, setToBatchId] = useState('');
  const [reason, setReason] = useState('');

  const destinations = campuses.filter((campus) => campus.id !== student?.campusId);
  const target = destinations.find((campus) => campus.id === toCampusId) ?? null;

  // The destination campus's batches. Only fetched once a campus is chosen, because the
  // student is not going into "a Foundation" — they are going into *that campus's*.
  const batches = useQuery({
    queryKey: ['campus-batches', toCampusId],
    queryFn: () => api.campusBatches(toCampusId),
    enabled: open && toCampusId !== '',
  });

  const targetBatch = (batches.data ?? []).find((batch) => batch.id === toBatchId) ?? null;

  const transfer = useMutation({
    mutationFn: () =>
      api.transferStudentCampus(
        student!.id,
        toCampusId,
        toBatchId || undefined,
        reason.trim() || undefined,
      ),
    onSuccess: (result) => {
      toast.success(`${result.name} transferred to ${target?.name ?? 'the new campus'}`, {
        description: 'All history, streaks and past results were preserved.',
      });
      // Every campus- and batch-scoped view is now stale.
      for (const key of [
        'students',
        'student',
        'campuses',
        'campus-stats',
        'batches',
        'batch-stats',
        'dashboard',
        'mentor',
        'leaderboard',
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      reset();
      onClose();
    },
    onError: (error: Error) =>
      toast.error('Could not transfer student', { description: error.message }),
  });

  const reset = (): void => {
    setToCampusId('');
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
      title="Transfer campus"
    >
      <div className="space-y-4 p-5">
        <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
          <p className="font-medium">{student.name}</p>
          <p className="text-[var(--color-fg-muted)]">
            Currently at {student.campusName ?? 'no campus'}
            {student.batchName ? ` — ${student.batchName}` : ''}
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Destination campus</span>
          <div className="space-y-1.5">
            {destinations.map((campus) => (
              <label
                key={campus.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-brand)]"
              >
                <input
                  type="radio"
                  name="to-campus"
                  value={campus.id}
                  checked={toCampusId === campus.id}
                  onChange={(event) => {
                    setToCampusId(event.target.value);
                    // A campus change invalidates the batch: ids belong to one campus.
                    setToBatchId('');
                  }}
                />
                {campus.name}
              </label>
            ))}
          </div>
        </div>

        {toCampusId ? (
          <div className="space-y-1.5">
            <span className="text-sm font-medium">
              Batch at {target?.name ?? 'the new campus'}{' '}
              <span className="font-normal text-[var(--color-fg-subtle)]">(optional)</span>
            </span>
            <div className="space-y-1.5">
              {(batches.data ?? []).map((batch) => (
                <label
                  key={batch.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:border-[var(--color-brand)]"
                >
                  <input
                    type="radio"
                    name="to-batch"
                    value={batch.id}
                    checked={toBatchId === batch.id}
                    onChange={(event) => setToBatchId(event.target.value)}
                  />
                  {batch.name}
                </label>
              ))}
            </div>
            <p className="text-xs text-[var(--color-fg-subtle)]">
              Leave this unset and the student lands in {target?.name ?? 'the campus'}&rsquo;s
              placement-pending batch — the honest state for someone who has not been
              re-assessed there yet.
            </p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <label htmlFor="transfer-reason" className="text-sm font-medium">
            Reason <span className="font-normal text-[var(--color-fg-subtle)]">(optional)</span>
          </label>
          <textarea
            id="transfer-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Relocated to the SRM campus for the second semester"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Recorded in the student&rsquo;s campus history alongside who made the change.
          </p>
        </div>

        {target ? (
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
            <p className="font-medium">
              Transfer {student.name} to {target.name}
              {targetBatch ? ` — ${targetBatch.name}` : ' (placement pending)'}?
            </p>
            {/*
              The reassurance this dialog exists for. Past days keep the campus and batch
              frozen on them, so every report about a day before today still reads exactly
              as it did (§17).
            */}
            <p className="mt-1 text-[var(--color-fg-muted)]">
              Submissions, streaks, past results and leaderboard history are all preserved,
              and every past day keeps the campus it was actually recorded under. The
              transfer takes effect from today forward.
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
            disabled={!toCampusId}
            loading={transfer.isPending}
            onClick={() => transfer.mutate()}
          >
            Transfer campus
          </Button>
        </div>
      </div>
    </Modal>
  );
}
