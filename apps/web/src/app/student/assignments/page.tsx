'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';

import { api } from '@/lib/api';
import {
  Button,
  Card,
  CardHeader,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

export default function StudentAssignmentsPage() {
  const [page, setPage] = useState(1);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['student', 'assignments', page],
    queryFn: () => api.studentAssignments(page, 20),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Assignments</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Your full assignment history — problems, difficulty and how you did.
        </p>
      </header>

      <Card>
        {isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : error || !data ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : data.items.length === 0 ? (
          <EmptyState
            title="No assignments yet"
            description="Assignments for your batch will show up here as they're published."
          />
        ) : (
          <>
            <TableShell>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Assignment</Th>
                  <Th>Difficulty</Th>
                  <Th>Completed</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    <Td className="whitespace-nowrap tabular-nums">
                      {new Date(`${row.dayKey}T00:00:00`).toLocaleDateString(undefined, {
                        day: '2-digit',
                        month: 'short',
                      })}
                    </Td>
                    <Td className="font-medium">{row.title ?? row.topic ?? 'Assignment'}</Td>
                    <Td>{row.difficulty ? <DifficultyBadge difficulty={row.difficulty} /> : '—'}</Td>
                    <Td>
                      <span className="flex items-center gap-1.5 tabular-nums">
                        {row.isPerfect ? (
                          <CheckCircle2 className="size-3.5 text-[var(--color-success)]" aria-hidden />
                        ) : (
                          <Circle className="size-3.5 text-[var(--color-fg-subtle)]" aria-hidden />
                        )}
                        {row.solvedCount}/{row.assignedCount}
                      </span>
                    </Td>
                    <Td>
                      <Link
                        href={`/student/assignments/${row.id}`}
                        className="text-xs font-medium text-[var(--color-brand)] hover:underline"
                      >
                        Open
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>

            <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3 text-xs text-[var(--color-fg-muted)]">
              <span>
                Page {data.page} of {Math.max(1, data.totalPages)} · {data.total} total
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
