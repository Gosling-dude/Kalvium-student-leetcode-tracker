'use client';

/** Subcomponents for the Email Reports page — kept out of page.tsx to keep both readable. */

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import {
  BLOCKER_CATEGORIES,
  BLOCKER_CATEGORY_LABELS,
  EMAIL_REPORT_STATUS_LABELS,
  isPlausibleEmail,
  type BlockerCategory,
  type DailyEmailReport,
  type DailyEmailReportStudentRow,
  type EmailReportRecord,
} from '@dsa/shared';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, Modal, StatTile, TableShell, Td, Th } from '@/components/ui';

// --- Summary cards ------------------------------------------------------------

export function SummaryCards({ report }: { report: DailyEmailReport }) {
  const { summary } = report;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <StatTile label="Problems Assigned" value={summary.problemsAssigned} />
      <StatTile label="Students Tracked" value={summary.studentsTracked} />
      {summary.bucketCounts.map((bucket) => (
        <StatTile
          key={bucket.solvedCount}
          label={bucket.label}
          value={bucket.count}
          tone={bucket.solvedCount === summary.problemsAssigned ? 'success' : 'neutral'}
        />
      ))}
      <StatTile
        label="Overall Completion"
        value={`${summary.overallCompletionPercent}%`}
        tone="brand"
      />
    </div>
  );
}

// --- Performance group tabs ----------------------------------------------------

export function PerformanceTabs({
  report,
  active,
  onChange,
}: {
  report: DailyEmailReport;
  active: number | 'ALL';
  onChange: (value: number | 'ALL') => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <TabButton active={active === 'ALL'} onClick={() => onChange('ALL')}>
        All ({report.students.length})
      </TabButton>
      {report.buckets.map((bucket) => (
        <TabButton
          key={bucket.solvedCount}
          active={active === bucket.solvedCount}
          onClick={() => onChange(bucket.solvedCount)}
        >
          {bucket.solvedCount}/{report.summary.problemsAssigned} ({bucket.count})
        </TabButton>
      ))}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-lg px-3 py-1.5 text-sm font-medium transition',
        active
          ? 'bg-[var(--color-brand)] text-[var(--color-brand-fg)]'
          : 'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-sunken)]',
      )}
    >
      {children}
    </button>
  );
}

// --- Student table --------------------------------------------------------------

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  Complete: 'success',
  'Follow-up': 'warning',
  Intervention: 'warning',
  Urgent: 'danger',
  'Not assigned': 'neutral',
};

