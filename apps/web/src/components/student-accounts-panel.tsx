'use client';

/**
 * Admin-only panel for provisioning student portal logins (§28).
 *
 * A generated password is shown exactly once, in the modal this component opens right
 * after a provision/reset call succeeds — never persisted client-side beyond that,
 * never sent anywhere but this response, never logged. Copy it and hand it to the
 * student directly; there is no other record of it once the modal closes.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, KeyRound, UserPlus } from 'lucide-react';

import { api } from '@/lib/api';
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

interface Credential {
  name: string;
  email: string;
  tempPassword: string;
}

export function StudentAccountsPanel() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<Credential[] | null>(null);

  const accounts = useQuery({
    queryKey: ['admin', 'student-accounts'],
    queryFn: api.studentAccounts,
  });

  const provision = useMutation({
    mutationFn: api.provisionStudentAccounts,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'student-accounts'] });
      if (result.provisioned.length === 0) {
        toast.info('Nothing to provision', { description: 'Every active student already has a login.' });
        return;
      }
      setIssued(result.provisioned);
    },
    onError: (error: Error) => toast.error('Could not provision accounts', { description: error.message }),
  });

  const reset = useMutation({
    mutationFn: (studentId: string) => api.resetStudentPassword(studentId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'student-accounts'] });
      setIssued([result]);
    },
    onError: (error: Error) => toast.error('Could not reset password', { description: error.message }),
  });

  const withoutAccount = accounts.data?.filter((a) => !a.hasAccount).length ?? 0;

  return (
    <Card>
      <CardHeader
        title="Student portal accounts"
        description={`${accounts.data?.length ?? 0} active student(s) · ${withoutAccount} without a login`}
        action={
          <Button
            variant="primary"
            onClick={() => provision.mutate()}
            loading={provision.isPending}
            disabled={withoutAccount === 0}
          >
            <UserPlus className="size-3.5" aria-hidden />
            Provision missing accounts
          </Button>
        }
      />

      {accounts.isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : !accounts.data || accounts.data.length === 0 ? (
        <EmptyState title="No active students" />
      ) : (
        <TableShell>
          <thead>
            <tr>
              <Th>Student</Th>
              <Th>Batch</Th>
              <Th>Login</Th>
              <Th>Last sign-in</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {accounts.data.map((a) => (
              <tr key={a.studentId}>
                <Td>
                  <p className="font-medium">{a.name}</p>
                  <p className="text-xs text-[var(--color-fg-subtle)]">{a.email}</p>
                </Td>
                <Td>{a.batchCode ?? '—'}</Td>
                <Td>
                  <Badge tone={a.hasAccount ? 'success' : 'neutral'}>
                    {a.hasAccount ? 'Provisioned' : 'None yet'}
                  </Badge>
                </Td>
                <Td className="text-xs text-[var(--color-fg-muted)]">{timeAgo(a.lastLoginAt)}</Td>
                <Td>
                  <Button
                    variant="ghost"
                    className="text-xs"
                    loading={reset.isPending && reset.variables === a.studentId}
                    onClick={() => reset.mutate(a.studentId)}
                  >
                    <KeyRound className="size-3.5" aria-hidden />
                    {a.hasAccount ? 'Reset password' : 'Create login'}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}

      <CredentialsModal issued={issued} onClose={() => setIssued(null)} />
    </Card>
  );
}

function CredentialsModal({ issued, onClose }: { issued: Credential[] | null; onClose: () => void }) {
  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  };

  return (
    <Modal
      open={issued !== null}
      onClose={onClose}
      title="One-time temporary passwords"
      description="Shown only now — copy these and hand them to each student directly. They are never shown again."
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done — I've copied these
        </Button>
      }
    >
      <div className="space-y-2">
        {(issued ?? []).map((c) => (
          <div
            key={c.email}
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{c.name}</p>
              <p className="truncate text-xs text-[var(--color-fg-subtle)]">{c.email}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <code className="rounded-md bg-[var(--color-surface-sunken)] px-2 py-1 font-mono text-xs">
                {c.tempPassword}
              </code>
              <Button variant="ghost" onClick={() => void copy(c.tempPassword)} aria-label={`Copy password for ${c.name}`}>
                <Copy className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
