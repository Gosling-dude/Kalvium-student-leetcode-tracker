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
import type {
  BaselineAttemptStatus,
  BaselineRiskSignal,
  BaselineReviewStatus,
  BaselineTestStatus,
} from '../domain/baseline';
import type { ActionTier, BlockerSummaryKey, StatusLabel } from '../domain/daily-email-report';
import type {
  BatchChangeSource,
  BatchStatus,
  CampusStatus,
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

/** A campus, as every picker, filter chip and report header renders it. */
export interface CampusSummary {
  id: string;
  name: string;
  /** Short stable key used in URLs and filters, e.g. `VELS`. */
  code: string;
  description: string | null;
  status: CampusStatus;
  sortOrder: number;
  /** Active students only — archived students are not part of a campus's current size. */
  studentCount: number;
  /** Active batches at this campus, in display order. */
  batchCount: number;
}

/** A campus plus the figures the campus cards and the campus-aware dashboard show. */
export interface CampusStats extends CampusSummary {
  activeStudents: number;
  archivedStudents: number;
  /** Active students at this campus who have no batch assigned yet. */
  unassignedStudents: number;
  /** Mean completion over the requested day, 0–100, across this campus only. */
  averageCompletionPercent: number;
  /** Per-batch breakdown, in display order. */
  batches: BatchSummary[];
  dayKey: DayKey;
}

/** One row of a student's campus history, newest first in API responses. */
export interface CampusHistoryEntry {
  id: string;
  studentId: string;
  fromCampusId: string | null;
  fromCampusName: string | null;
  fromCampusCode: string | null;
  toCampusId: string | null;
  toCampusName: string | null;
  toCampusCode: string | null;
  effectiveFromDayKey: DayKey;
  reason: string | null;
  source: BatchChangeSource;
  changedById: string | null;
  changedByName: string | null;
  changedAt: string;
}

export interface BatchSummary {
  id: string;
  /** The campus this batch belongs to. `VELS/A` and `SRM/A` are different batches. */
  campusId: string;
  campusName: string;
  campusCode: string;
  name: string;
  /** Short stable key used in URLs and filters, e.g. `A`. Unique per campus, not globally. */
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
  campusId: string | null;
  campusName: string | null;
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
  /** The campus the student is in *now*. Never used to interpret a past day (§17). */
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /** Squad number from the roster, e.g. 144. Independent of cohort and batch (§6). */
  squadNumber: number | null;
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
/** One campus's figures for a day, across every batch it has. */
export interface DashboardCampusBreakdown {
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  activeStudents: number;
  /** Sum of every in-scope student's assigned problems — not one batch's problem count. */
  assignedTotal: number;
  solvedTotal: number;
  completionPercent: number;
  attemptedNotSolvedStudents: number;
  notAttemptedStudents: number;
  /** Active students at this campus with no batch assigned yet. */
  unassignedStudents: number;
}

/**
 * One `Campus → Batch` group's figures for a day.
 *
 * Keyed by the pair, not by batch alone: `VELS/Foundation` and `SRM/Foundation` are
 * different groups with different problem sets, and collapsing them into one
 * "Foundation" row would average two unrelated cohorts into a number that describes
 * neither (§32).
 */
export interface DashboardBatchBreakdown {
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  activeStudents: number;
  assignedCount: number;
  solvedBuckets: number[];
  completionPercent: number;
  /**
   * Of the students in this batch who did *not* complete the assignment, how many have
   * at least one real (non-accepted) submission versus none at all — e.g. "17 students —
   * 5 attempted, 12 not attempted" (§ submission-attempt tracking). Students who
   * completed everything are excluded from both counts.
   */
  attemptedNotSolvedStudents: number;
  notAttemptedStudents: number;
}

/**
 * How the last sync went, for the students currently in scope.
 *
 * `synced + profileMissing + awaitingFirstSync + failed === activeStudents`, so the four
 * are a partition rather than four overlapping ways of counting the same students. That
 * property is the point: it lets the dashboard say "130 active · 108 synced · 21 need a
 * profile · 1 failed" instead of a single alarming total that mixed a roster gap with a
 * provider outage.
 */
export interface SyncHealthSummary {
  /** Active students in scope — the denominator every other count is part of. */
  activeStudents: number;
  /** Read successfully: their figures are real. */
  synced: number;
  /** No LeetCode handle on the roster yet. Never attempted, so never a failure (§7). */
  profileMissing: number;
  /** Has a handle, but the sync has not reached them yet. Resolves itself on the next run. */
  awaitingFirstSync: number;
  /** Genuinely attempted and could not be read — the only count that means "something broke". */
  failed: number;
  /** Every non-OK reason with its own count, for the detail chips. */
  byStatus: Partial<Record<SyncStatus, number>>;
}

export interface DashboardStats {
  dayKey: DayKey;
  /** The campus filter applied; `null` when showing every campus. */
  campusId: string | null;
  /** The batch filter applied; `null` when showing all batches. */
  batchId: string | null;
  /** Active students only — archived students are not part of the current programme. */
  totalStudents: number;
  activeStudents: number;
  /**
   * Per-campus roll-up, always present so the dashboard can show the global picture and
   * each campus's without a refetch. Every number is computed from the day's data rather
   * than summed from `batchBreakdown`, so a campus total stays right even when one of its
   * batches had no assignment (§32).
   */
  campusBreakdown: DashboardCampusBreakdown[];
  /** Per campus + batch figures, always present for the same reason. */
  batchBreakdown: DashboardBatchBreakdown[];
  /** Null on an unfiltered multi-batch day: there is no single assignment for everyone. */
  assignment: AssignmentSummary | null;
  /** Index = number solved, so `solvedBuckets[4]` is the count who cleared everything. */
  solvedBuckets: number[];
  completionPercent: number;
  /** Same split as `DashboardBatchBreakdown`, across every batch in scope. */
  attemptedNotSolvedStudents: number;
  notAttemptedStudents: number;
  averageProblemsSolved: number;
  streakChampion: { studentId: string; name: string; streak: number } | null;
  topPerformer: { studentId: string; name: string; score: number } | null;
  topSquad: { squadId: string; name: string; averageCompletion: number } | null;
  lastSyncAt: string | null;
  lastSyncStatus: SyncJobStatus | null;
  /** Students whose data could not be trusted this sync, by reason. */
  unreliableSyncCounts: Partial<Record<SyncStatus, number>>;
  /**
   * What the last sync actually managed, for the students in scope.
   *
   * Replaces reading a single "N students could not be read" figure off
   * `unreliableSyncCounts`, which counted a student with no linked handle as a failed
   * read and made an entire healthy campus look broken (§6). The four counts partition
   * `activeStudents` exactly, so the UI can state the whole picture without arithmetic
   * of its own.
   */
  syncSummary: SyncHealthSummary;
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
   * The campus this problem set *currently* targets. `null` means "every campus".
   * Always the batch's own campus when `batchId` is set.
   */
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  /**
   * The batch this problem set *currently* targets. `null` means "all batches within
   * `campusId`" — or, when `campusId` is also null, literally everyone (§9).
   */
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /** `SRM University — Foundation Level`. What the preview and history rows render. */
  audienceLabel: string;
  /** Active students this assignment currently applies to. */
  studentCount: number;
  originalCampusId: string | null;
  originalCampusName: string | null;
  originalCampusCode: string | null;
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
  fromCampusId: string | null;
  fromCampusName: string | null;
  fromCampusCode: string | null;
  toCampusId: string | null;
  toCampusName: string | null;
  toCampusCode: string | null;
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

/**
 * One assigned problem plus this student's outcome on it, for the mentor-facing views.
 * `status` is read straight from `DailyProblemStatus` — never re-derived from whether an
 * accepted submission exists, so `ATTEMPTED_NOT_ACCEPTED` and `NOT_ATTEMPTED` stay the
 * distinct facts they are (§ submission-attempt tracking).
 */
export interface MentorProblemOutcome {
  problemId: string;
  position: number;
  title: string;
  status: ProblemStatus;
  /** Submissions observed for this problem in the assignment window, accepted or not. */
  attempts: number;
  solvedAt: string | null;
}

/** A row in one of the mentor dashboard's five "solved N" tables. */
export interface MentorBucketRow {
  studentId: string;
  name: string;
  email: string;
  squadName: string | null;
  /** The campus the student was in *on this day*, not their campus now. */
  campusName: string | null;
  campusCode: string | null;
  /** The batch the student was in *on this day*, not their batch now. */
  batchName: string | null;
  batchCode: string | null;
  cohort: number | null;
  maxBeltLevel: number | null;
  leetcodeUsername: string | null;
  solvedCount: number;
  /** Problems assigned to *this student's* batch that day. */
  assignedCount: number;
  /**
   * Of the problems this student did not solve, how many have at least one real
   * submission (`ATTEMPTED_NOT_ACCEPTED`) versus none at all (`NOT_ATTEMPTED`).
   * `solvedCount + attemptedNotSolvedCount + notAttemptedCount === assignedCount` always.
   */
  attemptedNotSolvedCount: number;
  notAttemptedCount: number;
  completionTime: string | null;
  currentStreak: number;
  score: number;
  rank: number | null;
  /** Titles of the assigned problems still outstanding — both attempted and not. */
  missingProblems: string[];
  /** The full per-problem breakdown backing `missingProblems`, `attemptedNotSolvedCount`
   *  and `notAttemptedCount` — one entry per assigned problem, in position order. */
  problems: MentorProblemOutcome[];
  syncStatus: SyncStatus;
  /** Mentor-facing explanation of a zero — never just "unknown" when we know better. */
  reason: string | null;
}

export interface MentorBucket {
  solvedCount: number;
  label: string;
  students: MentorBucketRow[];
  /**
   * Of `students`, how many touched at least one of their remaining problems versus
   * none at all. Answers "did these students attempt and fail, or never try" without
   * opening every row (§ submission-attempt tracking). A student with nothing remaining
   * (the "completed all" bucket) counts toward neither.
   */
  studentsAttemptedCount: number;
  studentsNotAttemptedCount: number;
}

/**
 * One batch's slice of a day: its own problem set, its own students, its own buckets.
 *
 * Sized independently per batch because the batches genuinely differ — Foundation may
 * have 4 problems on a day Intermediate has 5, and bucketing either against the other's
 * count would invent students who "solved 5 of 4".
 */
/** One `Campus → Batch` section of the daily tracker. */
export interface MentorBatchSection {
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
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
  /** The campus filter that produced this view; `null` when showing every campus. */
  campusId: string | null;
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
  /** Rank *within the scope that was requested* — global, campus, or campus + batch. */
  rank: number;
  /**
   * Rank across every campus for the same period, always present.
   *
   * Carried alongside `rank` so a campus-scoped view can still show "#3 at SRM, #11
   * overall" — and so a student's standing never disappears merely because someone
   * narrowed the filter to a campus they are not in (§14).
   */
  globalRank: number | null;
  isTied: boolean;
  studentId: string;
  name: string;
  squadName: string | null;
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
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
  /**
   * Students the run deliberately did not attempt, because no LeetCode handle is linked
   * to them. Apart from `failedStudents`: nothing was requested, so nothing failed.
   */
  skippedStudents: number;
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
  /**
   * Every campus this student has belonged to, newest first.
   *
   * Alongside `batchHistory` for the same reason it exists: a mentor reading a result
   * from 10 Aug needs to know it was earned at Vels, not at the campus the student is at
   * today (§16, §17).
   */
  campusHistory: CampusHistoryEntry[];
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
  /** Same partition as `MentorBucketRow` — see there for the invariant. */
  attemptedNotSolvedCount: number;
  notAttemptedCount: number;
  completionPercent: number;
  statusLabel: StatusLabel;
  actionTier: ActionTier;
  missingProblems: string[];
  /** The full per-problem breakdown — see `MentorProblemOutcome`. */
  problems: MentorProblemOutcome[];
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
  /** See `MentorBucket` — same "attempted vs never touched" split for this bucket. */
  studentsAttemptedCount: number;
  studentsNotAttemptedCount: number;
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
  /**
   * The audience this report covers. `null` widens: no campus is every campus, no batch
   * is every batch within it. Both null is the all-campuses report (§33).
   */
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /**
   * `SRM University — Foundation Level`, or `All campuses — All batches`.
   *
   * Rendered into the email's heading and subject so a recipient can tell at a glance
   * which population the numbers below describe — the single most important thing to get
   * right once two campuses receive similar-looking reports on the same morning.
   */
  audienceLabel: string;
  problemsAssigned: number;
  studentsTracked: number;
  /** Indexed by solved count, `assignedCount` entries long — e.g. `bucketCounts[0]` = "solved 4 of 4". */
  bucketCounts: { solvedCount: number; label: string; count: number }[];
  overallCompletionPercent: number;
  generatedAt: string;
}

/**
 * One `Campus → Batch` group's portion of a report.
 *
 * An all-campuses report carries one of these per group, so the email can print
 * "Vels — Foundation: 4 assigned" and "SRM — Foundation: 4 assigned" as separate blocks
 * instead of averaging two unrelated cohorts into one meaningless number (§33).
 */
export interface DailyEmailReportBatchSection {
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /** `SRM University — Foundation Level`, the block's heading. */
  audienceLabel: string;
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
  /**
   * The audience this report covered. `null` widens, exactly as on the summary: both null
   * is the all-campuses report (§33).
   */
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
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
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
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
  /** The student's campus, shown alongside their level in the portal header (§15). */
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  batchName: string | null;
  batchCode: string | null;
  squadNumber: number | null;
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
  /**
   * Null when no leaderboard snapshot has been computed yet for this period.
   *
   * `rank`/`total` are the student's standing at their own campus; `globalRank`/
   * `globalTotal` are across every campus. Both are shown, because "#4 of 31" and
   * "#4 of 162" are different claims and a student who only saw the campus number would
   * have no idea where they sit in the programme (§14).
   */
  currentRank: {
    period: LeaderboardPeriod;
    rank: number;
    total: number;
    globalRank: number | null;
    globalTotal: number;
  } | null;
  recentDays: {
    dayKey: DayKey;
    solvedCount: number;
    assignedCount: number;
    isPerfect: boolean;
  }[];
}

export type LeaderboardPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';

// ---------------------------------------------------------------------------
// Baseline tests
// ---------------------------------------------------------------------------
//
// Two projections of every baseline entity exist on purpose: one for mentors and one for
// students. They are separate types rather than one type with optional fields, because
// "the student view happens not to include `riskFlags` today" is a property that decays,
// while "the student type has no such field" is enforced by the compiler (§22, §35).

/** A baseline test as an admin/mentor sees it. */
export interface BaselineTestSummary {
  id: string;
  name: string;
  dayKey: DayKey;
  description: string | null;
  instructions: string | null;
  /** Mentor-only. Absent from `StudentBaselineTest` entirely. */
  adminNotes: string | null;
  campusId: string | null;
  campusName: string | null;
  campusCode: string | null;
  batchId: string | null;
  batchName: string | null;
  batchCode: string | null;
  /** `SRM University — Foundation Level`. */
  audienceLabel: string;
  durationMinutes: number;
  opensAt: string | null;
  closesAt: string | null;
  status: BaselineTestStatus;
  problems: BaselineTestProblemSummary[];
  /** Active students currently eligible for this test. */
  eligibleStudentCount: number;
  startedCount: number;
  completedCount: number;
  /** Attempts whose signals put them in the review queue. Mentor-only. */
  reviewRequiredCount: number;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaselineTestProblemSummary {
  id: string;
  position: number;
  problemId: string;
  title: string;
  titleSlug: string;
  url: string;
  difficulty: Difficulty;
  points: number;
}

/**
 * A baseline test as a *student* sees it.
 *
 * Deliberately missing `adminNotes`, every aggregate about other students, and every
 * risk field. A student's own risk score is not included either: it is a mentor triage
 * signal, and showing a student "your work looks suspicious" on the basis of timing
 * alone would be both unkind and unsupported (§23).
 */
export interface StudentBaselineTest {
  id: string;
  name: string;
  dayKey: DayKey;
  description: string | null;
  instructions: string | null;
  durationMinutes: number;
  opensAt: string | null;
  closesAt: string | null;
  status: BaselineTestStatus;
  problemCount: number;
  /** Only populated once the student's own attempt has started. */
  problems: BaselineTestProblemSummary[];
  attempt: StudentBaselineAttempt | null;
  /** Whether this student may start it right now, and why not when they may not. */
  canStart: boolean;
  blockedReason: string | null;
}

export interface StudentBaselineAttempt {
  id: string;
  status: BaselineAttemptStatus;
  startedAt: string;
  submittedAt: string | null;
  expiresAt: string | null;
  solvedCount: number;
  attemptedCount: number;
  score: number;
  maxScore: number;
  results: StudentBaselineProblemResult[];
}

export interface StudentBaselineProblemResult {
  testProblemId: string;
  problemId: string;
  position: number;
  title: string;
  url: string;
  difficulty: Difficulty;
  points: number;
  status: ProblemStatus;
  solvedAt: string | null;
}

/** One student's attempt as a mentor sees it — risk fields included. */
export interface BaselineAttemptSummary {
  id: string;
  testId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  campusId: string | null;
  campusName: string | null;
  batchId: string | null;
  batchName: string | null;
  squadName: string | null;
  status: BaselineAttemptStatus;
  startedAt: string;
  submittedAt: string | null;
  expiresAt: string | null;
  solvedCount: number;
  attemptedCount: number;
  score: number;
  maxScore: number;
  percent: number;
  timeTakenSeconds: number | null;
  /** Mentor/admin only — never projected into a student response. */
  riskFlags: BaselineRiskSignal[];
  riskScore: number;
  /** One evidence line per raised signal. Mentor/admin only. */
  riskEvidence: string[];
  reviewStatus: BaselineReviewStatus;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  gradedAt: string | null;
  results: BaselineAttemptProblemResult[];
}

/**
 * One row of a baseline test's student-wise leaderboard.
 *
 * Separate from `BaselineAttemptSummary` and deliberately narrower: this is the
 * cohort-facing board, so it carries no risk signals, no review state and no evidence
 * lines — those are mentor triage about a *suspicion*, and they have no business on a
 * ranked list that gets read out or exported.
 *
 * Every eligible student appears, including those who never opened the test. `attempted`
 * is what separates "sat it and scored nothing" from "absent"; the two are different
 * conversations.
 */
export interface BaselineLeaderboardRow {
  /** Competition rank ("1224"): ties share a rank and the next student skips ahead. */
  rank: number;
  isTied: boolean;
  studentId: string;
  studentName: string;
  studentEmail: string;
  squadName: string | null;
  campusName: string | null;
  batchName: string | null;
  /** Problems on the test — the denominator, never hardcoded. */
  totalQuestions: number;
  solvedCount: number;
  notSolvedCount: number;
  /** Problems touched without an accepted answer. */
  attemptedCount: number;
  score: number;
  maxScore: number;
  percent: number;
  timeTakenSeconds: number | null;
  submittedAt: string | null;
  status: BaselineAttemptStatus;
  /** False for a student with no attempt row at all. */
  attempted: boolean;
}

export interface BaselineLeaderboard {
  testId: string;
  testTitle: string;
  /** The program day the test belongs to. */
  dayKey: string;
  totalQuestions: number;
  maxScore: number;
  /** Eligible students, whether or not they sat it. */
  totalStudents: number;
  attemptedStudents: number;
  notStartedStudents: number;
  averagePercent: number;
  highestPercent: number;
  lowestPercent: number;
  rows: BaselineLeaderboardRow[];
}

/** One student's baseline result with the per-question breakdown behind it. */
export interface BaselineStudentResult {
  testId: string;
  testTitle: string;
  dayKey: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  squadName: string | null;
  campusName: string | null;
  batchName: string | null;
  rank: number | null;
  totalQuestions: number;
  solvedCount: number;
  notSolvedCount: number;
  attemptedCount: number;
  score: number;
  maxScore: number;
  percent: number;
  timeTakenSeconds: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  status: BaselineAttemptStatus;
  attempted: boolean;
  problems: BaselineAttemptProblemResult[];
}

export interface BaselineAttemptProblemResult {
  testProblemId: string;
  problemId: string;
  position: number;
  title: string;
  difficulty: Difficulty;
  points: number;
  awardedPoints: number;
  status: ProblemStatus;
  attempts: number;
  solvedAt: string | null;
  timeToSolveSeconds: number | null;
}

/** Per-problem success across everyone who sat a test. */
export interface BaselineProblemStat {
  testProblemId: string;
  position: number;
  title: string;
  difficulty: Difficulty;
  points: number;
  solvedCount: number;
  attemptedNotSolvedCount: number;
  notAttemptedCount: number;
  /** Solved ÷ eligible, 0–100. */
  successRatePercent: number;
  /** Mean seconds-to-solve among those who solved it; null when nobody did. */
  averageTimeToSolveSeconds: number | null;
}

/** One campus's or batch's slice of a baseline report. */
export interface BaselineScopeBreakdown {
  scopeId: string | null;
  scopeName: string;
  eligible: number;
  started: number;
  completed: number;
  notStarted: number;
  averageScore: number;
  averagePercent: number;
}

export interface BaselineTestReport {
  test: BaselineTestSummary;
  totalEligible: number;
  started: number;
  completed: number;
  notStarted: number;
  averageScore: number;
  medianScore: number;
  averagePercent: number;
  /** Mean seconds from start to last accepted submission, among those who solved anything. */
  averageTimeTakenSeconds: number | null;
  solvedAll: number;
  attemptedNotSolved: number;
  notAttempted: number;
  problems: BaselineProblemStat[];
  campusBreakdown: BaselineScopeBreakdown[];
  batchBreakdown: BaselineScopeBreakdown[];
  /** Attempts a mentor should look at, most-signalled first. Never sent to students. */
  reviewQueue: BaselineAttemptSummary[];
}
