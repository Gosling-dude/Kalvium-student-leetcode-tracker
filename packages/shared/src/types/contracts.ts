/**
 * API contracts.
 *
 * These are the wire shapes the NestJS controllers return and the Next.js client
 * consumes. Keeping them in one shared package means a breaking change to a response
 * shape fails the frontend type-check at build time rather than at 9am in front of a
 * mentor. Dates cross the wire as ISO-8601 strings; day buckets cross as `DayKey`.
 */

import type { DayKey } from '../domain/time';
import type { BadgeSummary, EvaluatedAchievement, LevelProgress } from '../domain/gamification';
import type { ScoreComponent } from '../domain/scoring';
import type { ActionTier, BlockerSummaryKey, StatusLabel } from '../domain/daily-email-report';
import type {
  BatchChangeSource,
  BatchStatus,
  BlockerCategory,
  Difficulty,
  EmailReportStatus,
  ProblemStatus,
  StudentStatus,
  SyncJobStatus,
  SyncMode,
  SyncStatus,
  SyncTrigger,
  UserRole,
} from './enums';

/** Envelope used by every list endpoint. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
  /** Non-null only for `role: 'STUDENT'` — the linked `Student` row's id. */
  studentId: string | null;
  /** True when this account has never had its provisioned password changed. */
  mustChangePassword: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse extends AuthTokens {
  user: AuthUser;
}

export interface BatchSummary {
  id: string;
  name: string;
  /** Short stable key used in URLs and filters, e.g. `A`. */
  code: string;
  description: string | null;
  status: BatchStatus;
  sortOrder: number;
  /** Active students only — archived students are not part of a batch's current size. */
  studentCount: number;
  startDate: string | null;
  isActive: boolean;
}

/** A batch plus the figures the Batch Management cards show. */
export interface BatchStats extends BatchSummary {
  activeStudents: number;
  archivedStudents: number;
  /** Mean completion over the requested day, 0–100. */
  averageCompletionPercent: number;
  /** Mean `maxBeltLevel` across active students with one recorded; null when none have. */
  averageBeltLevel: number | null;
  /** Cohort → number of active students, ascending by cohort. */
  cohortCounts: { cohort: number | null; studentCount: number }[];
  /** Problems assigned to this batch on the requested day. */
  assignedCount: number;
  dayKey: DayKey;
}

/** One row of a student's batch history, newest first in API responses. */
export interface BatchHistoryEntry {
  id: string;
  studentId: string;
  fromBatchId: string | null;
  fromBatchName: string | null;
  fromBatchCode: string | null;
  toBatchId: string | null;
  toBatchName: string | null;
  toBatchCode: string | null;
  effectiveFromDayKey: DayKey;
  reason: string | null;
  source: BatchChangeSource;
  changedById: string | null;
  changedByName: string | null;
  changedAt: string;
}

export interface SquadSummary {
  id: string;
  name: string;
  batchId: string | null;
  batchName: string | null;
  mentorId: string | null;
  mentorName: string | null;
  studentCount: number;
  color: string | null;
}

export interface StudentSummary {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /** Null when no LeetCode account has been linked yet — see the schema note. */
  leetcodeUsername: string | null;
  status: StudentStatus;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /** Current cohort (1…6 today). Null when the student has not been assigned one. */
  cohort: number | null;
  /**
   * The authoritative belt from the roster — never derived from score, solved counts or
   * eligibility. Null when the roster has not supplied one.
   */
  maxBeltLevel: number | null;
  squadId: string | null;
  squadName: string | null;
  avatarUrl: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  currentStreak: number;
  longestStreak: number;
  /** Lifetime distinct LeetCode problems solved. Never assignment completion. */
  totalSolved: number;
  archivedAt: string | null;
  archivedReason: string | null;
  createdAt: string;
}

export interface DifficultyBreakdown {
  easy: number;
  medium: number;
  hard: number;
  total: number;
}

/** One assigned problem plus this student's outcome on it. */
export interface StudentProblemResult {
  problemId: string;
  title: string;
  titleSlug: string;
  url: string;
  difficulty: Difficulty;
  status: ProblemStatus;
  solvedAt: string | null;
  language: string | null;
  runtime: string | null;
  memory: string | null;
}

