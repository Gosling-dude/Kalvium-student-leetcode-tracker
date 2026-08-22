'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  SYNC_STATUS_LABELS,
  UNASSIGNED_BATCH_LABEL,
  isTrustworthySync,
  type ImportResult,
  type StudentSummary,
} from '@dsa/shared';

import { api, downloadFile } from '@/lib/api';
import { timeAgo, todayKey } from '@/lib/utils';
import { ScopeChips, ScopeFilter, useScopeFilter } from '@/components/scope-filter';
import { MoveBatchDialog } from '@/components/move-batch-dialog';
import { TransferCampusDialog } from '@/components/transfer-campus-dialog';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  StreakFlame,
  TableShell,
  TableSkeleton,
  Td,
  Th,
} from '@/components/ui';

export default function StudentsPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [squadId, setSquadId] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [cohort, setCohort] = useState('');
  /** '' = current students only (the default), 'all' = plus archived, 'ARCHIVED' = only. */
  const [archiveScope, setArchiveScope] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [moving, setMoving] = useState<StudentSummary | null>(null);
  const [transferring, setTransferring] = useState<StudentSummary | null>(null);

  const { campus, batch, campuses, batches } = useScopeFilter();
  /** Squad number is a directory-only filter (§13). */
  const [squadNumber, setSquadNumber] = useState('');

  const filters = useQuery({ queryKey: ['students', 'filters'], queryFn: api.studentFilters });

  const students = useQuery({
    queryKey: [
      'students',
      { page, search, squadId, syncStatus, campus, batch, cohort, archiveScope, squadNumber },
    ],
    queryFn: () =>
      api.students({
        page,
        pageSize: 25,
        search,
        squadId,
        syncStatus,
        sortBy: 'name',
        campus: campus ?? undefined,
        batch: batch ?? undefined,
        cohort: cohort || undefined,
        squadNumber: squadNumber || undefined,
        ...(archiveScope === 'all'
          ? { includeArchived: 'true' }
          : archiveScope === 'ARCHIVED'
            ? { status: 'ARCHIVED' }
            : {}),
      }),
  });

  // Today's completion for the table. Read from the daily tracker rather than recomputed
  // here, so this column can never disagree with the mentor view about the same student.
  const today = useQuery({
    queryKey: ['mentor', todayKey(), campus, batch],
    queryFn: () =>
      api.mentorDashboard(todayKey(), undefined, campus ?? undefined, batch ?? undefined),
    staleTime: 60_000,
  });

  const completionByStudent = new Map(
    (today.data?.buckets ?? [])
      .flatMap((bucket) => bucket.students)
      .map((row) => [row.studentId, { solved: row.solvedCount, assigned: row.assignedCount }]),
  );

  /** Cohorts present in the roster, so the filter never offers an empty option. */
  const cohortOptions = [
    ...new Set(
      (students.data?.items ?? [])
        .map((student) => student.cohort)
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);

  const importMutation = useMutation({
    mutationFn: (file: File) => api.importStudents(file, true),
    onSuccess: (result) => {
      setImportResult(result);
      toast.success(
        `Imported: ${result.created} created, ${result.updated} updated`,
        result.errors.length > 0
          ? { description: `${result.errors.length} row(s) need attention.` }
          : undefined,
      );
      void queryClient.invalidateQueries({ queryKey: ['students'] });
    },
    onError: (error: Error) => toast.error('Import failed', { description: error.message }),
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Students</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {students.data?.total ?? 0} students
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ScopeFilter />
          <Button
            onClick={() =>
              void downloadFile('/students/import/template', 'dsa-tracker-students.xlsx')
            }
          >
            <Download className="size-3.5" aria-hidden />
            Template
          </Button>
          <Button
            variant="primary"
            onClick={() => fileInput.current?.click()}
            loading={importMutation.isPending}
          >
            <Upload className="size-3.5" aria-hidden />
            Import Excel
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importMutation.mutate(file);
              // Reset so re-uploading the same file still fires a change event.
              event.target.value = '';
            }}
          />
        </div>
      </header>

      {/* Per-row import feedback: a spreadsheet of 250 rows is never entirely clean. */}
      {importResult && importResult.errors.length > 0 ? (
        <Card className="border-[var(--color-warning)]">
          <CardHeader
            title={`${importResult.errors.length} row(s) could not be imported`}
            description="Everything else was imported. Fix these rows and upload again."
            action={
              <Button variant="ghost" onClick={() => setImportResult(null)}>
                Dismiss
              </Button>
            }
          />
          <ul className="max-h-56 space-y-1 overflow-y-auto p-4 text-sm">
            {importResult.errors.slice(0, 50).map((error, index) => (
              <li key={index} className="flex gap-2">
                <span className="shrink-0 font-mono text-xs text-[var(--color-fg-subtle)]">
                  Row {error.row}
                </span>
                <span className="text-[var(--color-fg-muted)]">
                  {error.field ? <strong>{error.field}: </strong> : null}
                  {error.message}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap gap-2 border-b border-[var(--color-border)] p-3">
          <input
            type="search"
            placeholder="Search name, email or LeetCode handle…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="min-w-56 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />

          {/*
            Squads are narrowed to the selected campus. Squad numbers repeat across
            campuses — SRM has 83, Vels has 8 — so an unnarrowed list would offer two
            entries a mentor cannot tell apart (§13).
          */}
          <select
            value={squadId}
            onChange={(event) => {
              setSquadId(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by squad"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
          >
            <option value="">All squads</option>
            {(filters.data?.squads ?? [])
              .filter(
                (squad) =>
                  campus === null ||
                  squad.campusId ===
                    filters.data?.campuses.find((entry) => entry.code === campus)?.id,
              )
              .map((squad) => (
                <option key={squad.id} value={squad.id}>
                  {squad.name} ({squad.studentCount})
                </option>
              ))}
          </select>

          <select
            value={cohort}
            onChange={(event) => {
              setCohort(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by cohort"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
          >
            <option value="">All cohorts</option>
            {cohortOptions.map((value) => (
              <option key={value} value={value}>
                Cohort {value}
              </option>
            ))}
          </select>

          {/*
            Archived students are hidden by default — they have left the programme. They
            remain reachable here because their history is intact and still worth reading.
          */}
          <select
            value={archiveScope}
            onChange={(event) => {
              setArchiveScope(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by roster status"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
          >
            <option value="">Current students</option>
            <option value="all">Current + archived</option>
            <option value="ARCHIVED">Archived only</option>
          </select>

          <select
            value={squadNumber}
            onChange={(event) => {
              setSquadNumber(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by squad number"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
          >
            <option value="">All squad numbers</option>
            {[
              ...new Set(
                (filters.data?.squadNumbers ?? [])
                  .filter(
                    (entry) =>
                      campus === null ||
                      entry.campusId ===
                        filters.data?.campuses.find((c) => c.code === campus)?.id,
                  )
                  .map((entry) => entry.number),
              ),
            ]
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  Squad {value}
                </option>
              ))}
          </select>

          <select
            value={syncStatus}
            onChange={(event) => {
              setSyncStatus(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by sync status"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
          >
            <option value="">All sync states</option>
            {Object.entries(SYNC_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {students.isLoading ? (
          <TableSkeleton rows={10} cols={6} />
        ) : students.error ? (
          <ErrorState error={students.error} onRetry={() => void students.refetch()} />
        ) : !students.data || students.data.items.length === 0 ? (
          <EmptyState
            title="No students found"
            description="Import your student list to get started, or clear the filters."
          />
        ) : (
          <>
            <TableShell>
              <thead>
                <tr>
                  <Th>Student</Th>
                  <Th>Campus / Batch</Th>
                  <Th className="text-right">Cohort</Th>
                  <Th className="text-right">Squad</Th>
                  <Th className="text-right">Max belt</Th>
                  <Th>LeetCode</Th>
                  <Th>Streak</Th>
                  <Th className="text-right">Today</Th>
                  <Th className="text-right">Total solved</Th>
                  <Th>Last sync</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {students.data.items.map((student) => (
                  <tr
                    key={student.id}
                    className="transition hover:bg-[var(--color-surface-sunken)]"
                  >
                    <Td>
                      <Link
                        href={`/students/${student.id}`}
                        className="truncate font-medium hover:text-[var(--color-brand)]"
                      >
                        {student.name}
                      </Link>
                      <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                        {student.email}
                      </p>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ScopeChips
                          campusCode={student.campusCode}
                          campusName={student.campusName}
                          batchCode={student.batchCode}
                          batchName={student.batchName}
                        />
                        {/* An explicit state, not an empty cell: these students are
                            enrolled and waiting for a diagnostic result, which is a very
                            different thing from missing data. It is a property of the
                            student, not a batch they belong to. */}
                        {student.batchId === null && student.status !== 'ARCHIVED' ? (
                          <Badge tone="warning">{UNASSIGNED_BATCH_LABEL}</Badge>
                        ) : null}
                        {student.status === 'ARCHIVED' ? (
                          <Badge tone="neutral">Archived</Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums text-[var(--color-fg-muted)]">
                      {student.cohort ?? '—'}
                    </Td>
                    <Td className="text-right tabular-nums text-[var(--color-fg-muted)]">
                      {student.squadNumber ?? '—'}
                    </Td>
                    <Td className="text-right tabular-nums">{student.maxBeltLevel ?? '—'}</Td>
                    <Td>
                      {student.leetcodeUsername ? (
                        <a
                          href={`https://leetcode.com/u/${student.leetcodeUsername}/`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-mono text-xs hover:text-[var(--color-brand)]"
                        >
                          {student.leetcodeUsername}
                        </a>
                      ) : (
                        <span className="text-xs text-[var(--color-fg-subtle)]">Not linked</span>
                      )}
                    </Td>
                    <Td>
                      <StreakFlame streak={student.currentStreak} />
                    </Td>
                    <Td className="text-right tabular-nums text-[var(--color-fg-muted)]">
                      {(() => {
                        const todayRow = completionByStudent.get(student.id);
                        return todayRow ? `${todayRow.solved}/${todayRow.assigned}` : '—';
                      })()}
                    </Td>
                    <Td className="text-right tabular-nums">{student.totalSolved}</Td>
                    <Td>
                      {isTrustworthySync(student.syncStatus) ? (
                        <span className="text-xs text-[var(--color-fg-muted)]">
                          {timeAgo(student.lastSyncedAt)}
                        </span>
                      ) : (
                        <Badge tone="danger">{SYNC_STATUS_LABELS[student.syncStatus]}</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      {student.status === 'ARCHIVED' ? (
                        <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
                      ) : (
                        <span className="inline-flex gap-1">
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs"
                            onClick={() => setMoving(student)}
                          >
                            Move batch
                          </Button>
                          {/* Only offered when there is somewhere to transfer *to*.
                              With one campus the control would be a dead end. */}
                          {campuses.length > 1 ? (
                            <Button
                              variant="ghost"
                              className="px-2 py-1 text-xs"
                              onClick={() => setTransferring(student)}
                            >
                              Transfer campus
                            </Button>
                          ) : null}
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>

            <div className="flex items-center justify-between gap-3 p-3 text-sm">
              <p className="text-[var(--color-fg-muted)]">
                Page {students.data.page} of {students.data.totalPages || 1}
              </p>
              <div className="flex gap-2">
                <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  disabled={page >= (students.data.totalPages || 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <MoveBatchDialog
        student={moving}
        batches={batches}
        open={moving !== null}
        onClose={() => setMoving(null)}
      />

      <TransferCampusDialog
        student={transferring}
        campuses={campuses}
        open={transferring !== null}
        onClose={() => setTransferring(null)}
      />
    </div>
  );
}
