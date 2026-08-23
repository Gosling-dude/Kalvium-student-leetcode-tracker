'use client';

/**
 * "Which LeetCode account is this student's?" — the admin action for the roster gap (§7).
 *
 * 21 students arrived on the SRM roster with no handle. Until now the only way to close
 * that gap was to re-import the whole spreadsheet: the directory could *show* the gap
 * (`PROFILE_MISSING`) but offered nowhere to fix it, so the list of students needing
 * attention only ever grew.
 *
 * Two properties this dialog is careful about:
 *
 *  * **It only ever writes the handle.** Campus, batch, cohort, squad, belt and every
 *    historical row are untouched — linking an account is not a placement decision, and
 *    a student who gains a handle must not silently gain anything else (§15, §16).
 *  * **It never invents one.** There is no "guess from the name" affordance and no
 *    default value. An empty field submits nothing; unlinking is deliberate and separate.
 *
 * The sync is offered straight afterwards because the question the admin has next is
 * always "did that work?", and the answer arrives one sync later either way.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SYNC_STATUS_LABELS, type StudentSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { Button, Modal } from '@/components/ui';

/** Accepts a bare handle or a pasted profile URL — the server normalises the same way. */
function extractHandle(value: string): string {
  const match = /leetcode\.com\/(?:u\/|profile\/)?([A-Za-z0-9_-]+)/i.exec(value.trim());
  return (match?.[1] ?? value.trim().replace(/^@/, '')).toLowerCase();
}

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

export function LeetCodeProfileDialog({
  student,
  open,
  onClose,
}: {
  student: Pick<StudentSummary, 'id' | 'name' | 'email' | 'leetcodeUsername' | 'syncStatus'> | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');

  // Seeded per student rather than once, so opening the dialog on a second row does not
  // show the first row's handle sitting in the field as if it were theirs.
  useEffect(() => {
    setValue(student?.leetcodeUsername ?? '');
  }, [student]);

  const handle = extractHandle(value);
  const unchanged = handle === (student?.leetcodeUsername ?? '');
  const valid = handle === '' || HANDLE_PATTERN.test(handle);

  const save = useMutation({
    mutationFn: async () => {
      await api.updateStudent(student!.id, { leetcodeUsername: handle });
      // Sync just this student, so the row stops saying "no profile linked" without
      // waiting up to three hours for the next scheduled run.
      await api.startSync({ studentIds: [student!.id] });
    },
    onSuccess: () => {
      toast.success(`Linked ${handle} to ${student?.name}`, {
        description: 'A sync for this student has been queued.',
      });
      for (const key of ['students', 'student', 'dashboard', 'mentor', 'leaderboard', 'sync']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onClose();
    },
    onError: (error: Error) =>
      toast.error('Could not update the LeetCode profile', { description: error.message }),
  });

  if (!student) return null;

  return (
    <Modal open={open} onClose={onClose} title="LeetCode profile">
      <div className="space-y-4 p-5">
        <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3 text-sm">
          <p className="font-medium">{student.name}</p>
          <p className="text-[var(--color-fg-muted)]">{student.email}</p>
          <p className="mt-1 text-[var(--color-fg-muted)]">
            Currently:{' '}
            {student.leetcodeUsername ? (
              <span className="font-mono text-xs">{student.leetcodeUsername}</span>
            ) : (
              'not linked'
            )}{' '}
            · {SYNC_STATUS_LABELS[student.syncStatus]}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="leetcode-handle" className="text-sm font-medium">
            LeetCode username or profile URL
          </label>
          <input
            id="leetcode-handle"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="asha_menon or https://leetcode.com/u/asha_menon/"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
          {value.trim() !== '' && handle !== value.trim().toLowerCase() ? (
            <p className="text-xs text-[var(--color-fg-subtle)]">
              Will be saved as <span className="font-mono">{handle}</span>
            </p>
          ) : null}
          {!valid ? (
            <p className="text-xs text-[var(--color-danger)]">
              A handle may contain letters, digits, underscore and hyphen only.
            </p>
          ) : null}
        </div>

        {/*
          Stated because it is the question an admin has before clicking, and because the
          answer is the whole point of keeping identity and sync apart (§16).
        */}
        <p className="text-xs text-[var(--color-fg-subtle)]">
          Only the LeetCode handle changes. Campus, batch, cohort, squad, belt level and all
          past results stay exactly as they are. Solved counts are read from the new account
          from scratch, since submissions already mirrored belong to the previous one.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid || unchanged || handle === ''}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save and sync
          </Button>
        </div>
      </div>
    </Modal>
  );
}
