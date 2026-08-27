/**
 * API client.
 *
 * One place that knows how to talk to the backend: base URL, auth header, token
 * refresh, and error shape. Components call typed helpers and never touch `fetch`.
 *
 * Tokens live in `localStorage` rather than a cookie because the API is a separate
 * origin and this is an internal tool behind a login; the trade-off (XSS exposure) is
 * mitigated by the CSP headers and the strict input validation on the server.
 */

import type {
  AnalyticsOverview,
  AssignmentAudienceChangeEntry,
  AssignmentSummary,
  AuthUser,
  BaselineAttemptSummary,
  BaselineLeaderboard,
  BaselineStudentResult,
  BaselineTestReport,
  BaselineTestSummary,
  BatchHistoryEntry,
  BatchStats,
  BatchSummary,
  BlockerRecord,
  CampusHistoryEntry,
  CampusStats,
  CampusSummary,
  DailyEmailReport,
  DashboardStats,
  SquadLeaderboardRow,
  EmailReportRecord,
  ImportResult,
  LeaderboardRow,
  LoginResponse,
  MentorDashboard,
  Paginated,
  QueueHealth,
  StudentAssignmentHistoryRow,
  StudentAssignmentView,
  StudentBaselineTest,
  StudentDashboard,
  StudentPortalProfile,
  StudentProfile,
  StudentSummary,
  SyncJobSummary,
} from '@dsa/shared';

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:4000/api/v1';

const ACCESS_KEY = 'dsa.accessToken';
const REFRESH_KEY = 'dsa.refreshToken';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const tokenStore = {
  get access(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_KEY);
  },
  get refresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string): void {
    window.localStorage.setItem(ACCESS_KEY, access);
    window.localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear(): void {
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  },
};

/**
 * In-flight refresh, shared across callers.
 *
 * Without this, a page that fires six queries on mount would send six refresh requests
 * the moment the access token expires — and because refresh tokens rotate, five of them
 * would be rejected as reuse and log the user out.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        tokenStore.clear();
        return false;
      }
      const data = (await response.json()) as LoginResponse;
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Internal: prevents an infinite refresh loop. */
  retried?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, retried, headers, ...rest } = options;

  const isFormData = body instanceof FormData;
  const token = tokenStore.access;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && !retried && tokenStore.refresh) {
    const refreshed = await refreshTokens();
    if (refreshed) return apiFetch<T>(path, { ...options, retried: true });

    // The session is genuinely over. Send the user to login rather than leaving the
    // UI in a half-broken state showing stale data.
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      (payload as { message?: string | string[] } | null)?.message ??
      `Request failed with ${response.status}`;
    throw new ApiError(
      response.status,
      Array.isArray(message) ? message.join(', ') : String(message),
      payload,
    );
  }

  return payload as T;
}

