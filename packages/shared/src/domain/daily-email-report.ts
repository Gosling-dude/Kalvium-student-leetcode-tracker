/**
 * Daily email reporting — pure rules.
 *
 * This module answers two questions with no I/O involved: "what action tier does a
 * student fall into" and "how many performance buckets does a day need". Both are
 * driven entirely by `assignedCount`, which is read from that day's actual assignment
 * (§3) — never hardcoded to 4, so a 3-problem day gets 4 buckets (0..3) and a 5-problem
 * day gets 6 (0..5), not a fixed set with a misleading empty slot (§4).
 *
 * The five action tiers in the spec are phrased as absolute solved-counts for a
 * 4-problem day ("solved 0" / "solved 1" / "solved 2" / "solved 3" / "solved all").
 * Generalised to `assignedCount` problems, the only version of that rule that still
 * makes sense is by problems *remaining*: nobody who solved 0 is "nearly done" just
 * because the day only had 2 problems, and nobody who has exactly 1 left is "in the
 * intervention" tier just because the day had 6. So the tiers key off `remaining`
 * except at the two extremes (0 solved, and solved === assigned), which are absolute
 * by definition. For `assignedCount === 4` this reduces to exactly the worked example
 * in the spec.
 */

import { completionPercentage } from './scoring';
import type { DayKey } from './time';
import { BLOCKER_CATEGORY_LABELS, type BlockerCategory } from '../types/enums';

export type ActionTier =
  | 'NOT_ASSIGNED'
  | 'URGENT'
  | 'INTERVENTION'
  | 'FOLLOW_UP'
  | 'NEAR_COMPLETE'
  | 'COMPLETE';

/** The four labels the student table's "Status" column uses (§6). */
export type StatusLabel = 'Urgent' | 'Intervention' | 'Follow-up' | 'Complete' | 'Not assigned';

export interface ActionTierMeta {
  tier: ActionTier;
  emoji: string;
  title: string;
  /** Generic guidance used when no blocker has been recorded for a student in this tier. */
  actionWithoutBlocker: string;
  /** Guidance used when a blocker *has* been recorded — points at the record, not at guessing. */
  actionWithBlocker: string;
  statusLabel: StatusLabel;
}

export const ACTION_TIER_META: Record<ActionTier, ActionTierMeta> = {
  NOT_ASSIGNED: {
    tier: 'NOT_ASSIGNED',
    emoji: '⚪',
    title: 'No Assignment',
    actionWithoutBlocker: 'No problems were assigned this day — no action required.',
    actionWithBlocker: 'No problems were assigned this day — no action required.',
    statusLabel: 'Not assigned',
  },
  URGENT: {
    tier: 'URGENT',
    emoji: '🔴',
    title: 'Immediate Intervention — 0 Problems',
    actionWithoutBlocker:
      'Contact this student today and identify the blocker preventing them from starting or completing the assignment.',
    actionWithBlocker:
      'A blocker is on file. Follow up on the recorded action and confirm whether it resolved the issue.',
    statusLabel: 'Urgent',
  },
  INTERVENTION: {
    tier: 'INTERVENTION',
    emoji: '🟠',
    title: 'Follow-up Required — Early Progress',
    actionWithoutBlocker:
      'Connect with this student and understand the blocker. If there is no blocker, ask them to complete the remaining assignments.',
    actionWithBlocker:
      'A blocker is on file. Follow up on the recorded action and confirm whether it resolved the issue.',
    statusLabel: 'Intervention',
  },
  FOLLOW_UP: {
    tier: 'FOLLOW_UP',
    emoji: '🟡',
    title: 'Follow-up Required — Halfway',
    actionWithoutBlocker:
      'Ask the student to complete the remaining assignments and identify whether they are facing a conceptual, technical, or time-related blocker.',
    actionWithBlocker:
      'A blocker is on file. Follow up on the recorded action and confirm whether it resolved the issue.',
    statusLabel: 'Follow-up',
  },
  NEAR_COMPLETE: {
    tier: 'NEAR_COMPLETE',
    emoji: '🟢',
    title: 'Near Completion — 1 Remaining',
    actionWithoutBlocker: 'Send a reminder or encouragement to complete the final problem.',
    actionWithBlocker:
      'A blocker is on file for the remaining problem. Follow up on the recorded action.',
    statusLabel: 'Follow-up',
  },
  COMPLETE: {
    tier: 'COMPLETE',
    emoji: '✅',
    title: 'Completed',
    actionWithoutBlocker: 'No intervention required.',
    actionWithBlocker: 'No intervention required.',
    statusLabel: 'Complete',
  },
};

