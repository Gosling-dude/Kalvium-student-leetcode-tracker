'use client';

/**
 * Infosys Preparation — daily assignments.
 *
 * One row per day: Date, Question 1..4. `dayKey` is the date the questions were
 * actually given, never defaulted to "today" — entering a historical or future date
 * is the same form as entering today's (§3, §4). No campus/batch/squad targeting:
 * every Infosys student receives the same day's problems.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, TableShell, Td, Th } from '@/components/ui';

export default function InfosysAssignmentsPage() {
  const queryClient = useQueryClient();
  const assignments = useQuery({ queryKey: ['infosys-assignments'], queryFn: api.infosysAssignments });

  const today = new Date().toISOString().slice(0, 10);
  const [dayKey, setDayKey] = useState(today);
  const [urls, setUrls] = useState(['', '', '', '']);

  const create = useMutation({
    mutationFn: () =>
      api.createInfosysAssignment({
        dayKey,
        problemUrls: urls.map((u) => u.trim()).filter((u) => u.length > 0),
      }),
    onSuccess: () => {
      toast.success(`Assignment created for ${dayKey}`);
      setUrls(['', '', '', '']);
      void queryClient.invalidateQueries({ queryKey: ['infosys-assignments'] });
      void queryClient.invalidateQueries({ queryKey: ['infosys-dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['infosys-students'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not create the assignment');
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Infosys Preparation — Daily Assignments</h1>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Every Infosys student receives the same day's questions. No campus, batch, or squad targeting.
        </p>
      </div>

      <Card>
        <CardHeader title="Add a day's assignment" description="Date, plus 1–10 problem URLs or slugs." />
        <div className="space-y-3 p-5">
          <div>
            <label className="text-xs font-medium text-[var(--color-fg-muted)]" htmlFor="infosys-day-key">
              Date (the day the questions were actually given)
            </label>
            <input
              id="infosys-day-key"
              type="date"
              value={dayKey}
              onChange={(e) => setDayKey(e.target.value)}
              className="mt-1 block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
          </div>
          {urls.map((url, i) => (
            <div key={i}>
              <label className="text-xs font-medium text-[var(--color-fg-muted)]">Question {i + 1}</label>
              <input
                type="text"
                value={url}
                placeholder="https://leetcode.com/problems/two-sum/"
                onChange={(e) => {
                  const next = [...urls];
                  next[i] = e.target.value;
                  setUrls(next);
                }}
                className="mt-1 block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              />
            </div>
          ))}
          <Button
            variant="primary"
            disabled={create.isPending || urls.every((u) => u.trim() === '')}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create assignment'}
          </Button>
        </div>
      </Card>

      {assignments.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : assignments.error ? (
        <ErrorState error={assignments.error} onRetry={() => void assignments.refetch()} />
      ) : (assignments.data ?? []).length === 0 ? (
        <EmptyState title="No Infosys assignments yet" description="Add the first one above." />
      ) : (
        <Card>
          <CardHeader title="All Infosys assignments" description="Most recent first." />
          <TableShell>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Questions</Th>
              </tr>
            </thead>
            <tbody>
              {(assignments.data ?? []).map((assignment) => (
                <tr key={assignment.id}>
                  <Td className="font-medium">{assignment.dayKey}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      {assignment.problems.map((p) => (
                        <a
                          key={p.problem.titleSlug}
                          href={p.problem.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md bg-[var(--color-surface-sunken)] px-2 py-1 text-xs hover:underline"
                        >
                          {p.position}. {p.problem.title}
                        </a>
                      ))}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      )}
    </div>
  );
}
