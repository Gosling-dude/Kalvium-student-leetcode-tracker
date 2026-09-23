'use client';

/**
 * Edit one Infosys student's name, email, campus and/or LeetCode profile.
 *
 * Deliberately its own dialog, not a reuse of `LeetCodeProfileDialog` — that one writes
 * `Student.leetcodeUsername` for a Coding-Hours student and queues a Coding-Hours sync;
 * this one writes the same column but only ever for an Infosys-enrolled student, and
 * triggers `InfosysRollupService.recomputeStudent` instead (the backend enforces this
 * separation too — see `InfosysStudentsService`).
 *
 * The profile field is never trusted on the client: the server extracts the username,
 * verifies it live against LeetCode, and refuses a duplicate or an unresolvable link.
 * Errors from that come back as a plain message and are shown as-is, not reinterpreted.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { leetcodeProfileUrlFor, type InfosysStudentAnalysis } from '@dsa/shared';

import { api } from '@/lib/api';
import { Button, Modal } from '@/components/ui';

export function InfosysEditStudentDialog({
  student,
  open,
  onClose,
}: {
  student: InfosysStudentAnalysis | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const campuses = useQuery({ queryKey: ['campuses', 'all'], queryFn: () => api.campuses() });

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [campusId, setCampusId] = useState('');
  const [profileUrl, setProfileUrl] = useState('');

  // Seeded per student, not once, so a second row's edit never starts from the first
  // row's values still sitting in the fields.
  useEffect(() => {
    setName(student?.name ?? '');
    setEmail(student?.email ?? '');
    setProfileUrl(student?.leetcodeUsername ? leetcodeProfileUrlFor(student.leetcodeUsername) : '');
    const match = campuses.data?.find((c) => c.name === student?.campusName);
    setCampusId(match?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student, campuses.data]);

  const save = useMutation({
    mutationFn: () => {
      const body: { name?: string; email?: string; campusId?: string; leetcodeProfileUrl?: string } = {};
      if (name.trim() !== student?.name) body.name = name.trim();
      if (email.trim().toLowerCase() !== (student?.email ?? '').toLowerCase()) body.email = email.trim();
      const currentCampus = campuses.data?.find((c) => c.name === student?.campusName)?.id ?? '';
      if (campusId && campusId !== currentCampus) body.campusId = campusId;
      const currentProfileUrl = student?.leetcodeUsername ? leetcodeProfileUrlFor(student.leetcodeUsername) : '';
      if (profileUrl.trim() !== currentProfileUrl) body.leetcodeProfileUrl = profileUrl.trim();
      return api.updateInfosysStudent(student!.studentId, body);
    },
    onSuccess: () => {
      toast.success(`Updated ${student?.name}`);
      for (const key of ['infosys-students', 'infosys-dashboard', 'infosys-daily-report']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onClose();
    },
    onError: (error: Error) => toast.error('Could not update this student', { description: error.message }),
  });

  if (!student) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${student.name}`} description="Infosys Preparation only — never Coding Hours.">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="infosys-edit-name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="infosys-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="infosys-edit-email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="infosys-edit-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="infosys-edit-campus" className="text-sm font-medium">
            Campus
          </label>
          <select
            id="infosys-edit-campus"
            value={campusId}
            onChange={(e) => setCampusId(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          >
            <option value="" disabled>
              {campuses.isLoading ? 'Loading…' : 'Select a campus'}
            </option>
            {(campuses.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="infosys-edit-profile" className="text-sm font-medium">
            LeetCode profile URL
          </label>
          <input
            id="infosys-edit-profile"
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="https://leetcode.com/u/handle/"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono outline-none focus:border-[var(--color-brand)]"
          />
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Verified live against LeetCode before saving. Clear the field to explicitly unlink the profile.
            A successful change recomputes this student’s whole Infosys history.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