/**
 * The action tier a student falls into for a day, generalised to any assignment size.
 * `assignedCount <= 0` means nothing was assigned — never classify a student against a
 * day that had no work to do.
 */
export function actionTierFor(solvedCount: number, assignedCount: number): ActionTier {
  if (assignedCount <= 0) return 'NOT_ASSIGNED';
  const solved = Math.max(0, Math.min(solvedCount, assignedCount));
  if (solved >= assignedCount) return 'COMPLETE';
  if (solved === 0) return 'URGENT';

  const remaining = assignedCount - solved;
  if (remaining === 1) return 'NEAR_COMPLETE';
  if (remaining === 2) return 'FOLLOW_UP';
  return 'INTERVENTION';
}

export function statusLabelFor(solvedCount: number, assignedCount: number): StatusLabel {
  return ACTION_TIER_META[actionTierFor(solvedCount, assignedCount)].statusLabel;
}

/**
 * One row per possible solved-count, from `assignedCount` down to `0` — sized to the
 * day's actual assignment, never padded to a fixed number (§4). `assignedCount === 0`
 * yields an empty array: there is nothing to bucket.
 */
export interface PerformanceBucketShape {
  solvedCount: number;
  label: string;
}

export function buildBucketShapes(assignedCount: number): PerformanceBucketShape[] {
  if (assignedCount <= 0) return [];
  const shapes: PerformanceBucketShape[] = [];
  for (let solved = assignedCount; solved >= 0; solved -= 1) {
    shapes.push({
      solvedCount: solved,
      label: solved === assignedCount ? `Completed All (${assignedCount}/${assignedCount})` : `Completed ${solved}`,
    });
  }
  return shapes;
}

/** `2026-08-08` → `08 August 2026`. Pure string maths — `dayKey` carries no timezone. */
export function formatDayKeyLong(dayKey: DayKey): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return dayKey;
  return `${String(day).padStart(2, '0')} ${MONTH_NAMES_LONG[month - 1]} ${year}`;
}

/** `2026-08-08` → `08 Aug 2026`. Used for the email subject and compact date labels. */
export function formatDayKeyShort(dayKey: DayKey): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return dayKey;
  return `${String(day).padStart(2, '0')} ${MONTH_NAMES_SHORT[month - 1]} ${year}`;
}

const MONTH_NAMES_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_NAMES_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function defaultEmailSubject(dayKey: DayKey): string {
  return `Daily DSA Assignment Report — ${formatDayKeyShort(dayKey)}`;
}

/**
 * The subject line for a report, naming the batch when there is one.
 *
 * "DSA Daily Assignment Report — Foundation Level — 12 Aug 2026" rather than two
 * identically-titled emails, so a recipient holding both can tell at a glance which
 * students each one is about (§13). Falls back to the batch-less subject for the overall
 * report, which genuinely covers everyone.
 */
export function batchEmailSubject(dayKey: DayKey, batchName?: string | null): string {
  if (!batchName) return defaultEmailSubject(dayKey);
  return `Daily DSA Assignment Report — ${batchName} — ${formatDayKeyShort(dayKey)}`;
}

/**
 * The subject line for a campus-scoped report (§33).
 *
 * Names the campus before the batch, because that is the coarser distinction and the one
 * a recipient needs first: two "Foundation" reports arriving the same morning are
 * indistinguishable without it. An unscoped report says "All Campuses" outright rather
 * than staying silent, so nobody has to infer from an absence what population it covers.
 *
 * Falls back to `batchEmailSubject` when there is no campus at all, which keeps every
 * pre-campus subject line — and the tests asserting them — reading exactly as before.
 */
