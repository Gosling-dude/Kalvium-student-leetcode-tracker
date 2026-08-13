/**
 * The daily report email body.
 *
 * Table-based layout with inline styles only — the constraints of HTML email, not a
 * stylistic choice. No external stylesheet, no JS, nothing that Gmail/Outlook strip.
 * Structure follows the spec section-by-section (§12) so a reviewer can check the
 * rendered email against the brief line for line.
 */

import type { DailyEmailReport, DailyEmailReportStudentRow } from '@dsa/shared';

const COLORS = {
  text: '#1e293b',
  muted: '#64748b',
  border: '#e2e8f0',
  headerBg: '#0f172a',
  headerFg: '#ffffff',
  soft: '#f8fafc',
  brand: '#4338ca',
  danger: '#dc2626',
  warning: '#d97706',
  success: '#16a34a',
  info: '#2563eb',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusColor(row: DailyEmailReportStudentRow): string {
  switch (row.actionTier) {
    case 'COMPLETE':
      return COLORS.success;
    case 'NEAR_COMPLETE':
    case 'FOLLOW_UP':
      return COLORS.warning;
    case 'INTERVENTION':
      return COLORS.warning;
    case 'URGENT':
      return COLORS.danger;
    default:
      return COLORS.muted;
  }
}

function section(title: string, bodyHtml: string): string {
  return `
    <tr>
      <td style="padding: 24px 0 8px;">
        <h2 style="margin:0; font-size:13px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${COLORS.muted};">
          ${escapeHtml(title)}
        </h2>
      </td>
    </tr>
    <tr><td>${bodyHtml}</td></tr>`;
}

function summaryTable(report: DailyEmailReport): string {
  const { summary } = report;
  const rows: [string, string][] = [
    ['Problems Assigned', String(summary.problemsAssigned)],
    ['Students Tracked', String(summary.studentsTracked)],
    ...summary.bucketCounts.map(
      (b): [string, string] => [b.label, String(b.count)],
    ),
    ['Overall Completion', `${summary.overallCompletionPercent}%`],
  ];
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows
        .map(
          ([label, value]) => `
        <tr>
          <td style="padding:6px 0; font-size:14px; color:${COLORS.muted};">${escapeHtml(label)}</td>
          <td style="padding:6px 0; font-size:14px; font-weight:700; color:${COLORS.text}; text-align:right;">${escapeHtml(value)}</td>
        </tr>`,
        )
        .join('')}
    </table>`;
}

function problemItems(problems: DailyEmailReport['problems']): string {
  return `
    <ol style="margin:0; padding-left:20px; font-size:14px; color:${COLORS.text};">
      ${problems
        .map(
          (p) => `
        <li style="margin-bottom:8px;">
          <strong>${escapeHtml(p.title)}</strong><br/>
          <span style="color:${COLORS.muted};">${escapeHtml(p.difficulty)}</span> ·
          <a href="${escapeHtml(p.url)}" style="color:${COLORS.brand};">${escapeHtml(p.url)}</a>
        </li>`,
        )
        .join('')}
    </ol>`;
}

/**
 * The assigned problems, per batch.
 *
 * An overall report covering batches with different sets prints one labelled block per
 * batch rather than a single merged list — a merged list would read as though every
 * student was given all of them (§4, §13).
 */
function problemsList(report: DailyEmailReport): string {
  const sections = report.batchSections.filter((s) => s.problems.length > 0);

  if (sections.length === 0) {
    return `<p style="margin:0; font-size:14px; color:${COLORS.muted};">No problems were assigned this day.</p>`;
  }

  if (sections.length === 1 && !sections[0]!.batchName) {
    return problemItems(sections[0]!.problems);
  }

  return sections
    .map(
      (batchSection) => `
      <div style="margin-bottom:18px;">
        <h3 style="margin:0 0 6px; font-size:14px; color:${COLORS.text};">
          ${escapeHtml(batchSection.batchName ?? 'All students')}
          <span style="font-weight:400; color:${COLORS.muted};">
            — ${batchSection.assignedCount} assigned · ${batchSection.studentsTracked} student(s) · ${batchSection.completionPercent}% complete
          </span>
        </h3>
        ${problemItems(batchSection.problems)}
      </div>`,
    )
    .join('');
}

/** Per-batch headline counts, so each batch's distribution is legible on its own (§10). */
function batchBreakdownTable(report: DailyEmailReport): string {
  if (report.batchSections.length <= 1) return '';

  const rows = report.batchSections
    .map((batchSection) => {
      const buckets = batchSection.buckets
        .map((bucket) => {
          const attemptParts: string[] = [];
          if (bucket.studentsAttemptedCount > 0) attemptParts.push(`${bucket.studentsAttemptedCount} attempted`);
          if (bucket.studentsNotAttemptedCount > 0) {
            attemptParts.push(`${bucket.studentsNotAttemptedCount} not attempted`);
          }
          const breakdown = attemptParts.length > 0 ? ` (${attemptParts.join(', ')})` : '';
          return `${bucket.label}: <strong>${bucket.count}</strong>${breakdown}`;
        })
        .join(' &middot; ');
      return `
        <tr>
          <td style="padding:8px 0; font-size:14px; color:${COLORS.text}; border-bottom:1px solid ${COLORS.border};">
            <strong>${escapeHtml(batchSection.batchName ?? 'Unassigned')}</strong>
            <span style="color:${COLORS.muted};"> — ${batchSection.assignedCount} assigned, ${batchSection.studentsTracked} student(s)</span>
            <br/>
            <span style="font-size:13px; color:${COLORS.muted};">${buckets}</span>
          </td>
        </tr>`;
    })
    .join('');

  return `<table role="presentation" width="100%" style="border-collapse:collapse;">${rows}</table>`;
}

/**
 * "2 attempted, 1 not attempted" for the problems a student did not solve — never just
 * a bare count, so a mentor reading the table does not have to guess which half of an
 * incomplete row is a real attempt versus untouched work (§ submission-attempt tracking).
 */
function attemptSummary(row: DailyEmailReportStudentRow): string {
  if (row.assignedCount === 0) return '—';
  if (row.solvedCount >= row.assignedCount) return `All ${row.assignedCount} solved`;
  const parts: string[] = [];
  if (row.attemptedNotSolvedCount > 0) parts.push(`${row.attemptedNotSolvedCount} attempted`);
  if (row.notAttemptedCount > 0) parts.push(`${row.notAttemptedCount} not attempted`);
  return parts.join(', ') || '—';
}

function studentTable(report: DailyEmailReport): string {
  if (report.students.length === 0) {
    return `<p style="margin:0; font-size:14px; color:${COLORS.muted};">No students tracked for this day.</p>`;
  }
  const rows = [...report.students].sort(
    (a, b) => (a.squadName ?? '').localeCompare(b.squadName ?? '') || a.name.localeCompare(b.name),
  );
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px;">
      <thead>
        <tr>
          ${['Student', 'Squad', 'Assigned', 'Solved', 'Remaining', 'Completion', 'Status']
            .map(
              (h) =>
                `<th align="left" style="padding:8px 6px; border-bottom:2px solid ${COLORS.border}; color:${COLORS.muted}; font-size:11px; text-transform:uppercase; letter-spacing:0.04em;">${h}</th>`,
            )
            .join('')}
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
        <tr>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border};">
            ${escapeHtml(row.name)}<br/><span style="color:${COLORS.muted}; font-size:12px;">${escapeHtml(row.email)}</span>
          </td>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border}; color:${COLORS.muted};">${escapeHtml(row.squadName ?? '—')}</td>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border};">${row.assignedCount}</td>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border};">${row.solvedCount}</td>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border}; color:${COLORS.muted};">${escapeHtml(attemptSummary(row))}</td>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border};">${row.completionPercent}%</td>
          <td style="padding:6px; border-bottom:1px solid ${COLORS.border};">
            <span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#fff; background:${statusColor(row)};">
              ${escapeHtml(row.statusLabel)}
            </span>
          </td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function actionItems(report: DailyEmailReport): string {
  const groups = report.actionGroups.filter((g) => g.count > 0 && g.tier !== 'COMPLETE');
  const completed = report.actionGroups.find((g) => g.tier === 'COMPLETE');

  const groupHtml = groups
    .map(
      (group) => `
    <div style="margin-bottom:16px; padding:12px 14px; border-left:3px solid ${COLORS.border}; background:${COLORS.soft};">
      <p style="margin:0 0 6px; font-size:14px; font-weight:700; color:${COLORS.text};">
        ${group.emoji} ${escapeHtml(group.title)} — ${group.count}
      </p>
      <p style="margin:0 0 6px; font-size:13px; color:${COLORS.muted};">
        ${group.students.map((s) => escapeHtml(s.name)).join(', ')}
      </p>
    </div>`,
    )
    .join('');

  const completedHtml = completed
    ? `<p style="margin:0; font-size:13px; color:${COLORS.muted};">✅ ${completed.count} student(s) completed everything — no action required.</p>`
    : '';

  return groupHtml + completedHtml || `<p style="margin:0; font-size:14px; color:${COLORS.muted};">Nothing to report.</p>`;
}

function blockerSummary(report: DailyEmailReport): string {
  if (report.blockerSummary.length === 0) {
    return `<p style="margin:0; font-size:14px; color:${COLORS.muted};">No students required follow-up this day.</p>`;
  }
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${report.blockerSummary
        .map(
          (entry) => `
        <tr>
          <td style="padding:4px 0; font-size:14px; color:${COLORS.text};">${escapeHtml(entry.label)}</td>
          <td style="padding:4px 0; font-size:14px; font-weight:700; text-align:right;">${entry.count} student(s)</td>
        </tr>`,
        )
        .join('')}
    </table>`;
}

