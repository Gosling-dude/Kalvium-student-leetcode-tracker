'use client';

/**
 * Edit a Coding-Hours student's name, email, campus, batch, squad and/or LeetCode
 * profile — the Campus Analysis counterpart to `LeetCodeProfileDialog`, generalised to
 * every field `PATCH /students/:id` (`StudentsService.update`) already accepts. No new
 * backend mutation logic: this dialog is a UI surface over the existing, already-tested
 * update path (campus/batch transfers still write their history rows, archiving still
 * dates itself, exactly as they do from the Students page).
 *
 * The LeetCode field keeps the existing product's validation model — a client-side
 * format check, not a live LeetCode call before saving (that is Infosys Preparation's
 * own, separate rule; see `InfosysStudentsService` for why it is stricter there). A
 * changed handle queues a sync immediately afterward, same as `LeetCodeProfileDialog`,
 * so the row does not sit stale for up to three hours.
 *
 * Only loads the full editable record when opened — the calling table only carries a
 * `studentId` and a `name`, not email/campusId/batchId/squadId, so those are fetched here
 * on demand rather than bloating every list response for an action used occasionally.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button, Modal, Skeleton } from '@/components/ui';

export interface EditableStudent {
  studentId: string;
  name: string;
}

function extractHandle(value: string): string {
  const match = /leetcode\.com\/(?:u\/|profile\/)?([A-Za-z0-9_-]+)/i.exec(value.trim());
  return (match?.[1] ?? value.trim().replace(/^@/, '')).toLowerCase();
}

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

export function EditStudentDialog({
  student,
  open,
  onClose,
}: {
  student: EditableStudent | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const full = useQuery({
    queryKey: ['student', student?.studentId],
    queryFn: () => api.student(student!.studentId),
    enabled: open && !!student,
  });
  const filters = useQuery({ queryKey: ['students', 'filters'], queryFn: api.studentFilters, enabled: open });

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [campusId, setCampusId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [squadId, setSquadId] = useState('');
  const [leetcode, setLeetcode] = useState('');

  useEffect(() => {
    if (!full.data) return;
    setName(full.data.name);
    setEmail(full.data.email ?? '');
    setCampusId(full.data.campusId ?? '');
    setBatchId(full.data.batchId ?? '');
    setSquadId(full.data.squadId ?? '');
    setLeetcode(full.data.leetcodeUsername ?? '');
  }, [full.data]);

  const handle = extractHandle(leetcode);
  const handleValid = handle === '' || HANDLE_PATTERN.test(handle);
  const batchesForCampus = (filters.data?.batches ?? []).filter((b) => !campusId || b.campusId === campusId);
  const squadsForCampus = (filters.data?.squads ?? []).filter((s) => !campusId || s.campusId === campusId);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (name.trim() !== full.data?.name) body.name = name.trim();
      if (email.trim().toLowerCase() !== (full.data?.email ?? '')) body.email = email.trim();
      if (campusId && campusId !== (full.data?.campusId ?? '')) body.campusId = campusId;
      if (batchId !== (full.data?.batchId ?? '')) body.batchId = batchId || null;
      if (squadId !== (full.data?.squadId ?? '')) body.squadId = squadId || null;
      const leetcodeChanged = handle !== (full.data?.leetcodeUsername ?? '');
      if (leetcodeChanged && handle !== '') body.leetcodeUsername = handle;

      await api.updateStudent(student!.studentId, body);
      if (leetcodeChanged && handle !== '') {
        await api.startSync({ studentIds: [student!.studentId] });
      }
    },
    onSuccess: () => {
      toast.success(`Updated ${student?.name}`);
      for (const key of ['campus-analysis', 'students', 'student', 'dashboard', 'mentor', 'leaderboard', 'campus-daily-report']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onClose();
    },
    onError: (error: Error) => toast.error('Could not update this student', { description: error.message }),
  });

  if (!student) return null;

  const inputClass =
    'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]';

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${student.name}`} description="Coding Hours only — never Infosys Preparation.">
      {full.isLoading || !full.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="edit-name" className="text-sm font-medium">
              Name
            </label>
            <input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-email" className="text-sm font-medium">
              Email
            </label>
            <input id="edit-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="edit-campus" className="text-sm font-medium">
                Campus
              </label>
              <select
                id="edit-campus"
                value={campusId}
                onChange={(e) => {
                  setCampusId(e.target.value);
                  setBatchId('');
                  setSquadId('');
                }}
                className={inputClass}
              >
                <option value="" disabled>
                  Select
                </option>
                {(filters.data?.campuses ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-batch" className="text-sm font-medium">
                Batch
              </label>
              <select id="edit-batch" value={batchId} onChange={(e) => setBatchId(e.target.value)} className={inputClass}>
                <option value="">None</option>
                {batchesForCampus.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-squad" className="text-sm font-medium">
                Squad
              </label>
              <select id="edit-squad" value={squadId} onChange={(e) => setSquadId(e.target.value)} className={inputClass}>
                <option value="">None</option>
                {squadsForCampus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-leetcode" className="text-sm font-medium">
              LeetCode username or profile URL
            </label>
            <input
              id="edit-leetcode"
              value={leetcode}
              onChange={(e) => setLeetcode(e.target.value)}
              placeholder="asha_menon or https://leetcode.com/u/asha_menon/"
              className={inputClass}
            />
            {!handleValid ? (
              <p className="text-xs text-[var(--color-danger)]">A handle may contain letters, digits, underscore and hyphen only.</p>
            ) : null}
            <p className="text-xs text-[var(--color-fg-subtle)]">
              A changed handle queues a sync for this student immediately. Clearing this field does not blank an
              existing profile — remove it from the Students page if that is genuinely intended.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!handleValid} loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
