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
  studentCount: number;
  startDate: string | null;
  isActive: boolean;
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
  leetcodeUsername: string;
  status: StudentStatus;
  batchId: string | null;
  batchName: string | null;
  squadId: string | null;
  squadName: string | null;
  avatarUrl: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  currentStreak: number;
  longestStreak: number;
  totalSolved: number;
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

export interface DashboardStats {
  dayKey: DayKey;
  totalStudents: number;
  activeStudents: number;
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
  title: string | null;
  topic: string | null;
  notes: string | null;
  difficulty: Difficulty | null;
  problems: AssignmentProblem[];
  createdAt: string;
  createdByName: string | null;
}

/** A row in one of the mentor dashboard's five "solved N" tables. */
export interface MentorBucketRow {
  studentId: string;
  name: string;
  email: string;
  squadName: string | null;
  batchName: string | null;
  leetcodeUsername: string;
  solvedCount: number;
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

export interface MentorDashboard {
  dayKey: DayKey;
  assignment: AssignmentSummary | null;
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
  batchName: string | null;
  leetcodeUsername: string;
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
  problemsAssigned: number;
  studentsTracked: number;
  /** Indexed by solved count, `assignedCount` entries long — e.g. `bucketCounts[0]` = "solved 4 of 4". */
  bucketCounts: { solvedCount: number; label: string; count: number }[];
  overallCompletionPercent: number;
  generatedAt: string;
}

/** The full computed report for one day — reconstructed live, never stored (§2, §21). */
export interface DailyEmailReport {
  summary: DailyEmailReportSummary;
  hasAssignment: boolean;
  isFutureDate: boolean;
  /** Active students whose account predates the assignment but who joined after this
   *  particular day closed are excluded from the report; this is how many were. */
  excludedNotYetEnrolled: number;
  problems: AssignmentProblem[];
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
