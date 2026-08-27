'use client';

/**
 * Admin-only mentor management: who mentors which campus, and their access.
 *
 * Exists so that adding a mentor is not a database task. Everything here was previously
 * possible only through the API by hand or through psql, which meant in practice that
 * campus grants were set once at migration time and never revisited — and a mentor with
 * the wrong grants either sees nothing or sees a campus that is not theirs.
 *
 * Two rules the UI is deliberately built around:
 *
 *  * **Campus is picked from real campus records**, never typed and never a constant in
 *    this file. The grant is a foreign key; offering a free-text box would let an admin
 *    create a mentor pointing at a campus that does not exist, which fails as an empty
 *    screen at login rather than as an error here.
 *
 *  * **Deactivation is soft and confirmed.** The account keeps its grants and its audit
 *    trail — those rows are the record of who changed what — and comes back with exactly
 *    the access it had. Nothing here deletes a user.
 *
 * A generated password is shown exactly once, in the modal that opens after a create or
 * reset succeeds. It is never persisted client-side beyond that modal and never logged.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, KeyRound, ShieldCheck, UserPlus } from 'lucide-react';

import { api, type MentorAccountRow, type ProvisionedMentorResponse } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Modal,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

const inputClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]';

export function MentorManagement() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<ProvisionedMentorResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<MentorAccountRow | null>(null);
  const [form, setForm] = useState({ name: '', email: '', campusId: '' });

  const mentors = useQuery({ queryKey: ['admin', 'mentors'], queryFn: api.mentors });
  const campuses = useQuery({ queryKey: ['campuses'], queryFn: api.campuses });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'mentors'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.createMentor({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        campusIds: form.campusId ? [form.campusId] : [],
      }),
    onSuccess: (result) => {
      setAdding(false);
      setForm({ name: '', email: '', campusId: '' });
      refresh();
      // Only open the credential modal when there is something to show: with a shared
      // initial password configured the server returns null, and a modal reading
      // "password: —" invites the admin to think something went wrong.
      if (result.tempPassword) setIssued(result);
      else toast.success(`${result.email} created`, { description: 'Uses the shared initial password.' });
    },
    onError: (error: Error) => toast.error('Could not create mentor', { description: error.message }),
  });

  const setCampus = useMutation({
    mutationFn: ({ id, campusId }: { id: string; campusId: string }) =>
      api.setMentorCampuses(id, campusId ? [campusId] : []),
    onSuccess: () => {
      toast.success('Campus updated');
      refresh();
    },
    onError: (error: Error) => toast.error('Could not change campus', { description: error.message }),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.setMentorActive(id, isActive),
    onSuccess: (result) => {
      setConfirming(null);
      toast.success(result.isActive ? 'Mentor reactivated' : 'Mentor deactivated', {
        description: result.isActive
          ? 'Their previous campus access is restored.'
          : 'Their sessions were ended immediately.',
      });
      refresh();
    },
    onError: (error: Error) => toast.error('Could not change status', { description: error.message }),
  });

  const reset = useMutation({
    mutationFn: (id: string) => api.resetMentorPassword(id),
    onSuccess: (result) => {
      refresh();
      if (result.tempPassword) setIssued(result);
      else toast.success('Password reset to the shared initial password.');
    },
    onError: (error: Error) => toast.error('Could not reset password', { description: error.message }),
  });

  // Admins appear in this list because they are shown by the same endpoint, but they are
  // not mentors: they read every campus by definition and have no grants to manage.
  const rows = (mentors.data ?? []).filter((row) => row.role === 'MENTOR');
  const activeCount = rows.filter((row) => row.isActive).length;

  return (
    <>
      <Card>
        <CardHeader
          title="Mentor management"
          description={
            mentors.data
              ? `${activeCount} active of ${rows.length} mentor account${rows.length === 1 ? '' : 's'} · a campus can have any number of mentors`
              : 'Who mentors which campus, and their access.'
          }
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <UserPlus className="size-4" aria-hidden />
              Add mentor
            </Button>
          }
        />

        {mentors.isLoading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No mentor accounts yet"
            description="Add one, and grant it the campus whose students it should see."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Mentor</Th>
                <Th>Campus</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const granted = row.mentorCampuses[0]?.campus;
                return (
                  <tr key={row.id}>
                    <Td>
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-[var(--color-fg-muted)]">{row.email}</div>
                    </Td>
                    <Td>
                      <label className="sr-only" htmlFor={`campus-${row.id}`}>
                        Campus for {row.name}
                      </label>
                      <select
                        id={`campus-${row.id}`}
                        className={inputClass}
                        value={granted?.id ?? ''}
                        disabled={setCampus.isPending}
                        onChange={(event) =>
                          setCampus.mutate({ id: row.id, campusId: event.target.value })
                        }
                      >
                        {/* Explicit rather than implied: a mentor with no campus can log
                            in and see nothing, so it has to be a visible state and not
                            an empty select that looks like it failed to load. */}
                        <option value="">No campus — sees nothing</option>
                        {(campuses.data ?? []).map((campus) => (
                          <option key={campus.id} value={campus.id}>
                            {campus.code} — {campus.name}
                          </option>
                        ))}
                      </select>
                      {row.mentorCampuses.length > 1 ? (
                        <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
                          also {row.mentorCampuses.slice(1).map((g) => g.campus.code).join(', ')}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={row.isActive ? 'success' : 'neutral'}>
                        {row.isActive ? 'Active' : 'Disabled'}
                      </Badge>
                    </Td>
                    <Td className="text-[var(--color-fg-muted)]">
                      {row.lastLoginAt ? timeAgo(row.lastLoginAt) : 'Never'}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          onClick={() => reset.mutate(row.id)}
                          loading={reset.isPending && reset.variables === row.id}
                        >
                          <KeyRound className="size-4" aria-hidden />
                          Reset password
                        </Button>
                        <Button onClick={() => setConfirming(row)}>
                          {row.isActive ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a mentor"
        description="They will be held at the change-password screen until they set their own password."
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!form.name.trim() || !form.email.trim()}
              onClick={() => create.mutate()}
            >
              Create mentor
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="mentor-name" className="mb-1 block text-sm font-medium">
              Name
            </label>
            <input
              id="mentor-name"
              className={inputClass}
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="mentor-email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="mentor-email"
              type="email"
              className={inputClass}
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
            />
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Must be unique — an address that already has an account is refused rather than
              overwriting it.
            </p>
          </div>
          <div>
            <label htmlFor="mentor-campus" className="mb-1 block text-sm font-medium">
              Campus
            </label>
            <select
              id="mentor-campus"
              className={inputClass}
              value={form.campusId}
              onChange={(event) => setForm((prev) => ({ ...prev, campusId: event.target.value }))}
            >
              <option value="">No campus — sees nothing</option>
              {(campuses.data ?? []).map((campus) => (
                <option key={campus.id} value={campus.id}>
                  {campus.code} — {campus.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        title={confirming?.isActive ? 'Disable this mentor?' : 'Re-enable this mentor?'}
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={setActive.isPending}
              onClick={() =>
                confirming &&
                setActive.mutate({ id: confirming.id, isActive: !confirming.isActive })
              }
            >
              {confirming?.isActive ? 'Disable' : 'Re-enable'}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {confirming?.isActive ? (
            <>
              <strong>{confirming.email}</strong> will be signed out immediately and will not be
              able to log in. Nothing is deleted — their campus access and history are kept, and
              re-enabling restores exactly the access they had.
            </>
          ) : (
            <>
              <strong>{confirming?.email}</strong> will be able to log in again, with the campus
              access they had before.
            </>
          )}
        </p>
      </Modal>

      <Modal
        open={Boolean(issued)}
        onClose={() => setIssued(null)}
        title="Copy this password now"
        description="It is shown once and is not stored anywhere in readable form. Hand it over directly."
        footer={<Button onClick={() => setIssued(null)}>Done</Button>}
      >
        {issued ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
              <ShieldCheck className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{issued.email}</div>
                <code className="block truncate font-mono text-sm">{issued.tempPassword}</code>
              </div>
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(issued.tempPassword ?? '');
                  toast.success('Copied');
                }}
              >
                <Copy className="size-4" aria-hidden />
                Copy
              </Button>
            </div>
            <p className="text-xs text-[var(--color-fg-muted)]">
              They must change it at first sign-in before they can reach anything else.
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