export interface StudentDailyReport {
  student: StudentSummary;
  dayKey: DayKey;
  assignedCount: number;
  solvedCount: number;
  pendingCount: number;
  completionPercent: number;
  score: number;
  scoreComponents: ScoreComponent[];
  /** Program-local `HH:mm` when the assignment was completed, or `null`. */
  completionTime: string | null;
  firstSubmissionAt: string | null;
  lastSubmissionAt: string | null;
  currentStreak: number;
  longestStreak: number;
  weeklyCompletionPercent: number;
  monthlyCompletionPercent: number;
  totalSolvedAllTime: number;
  difficultyBreakdown: DifficultyBreakdown;
  problems: StudentProblemResult[];
  rank: number | null;
  badges: BadgeSummary[];
}

/** Headline figures for one batch on the dashboard, sized to that batch's assignment. */
export interface DashboardBatchBreakdown {
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  activeStudents: number;
  assignedCount: number;
  solvedBuckets: number[];
  completionPercent: number;
}

export interface DashboardStats {
  dayKey: DayKey;
  /** The batch filter applied; `null` when showing all batches. */
  batchId: string | null;
  /** Active students only — archived students are not part of the current programme. */
  totalStudents: number;
  activeStudents: number;
  /** Per-batch figures, always present so the dashboard can show both without a refetch. */
  batchBreakdown: DashboardBatchBreakdown[];
  /** Null on an unfiltered multi-batch day: there is no single assignment for everyone. */
  assignment: AssignmentSummary | null;
  /** Index = number solved, so `solvedBuckets[4]` is the count who cleared everything. */
  solvedBuckets: number[];
  completionPercent: number;
  averageProblemsSolved: number;
  streakChampion: { studentId: string; name: string; streak: number } | null;
  topPerformer: { studentId: string; name: string; score: number } | null;
  topSquad: { squadId: string; name: string; averageCompletion: number } | null;
  lastSyncAt: string | null;
  lastSyncStatus: SyncJobStatus | null;
  /** Students whose data could not be trusted this sync, by reason. */
  unreliableSyncCounts: Partial<Record<SyncStatus, number>>;
}

export interface AssignmentProblem {
  id: string;
  position: number;
  problemId: string;
  title: string;
  titleSlug: string;
  url: string;
  difficulty: Difficulty;
  questionFrontendId: string | null;
  acceptanceRate: number | null;
  topicTags: string[];
  companyTags: string[];
  isPaidOnly: boolean;
}

export interface AssignmentSummary {
  id: string;
  dayKey: DayKey;
  /**
   * The batch this problem set *currently* targets. `null` means "all batches" — either
   * because it predates batches, or because an admin retargeted it to "Both" (§9).
   */
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /**
   * The audience this assignment was first created with, frozen forever. Differs from
   * `batchId` only after a "Change Assignment Target" retarget — comparing the two is how
   * the UI shows "originally All, now Foundation" instead of silently rewriting history.
   */
  originalBatchId: string | null;
  originalBatchName: string | null;
  originalBatchCode: string | null;
  /** Non-null once this assignment's target has ever been changed from its original. */
  audienceChangedAt: string | null;
  title: string | null;
  topic: string | null;
  notes: string | null;
  difficulty: Difficulty | null;
  problems: AssignmentProblem[];
  createdAt: string;
  createdByName: string | null;
}

/** One "Change Assignment Target" event (§9) — mirrors `BatchHistoryEntry`'s shape. */
export interface AssignmentAudienceChangeEntry {
  id: string;
  assignmentId: string;
  fromBatchId: string | null;
  fromBatchName: string | null;
  fromBatchCode: string | null;
  toBatchId: string | null;
  toBatchName: string | null;
  toBatchCode: string | null;
  reason: string | null;
  changedById: string | null;
  changedByName: string | null;
  changedAt: string;
}

/** A row in one of the mentor dashboard's five "solved N" tables. */
export interface MentorBucketRow {
  studentId: string;
  name: string;
  email: string;
  squadName: string | null;
  /** The batch the student was in *on this day*, not their batch now. */
  batchName: string | null;
  batchCode: string | null;
  cohort: number | null;
  maxBeltLevel: number | null;
  leetcodeUsername: string | null;
  solvedCount: number;
  /** Problems assigned to *this student's* batch that day. */
  assignedCount: number;
  completionTime: string | null;
  currentStreak: number;
  score: number;
  rank: number | null;
  /** Titles of the assigned problems still outstanding. */
  missingProblems: string[];
  syncStatus: SyncStatus;
  /** Mentor-facing explanation of a zero — never just "unknown" when we know better. */
  reason: string | null;
}

export interface MentorBucket {
  solvedCount: number;
  label: string;
  students: MentorBucketRow[];
}

/**
 * One batch's slice of a day: its own problem set, its own students, its own buckets.
 *
 * Sized independently per batch because the batches genuinely differ — Foundation may
 * have 4 problems on a day Intermediate has 5, and bucketing either against the other's
 * count would invent students who "solved 5 of 4".
 */
