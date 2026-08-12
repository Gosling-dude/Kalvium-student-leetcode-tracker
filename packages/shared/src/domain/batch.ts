/**
 * Batch — the rules for "which batch does this student belong to, and when".
 *
 * Two concepts that are easy to conflate and must not be:
 *
 *  * **Current batch** (`Student.batchId`) — where a student is *now*. Changes whenever
 *    an admin moves them. Drives current views: the dashboard, today's assignment, the
 *    live leaderboard, today's email.
 *
 *  * **Historical batch** (`resolveBatchOnDay` over `StudentBatchHistory`) — where a
 *    student was on a *given day*. Never changes once that day has passed.
 *
 * The distinction is the whole point of this module. A student who was Foundation on
 * 10 Aug and moves to Intermediate on 15 Aug must still appear under Foundation in every
 * report about 10 Aug, and must be evaluated against Foundation's 10 Aug problems — not
 * Intermediate's. Deriving a past day's batch from `Student.batchId` silently rewrites
 * history the moment anyone is moved, which is exactly the bug this prevents.
 *
 * Pure: no I/O, no clock reads. Callers load the placement rows and pass them in.
 */

import type { DayKey } from './time';

/** Batch codes are compared case-insensitively at the edges and stored uppercase. */
export function normaliseBatchCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * A batch code derived from a name, for callers that only supply a name.
 *
 * Used by the legacy admin/import paths that create batches by name alone. `code` is
 * `NOT NULL UNIQUE`, so those paths need *something* deterministic; the caller is
 * responsible for resolving a collision (typically by appending a counter), which is why
 * this returns a candidate rather than claiming to be unique.
 */
export function deriveBatchCode(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 24) || 'BATCH';
}

/**
 * One placement, as stored in `StudentBatchHistory`.
 *
 * `toBatchId` is the batch the student is in *from* `effectiveFromDayKey` onwards, and
 * may be null (moved out of every batch). `changedAt` breaks ties when two placements
 * share an effective day — the later record wins, because it was recorded later.
 */
export interface BatchPlacement {
  toBatchId: string | null;
  effectiveFromDayKey: DayKey;
  changedAt: Date;
}

/**
 * The batch a student was in on `dayKey`, given their full placement history.
 *
 * Returns the newest placement effective on or before the day. `null` means the student
 * had no batch then — either they predate batches entirely, or their earliest placement
 * starts after `dayKey` (they had not been classified yet). Both are genuine "no batch"
 * answers, and callers must not substitute the current batch for them: reporting a
 * pre-batch day under a batch that did not exist yet is a fabricated fact.
 *
 * `placements` may arrive in any order.
 */
export function resolveBatchOnDay(
  placements: readonly BatchPlacement[],
  dayKey: DayKey,
): string | null {
  let winner: BatchPlacement | null = null;

  for (const placement of placements) {
    // `dayKey` strings are zero-padded ISO dates, so lexical order is chronological.
    if (placement.effectiveFromDayKey > dayKey) continue;

    if (
      winner === null ||
      placement.effectiveFromDayKey > winner.effectiveFromDayKey ||
      (placement.effectiveFromDayKey === winner.effectiveFromDayKey &&
        placement.changedAt.getTime() >= winner.changedAt.getTime())
    ) {
      winner = placement;
    }
  }

  return winner?.toBatchId ?? null;
}

/**
 * Which assignment applies to a student on a day, given the day's assignments.
 *
 * Resolution is deliberately two-tier:
 *
 *  1. the assignment for the student's batch that day, if one exists;
 *  2. otherwise the batch-less (`batchId === null`) assignment for that day.
 *
 * Tier 2 is not a fallback for "this batch has no work today" — it is how assignments
 * created *before* batches existed keep applying to everyone, which is what they did at
 * the time. A student in Foundation is never evaluated against Intermediate's problem
 * set: a batch-specific assignment belonging to another batch is not a candidate at all.
 *
 * Returns `null` when neither tier matches, which means "nothing was assigned to this
 * student that day" — a neutral day, not a missed one.
 */
export function selectAssignmentForBatch<T extends { batchId: string | null }>(
  assignments: readonly T[],
  batchId: string | null,
): T | null {
  if (batchId !== null) {
    const own = assignments.find((assignment) => assignment.batchId === batchId);
    if (own) return own;
  }
  return assignments.find((assignment) => assignment.batchId === null) ?? null;
}

/**
 * Whether a proposed move is a real change.
 *
 * Moving a student to the batch they are already in writes a misleading history row and
 * an audit entry describing a change that did not happen, so callers reject it instead.
 */
export function isRedundantMove(currentBatchId: string | null, targetBatchId: string): boolean {
  return currentBatchId === targetBatchId;
}

/**
 * The write-once freeze that protects a `DailyStatus` row's `batchId` and `assignmentId`
 * once a day has been computed (§7, §9): an ordinary recompute keeps whatever value is
 * already on the row rather than the freshly-resolved one, so a later batch move or
 * assignment retarget can never silently rewrite an already-scored day.
 *
 * `force` is the deliberate escape hatch for the one case that freeze must *not* protect:
 * a day whose frozen value was wrong from the start because of an upstream data bug (for
 * example a roster sync that recorded a placement as effective from the wrong day). That
 * is a data correction, not an after-the-fact edit, so a forced recompute is allowed to
 * replace the frozen value outright.
 *
 * Pure and shared by every caller that freezes a field this way, so the two fields
 * (`batchId`, `assignmentId`) and any future one can never drift into applying the rule
 * differently.
 */
export function resolveFrozenField<T>(
  existingValue: T | null | undefined,
  incomingValue: T,
  force = false,
): T {
  if (force) return incomingValue;
  return existingValue ?? incomingValue;
}