/** Download a binary export and hand it to the browser as a file. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const token = tokenStore.access;
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) throw new ApiError(response.status, 'Export failed');

  const disposition = response.headers.get('content-disposition');
  const match = disposition ? /filename="?([^"]+)"?/.exec(disposition) : null;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  login: (email: string, password: string) =>
    apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }),

  me: () => apiFetch<AuthUser>('/auth/me'),

  logout: (refreshToken: string) =>
    apiFetch<void>('/auth/logout', { method: 'POST', body: { refreshToken } }),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<void>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),

  dashboard: (dayKey?: string, campus?: string, batch?: string) =>
    apiFetch<DashboardStats>(`/dashboard${qs({ dayKey, campus, batch })}`),

  mentorDashboard: (dayKey?: string, squadId?: string, campus?: string, batch?: string) =>
    apiFetch<MentorDashboard>(`/mentor/dashboard${qs({ dayKey, squadId, campus, batch })}`),

  // --- Campuses --------------------------------------------------------------

  campuses: () => apiFetch<CampusSummary[]>('/campuses'),

  campusStats: (dayKey?: string) => apiFetch<CampusStats[]>(`/campuses/stats${qs({ dayKey })}`),

  /** The batches at one campus — what the campus-dependent batch picker reads. */
  campusBatches: (campusId: string) =>
    apiFetch<BatchSummary[]>(`/campuses/${campusId}/batches`),

  campusHistory: (studentId: string) =>
    apiFetch<CampusHistoryEntry[]>(`/students/${studentId}/campus-history`),

  transferStudentCampus: (
    studentId: string,
    toCampusId: string,
    toBatchId?: string,
    reason?: string,
  ) =>
    apiFetch<{
      studentId: string;
      name: string;
      fromCampusId: string | null;
      toCampusId: string;
      fromBatchId: string | null;
      toBatchId: string | null;
      history: CampusHistoryEntry[];
    }>(`/students/${studentId}/transfer-campus`, {
      method: 'POST',
      body: { toCampusId, toBatchId, reason },
    }),

  // --- Batches ---------------------------------------------------------------

  batches: (campus?: string) => apiFetch<BatchSummary[]>(`/batches${qs({ campus })}`),

  batchStats: (dayKey?: string, campus?: string) =>
    apiFetch<BatchStats[]>(`/batches/stats${qs({ dayKey, campus })}`),

  batchHistory: (studentId: string) =>
    apiFetch<BatchHistoryEntry[]>(`/students/${studentId}/batch-history`),

  moveStudentBatch: (studentId: string, toBatchId: string, reason?: string) =>
    apiFetch<{
      studentId: string;
      name: string;
      fromBatchId: string | null;
      toBatchId: string;
      history: BatchHistoryEntry[];
    }>(`/students/${studentId}/move-batch`, { method: 'POST', body: { toBatchId, reason } }),

  students: (params: Record<string, string | number | undefined>) =>
    apiFetch<Paginated<StudentSummary>>(`/students${qs(params)}`),

  studentProfile: (id: string) => apiFetch<StudentProfile>(`/students/${id}/profile`),

  studentFilters: () =>
    apiFetch<{
      campuses: CampusSummary[];
      batches: BatchSummary[];
      squads: {
        id: string;
        name: string;
        campusId: string | null;
        batchName: string | null;
        studentCount: number;
      }[];
      squadNumbers: { campusId: string | null; number: number; label: string }[];
    }>('/students/filters'),

  createStudent: (body: unknown) =>
    apiFetch<StudentSummary>('/students', { method: 'POST', body }),

  updateStudent: (id: string, body: unknown) =>
    apiFetch<StudentSummary>(`/students/${id}`, { method: 'PATCH', body }),

  /** Archives the student when they have history; deletes only when they have none. */
  deleteStudent: (id: string) =>
    apiFetch<{ deleted: boolean; archived: boolean }>(`/students/${id}`, { method: 'DELETE' }),

  importStudents: (file: File, updateExisting: boolean) => {
    const form = new FormData();
    form.append('file', file);
    form.append('updateExisting', String(updateExisting));
    return apiFetch<ImportResult>('/students/import', { method: 'POST', body: form });
  },

  assignments: (params: Record<string, string | number | undefined>) =>
    apiFetch<Paginated<AssignmentSummary>>(`/assignments${qs(params)}`),

  /** Without a batch this returns every matching audience's set for today. */
  todayAssignment: (campus?: string, batch?: string) =>
    batch
      ? apiFetch<AssignmentSummary | null>(`/assignments/today${qs({ campus, batch })}`)
      : apiFetch<AssignmentSummary[]>(`/assignments/today${qs({ campus })}`),

  assignmentsForDay: (dayKey: string, campus?: string, batch?: string) =>
    apiFetch<AssignmentSummary[]>(`/assignments/day/${dayKey}${qs({ campus, batch })}`),

  /** Returns one assignment per batch targeted. */
  createAssignment: (body: unknown) =>
    apiFetch<AssignmentSummary[]>('/assignments', { method: 'POST', body }),

  previewProblem: (url: string) =>
    apiFetch<{ title: string; difficulty: string; acceptanceRate: number | null; topicTags: string[] }>(
      '/assignments/preview',
      { method: 'POST', body: { url } },
    ),

  /**
   * "Change Assignment Target" (§9) — admin only.
   *
   * `campus` is a campus id/code or "ALL"; `target` is a batch id/code or "BOTH".
   */
  changeAssignmentTarget: (id: string, campus: string, target: string, reason?: string) =>
    apiFetch<AssignmentSummary>(`/assignments/${id}/target`, {
      method: 'PATCH',
      body: { campus, target, reason },
    }),

  assignmentTargetHistory: (id: string) =>
    apiFetch<AssignmentAudienceChangeEntry[]>(`/assignments/${id}/target-history`),

  leaderboard: (params: Record<string, string | number | undefined>) =>
    apiFetch<LeaderboardRow[]>(`/leaderboard${qs(params)}`),

  squadLeaderboard: (params: Record<string, string | number | undefined>) =>
    apiFetch<SquadLeaderboardRow[]>(`/leaderboard/squads${qs(params)}`),

  analytics: (from?: string, to?: string, campus?: string, batch?: string) =>
    apiFetch<AnalyticsOverview>(`/analytics/overview${qs({ from, to, campus, batch })}`),

  /** `studentIds` narrows the run to those students — used to re-sync one row on demand. */
  startSync: (body: { mode?: string; dayKey?: string; studentIds?: string[] } = {}) =>
    apiFetch<SyncJobSummary>('/sync', { method: 'POST', body }),

  retryFailedSync: () => apiFetch<SyncJobSummary>('/sync/retry-failed', { method: 'POST' }),

  syncJob: (id: string) => apiFetch<SyncJobSummary>(`/sync/jobs/${id}`),

  latestSync: () => apiFetch<SyncJobSummary | null>('/sync/latest'),

  syncJobItems: (id: string) =>
    apiFetch<
      {
        studentId: string;
        name: string;
        leetcodeUsername: string;
        status: string;
        newSubmissions: number;
        error: string | null;
      }[]
    >(`/sync/jobs/${id}/items`),

  queueHealth: () => apiFetch<QueueHealth>('/sync/queue'),

  recompute: (body: { from?: string; to?: string } = {}) =>
    apiFetch<{ days: number }>('/admin/recompute', { method: 'POST', body }),

  // --- Daily email reporting -------------------------------------------------

  dailyEmailReport: (dayKey: string, squadId?: string, campus?: string, batch?: string) =>
    apiFetch<DailyEmailReport>(`/reports/daily/${dayKey}${qs({ squadId, campus, batch })}`),

  generateEmail: (
    dayKey: string,
    body: {
      fromEmail: string;
      toRecipients: string[];
      ccRecipients?: string[];
      subject?: string;
      /** Omit for every campus; supply to generate a single campus's report (§33). */
      campusId?: string;
      /** Omit for the overall report; supply to generate a single batch's report. */
      batchId?: string;
    },
  ) => apiFetch<EmailReportRecord>(`/reports/daily/${dayKey}/generate-email`, { method: 'POST', body }),

  previewEmail: (body: {
    emailReportId: string;
    fromEmail?: string;
    toRecipients?: string[];
    ccRecipients?: string[];
    subject?: string;
  }) => apiFetch<EmailReportRecord>('/reports/email/preview', { method: 'POST', body }),

  approveEmail: (emailReportId: string) =>
    apiFetch<EmailReportRecord>('/reports/email/approve', { method: 'POST', body: { emailReportId } }),

  sendEmail: (emailReportId: string, force = false) =>
    apiFetch<EmailReportRecord>('/reports/email/send', {
      method: 'POST',
      body: { emailReportId, force },
    }),

  emailHistory: (
    params: {
      dayKey?: string;
      status?: string;
      campus?: string;
      batch?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) =>
    apiFetch<Paginated<EmailReportRecord>>(`/reports/email/history${qs(params)}`),

  emailStatus: (dayKey: string, campus?: string, batch?: string) =>
    apiFetch<{ sent: EmailReportRecord | null; latest: EmailReportRecord | null }>(
      `/reports/email/status${qs({ dayKey, campus, batch })}`,
    ),

  emailReport: (id: string) => apiFetch<EmailReportRecord>(`/reports/email/${id}`),

  listBlockers: (params: { dayKey?: string; studentId?: string } = {}) =>
    apiFetch<BlockerRecord[]>(`/reports/blockers${qs(params)}`),

  createBlocker: (body: {
    studentId: string;
    dayKey: string;
    category: string;
    description?: string;
    actionTaken?: string;
    followUpRequired?: boolean;
    followUpDate?: string;
    mentorNotes?: string;
  }) => apiFetch<BlockerRecord>('/reports/blockers', { method: 'POST', body }),

  updateBlocker: (id: string, body: Record<string, unknown>) =>
    apiFetch<BlockerRecord>(`/reports/blockers/${id}`, { method: 'PATCH', body }),

  // --- Student portal ----------------------------------------------------------
  //
  // Every call below is scoped to the logged-in student by the backend session — none
  // of them take a student id, batch id or email as a parameter (§18, §19).

  studentMe: () => apiFetch<StudentSummary>('/student/me'),

  studentDashboard: () => apiFetch<StudentDashboard>('/student/dashboard'),

  studentPortalProfile: () => apiFetch<StudentPortalProfile>('/student/profile'),

  studentAssignments: (page = 1, pageSize = 20) =>
    apiFetch<Paginated<StudentAssignmentHistoryRow>>(
      `/student/assignments${qs({ page, pageSize })}`,
    ),

  studentAssignment: (id: string) =>
    apiFetch<StudentAssignmentView>(`/student/assignments/${id}`),

  /**
   * `scope` is the *only* thing a student can vary — never a campus or batch id. See
   * `StudentLeaderboardQueryDto`: the ids come from their own record, server-side (§40).
   */
  studentLeaderboard: (
    period: 'DAILY' | 'WEEKLY' | 'MONTHLY',
    scope: 'mine' | 'campus' | 'global',
  ) =>
    apiFetch<{ rows: LeaderboardRow[]; myStudentId: string; scope: string }>(
      `/student/leaderboard${qs({ period, scope })}`,
    ),

  // --- Baseline tests ------------------------------------------------------------

  baselineTests: (
    params: { status?: string; campus?: string; batch?: string; from?: string; to?: string } = {},
  ) => apiFetch<BaselineTestSummary[]>(`/baseline-tests${qs(params)}`),

  baselineTest: (id: string) => apiFetch<BaselineTestSummary>(`/baseline-tests/${id}`),

  baselineTestReport: (id: string) =>
    apiFetch<BaselineTestReport>(`/baseline-tests/${id}/report`),

  baselineTestAttempts: (id: string) =>
    apiFetch<BaselineAttemptSummary[]>(`/baseline-tests/${id}/attempts`),

  baselineLeaderboard: (
    id: string,
    params: {
      search?: string;
      squad?: string;
      status?: string;
      sort?: string;
      direction?: string;
    } = {},
  ) => apiFetch<BaselineLeaderboard>(`/baseline-tests/${id}/leaderboard${qs(params)}`),

  baselineStudentResult: (id: string, studentId: string) =>
    apiFetch<BaselineStudentResult>(`/baseline-tests/${id}/students/${studentId}`),

  createBaselineTest: (body: unknown) =>
    apiFetch<BaselineTestSummary>('/baseline-tests', { method: 'POST', body }),

  updateBaselineTest: (id: string, body: unknown) =>
    apiFetch<BaselineTestSummary>(`/baseline-tests/${id}`, { method: 'PATCH', body }),

  duplicateBaselineTest: (id: string) =>
    apiFetch<BaselineTestSummary>(`/baseline-tests/${id}/duplicate`, { method: 'POST' }),

  publishBaselineTest: (id: string) =>
    apiFetch<BaselineTestSummary>(`/baseline-tests/${id}/publish`, { method: 'POST' }),

  closeBaselineTest: (id: string) =>
    apiFetch<BaselineTestSummary>(`/baseline-tests/${id}/close`, { method: 'POST' }),

  gradeBaselineTest: (id: string) =>
    apiFetch<{ graded: number }>(`/baseline-tests/${id}/grade`, { method: 'POST' }),

  reviewBaselineAttempt: (
    attemptId: string,
    reviewStatus: 'NOT_REVIEWED' | 'REVIEW_REQUIRED' | 'REVIEWED',
    note?: string,
  ) =>
    apiFetch<BaselineAttemptSummary>(`/baseline-tests/attempts/${attemptId}/review`, {
      method: 'PATCH',
      body: { reviewStatus, note },
    }),

  deleteBaselineTest: (id: string) =>
    apiFetch<void>(`/baseline-tests/${id}`, { method: 'DELETE' }),

  // --- Baseline tests: student ---------------------------------------------------
  //
  // Scoped to the session like every other student route. No campus, batch or student id
  // is ever a parameter here.

  studentBaselineTests: () => apiFetch<StudentBaselineTest[]>('/student/baseline-tests'),

  studentBaselineTest: (id: string) =>
    apiFetch<StudentBaselineTest>(`/student/baseline-tests/${id}`),

  startBaselineTest: (id: string) =>
    apiFetch<StudentBaselineTest>(`/student/baseline-tests/${id}/start`, { method: 'POST' }),

  submitBaselineTest: (id: string) =>
    apiFetch<StudentBaselineTest>(`/student/baseline-tests/${id}/submit`, { method: 'POST' }),

  // --- Admin: student portal accounts -------------------------------------------

  studentAccounts: () =>
    apiFetch<
      {
        studentId: string;
        name: string;
        email: string;
        batchCode: string | null;
        hasAccount: boolean;
        isActive: boolean | null;
        lastLoginAt: string | null;
      }[]
    >('/admin/students/accounts'),

  provisionStudentAccounts: () =>
    apiFetch<{
      provisioned: { studentId: string; name: string; email: string; tempPassword: string | null }[];
      skipped: { studentId: string; name: string; email: string; reason: string }[];
    }>('/admin/students/accounts/provision', { method: 'POST' }),

  resetStudentPassword: (studentId: string) =>
    apiFetch<{ studentId: string; name: string; email: string; tempPassword: string | null }>(
      `/admin/students/${studentId}/reset-password`,
      { method: 'POST' },
    ),

  // --- Mentor management (admin only) ---------------------------------------

  mentors: () => apiFetch<MentorAccountRow[]>('/admin/mentors'),

  createMentor: (body: { name: string; email: string; campusIds: string[] }) =>
    apiFetch<ProvisionedMentorResponse>('/admin/mentors', { method: 'POST', body }),

  setMentorCampuses: (userId: string, campusIds: string[]) =>
    apiFetch<{ userId: string; campusIds: string[] }>(`/admin/mentors/${userId}/campuses`, {
      method: 'PUT',
      body: { campusIds },
    }),

  setMentorActive: (userId: string, isActive: boolean) =>
    apiFetch<{ userId: string; isActive: boolean }>(`/admin/mentors/${userId}/active`, {
      method: 'PATCH',
      body: { isActive },
    }),

  resetMentorPassword: (userId: string) =>
    apiFetch<ProvisionedMentorResponse>(`/admin/mentors/${userId}/reset-password`, {
      method: 'POST',
    }),
};

/** One row of `GET /admin/mentors`. */
export interface MentorAccountRow {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MENTOR';
  isActive: boolean;
  lastLoginAt: string | null;
  _count: { mentoredSquads: number };
  mentorCampuses: { campus: { id: string; name: string; code: string } }[];
}

/**
 * A newly created or reset mentor.
 *
 * `tempPassword` is null when the programme has configured a shared initial password —
 * the admin already holds it, and echoing it per account only widens where it can leak.
 * When it is present it is shown exactly once and is never stored in plaintext anywhere.
 */
export interface ProvisionedMentorResponse {
  userId: string;
  name: string;
  email: string;
  tempPassword: string | null;
  campusIds: string[];
}