export interface MentorBatchSection {
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  assignment: AssignmentSummary | null;
  /** This batch's problem count for the day. Never assume 4. */
  assignedCount: number;
  buckets: MentorBucket[];
  totalStudents: number;
}

export interface MentorDashboard {
  dayKey: DayKey;
  /** The batch filter that produced this view; `null` when showing all batches. */
  batchId: string | null;
  /**
   * One section per batch that had students on this day, in batch sort order. A
   * batch-filtered request yields exactly one section; an unfiltered request yields one
   * per batch, which is what the "Foundation … / Intermediate …" daily tracker renders.
   */
  sections: MentorBatchSection[];
  /**
   * The single section's assignment when filtered to one batch, otherwise `null` —
   * there is no one assignment for a multi-batch day, and picking one would misreport
   * the other batch's problems as everyone's.
   */
  assignment: AssignmentSummary | null;
  /** Every student across all sections, bucketed by solved count. */
  buckets: MentorBucket[];
  totalStudents: number;
}

export interface LeaderboardRow {
  rank: number;
  isTied: boolean;
  studentId: string;
  name: string;
  squadName: string | null;
  batchName: string | null;
  batchCode: string | null;
  cohort: number | null;
  maxBeltLevel: number | null;
  avatarUrl: string | null;
  solvedCount: number;
  currentStreak: number;
  score: number;
  completionTime: string | null;
  consistency: number;
  badges: BadgeSummary[];
  level: number;
  /** Rank change versus the previous period; positive means improved. */
  rankDelta: number | null;
}

export interface SquadLeaderboardRow {
  rank: number;
  isTied: boolean;
  squadId: string;
  name: string;
  memberCount: number;
  averageCompletion: number;
  totalSolved: number;
  averageStreak: number;
  averageScore: number;
  dailyScore: number;
  weeklyScore: number;
  monthlyScore: number;
}