export function scopedEmailSubject(
  dayKey: DayKey,
  campusName?: string | null,
  batchName?: string | null,
): string {
  if (!campusName) return batchEmailSubject(dayKey, batchName);
  const audience = batchName ? `${campusName} — ${batchName}` : campusName;
  return `Daily DSA Assignment Report — ${audience} — ${formatDayKeyShort(dayKey)}`;
}

/**
 * Blocker-summary bucket key. `NOT_REPORTED` is distinct from the `NO_BLOCKER` category
 * — one means nobody asked yet, the other means a mentor asked and there genuinely was
 * none (§8). Collapsing them would hide exactly the gap this feature exists to surface.
 */
export type BlockerSummaryKey = BlockerCategory | 'NOT_REPORTED';

export const BLOCKER_SUMMARY_LABELS: Record<BlockerSummaryKey, string> = {
  CONCEPTUAL_DIFFICULTY: 'Conceptual difficulty',
  UNABLE_TO_UNDERSTAND_PROBLEM: 'Unable to understand problem',
  UNABLE_TO_IDENTIFY_PATTERN: 'Unable to identify pattern',
  CODING_IMPLEMENTATION_ISSUE: 'Coding/implementation issue',
  ENVIRONMENT_SETUP_ISSUE: 'Environment/setup issue',
  LEETCODE_ISSUE: 'LeetCode issue',
  TIME_MANAGEMENT: 'Time management',
  INTERNET_DEVICE_ISSUE: 'Internet/device issue',
  PERSONAL_REASON: 'Personal reason',
  NO_BLOCKER: 'No blocker (confirmed)',
  OTHER: 'Other',
  NOT_REPORTED: 'No blocker reported',
};

/** Stable display order: unresolved first, "no blocker" states last. */
export const BLOCKER_SUMMARY_ORDER: BlockerSummaryKey[] = [
  'CONCEPTUAL_DIFFICULTY',
  'UNABLE_TO_UNDERSTAND_PROBLEM',
  'UNABLE_TO_IDENTIFY_PATTERN',
  'CODING_IMPLEMENTATION_ISSUE',
  'ENVIRONMENT_SETUP_ISSUE',
  'LEETCODE_ISSUE',
  'TIME_MANAGEMENT',
  'INTERNET_DEVICE_ISSUE',
  'PERSONAL_REASON',
  'OTHER',
  'NO_BLOCKER',
  'NOT_REPORTED',
];

/** Simple RFC 5322-ish check used by both the DTO layer and the recipient editor. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** The summary card's "Overall Completion Rate" (§5) — total solved over total assigned. */
export function overallCompletionPercent(totalSolved: number, totalAssigned: number): number {
  return completionPercentage(totalSolved, totalAssigned);
}

/**
 * The per-student "Action Required" text (§7, §8) — blocker-aware. Three distinct
 * cases, deliberately worded differently so a mentor scanning the table can tell them
 * apart at a glance:
 *
 *  1. Nobody has recorded anything for this student yet → generic tier guidance, and
 *     says explicitly that no blocker has been reported.
 *  2. A mentor recorded that there genuinely is no blocker (`NO_BLOCKER` category) →
 *     the exact phrasing the spec calls for: the student should just finish the work.
 *  3. A real blocker is on file → point at it by name, quoting the description when one
 *     was given, instead of repeating generic advice the mentor has already acted on.
 */
export function buildActionRequiredText(
  tier: ActionTier,
  blocker: { category: BlockerCategory; description: string | null } | null,
): string {
  const meta = ACTION_TIER_META[tier];
  if (tier === 'COMPLETE' || tier === 'NOT_ASSIGNED') return meta.actionWithoutBlocker;

  if (!blocker) {
    return `${meta.actionWithoutBlocker} No blocker reported.`;
  }
  if (blocker.category === 'NO_BLOCKER') {
    return 'No blocker reported — student should complete the remaining assignments.';
  }

  const label = BLOCKER_CATEGORY_LABELS[blocker.category];
  const quoted = blocker.description ? ` — "${blocker.description}"` : '';
  return `${meta.actionWithBlocker} Blocker: ${label}${quoted}.`;
}