export function buildDailyReportEmailHtml(report: DailyEmailReport): string {
  const { summary } = report;

  if (!report.hasAssignment) {
    const reason = report.isFutureDate
      ? 'This date is in the future — there is no assignment or submission data to report yet.'
      : 'No assignment was published for this day, so there is nothing to report.';
    return wrap(`
      <tr><td style="padding:8px 0 24px;">
        <h1 style="margin:0 0 8px; font-size:20px; color:${COLORS.text};">Daily DSA Assignment Report${summary.batchName ? ` — ${escapeHtml(summary.batchName)}` : ''} — ${escapeHtml(summary.dayLabelShort)}</h1>
        <p style="margin:0; font-size:14px; color:${COLORS.muted};">${escapeHtml(reason)}</p>
      </td></tr>
    `);
  }

  return wrap(`
    <tr><td style="padding:8px 0 4px;">
      <h1 style="margin:0 0 4px; font-size:20px; color:${COLORS.text};">Daily DSA Assignment Report</h1>
      <p style="margin:0; font-size:14px; color:${COLORS.muted};">
        ${summary.batchName ? `${escapeHtml(summary.batchName)} &middot; ` : ''}${escapeHtml(summary.dayLabelLong)}
      </p>
    </td></tr>
    <tr><td style="padding:16px 0 0; font-size:14px; color:${COLORS.text};">
      Hello Team,<br/><br/>
      Here is the DSA assignment progress report for ${escapeHtml(summary.dayLabelLong)}${
        summary.batchName ? ` (${escapeHtml(summary.batchName)})` : ''
      }.
    </td></tr>
    ${section('Assignment Summary', summaryTable(report))}
    ${
      report.batchSections.length > 1
        ? section('Batch Breakdown', batchBreakdownTable(report))
        : ''
    }
    ${section('Assigned Problems', problemsList(report))}
    ${section('Student Performance', studentTable(report))}
    ${section('Action Items for Campus Team', actionItems(report))}
    ${section('Blocker Summary', blockerSummary(report))}
    ${section(
      'Mentor Action Required',
      `<p style="margin:0; font-size:14px; color:${COLORS.text};">
        Please connect with students in the intervention and follow-up groups today, and record blockers/actions in the tracker.
        Where no blocker exists, students should complete all assigned problems.
      </p>`,
    )}
    <tr><td style="padding:28px 0 4px; font-size:14px; color:${COLORS.text};">
      Regards,<br/>DSA Program Team<br/>Kalvium
    </td></tr>
  `);
}

function wrap(bodyRows: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:${COLORS.soft}; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.soft};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px; width:100%; background:#ffffff; border:1px solid ${COLORS.border}; border-radius:12px; overflow:hidden;">
            <tr>
              <td style="background:${COLORS.headerBg}; color:${COLORS.headerFg}; padding:16px 24px; font-size:13px; font-weight:700; letter-spacing:0.04em;">
                DSA TRACKER · KALVIUM
              </td>
            </tr>
            <tr>
              <td style="padding:8px 24px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${bodyRows}
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