export function StudentTable({
  report,
  filter,
  dayKey,
  onRecordBlocker,
}: {
  report: DailyEmailReport;
  filter: number | 'ALL';
  dayKey: string;
  onRecordBlocker: (student: DailyEmailReportStudentRow) => void;
}) {
  const rows =
    filter === 'ALL' ? report.students : report.students.filter((s) => s.solvedCount === filter);
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    return <EmptyState title="No students in this group" description="Nobody landed here today." />;
  }

  return (
    <TableShell>
      <thead>
        <tr>
          <Th>Student</Th>
          <Th>Squad</Th>
          <Th className="text-right">Assigned</Th>
          <Th className="text-right">Solved</Th>
          <Th className="text-right">Completion</Th>
          <Th>Status</Th>
          <Th>Blocker</Th>
          <Th>Action Required</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((student) => (
          <tr key={student.studentId} className="transition hover:bg-[var(--color-surface-sunken)]">
            <Td>
              <p className="truncate font-medium">{student.name}</p>
              <p className="truncate text-xs text-[var(--color-fg-subtle)]">{student.email}</p>
            </Td>
            <Td className="text-[var(--color-fg-muted)]">{student.squadName ?? '—'}</Td>
            <Td className="text-right tabular-nums">{student.assignedCount}</Td>
            <Td className="text-right tabular-nums font-medium">{student.solvedCount}</Td>
            <Td className="text-right tabular-nums">{student.completionPercent}%</Td>
            <Td>
              <Badge tone={STATUS_TONE[student.statusLabel] ?? 'neutral'}>{student.statusLabel}</Badge>
            </Td>
            <Td className="max-w-[16rem]">
              {student.blocker ? (
                <span className="text-xs">
                  {BLOCKER_CATEGORY_LABELS[student.blocker.category]}
                  {student.blocker.description ? (
                    <span className="block truncate text-[var(--color-fg-subtle)]">
                      &ldquo;{student.blocker.description}&rdquo;
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-xs text-[var(--color-fg-subtle)]">No blocker reported</span>
              )}
            </Td>
            <Td className="max-w-[18rem]">
              <p className="text-xs text-[var(--color-fg-muted)]">{student.actionRequired}</p>
              {student.actionTier !== 'COMPLETE' && student.actionTier !== 'NOT_ASSIGNED' ? (
                <Button
                  variant="ghost"
                  className="mt-1 h-auto px-0 py-0 text-xs text-[var(--color-brand)]"
                  onClick={() => onRecordBlocker(student)}
                >
                  {student.blocker ? 'Edit blocker' : 'Record blocker'}
                </Button>
              ) : null}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

// --- Action items -----------------------------------------------------------

export function ActionItemsPanel({ report }: { report: DailyEmailReport }) {
  const groups = report.actionGroups.filter((g) => g.count > 0);
  if (groups.length === 0) {
    return <EmptyState title="Nothing to action" description="No students tracked for this day." />;
  }
  return (
    <div className="space-y-3 p-4">
      {groups.map((group) => (
        <div
          key={group.tier}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3"
        >
          <p className="text-sm font-semibold">
            {group.emoji} {group.title} <span className="text-[var(--color-fg-muted)]">— {group.count}</span>
          </p>
          {group.tier !== 'COMPLETE' ? (
            <p className="mt-1 flex flex-wrap gap-1">
              {group.students.map((s) => (
                <Badge key={s.studentId} tone="neutral">
                  {s.name}
                </Badge>
              ))}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// --- Blocker summary ----------------------------------------------------------

export function BlockerSummaryPanel({ report }: { report: DailyEmailReport }) {
  if (report.blockerSummary.length === 0) {
    return (
      <EmptyState
        title="No follow-ups needed"
        description="Nobody in an intervention or follow-up group today."
      />
    );
  }
  return (
    <div className="space-y-2 p-4">
      {report.blockerSummary.map((entry) => (
        <div key={entry.key} className="flex items-center justify-between text-sm">
          <span className={entry.key === 'NOT_REPORTED' ? 'text-[var(--color-warning)]' : ''}>
            {entry.label}
          </span>
          <span className="font-semibold tabular-nums">{entry.count}</span>
        </div>
      ))}
    </div>
  );
}

// --- Blocker form modal --------------------------------------------------------

export function BlockerFormModal({
  open,
  onClose,
  student,
  dayKey,
}: {
  open: boolean;
  onClose: () => void;
  student: DailyEmailReportStudentRow | null;
  dayKey: string;
}) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<BlockerCategory>('NO_BLOCKER');
  const [description, setDescription] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [followUpRequired, setFollowUpRequired] = useState(false);
  const [followUpDate, setFollowUpDate] = useState('');
  const [mentorNotes, setMentorNotes] = useState('');

  // Reset the form whenever a different student is opened.
  const key = student?.studentId ?? '';
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setCategory(student?.blocker?.category ?? 'NO_BLOCKER');
    setDescription(student?.blocker?.description ?? '');
    setActionTaken(student?.blocker?.actionTaken ?? '');
    setFollowUpRequired(student?.blocker?.followUpRequired ?? false);
    setFollowUpDate(student?.blocker?.followUpDate ?? '');
    setMentorNotes(student?.blocker?.mentorNotes ?? '');
  }

  const save = useMutation({
    mutationFn: () => {
      if (!student) throw new Error('No student selected');
      return api.createBlocker({
        studentId: student.studentId,
        dayKey,
        category,
        description: description || undefined,
        actionTaken: actionTaken || undefined,
        followUpRequired,
        followUpDate: followUpDate || undefined,
        mentorNotes: mentorNotes || undefined,
      });
    },
    onSuccess: () => {
      toast.success('Blocker recorded');
      void queryClient.invalidateQueries({ queryKey: ['email-report'] });
      onClose();
    },
    onError: (error: Error) => toast.error('Could not save blocker', { description: error.message }),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={student ? `Blocker — ${student.name}` : 'Blocker'}
      description={student ? `${dayKey} · Solved ${student.solvedCount}/${student.assignedCount}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Blocker category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as BlockerCategory)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          >
            {BLOCKER_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {BLOCKER_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder='e.g. "Unable to understand sliding window."'
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </Field>
        <Field label="Action taken">
          <textarea
            value={actionTaken}
            onChange={(e) => setActionTaken(e.target.value)}
            rows={2}
            placeholder="e.g. Explained fixed vs variable window."
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </Field>
        <div className="flex items-center gap-2">
          <input
            id="followUpRequired"
            type="checkbox"
            checked={followUpRequired}
            onChange={(e) => setFollowUpRequired(e.target.checked)}
            className="size-4 rounded border-[var(--color-border)]"
          />
          <label htmlFor="followUpRequired" className="text-sm">
            Follow-up required
          </label>
        </div>
        {followUpRequired ? (
          <Field label="Follow-up date">
            <input
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
            />
          </Field>
        ) : null}
        <Field label="Mentor notes">
          <textarea
            value={mentorNotes}
            onChange={(e) => setMentorNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{label}</span>
      {children}
    </label>
  );
}

// --- Recipients editor ----------------------------------------------------------

export function RecipientsEditor({
  label,
  emails,
  onChange,
  placeholder,
}: {
  label: string;
  emails: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = (): void => {
    const value = draft.trim().toLowerCase();
    if (!value) return;
    if (!isPlausibleEmail(value)) {
      toast.error('That does not look like a valid email address');
      return;
    }
    if (emails.includes(value)) {
      setDraft('');
      return;
    }
    onChange([...emails, value]);
    setDraft('');
  };

  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5">
        {emails.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-sunken)] px-2 py-1 text-xs"
          >
            {email}
            <button
              type="button"
              onClick={() => onChange(emails.filter((e) => e !== email))}
              aria-label={`Remove ${email}`}
              className="text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)]"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={placeholder ?? 'name@kalvium.community'}
          className="min-w-[10rem] flex-1 bg-transparent px-1.5 py-1 text-sm outline-none"
        />
        <Button variant="ghost" onClick={add} className="h-auto px-2 py-1">
          <Plus className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

// --- Email preview modal --------------------------------------------------------

export function EmailPreviewModal({
  open,
  onClose,
  emailReport,
  readOnly,
  onApproved,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  emailReport: EmailReportRecord | null;
  readOnly?: boolean;
  onApproved?: (record: EmailReportRecord) => void;
  onSent?: (record: EmailReportRecord) => void;
}) {
  const [confirmingSend, setConfirmingSend] = useState(false);
  /**
   * Last failure, kept on screen. A toast disappears after a few seconds, which is not
   * long enough to act on "Sender email is not verified" — the reason has to stay
   * visible next to the button that produced it.
   */
  const [sendError, setSendError] = useState<string | null>(null);

  const { data: sentStatus } = useQuery({
    queryKey: ['email-status', emailReport?.dayKey],
    queryFn: () => api.emailStatus(emailReport!.dayKey),
    enabled: Boolean(emailReport?.dayKey) && open,
  });

  const approve = useMutation({
    mutationFn: () => api.approveEmail(emailReport!.id),
    onSuccess: (record) => {
      toast.success('Email approved');
      onApproved?.(record);
    },
    onError: (error: Error) => {
      setSendError(error.message);
      toast.error('Approval failed', { description: error.message });
    },
  });

  const send = useMutation({
    mutationFn: (force: boolean) => api.sendEmail(emailReport!.id, force),
    onSuccess: (record) => {
      toast.success('Email sent');
      setConfirmingSend(false);
      setSendError(null);
      onSent?.(record);
    },
    onError: (error: Error) => {
      // The backend now returns a specific, human-readable reason (missing provider
      // config, unverified sender, rate limit). Show it verbatim rather than a generic
      // failure line — it is the whole point of the error being typed server-side.
      setSendError(error.message);
      toast.error('Send failed', { description: error.message });
      setConfirmingSend(false);
    },
  });

  if (!emailReport) return null;

  const alreadySentElsewhere =
    sentStatus?.sent && sentStatus.sent.id !== emailReport.id ? sentStatus.sent : null;

  const inFlight = approve.isPending || send.isPending || emailReport.status === 'SENDING';

  const handleApproveAndSend = async (): Promise<void> => {
    if (emailReport.status === 'SENT' || emailReport.status === 'SENDING') return;
    if (alreadySentElsewhere && !confirmingSend) {
      setConfirmingSend(true);
      return;
    }
    setSendError(null);
    // FAILED reports are already approved; re-approving would be rejected, and the
    // send path accepts FAILED directly as a retry.
    if (emailReport.status !== 'APPROVED' && emailReport.status !== 'FAILED') {
      await approve.mutateAsync();
    }
    send.mutate(Boolean(alreadySentElsewhere));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Email Preview"
      description={`Status: ${EMAIL_REPORT_STATUS_LABELS[emailReport.status]}`}
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Edit
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {emailReport.status === 'SENT' ? (
              <Badge tone="success">Sent {new Date(emailReport.sentAt ?? '').toLocaleString()}</Badge>
            ) : (
              <Button
                variant="primary"
                loading={inFlight}
                disabled={inFlight}
                onClick={() => void handleApproveAndSend()}
              >
                {confirmingSend
                  ? 'Confirm — Send Anyway'
                  : emailReport.status === 'FAILED'
                    ? 'Retry Send'
                    : 'Approve & Send'}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-3">
        {sendError ?? emailReport.failedError ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm text-[var(--color-danger)]"
          >
            <p className="font-semibold">This email was not sent.</p>
            <p className="mt-0.5">{sendError ?? emailReport.failedError}</p>
          </div>
        ) : null}

        {alreadySentElsewhere ? (
          <div className="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning)]">
            This report has already been sent ({new Date(alreadySentElsewhere.sentAt ?? '').toLocaleString()}).
            {confirmingSend ? ' Click "Confirm — Send Anyway" to send it again.' : ' Sending again requires confirmation.'}
          </div>
        ) : null}

        <div className="rounded-lg border border-[var(--color-border)] p-3 text-xs">
          <Row label="From" value={emailReport.fromEmail} />
          <Row label="To" value={emailReport.toRecipients.join(', ') || '—'} />
          <Row label="CC" value={emailReport.ccRecipients.join(', ') || '—'} />
          <Row label="Subject" value={emailReport.subject} />
        </div>

        <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
          <iframe
            title="Email preview"
            srcDoc={emailReport.bodyHtml}
            className="h-[520px] w-full bg-white"
            sandbox=""
          />
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 border-b border-[var(--color-border)] py-1.5 last:border-0">
      <span className="w-14 shrink-0 font-medium text-[var(--color-fg-muted)]">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

// --- History table -----------------------------------------------------------

export function HistoryTable({
  dayKey,
  onView,
}: {
  dayKey?: string;
  onView: (record: EmailReportRecord) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['email-history', dayKey],
    queryFn: () => api.emailHistory({ dayKey, pageSize: 20 }),
  });

  if (isLoading) return <div className="p-4 text-sm text-[var(--color-fg-muted)]">Loading…</div>;
  if (!data || data.items.length === 0) {
    return <EmptyState title="No reports generated yet" description="Generate and send a report to see it here." />;
  }

  const statusTone: Record<string, 'neutral' | 'warning' | 'info' | 'success' | 'danger'> = {
    DRAFT: 'neutral',
    PENDING_APPROVAL: 'warning',
    APPROVED: 'info',
    SENDING: 'info',
    SENT: 'success',
    FAILED: 'danger',
  };

  return (
    <TableShell>
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Generated</Th>
          <Th>To</Th>
          <Th>Subject</Th>
          <Th>Status</Th>
          <Th>Sent</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {data.items.map((record) => (
          <tr key={record.id} className="transition hover:bg-[var(--color-surface-sunken)]">
            <Td className="tabular-nums">{record.dayKey}</Td>
            <Td>
              <span className="text-xs text-[var(--color-fg-muted)]">
                {new Date(record.generatedAt).toLocaleString()}
                {record.generatedByName ? ` · ${record.generatedByName}` : ' · automation'}
              </span>
            </Td>
            <Td className="max-w-[14rem] truncate text-xs">{record.toRecipients.join(', ')}</Td>
            <Td className="max-w-[16rem] truncate">{record.subject}</Td>
            <Td>
              <Badge tone={statusTone[record.status] ?? 'neutral'}>
                {EMAIL_REPORT_STATUS_LABELS[record.status]}
              </Badge>
              {/* Why it failed, on the row itself — otherwise a FAILED report in the
                  history is a dead end that says nothing about what to fix. */}
              {record.status === 'FAILED' && record.failedError ? (
                <p
                  title={record.failedError}
                  className="mt-1 max-w-[16rem] truncate text-xs text-[var(--color-danger)]"
                >
                  {record.failedError}
                </p>
              ) : null}
            </Td>
            <Td className="text-xs text-[var(--color-fg-muted)]">
              {record.sentAt ? new Date(record.sentAt).toLocaleString() : '—'}
            </Td>
            <Td>
              <Button variant="ghost" onClick={() => onView(record)}>
                View
              </Button>
            </Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}