export interface SyncJobSummary {
  id: string;
  status: SyncJobStatus;
  mode: SyncMode;
  trigger: SyncTrigger;
  dayKey: DayKey | null;
  totalStudents: number;
  processedStudents: number;
  succeededStudents: number;
  failedStudents: number;
  newSubmissions: number;
  progressPercent: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface QueueHealth {
  driver: 'bullmq' | 'inline';
  connected: boolean;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

export interface AnalyticsPoint {
  dayKey: DayKey;
  label: string;
  completionPercent: number;
  solvedCount: number;
  activeStudents: number;
  averageScore: number;
}

export interface TopicAnalytics {
  topic: string;
  assignedCount: number;
  solvedCount: number;
  completionPercent: number;
}

export interface DifficultyAnalytics {
  difficulty: Difficulty;
  assignedCount: number;
  solvedCount: number;
  completionPercent: number;
}

export interface SquadComparisonPoint {
  squadId: string;
  squadName: string;
  averageCompletion: number;
  averageScore: number;
  averageStreak: number;
  memberCount: number;
}

export interface AnalyticsOverview {
  range: { from: DayKey; to: DayKey };
  daily: AnalyticsPoint[];
  weekly: { label: string; completionPercent: number; averageScore: number }[];
  monthly: { label: string; completionPercent: number; averageScore: number }[];
  byDifficulty: DifficultyAnalytics[];
  byTopic: TopicAnalytics[];
  squadComparison: SquadComparisonPoint[];
  topImprovers: { studentId: string; name: string; delta: number }[];
  bottomPerformers: { studentId: string; name: string; completionPercent: number }[];
}

/**
 * The student-details metrics, kept as five separate named quantities.
 *
 * They were previously conflated — "Total Solved" was showing assignment completion —
 * so each one states exactly what it counts. Nothing here may be substituted for
 * anything else here.
 */
export interface StudentMetrics {
  /** Lifetime distinct LeetCode problems solved, across everything the student does. */
  totalLeetcodeSolved: number;
  /** The day `todayAssignment` describes, in program-local time. */
  dayKey: DayKey;
  /** Assigned problems completed for that day, and how many were assigned. */
  todayAssignment: {
    solvedCount: number;
    assignedCount: number;
    completionPercent: number;
    /** False when nothing was assigned that day — not the same as solving nothing. */
    hasAssignment: boolean;
  };
  /** Consecutive assignment days ending at the latest relevant one with ≥1 solved. */
  currentDsaStreak: number;
  longestDsaStreak: number;
  /** Assigned problems completed across the whole programme. */
  totalAssignmentProblemsCompleted: number;
}

export interface StudentProfile extends StudentSummary {
  levelProgress: LevelProgress;
  /**
   * Every batch this student has been placed in, newest first — the "Batch History"
   * section. Present on the profile because a mentor reading a past result needs to know
   * which batch it was earned in.
   */
  batchHistory: BatchHistoryEntry[];
  achievements: EvaluatedAchievement[];
  difficultyBreakdown: DifficultyBreakdown;
  /** Explicitly separated headline numbers — see `StudentMetrics`. */
  metrics: StudentMetrics;
  heatmap: { dayKey: DayKey; solvedCount: number; assignedCount: number; intensity: number }[];
  recentDays: {
    dayKey: DayKey;
    solvedCount: number;
    assignedCount: number;
    score: number;
    completionTime: string | null;
  }[];
  totalScore: number;
  weeklyCompletionPercent: number;
  monthlyCompletionPercent: number;
  notes: MentorNote[];
}

export interface MentorNote {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

/** Result of an Excel/CSV student import — partial success is the normal case. */
export interface ImportRowError {
  row: number;
  field: string | null;
  message: string;
  /** The raw values as parsed, so the mentor can see what went wrong. */
  data: Record<string, unknown>;
}

export interface ImportResult {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  /** Batches and squads auto-created because the sheet referenced them. */
  createdBatches: string[];
  createdSquads: string[];
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface SystemLogEntry {
  id: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  context: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Daily email reporting & follow-up
// ---------------------------------------------------------------------------

/** A mentor's blocker record for one student on one day. */
export interface BlockerRecord {
  id: string;
  studentId: string;
  studentName: string;
  dayKey: DayKey;
  solvedCount: number;
  assignedCount: number;
  category: BlockerCategory;
  description: string | null;
  actionTaken: string | null;
  followUpRequired: boolean;
  followUpDate: DayKey | null;
  mentorNotes: string | null;
  resolvedAt: string | null;
  recordedById: string | null;
  recordedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One student's outcome in a daily email report — the student table row (§6). */
export interface DailyEmailReportStudentRow {
  studentId: string;
  name: string;
  email: string;
  squadName: string | null;
  /** The batch the student was in on the reported day — historical, not current. */
  batchName: string | null;
  batchCode: string | null;
  cohort: number | null;
  leetcodeUsername: string | null;
  /** Problems assigned to *this student's* batch that day. */
  assignedCount: number;
  solvedCount: number;
  completionPercent: number;
  statusLabel: StatusLabel;
  actionTier: ActionTier;
  missingProblems: string[];
  syncStatus: SyncStatus;
  /** Why a zero is a zero — data problem vs. genuine non-attempt (reused from the mentor dashboard). */
  reason: string | null;
  blocker: BlockerRecord | null;
  /** Ready-to-use guidance text: blocker-aware when one is on file, generic otherwise (§8). */
  actionRequired: string;
}

export interface DailyEmailReportBucket {
  solvedCount: number;
  label: string;
  count: number;
  students: DailyEmailReportStudentRow[];
}

export interface DailyEmailReportActionGroup {
  tier: ActionTier;
  emoji: string;
  title: string;
  count: number;
  students: { studentId: string; name: string; email: string }[];
}

export interface DailyEmailBlockerSummaryEntry {
  key: BlockerSummaryKey;
  label: string;
  count: number;
}

export interface DailyEmailReportSummary {
  dayKey: DayKey;
  dayLabelLong: string;
  dayLabelShort: string;
  /** Which batch this report covers; `null` is the overall (all-batches) report. */
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  problemsAssigned: number;
  studentsTracked: number;
  /** Indexed by solved count, `assignedCount` entries long — e.g. `bucketCounts[0]` = "solved 4 of 4". */
  bucketCounts: { solvedCount: number; label: string; count: number }[];
  overallCompletionPercent: number;
  generatedAt: string;
}

/**
 * One batch's portion of a report. An overall report carries one of these per batch, so
 * the email can print "Foundation — 4 assigned" and "Intermediate — 5 assigned" as
 * separate blocks instead of averaging two different assignments into one meaningless
 * number.
 */
export interface DailyEmailReportBatchSection {
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  assignedCount: number;
  studentsTracked: number;
  completionPercent: number;
  problems: AssignmentProblem[];
  buckets: DailyEmailReportBucket[];
}

/** The full computed report for one day — reconstructed live, never stored (§2, §21). */
export interface DailyEmailReport {
  summary: DailyEmailReportSummary;
  hasAssignment: boolean;
  isFutureDate: boolean;
  /** Active students whose account predates the assignment but who joined after this
   *  particular day closed are excluded from the report; this is how many were. */
  excludedNotYetEnrolled: number;
  /**
   * Problems for the single batch being reported. Empty on an overall report spanning
   * batches with different sets — read `batchSections` there, because there is no one
   * problem list that is true for everybody.
   */
  problems: AssignmentProblem[];
  /** Per-batch blocks, in batch order. One entry when the report is batch-filtered. */
  batchSections: DailyEmailReportBatchSection[];
  buckets: DailyEmailReportBucket[];
  students: DailyEmailReportStudentRow[];
  actionGroups: DailyEmailReportActionGroup[];
  blockerSummary: DailyEmailBlockerSummaryEntry[];
}

export interface EmailRecipientsInput {
  fromEmail: string;
  toRecipients: string[];
  ccRecipients: string[];
  subject?: string;
}

/** Unsent, fully-rendered preview of what an email would contain (§11). */
export interface EmailPreview {
  dayKey: DayKey;
  /** The batch this preview covers; `null` for the overall report. */
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  fromEmail: string;
  toRecipients: string[];
  ccRecipients: string[];
  subject: string;
  bodyHtml: string;
}

/** One row of email history (§14) — the `EmailReport` row itself, wire-shaped. */
export interface EmailReportRecord {
  id: string;
  dayKey: DayKey;
  /** Which batch this report covered; `null` for the overall report. */
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  status: EmailReportStatus;
  fromEmail: string;
  toRecipients: string[];
  ccRecipients: string[];
  subject: string;
  bodyHtml: string;
  generatedAt: string;
  generatedByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  failedError: string | null;
  supersedesId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Student portal
//
// Every shape below is a *view* over the same tables the admin/mentor screens read —
// there is no parallel student data model. The one rule specific to this surface: never
// include `MentorNote`/`notes` (private mentor observations) or anything from the batch
// audience-retarget trail (`originalBatch*`, `audienceChangedAt`) — a student sees the
// assignment that currently applies to them, not the admin history of how it got there.
// ---------------------------------------------------------------------------

/** `StudentProfile` minus the one field a student must never see: mentor notes. */
export type StudentPortalProfile = Omit<StudentProfile, 'notes'>;

/** One assigned problem's outcome for the logged-in student, from `DailyProblemStatus`. */
export interface StudentProblemOutcome {
  problemId: string;
  position: number;
  title: string;
  titleSlug: string;
  url: string;
  difficulty: Difficulty;
  status: ProblemStatus;
  solvedAt: string | null;
}

/**
 * An assignment as a student may see it: the batch-level content (from
 * `AssignmentSummary`, with the retarget-history fields dropped) plus — only when the
 * assignment is for a day that has been rolled up — this student's own per-problem
 * result. `myOutcome` is `null` for a day that has not been computed yet (e.g. today,
 * before the next sync/rollup), which is different from "solved nothing".
 */
export interface StudentAssignmentView {
  id: string;
  dayKey: DayKey;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  title: string | null;
  topic: string | null;
  difficulty: Difficulty | null;
  problems: AssignmentProblem[];
  myOutcome: {
    solvedCount: number;
    assignedCount: number;
    completionPercent: number;
    isPerfect: boolean;
    completedAt: string | null;
    problems: StudentProblemOutcome[];
  } | null;
}

/** One row of `/student/assignments` — the history table, not the full detail view. */
export interface StudentAssignmentHistoryRow {
  id: string;
  dayKey: DayKey;
  title: string | null;
  topic: string | null;
  difficulty: Difficulty | null;
  assignedCount: number;
  solvedCount: number;
  isPerfect: boolean;
  score: number;
  completedAt: string | null;
}

/** Everything `/student/dashboard` needs in one round trip. */
export interface StudentDashboard {
  name: string;
  batchName: string | null;
  batchCode: string | null;
  cohort: number | null;
  maxBeltLevel: number | null;
  currentStreak: number;
  longestStreak: number;
  totalSolved: number;
  totalScore: number;
  todayAssignment: StudentAssignmentView | null;
  weeklySolved: number;
  monthlySolved: number;
  weeklyCompletionPercent: number;
  monthlyCompletionPercent: number;
  /** Null when no leaderboard snapshot has been computed yet for this period. */
  currentRank: { period: LeaderboardPeriod; rank: number; total: number } | null;
  recentDays: {
    dayKey: DayKey;
    solvedCount: number;
    assignedCount: number;
    isPerfect: boolean;
  }[];
}

export type LeaderboardPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';
