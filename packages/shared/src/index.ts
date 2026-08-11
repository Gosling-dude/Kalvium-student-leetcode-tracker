/**
 * `@dsa/shared` — the domain core.
 *
 * Everything exported here is pure: no I/O, no clock reads that aren't passed in, no
 * framework imports. That is what makes the scoring, streak and ranking rules testable
 * without a database and reusable identically on the server and in the browser.
 */

export * from './domain/time';
export * from './domain/scoring';
export * from './domain/assignment-completion';
export * from './domain/streak';
export * from './domain/ranking';
export * from './domain/gamification';
export * from './domain/daily-email-report';
export * from './types/enums';
export * from './types/contracts';
export * from './constants';
