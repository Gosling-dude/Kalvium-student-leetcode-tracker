/**
 * Domain enumerations shared by the API and the web client.
 *
 * These are plain string unions plus value objects rather than TypeScript `enum`s so
 * they serialise transparently over JSON, match the Prisma enum values one-for-one,
 * and can be used in both a NestJS DTO and a React component without a runtime import
 * dependency between the two.
 */

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * `STUDENT` is deliberately last and never implied by the others: `RolesGuard` grants
 * `ADMIN` every route automatically, but a route with no `@Roles(...)` at all is open to
 * every *other* existing role by default (that default predates this role and stays
 * unchanged for them). `STUDENT` is the one role for which that default flips to closed —
 * see `RolesGuard` — so a new admin/mentor endpoint that forgets a decorator fails safe
 * for students without anyone having to remember to exclude them.
 */
export const USER_ROLES = ['ADMIN', 'MENTOR', 'VIEWER', 'STUDENT'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Outcome of checking one student against one assigned problem.
 *
 * `NOT_ATTEMPTED` and `ATTEMPTED_NOT_ACCEPTED` are deliberately distinct: a mentor
 * reads them very differently, and only `ACCEPTED` earns points.
 */
export const PROBLEM_STATUSES = [
  'ACCEPTED',
  'ATTEMPTED_NOT_ACCEPTED',
  'NOT_ATTEMPTED',
  'UNKNOWN',
] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/**
 * Why a student's data looks the way it does after a sync.
 *
 * This exists because at 250+ students, bad usernames are a certainty — typos, renamed
 * accounts, private profiles. Without a reason code every one of those students renders
 * as "solved 0", and mentors read that as laziness rather than a data problem. Every
 * zero in the dashboard must be explainable.
 */
export const SYNC_STATUSES = [
  'OK',
  'NEVER_SYNCED',
  'USER_NOT_FOUND',
  'PROFILE_PRIVATE',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'TIMEOUT',
] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const SYNC_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

export const SYNC_TRIGGERS = ['MANUAL', 'CRON', 'RETRY', 'IMPORT', 'API'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_MODES = ['FULL', 'INCREMENTAL', 'RETRY_FAILED', 'SINGLE_STUDENT'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

/**
 * `ARCHIVED` is "no longer in the current programme" — the state a student reaches when
 * they drop off the authoritative roster.
 *
 * It exists so that removing someone from the roster never means deleting them. Their
 * submissions, daily statuses, streak history, leaderboard entries and email history are
 * historical facts that remain true after they leave; only their presence in *current*
 * views ends. Use `isCurrentStudent` rather than testing this value by hand.
 */
export const STUDENT_STATUSES = ['ACTIVE', 'INACTIVE', 'DROPPED', 'PAUSED', 'ARCHIVED'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DROPPED: 'Dropped',
  PAUSED: 'Paused',
  ARCHIVED: 'Archived',
};

/**
 * Whether a student counts towards the *current* programme.
 *
 * The single predicate behind "active student count", the dashboard, the daily tracker,
 * current leaderboards, new assignments and daily emails. Archived students fail it and
 * therefore vanish from all of those, while every historical query — which filters on a
 * `dayKey`, not on this — keeps them.
 */
export function isCurrentStudent(status: StudentStatus): boolean {
  return status === 'ACTIVE';
}

export const BATCH_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * Lifecycle of a campus. Mirrors `BatchStatus`: archiving removes a campus from pickers,
 * "all campuses" aggregates and new assignment targets, while it keeps owning every
 * student, batch and result it ever had. A campus is never deleted.
 */
export const CAMPUS_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type CampusStatus = (typeof CAMPUS_STATUSES)[number];

/**
 * The value a campus filter carries when the user has not narrowed to one.
 *
 * A single shared constant rather than each surface inventing `'all'` / `''` / `undefined`
 * for itself, because the API distinguishes "every campus" from "campus not specified" and
 * a filter that blurred the two would show one campus's students under another's heading.
 */
export const ALL_CAMPUSES = 'all' as const;

/**
 * How an unassigned batch is written wherever a student's placement is displayed.
 *
 * A student enrolled before their diagnostic assessment has **no batch** — `batchId` is
 * simply null. That is deliberately not modelled as a batch of its own: a placeholder
 * batch shows up in every batch picker, every leaderboard scope and every assignment
 * target, and reads as somewhere a student can be *assigned to* rather than somewhere
 * they are waiting. Null is the honest representation, and this is only its label.
 */
export const UNASSIGNED_BATCH_LABEL = 'Not Assigned';

/**
 * The batch filter value meaning "students with no batch yet".
 *
 * A third selector value alongside a batch code and `all`, because "no batch" is not a
 * batch and cannot be named by one. Resolvers turn it into `batchId IS NULL`.
 */
export const UNASSIGNED_BATCH_SELECTOR = 'none';

export const BATCH_CHANGE_SOURCES = ['MANUAL', 'ROSTER_SYNC', 'IMPORT', 'MIGRATION'] as const;
export type BatchChangeSource = (typeof BATCH_CHANGE_SOURCES)[number];

export const BATCH_CHANGE_SOURCE_LABELS: Record<BatchChangeSource, string> = {
  MANUAL: 'Manual change',
  ROSTER_SYNC: 'Roster sync',
  IMPORT: 'Import',
  MIGRATION: 'Migration',
};

export const NOTIFICATION_CHANNELS = [
  'EMAIL',
  'SLACK',
  'DISCORD',
  'WHATSAPP',
  'TELEGRAM',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENTS = [
  'ASSIGNMENT_MISSED',
  'STREAK_BROKEN',
  'LEADERBOARD_UPDATED',
  'SYNC_COMPLETED',
  'SYNC_FAILED',
  'ACHIEVEMENT_UNLOCKED',
  'DAILY_REPORT_PENDING_APPROVAL',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * Why a student did not finish a day's assignment, as recorded by a mentor.
 *
 * `NO_BLOCKER` is a deliberate choice a mentor makes ("I asked, there is no blocker") —
 * it is not the same as no `Blocker` row existing at all, which means nobody asked yet.
 * The report and email must keep those two states visually distinct.
 */
export const BLOCKER_CATEGORIES = [
  'CONCEPTUAL_DIFFICULTY',
  'UNABLE_TO_UNDERSTAND_PROBLEM',
  'UNABLE_TO_IDENTIFY_PATTERN',
  'CODING_IMPLEMENTATION_ISSUE',
  'ENVIRONMENT_SETUP_ISSUE',
  'LEETCODE_ISSUE',
  'TIME_MANAGEMENT',
  'INTERNET_DEVICE_ISSUE',
  'PERSONAL_REASON',
  'NO_BLOCKER',
  'OTHER',
] as const;
export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

export const BLOCKER_CATEGORY_LABELS: Record<BlockerCategory, string> = {
  CONCEPTUAL_DIFFICULTY: 'Conceptual difficulty',
  UNABLE_TO_UNDERSTAND_PROBLEM: 'Unable to understand problem',
  UNABLE_TO_IDENTIFY_PATTERN: 'Unable to identify pattern',
  CODING_IMPLEMENTATION_ISSUE: 'Coding/implementation issue',
  ENVIRONMENT_SETUP_ISSUE: 'Environment/setup issue',
  LEETCODE_ISSUE: 'LeetCode issue',
  TIME_MANAGEMENT: 'Time management',
  INTERNET_DEVICE_ISSUE: 'Internet/device issue',
  PERSONAL_REASON: 'Personal reason',
  NO_BLOCKER: 'No blocker',
  OTHER: 'Other',
};

/** Lifecycle of one generated daily report email. See `domain/daily-email-report.ts`. */
/**
 * DRAFT → PENDING_APPROVAL → APPROVED → SENDING → SENT, with SENDING → FAILED on error.
 * `SENDING` is the in-flight claim that makes a duplicate send impossible; see the
 * `EmailReportStatus` enum in schema.prisma.
 */
export const EMAIL_REPORT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENDING',
  'SENT',
  'FAILED',
] as const;
export type EmailReportStatus = (typeof EMAIL_REPORT_STATUSES)[number];

export const EMAIL_REPORT_STATUS_LABELS: Record<EmailReportStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  SENDING: 'Sending…',
  SENT: 'Sent',
  FAILED: 'Failed',
};

export const REPORT_TYPES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'SQUAD',
  'MENTOR',
  'ATTENDANCE',
  'HEATMAP',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF', 'JSON'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Human-readable copy for a sync status, surfaced directly in the "Solved 0" table. */
export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  OK: 'Synced',
  NEVER_SYNCED: 'Never synced',
  USER_NOT_FOUND: 'LeetCode username not found',
  PROFILE_PRIVATE: 'Profile is private',
  RATE_LIMITED: 'Rate limited by provider',
  PROVIDER_ERROR: 'Provider error',
  TIMEOUT: 'Request timed out',
};

/**
 * Whether a sync status means "the data is trustworthy".
 *
 * A zero under `OK` is a real zero the mentor should act on. A zero under anything else
 * is a data-quality problem the admin should fix, and the UI must not conflate them.
 */
export function isTrustworthySync(status: SyncStatus): boolean {
  return status === 'OK';
}
