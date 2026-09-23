'use client';

/**
 * Infosys Preparation — every enrolled student, one flat list.
 *
 * `campusName` appears as a filterable, informational column (the roster happens to
 * record it) — it narrows this list only, and never becomes a group, a separate
 * cohort, or an assignment-visibility rule. No `ScopeFilter` here (see the header
 * comment on `packages/shared/src/domain/infosys-analysis.ts`).
 *
 * All filtering happens client-side against the one flat-cohort response `api.infosysStudents()`
 * already returns — 130 rows is cheap to filter in the browser, and doing it here keeps
 * the server endpoint itself trivial and guaranteed to agree with every other Infosys
 * screen reading the same call.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { INFOSYS_CATEGORIES, INFOSYS_CATEGORY_LABELS, leetcodeProfileUrlFor, type InfosysStudentAnalysis } from '@dsa/shared';

import { api } from '@/lib/api';
import { formatPercent } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Skeleton, TableShell, Td, Th } from '@/components/ui';
import { InfosysEditStudentDialog } from '@/components/infosys-edit-student-dialog';

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

/** Opens the real, stored LeetCode profile in a new tab — never an internal page, never
 * a guessed URL. Absent entirely when there is no profile (the badge already says so). */
function LeetCodeLink({ username }: { username: string | null }) {
  if (!username) return <span className="text-[var(--color-fg-subtle)]">—</span>;
  return (
    <a
      href={leetcodeProfileUrlFor(username)}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-xs text-[var(--color-brand)] hover:underline"
    >
      {username}
    </a>
  );
}

const PROFILE_FILTERS = ['ALL', 'LINKED', 'NOT_LINKED'] as const;
type ProfileFilter = (typeof PROFILE_FILTERS)[number];

export default function InfosysStudentsPage() {
  const [selected, setSelected] = useState<InfosysStudentAnalysis | null>(null);
  const [editing, setEditing] = useState<InfosysStudentAnalysis | null>(null);

  const [campusFilter, setCampusFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('ALL');
  const [minSolved, setMinSolved] = useState('');
  const [maxSolved, setMaxSolved] = useState('');

  const students = useQuery({ queryKey: ['infosys-students'], queryFn: api.infosysStudents });

  const rows = students.data ?? [];

  // Only campuses actually present in the active cohort — an "All" option plus
  // whatever is real, never a picker offering a campus with nothing behind it.
  const campusOptions = useMemo(
    () => [...new Set(rows.map((r) => r.campusName).filter((c): c is string => !!c))].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const min = minSolved.trim() === '' ? null : Number(minSolved);
    const max = maxSolved.trim() === '' ? null : Number(maxSolved);
    return rows.filter((r) => {
      if (campusFilter !== 'ALL' && r.campusName !== campusFilter) return false;
      if (categoryFilter !== 'ALL' && r.verdict.category !== categoryFilter) return false;
      if (profileFilter === 'LINKED' && r.profileState !== 'OK') return false;
      if (profileFilter === 'NOT_LINKED' && r.profileState !== 'PROFILE_NOT_LINKED') return false;
      if (min !== null && !Number.isNaN(min) && r.solved < min) return false;
      if (max !== null && !Number.isNaN(max) && r.solved > max) return false;
      return true;
    });
  }, [rows, campusFilter, categoryFilter, profileFilter, minSolved, maxSolved]);

  if (students.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (students.error) return <ErrorState error={students.error} onRetry={() => void students.refetch()} />;

  const selectClass =
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-brand)]';
  const numberClass =
    'w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-brand)]';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Infosys Preparation — Students</h1>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          {rows.length} students, one cohort · showing {filtered.length}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No Infosys students" description="Import the roster to see students here." />
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-end gap-3 p-4">
              <div className="space-y-1">
                <label htmlFor="filter-campus" className="text-xs font-medium text-[var(--color-fg-muted)]">
                  Campus
                </label>
                <select id="filter-campus" className={selectClass} value={campusFilter} onChange={(e) => setCampusFilter(e.target.value)}>
                  <option value="ALL">All campuses</option>
                  {campusOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="filter-category" className="text-xs font-medium text-[var(--color-fg-muted)]">
                  Category
                </label>
                <select id="filter-category" className={selectClass} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                  <option value="ALL">All categories</option>
                  {INFOSYS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {INFOSYS_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="filter-profile" className="text-xs font-medium text-[var(--color-fg-muted)]">
                  Profile
                </label>
                <select
                  id="filter-profile"
                  className={selectClass}
                  value={profileFilter}
                  onChange={(e) => setProfileFilter(e.target.value as ProfileFilter)}
                >
                  <option value="ALL">All profiles</option>
                  <option value="LINKED">Profile linked</option>
                  <option value="NOT_LINKED">Profile not linked</option>
                </select>
              </div>

              <div className="space-y-1">
                <span className="block text-xs font-medium text-[var(--color-fg-muted)]">Solved (min–max)</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    value={minSolved}
                    onChange={(e) => setMinSolved(e.target.value)}
                    placeholder="0"
                    className={numberClass}
                  />
                  <span className="text-[var(--color-fg-subtle)]">–</span>
                  <input
                    type="number"
                    min={0}
                    value={maxSolved}
                    onChange={(e) => setMaxSolved(e.target.value)}
                    placeholder="max"
                    className={numberClass}
                  />
                </div>
              </div>

              {campusFilter !== 'ALL' || categoryFilter !== 'ALL' || profileFilter !== 'ALL' || minSolved || maxSolved ? (
                <Button
                  className="text-xs"
                  onClick={() => {
                    setCampusFilter('ALL');
                    setCategoryFilter('ALL');
                    setProfileFilter('ALL');
                    setMinSolved('');
                    setMaxSolved('');
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          </Card>

          {filtered.length === 0 ? (
            <EmptyState title="No students match these filters" description="Try widening or clearing them." />
          ) : (
            <Card>
              <CardHeader title="Infosys students" />
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
                    <Th className="text-right">Edit</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((student) => (
                    <tr
                      key={student.studentId}
                      className="cursor-pointer hover:bg-[var(--color-surface-sunken)]"
                      onClick={() => setSelected(student)}
                    >
                      <Td className="font-medium">{student.name}</Td>
                      <Td className="text-[var(--color-fg-muted)]">{student.email ?? '—'}</Td>
                      <Td>
                        <LeetCodeLink username={student.leetcodeUsername} />
                      </Td>
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
                      <Td className="text-right">
                        <button
                          type="button"
                          aria-label={`Edit ${student.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(student);
                          }}
                          className="rounded-md p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-fg)]"
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </Card>
          )}
        </>
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

      <InfosysEditStudentDialog student={editing} open={editing !== null} onClose={() => setEditing(null)} />
    </div>
  );
}
