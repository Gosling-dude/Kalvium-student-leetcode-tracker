'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileSpreadsheet, Mail, Send } from 'lucide-react';
import { defaultEmailSubject, type DailyEmailReportStudentRow, type EmailReportRecord } from '@dsa/shared';

import { api, downloadFile } from '@/lib/api';
import { BatchFilter, useBatchFilter } from '@/components/batch-filter';
import { todayKey } from '@/lib/utils';
import { Button, Card, CardHeader, EmptyState, ErrorState, TableSkeleton } from '@/components/ui';
import {
  ActionItemsPanel,
  BlockerFormModal,
  BlockerSummaryPanel,
  EmailPreviewModal,
  HistoryTable,
  PerformanceTabs,
  RecipientsEditor,
  StudentTable,
  SummaryCards,
} from './components';

export default function EmailReportsPage() {
  const [dayKey, setDayKey] = useState(todayKey());
  const { selected: batch, batches } = useBatchFilter();

  /** The batch id matching the active filter, for scoping the generated email. */
  const batchId = batch ? (batches.find((item) => item.code === batch)?.id ?? undefined) : undefined;
  const [tab, setTab] = useState<number | 'ALL'>('ALL');
  const [blockerStudent, setBlockerStudent] = useState<DailyEmailReportStudentRow | null>(null);
  const [exporting, setExporting] = useState(false);

  const [fromEmail, setFromEmail] = useState('');
  const [toRecipients, setToRecipients] = useState<string[]>([]);
  const [ccRecipients, setCcRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState('');

  const [previewRecord, setPreviewRecord] = useState<EmailReportRecord | null>(null);
  const [previewReadOnly, setPreviewReadOnly] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const queryClient = useQueryClient();

  const { data: report, isLoading, error, refetch } = useQuery({
    queryKey: ['email-report', dayKey, batch],
    queryFn: () => api.dailyEmailReport(dayKey, undefined, batch ?? undefined),
  });

  const { data: sentStatus } = useQuery({
    queryKey: ['email-status', dayKey, batch],
    queryFn: () => api.emailStatus(dayKey, batch ?? undefined),
    enabled: Boolean(report?.hasAssignment),
  });

  const generate = useMutation({
    mutationFn: () => {
      if (toRecipients.length === 0) {
        throw new Error('Add at least one "To" recipient before generating the email.');
      }
      if (!fromEmail) {
        throw new Error('Set a sender email before generating the email.');
      }
      // Scoped to the active batch filter, so "Foundation" on screen generates the
      // Foundation report — subject line included (§13).
      return api.generateEmail(dayKey, {
        fromEmail,
        toRecipients,
        ccRecipients,
        subject: subject || undefined,
        batchId,
      });
    },
    onSuccess: (record) => {
      setPreviewRecord(record);
      setPreviewReadOnly(false);
      setPreviewOpen(true);
      void queryClient.invalidateQueries({ queryKey: ['email-history'] });
    },
    onError: (error: Error) => toast.error('Could not generate email', { description: error.message }),
  });

  const onExport = async (format: 'CSV' | 'XLSX'): Promise<void> => {
    setExporting(true);
    try {
      await downloadFile(
        `/reports/daily/${dayKey}/export?format=${format}${batch ? `&batch=${encodeURIComponent(batch)}` : ''}`,
        `daily-email-report-${dayKey}.${format.toLowerCase()}`,
      );
      toast.success('Report downloaded');
    } catch (err) {
      toast.error('Export failed', { description: (err as Error).message });
    } finally {
      setExporting(false);
    }
  };

  const onViewHistory = async (record: EmailReportRecord): Promise<void> => {
    setPreviewRecord(record);
    setPreviewReadOnly(true);
    setPreviewOpen(true);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Email Reports</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Daily DSA assignment reporting, follow-up, and mentor-approved email delivery.
            {report?.summary.batchName ? ` Showing ${report.summary.batchName}.` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <BatchFilter />
          <label htmlFor="reportDate" className="sr-only">
            Report date
          </label>
          <input
            id="reportDate"
            type="date"
            value={dayKey}
            onChange={(event) => {
              setDayKey(event.target.value);
              setTab('ALL');
            }}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
          />
          <Button onClick={() => void refetch()}>Generate Report</Button>
        </div>
      </header>

      {isLoading ? (
        <Card>
          <TableSkeleton rows={6} cols={6} />
        </Card>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !report ? null : report.isFutureDate ? (
        <Card>
          <EmptyState
            title="No assignment data available for this date"
            description="This date is in the future — there is nothing to report yet."
          />
        </Card>
      ) : !report.hasAssignment ? (
        <Card>
          <EmptyState
            title={`No assignment on ${dayKey}`}
            description="Nothing was assigned that day, so there is nothing to report. Pick another date."
          />
        </Card>
      ) : (
        <>
          {sentStatus?.sent ? (
            <div className="rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-4 py-3 text-sm text-[var(--color-success)]">
              This report has already been sent — {new Date(sentStatus.sent.sentAt ?? '').toLocaleString()}.{' '}
              <button
                className="font-semibold underline"
                onClick={() => void onViewHistory(sentStatus.sent!)}
              >
                View previous email
              </button>
            </div>
          ) : null}

          {report.excludedNotYetEnrolled > 0 ? (
            <p className="text-xs text-[var(--color-fg-subtle)]">
              {report.excludedNotYetEnrolled} student(s) excluded — they joined after this program day.
            </p>
          ) : null}

          <SummaryCards report={report} />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <PerformanceTabs report={report} active={tab} onChange={setTab} />
            <div className="flex gap-2">
              <Button variant="secondary" loading={exporting} onClick={() => void onExport('CSV')}>
                <Download className="size-3.5" aria-hidden />
                CSV
              </Button>
              <Button variant="secondary" loading={exporting} onClick={() => void onExport('XLSX')}>
                <FileSpreadsheet className="size-3.5" aria-hidden />
                Excel
              </Button>
            </div>
          </div>

          <Card>
            <CardHeader title="Student Performance" description={`${report.students.length} students tracked`} />
            <StudentTable
              report={report}
              filter={tab}
              dayKey={dayKey}
              onRecordBlocker={setBlockerStudent}
            />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Action Items for Campus Team" description="Who needs intervention today, and what to do." />
              <ActionItemsPanel report={report} />
            </Card>
            <Card>
              <CardHeader title="Blockers" description="Reported vs. not-yet-reported, for students who did not finish." />
              <BlockerSummaryPanel report={report} />
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Email"
              description="Configure recipients, then preview before anything is sent."
              action={<Mail className="size-4 text-[var(--color-fg-subtle)]" aria-hidden />}
            />
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                  From (sender email)
                </span>
                <input
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                  placeholder="mentor@kalvium.community"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </label>
              <RecipientsEditor label="To" emails={toRecipients} onChange={setToRecipients} />
              <RecipientsEditor label="CC" emails={ccRecipients} onChange={setCcRecipients} />
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">Subject</span>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={defaultEmailSubject(dayKey)}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]"
                />
              </label>
              <div className="sm:col-span-2">
                <Button
                  variant="primary"
                  loading={generate.isPending}
                  onClick={() => generate.mutate()}
                >
                  <Send className="size-3.5" aria-hidden />
                  Preview Email
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Report History" description="Every generated report, its approval status, and when it was sent." />
            <HistoryTable dayKey={dayKey} onView={onViewHistory} />
          </Card>
        </>
      )}

      <BlockerFormModal
        open={Boolean(blockerStudent)}
        onClose={() => setBlockerStudent(null)}
        student={blockerStudent}
        dayKey={dayKey}
      />

      <EmailPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        emailReport={previewRecord}
        readOnly={previewReadOnly}
        onApproved={(record) => setPreviewRecord(record)}
        onSent={(record) => {
          setPreviewRecord(record);
          void queryClient.invalidateQueries({ queryKey: ['email-status', dayKey, batch] });
          void queryClient.invalidateQueries({ queryKey: ['email-history'] });
        }}
      />
    </div>
  );
}
