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
  AssignmentSummary,
  AuthUser,
  BatchHistoryEntry,
  BatchStats,
  BatchSummary,
  BlockerRecord,
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

  dashboard: (dayKey?: string, batch?: string) =>
    apiFetch<DashboardStats>(`/dashboard${qs({ dayKey, batch })}`),

  mentorDashboard: (dayKey?: string, squadId?: string, batch?: string) =>
    apiFetch<MentorDashboard>(`/mentor/dashboard${qs({ dayKey, squadId, batch })}`),

  // --- Batches ---------------------------------------------------------------

  batches: () => apiFetch<BatchSummary[]>('/batches'),

  batchStats: (dayKey?: string) => apiFetch<BatchStats[]>(`/batches/stats${qs({ dayKey })}`),

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
      batches: BatchSummary[];
      squads: { id: string; name: string; batchName: string | null; studentCount: number }[];
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

  /** Without a batch this returns every batch's set for today. */
  todayAssignment: (batch?: string) =>
    batch
      ? apiFetch<AssignmentSummary | null>(`/assignments/today${qs({ batch })}`)
      : apiFetch<AssignmentSummary[]>('/assignments/today'),

  assignmentsForDay: (dayKey: string) =>
    apiFetch<AssignmentSummary[]>(`/assignments/day/${dayKey}`),

  /** Returns one assignment per batch targeted. */
  createAssignment: (body: unknown) =>
    apiFetch<AssignmentSummary[]>('/assignments', { method: 'POST', body }),

  previewProblem: (url: string) =>
    apiFetch<{ title: string; difficulty: string; acceptanceRate: number | null; topicTags: string[] }>(
      '/assignments/preview',
      { method: 'POST', body: { url } },
    ),

  leaderboard: (params: Record<string, string | number | undefined>) =>
    apiFetch<LeaderboardRow[]>(`/leaderboard${qs(params)}`),

  squadLeaderboard: (params: Record<string, string | number | undefined>) =>
    apiFetch<SquadLeaderboardRow[]>(`/leaderboard/squads${qs(params)}`),

  analytics: (from?: string, to?: string, batch?: string) =>
    apiFetch<AnalyticsOverview>(`/analytics/overview${qs({ from, to, batch })}`),

  startSync: (body: { mode?: string; dayKey?: string } = {}) =>
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

  dailyEmailReport: (dayKey: string, squadId?: string, batch?: string) =>
    apiFetch<DailyEmailReport>(`/reports/daily/${dayKey}${qs({ squadId, batch })}`),

  generateEmail: (
    dayKey: string,
    body: {
      fromEmail: string;
      toRecipients: string[];
      ccRecipients?: string[];
      subject?: string;
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
    params: { dayKey?: string; status?: string; batch?: string; page?: number; pageSize?: number } = {},
  ) =>
    apiFetch<Paginated<EmailReportRecord>>(`/reports/email/history${qs(params)}`),

  emailStatus: (dayKey: string, batch?: string) =>
    apiFetch<{ sent: EmailReportRecord | null; latest: EmailReportRecord | null }>(
      `/reports/email/status${qs({ dayKey, batch })}`,
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
};
