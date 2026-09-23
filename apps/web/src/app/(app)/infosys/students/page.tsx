'use client';

/**
 * Infosys Preparation — every enrolled student, one flat list.
 *
 * `campusName` appears as a plain informational column (the roster happens to record
 * it) — never a filter, never a group, never a dropdown. No `ScopeFilter` here.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InfosysStudentAnalysis } from '@dsa/shared';

import { api } from '@/lib/api';
import { formatPercent } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton, TableShell, Td, Th } from '@/components/ui';

const percent = (value: number | null): string => (value === null ? '—' : formatPercent(value * 100));

const CATEGORY_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  CONSISTENT_SOLVER: 'success',
  IMPROVING: 'success',
  INCONSISTENT: 'warning',
  TRYING_BUT_STRUGGLING: 'warning',
  NOT_PARTICIPATING: 'danger',
  DECLINING: 'danger',
  PROFILE_NOT_LINKED: 'neutral',
};

/**
 * Whether a profile has been *added*, never whether the last sync succeeded — a sync
 * failure is an internal diagnostic (`InfosysProfileState: 'DATA_UNAVAILABLE'`, kept on
 * `StudentSyncState` for troubleshooting), not a student-facing status. It never renders
 * here; see the module banner on `infosys-analysis.ts`.
 */
function ProfileStatusBadge({ state }: { state: InfosysStudentAnalysis['profileState'] }) {
  if (state === 'PROFILE_NOT_LINKED') return <Badge tone="neutral">Profile not linked</Badge>;
  return <Badge tone="success">Linked</Badge>;
}

export default function InfosysStudentsPage() {
  const [selected, setSelected] = useState<InfosysStudentAnalysis | null>(null);
  const students = useQuery({ queryKey: ['infosys-students'], queryFn: api.infosysStudents });

  if (students.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (students.error) return <ErrorState error={students.error} onRetry={() => void students.refetch()} />;

  const rows = students.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Infosys Preparation — Students</h1>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{rows.length} students, one cohort</p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No Infosys students" description="Import the roster to see students here." />
      ) : (
        <Card>
          <CardHeader title="All Infosys students" />
          <TableShell>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>LeetCode</Th>
                <Th>Campus</Th>
                <Th>Profile</Th>
                <Th className="text-right">Assigned</Th>
                <Th className="text-right">Solved</Th>
                <Th className="text-right">Attempted</Th>
                <Th className="text-right">Not attempted</Th>
                <Th className="text-right">Solve %</Th>
                <Th>Category</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((student) => (
                <tr
                  key={student.studentId}
                  className="cursor-pointer hover:bg-[var(--color-surface-sunken)]"
                  onClick={() => setSelected(student)}
                >
                  <Td className="font-medium">{student.name}</Td>
                  <Td className="text-[var(--color-fg-muted)]">{student.email ?? '—'}</Td>
                  <Td>{student.leetcodeUsername ?? '—'}</Td>
                  <Td className="text-[var(--color-fg-subtle)]">{student.campusName ?? '—'}</Td>
                  <Td>
                    <ProfileStatusBadge state={student.profileState} />
                  </Td>
                  <Td className="text-right tabular-nums">{student.assigned}</Td>
                  <Td className="text-right tabular-nums">{student.solved}</Td>
                  <Td className="text-right tabular-nums">{student.attemptedNotSolved}</Td>
                  <Td className="text-right tabular-nums">{student.notAttempted}</Td>
                  <Td className="text-right tabular-nums">{percent(student.solvePercent)}</Td>
                  <Td>
                    <Badge tone={CATEGORY_TONE[student.verdict.category] ?? 'neutral'}>
                      {student.verdict.category.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      )}

      {selected ? (
        <Card>
          <CardHeader
            title={`${selected.name} — weekly history`}
            description={selected.verdict.because}
            action={
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                Close
              </button>
            }
          />
          <TableShell>
            <thead>
              <tr>
                <Th>Week</Th>
                <Th>Date range</Th>
                <Th className="text-right">Assigned</Th>
                <Th className="text-right">Solved</Th>
                <Th className="text-right">Attempted</Th>
                <Th className="text-right">Not attempted</Th>
              </tr>
            </thead>
            <tbody>
              {selected.weeks.map((week) => (
                <tr key={week.weekNumber}>
                  <Td>Week {week.weekNumber}</Td>
                  <Td className="text-[var(--color-fg-muted)]">
                    {week.from} – {week.to}
                  </Td>
                  <Td className="text-right tabular-nums">{week.assigned}</Td>
                  <Td className="text-right tabular-nums">{week.solved}</Td>
                  <Td className="text-right tabular-nums">{week.attemptedNotSolved}</Td>
                  <Td className="text-right tabular-nums">{week.notAttempted}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Card>
      ) : null}
    </div>
  );
}
