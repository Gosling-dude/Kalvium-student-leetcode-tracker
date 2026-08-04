/**
 * GraphQL documents for LeetCode's public endpoint.
 *
 * Every query here was verified against `https://leetcode.com/graphql` before being
 * written; the field sets are what the endpoint actually returns, not what the
 * documentation (of which there is none — this is an unofficial API) might imply.
 *
 * Verified behaviour, 2026-08:
 *
 *  - `recentAcSubmissionList` returns **at most 20 rows** regardless of `limit`
 *    (requesting 100 and 500 both returned 20). It exposes only
 *    `id / title / titleSlug / timestamp` — no language, runtime or memory.
 *  - `recentSubmissionList` returns the same 20-row window but *does* include
 *    `statusDisplay` and `lang`. It is the richer call, at the cost of spending
 *    window space on failed attempts.
 *  - `matchedUser` returns a GraphQL error `"That user does not exist."` with
 *    `data.matchedUser === null` for unknown usernames — this is how we detect typos.
 *  - `question.companyTags` returns `null` for unauthenticated callers (premium-gated).
 *  - `question.acRate` and `topicTags` are available and populated.
 */

/** Accepted submissions only. Cheapest call; lacks language and status. */
export const RECENT_AC_SUBMISSIONS_QUERY = /* GraphQL */ `
  query recentAcSubmissions($username: String!, $limit: Int!) {
    recentAcSubmissionList(username: $username, limit: $limit) {
      id
      title
      titleSlug
      timestamp
    }
  }
`;

/**
 * All recent submissions with status and language.
 *
 * Preferred by the sync engine: knowing a student attempted a problem and failed is
 * materially different from them never having tried, and mentors act on that difference.
 */
export const RECENT_SUBMISSIONS_QUERY = /* GraphQL */ `
  query recentSubmissions($username: String!, $limit: Int!) {
    recentSubmissionList(username: $username, limit: $limit) {
      id
      title
      titleSlug
      timestamp
      statusDisplay
      lang
    }
  }
`;

export const USER_PROFILE_QUERY = /* GraphQL */ `
  query userProfile($username: String!) {
    matchedUser(username: $username) {
      username
      profile {
        realName
        userAvatar
        ranking
      }
      submitStats {
        acSubmissionNum {
          difficulty
          count
          submissions
        }
      }
    }
  }
`;

/** Problem metadata for assignment auto-fill. */
export const PROBLEM_METADATA_QUERY = /* GraphQL */ `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      title
      titleSlug
      difficulty
      acRate
      isPaidOnly
      topicTags {
        name
        slug
      }
    }
  }
`;

/** Minimal document used only as a liveness probe. */
export const HEALTHCHECK_QUERY = /* GraphQL */ `
  query healthcheck {
    allQuestionsCount {
      difficulty
      count
    }
  }
`;

// --- Response shapes -------------------------------------------------------
// Modelled exactly on observed payloads. Timestamps arrive as *strings* of epoch
// seconds, not numbers — a detail that silently produces 1970 dates if assumed wrong.

export interface RawAcSubmission {
  id: string;
  title: string;
  titleSlug: string;
  timestamp: string;
}

export interface RawSubmission extends RawAcSubmission {
  statusDisplay: string;
  lang: string;
}

export interface RawSubmitStatsEntry {
  difficulty: 'All' | 'Easy' | 'Medium' | 'Hard';
  count: number;
  submissions: number;
}

export interface RawMatchedUser {
  username: string;
  profile: {
    realName: string | null;
    userAvatar: string | null;
    ranking: number | null;
  } | null;
  submitStats: {
    acSubmissionNum: RawSubmitStatsEntry[];
  } | null;
}

export interface RawQuestion {
  questionId: string | null;
  questionFrontendId: string | null;
  title: string;
  titleSlug: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  acRate: number | null;
  isPaidOnly: boolean;
  topicTags: { name: string; slug: string }[] | null;
}

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}
