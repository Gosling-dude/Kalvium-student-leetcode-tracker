/**
 * Cross-cutting constants.
 *
 * Several of these encode limits discovered by probing the live LeetCode GraphQL
 * endpoint rather than assumptions — they are documented at the point of definition
 * because getting them wrong silently loses student data.
 */

/**
 * LeetCode's `recentAcSubmissionList` returns **at most 20 rows**, no matter what
 * `limit` is requested. Verified against the live endpoint: asking for 100 returned 20,
 * and asking for 500 also returned 20.
 *
 * Consequences that shape the whole sync design:
 *  - A student who solves many problems can push an assigned problem out of the window
 *    within a single day, so syncing once daily is not safe.
 *  - History before the window is unrecoverable — which is exactly why every accepted
 *    submission we ever observe is persisted locally and never re-derived from the API.
 */
export const LEETCODE_RECENT_AC_LIMIT = 20;

/** Same cap applies to the mixed-status `recentSubmissionList` query. */
export const LEETCODE_RECENT_SUBMISSION_LIMIT = 20;

export const LEETCODE_GRAPHQL_ENDPOINT = 'https://leetcode.com/graphql';
export const LEETCODE_PROBLEM_BASE_URL = 'https://leetcode.com/problems';

export function leetcodeProblemUrl(titleSlug: string): string {
  return `${LEETCODE_PROBLEM_BASE_URL}/${titleSlug}/`;
}

export function leetcodeProfileUrl(username: string): string {
  return `https://leetcode.com/u/${encodeURIComponent(username)}/`;
}

/**
 * Extract a problem slug from any LeetCode URL form mentors paste, including
 * `/problems/two-sum/`, `/problems/two-sum/description/`, contest URLs, and bare slugs.
 * Returns `null` when nothing slug-shaped is present.
 */
export function extractProblemSlug(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = /leetcode\.com\/(?:problems|contest\/[^/]+\/problems)\/([a-z0-9-]+)/i.exec(
    trimmed,
  );
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();

  // A bare slug: lowercase words joined by hyphens, with no scheme or spaces.
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(trimmed) && !trimmed.includes(' ')) {
    return trimmed.toLowerCase();
  }
  return null;
}

/** Problems assigned per day by the programme. Assignments may legitimately differ. */
export const DEFAULT_PROBLEMS_PER_DAY = 4;

export const PAGINATION = {
  defaultPage: 1,
  defaultPageSize: 25,
  maxPageSize: 200,
} as const;

/** Cache lifetimes in seconds. Problem metadata is effectively immutable; profiles are not. */
export const CACHE_TTL = {
  problemMetadata: 60 * 60 * 24 * 7,
  userProfile: 60 * 30,
  dashboard: 60,
  leaderboard: 60,
  analytics: 60 * 5,
} as const;

/**
 * Provider politeness settings. LeetCode has no published rate limit and no official
 * API, so these are deliberately conservative: being throttled costs us a whole sync
 * cycle, and there is no support channel to appeal to.
 */
export const PROVIDER_LIMITS = {
  /** Requests per second across the whole worker pool. */
  requestsPerSecond: 4,
  /** Simultaneous in-flight student syncs. */
  concurrency: 5,
  maxRetries: 4,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  requestTimeoutMs: 15_000,
} as const;

export const BADGE_COLORS: Record<string, string> = {
  BRONZE: '#b45309',
  SILVER: '#94a3b8',
  GOLD: '#eab308',
  PLATINUM: '#22d3ee',
};

export const DIFFICULTY_COLORS = {
  EASY: '#22c55e',
  MEDIUM: '#f59e0b',
  HARD: '#ef4444',
} as const;

/** Column headers accepted by the student importer, lowercased and stripped of spaces. */
export const IMPORT_COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'studentname', 'fullname', 'student'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  batch: ['batch', 'batchname', 'cohort'],
  group: ['group', 'groupname', 'team', 'pod'],
  leetcodeUsername: [
    'leetcodeusername',
    'leetcode',
    'leetcodeid',
    'leetcodehandle',
    'username',
    'leetcodeprofile',
  ],
  phone: ['phone', 'phonenumber', 'mobile', 'contact', 'contactnumber'],
};

export const API_ROUTES = {
  auth: '/api/v1/auth',
  students: '/api/v1/students',
  assignments: '/api/v1/assignments',
  dashboard: '/api/v1/dashboard',
  mentor: '/api/v1/mentor',
  leaderboard: '/api/v1/leaderboard',
  analytics: '/api/v1/analytics',
  sync: '/api/v1/sync',
  reports: '/api/v1/reports',
  admin: '/api/v1/admin',
  groups: '/api/v1/groups',
  batches: '/api/v1/batches',
  notifications: '/api/v1/notifications',
} as const;
