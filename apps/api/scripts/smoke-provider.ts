/**
 * Live smoke test for the LeetCode provider.
 *
 * Run with: `npm run smoke:provider -w @dsa/api`
 *
 * This talks to the real endpoint, so it is deliberately kept out of the unit test
 * suite (which uses `FakeSubmissionProvider` and never touches the network). Its job is
 * to tell you quickly whether LeetCode has changed something under us — the failure
 * mode this whole architecture exists to survive.
 */

import { loadConfiguration } from '../src/config/configuration';
import { LeetCodeProvider } from '../src/modules/providers/leetcode/leetcode.provider';
import { isProviderError } from '../src/modules/providers/provider.errors';

const KNOWN_USER = process.env.SMOKE_USERNAME ?? 'lee215';
const MISSING_USER = 'zzz-not-a-real-user-99871';
const KNOWN_SLUG = 'two-sum';

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

async function main(): Promise<void> {
  const config = loadConfiguration();
  const provider = new LeetCodeProvider(config);
  let failures = 0;

  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  console.log(`\nProvider smoke test against ${config.provider.endpoint}\n`);

  // 1. Health -------------------------------------------------------------
  const healthy = await provider.healthCheck();
  check('healthCheck', healthy);

  // 2. Problem metadata ---------------------------------------------------
  try {
    const problem = await provider.fetchProblemMetadata(KNOWN_SLUG);
    line('title', problem.title);
    line('difficulty', problem.difficulty);
    line('acceptanceRate', problem.acceptanceRate);
    line('topicTags', problem.topicTags.join(', '));
    line('companyTags', `[${problem.companyTags.join(', ')}] (premium-gated)`);
    check(
      'fetchProblemMetadata',
      problem.titleSlug === KNOWN_SLUG && problem.difficulty === 'EASY',
    );
  } catch (error) {
    check('fetchProblemMetadata', false, (error as Error).message);
  }

  // 3. User profile -------------------------------------------------------
  try {
    const profile = await provider.fetchUserProfile(KNOWN_USER);
    line('username', profile.username);
    line('totalSolved', profile.totalSolved);
    line('easy/med/hard', `${profile.easySolved}/${profile.mediumSolved}/${profile.hardSolved}`);
    check('fetchUserProfile', profile.totalSolved > 0);
  } catch (error) {
    check('fetchUserProfile', false, (error as Error).message);
  }

  // 4. Recent submissions + the 20-row window ------------------------------
  try {
    const page = await provider.fetchRecentSubmissions(KNOWN_USER, { limit: 100 });
    line('returned', page.submissions.length);
    line('windowSize', page.windowSize);
    line('truncated', page.truncated);
    line('newest', page.submissions[0]?.submittedAt.toISOString() ?? 'n/a');
    line('language captured', page.submissions[0]?.language ?? 'n/a');
    check(
      'window cap is enforced',
      page.submissions.length <= 20,
      `asked for 100, got ${page.submissions.length}`,
    );
    check('submissions are newest-first', isDescending(page.submissions.map((s) => s.submittedAt)));
  } catch (error) {
    check('fetchRecentSubmissions', false, (error as Error).message);
  }

  // 5. Accepted-only filter ------------------------------------------------
  try {
    const solved = await provider.fetchSolvedProblems(KNOWN_USER);
    check(
      'fetchSolvedProblems returns only ACCEPTED',
      solved.submissions.every((s) => s.status === 'ACCEPTED'),
      `${solved.submissions.length} rows`,
    );
  } catch (error) {
    check('fetchSolvedProblems', false, (error as Error).message);
  }

  // 6. Incremental cursor --------------------------------------------------
  try {
    const full = await provider.fetchSolvedProblems(KNOWN_USER);
    const newest = full.submissions[0]?.submittedAt;
    if (newest) {
      const incremental = await provider.fetchSolvedProblems(KNOWN_USER, { since: newest });
      check(
        'since-cursor excludes seen rows',
        incremental.submissions.length === 0,
        `${incremental.submissions.length} new since newest`,
      );
    } else {
      check('since-cursor excludes seen rows', false, 'no baseline submissions');
    }
  } catch (error) {
    check('incremental cursor', false, (error as Error).message);
  }

  // 7. Unknown username is classified, not swallowed ------------------------
  try {
    await provider.fetchUserProfile(MISSING_USER);
    check('unknown user raises USER_NOT_FOUND', false, 'no error thrown');
  } catch (error) {
    const ok = isProviderError(error) && error.syncStatus === 'USER_NOT_FOUND' && !error.retryable;
    check(
      'unknown user raises USER_NOT_FOUND',
      ok,
      isProviderError(error) ? error.syncStatus : (error as Error).message,
    );
  }

  provider.onModuleDestroy();

  console.log(`\n${failures === 0 ? 'All provider checks passed.' : `${failures} check(s) failed.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

function isDescending(dates: Date[]): boolean {
  for (let i = 1; i < dates.length; i += 1) {
    if (dates[i - 1]!.getTime() < dates[i]!.getTime()) return false;
  }
  return true;
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
