/**
 * How an Infosys Preparation student's weeks are turned into one behaviour category.
 *
 * Deliberately a separate module from `campus-analysis.ts`, not an extension of it —
 * see the schema.prisma section banner above `InfosysEnrollment` for why the two
 * programs do not share aggregation code. The eight categories are exactly the set
 * named in the program brief (§8); no thresholds were supplied there ("use objective,
 * documented rules"), so this file is where they are pinned down, following the
 * conventions `campus-analysis.ts` already established for Coding Hours (a 60% strong-
 * week bar, a 20% not-participating bar, a first-half/second-half trend split) rather
 * than inventing a new style. Any number below can be revisited; what must not change
 * without a deliberate decision is that every verdict comes from this one function, so
 * a summary card and its drill-down can never disagree (§12).
 *
 * One category is structural, not a performance judgement, and is checked before
 * anything else:
 *
 *  * `PROFILE_NOT_LINKED` — no LeetCode profile has been added yet. Never scored as
 *    "not participating"; §6 and §13 of the brief are explicit that this must never
 *    collapse into a zero.
 *
 * A linked profile whose submissions could not be read reliably (a sync failure, or
 * simply no assignment yet to judge against) is deliberately *not* a category of its
 * own — an earlier version exposed this as `DATA_UNAVAILABLE`, which read to a
 * non-technical viewer as a fourth kind of student outcome rather than what it was: an
 * internal sync/diagnostic state. It reports as `NOT_PARTICIPATING` instead — "profile
 * linked, no qualifying activity observed" is true in both cases, and the counts behind
 * it are never fabricated (a sync failure still produces zero solved/attempted rows,
 * per §6/§13, it is only the *label* shown for it that changed). The technical
 * distinction is not lost: `InfosysProfileState` and `InfosysDailyStatus.dataUnavailableCount`
 * still carry it for diagnostics, they are just never surfaced as a category.
 *
 * `TRYING_BUT_STRUGGLING` is the one category with no Coding-Hours analogue: a student
 * who attempts most assigned questions but rarely gets an accepted submission is a
 * materially different case from one who does not attempt at all, and the brief asks
 * for both to be visible rather than folded into one "Not Participating" bucket.
 *
 * **One cohort, not campus-divided.** Every Infosys-enrolled student is one flat
 * cohort — there is no campus-wise Infosys dashboard, leaderboard, filter, or
 * category, and nothing in this file groups by campus. `InfosysEnrollment.campusId`
 * still exists in the schema and still shows up as an informational field on a
 * student's row (the roster happens to record it), but it never drives a calculation,
 * a filter, or an authorization decision here — that would re-couple Infosys to
 * Coding Hours' campus-organised world, which is exactly what keeping it a genuinely
 * separate program is meant to avoid. An earlier version of this feature built a full
 * campus-wise analysis layer mirroring `campus-analysis.ts`; it was deliberately
 * removed because Infosys does not need it and campus-wise Infosys reporting was
 * never asked for.
 */

import type { DayKey } from './time';

export const INFOSYS_STRONG_WEEK_THRESHOLD = 0.6;
export const INFOSYS_NOT_PARTICIPATING_ATTEMPT_THRESHOLD = 0.2;
export const INFOSYS_STRUGGLING_ATTEMPT_THRESHOLD = 0.5;
export const INFOSYS_STRUGGLING_SOLVE_THRESHOLD = 0.2;
export const INFOSYS_INCONSISTENT_MIN_STRONG_WEEKS = 2;

export type InfosysCategory =
  | 'CONSISTENT_SOLVER'
  | 'IMPROVING'
  | 'INCONSISTENT'
  | 'TRYING_BUT_STRUGGLING'
  | 'NOT_PARTICIPATING'
  | 'DECLINING'
  | 'PROFILE_NOT_LINKED';

export const INFOSYS_CATEGORIES: InfosysCategory[] = [
  'CONSISTENT_SOLVER',
  'INCONSISTENT',
  'TRYING_BUT_STRUGGLING',
  'IMPROVING',
  'DECLINING',
  'NOT_PARTICIPATING',
  'PROFILE_NOT_LINKED',
];

export const INFOSYS_CATEGORY_LABELS: Record<InfosysCategory, string> = {
  CONSISTENT_SOLVER: 'Consistent Solver',
  IMPROVING: 'Improving',
  INCONSISTENT: 'Inconsistent',
  TRYING_BUT_STRUGGLING: 'Trying But Struggling',
  NOT_PARTICIPATING: 'Not Participating',
  DECLINING: 'Declining',
  PROFILE_NOT_LINKED: 'Profile Not Linked',
};

export const INFOSYS_CATEGORY_RULES: Record<InfosysCategory, string> = {
  CONSISTENT_SOLVER: `Solved ${INFOSYS_STRONG_WEEK_THRESHOLD * 100}% or more of assigned questions in every observed week.`,
  INCONSISTENT: `Solved ${INFOSYS_STRONG_WEEK_THRESHOLD * 100}% or more in at least ${INFOSYS_INCONSISTENT_MIN_STRONG_WEEKS} weeks, but not in all of them.`,
  TRYING_BUT_STRUGGLING: `Attempted ${INFOSYS_STRUGGLING_ATTEMPT_THRESHOLD * 100}% or more of assigned questions in every observed week, but solved under ${INFOSYS_STRUGGLING_SOLVE_THRESHOLD * 100}%.`,
  IMPROVING: 'Share of questions solved in the second half of the period is higher than in the first.',
  DECLINING: 'Share of questions solved in the second half of the period is lower than in the first.',
  NOT_PARTICIPATING: `Attempted under ${INFOSYS_NOT_PARTICIPATING_ATTEMPT_THRESHOLD * 100}% of assigned questions in every observed week (includes a linked profile with no qualifying activity, or no assignment yet to be judged against).`,
  PROFILE_NOT_LINKED: 'No LeetCode profile has been added for this student yet.',
};

/** One week of one Infosys student, as the canonical daily rows add up to. */
export interface InfosysStudentWeek {
  weekNumber: number;
  from: DayKey;
  to: DayKey;
  assigned: number;
  /** Solved within the Infosys tracking window only — never an "ever solved" figure. */
  solved: number;
  attemptedNotSolved: number;
  notAttempted: number;
}

export type InfosysProfileState = 'OK' | 'PROFILE_NOT_LINKED' | 'DATA_UNAVAILABLE';

export interface InfosysCategoryInput {
  weeks: InfosysStudentWeek[];
  profileState: InfosysProfileState;
}

export interface InfosysCategoryVerdict {
  category: InfosysCategory;
  consideredWeeks: number;
  strongWeeks: number;
  firstHalfSolvePercent: number | null;
  secondHalfSolvePercent: number | null;
  overallSolvePercent: number | null;
  because: string;
}

const pct = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const solvedShare = (weeks: InfosysStudentWeek[]): number | null => {
  const assigned = weeks.reduce((sum, w) => sum + w.assigned, 0);
  const solved = weeks.reduce((sum, w) => sum + w.solved, 0);
  return pct(solved, assigned);
};

const attemptShare = (week: InfosysStudentWeek): number =>
  pct(week.solved + week.attemptedNotSolved, week.assigned) ?? 0;

const solveShare = (week: InfosysStudentWeek): number => pct(week.solved, week.assigned) ?? 0;

/**
 * Place one Infosys student, from their weekly rows alone. Pure — see the module
 * comment on why this is the single function every summary and drill-down must call.
 */
export function categoriseInfosysStudent(input: InfosysCategoryInput): InfosysCategoryVerdict {
  const { weeks, profileState } = input;

  // Weeks with nothing assigned carry no evidence and are excluded — there are none of
  // these in practice today (every Infosys day is assigned to every student, §3), but a
  // day with zero problems entered is not evidence of non-participation either.
  const considered = weeks.filter((w) => w.assigned > 0);

  const strongWeeks = considered.filter((w) => solveShare(w) >= INFOSYS_STRONG_WEEK_THRESHOLD).length;
  const midpoint = Math.ceil(considered.length / 2);
  const firstHalf = solvedShare(considered.slice(0, midpoint));
  const secondHalf = solvedShare(considered.slice(midpoint));
  const overall = solvedShare(considered);

  const base = {
    consideredWeeks: considered.length,
    strongWeeks,
    firstHalfSolvePercent: firstHalf,
    secondHalfSolvePercent: secondHalf,
    overallSolvePercent: overall,
  };

  // Structural states first — neither is a claim about what the student did.
  if (profileState === 'PROFILE_NOT_LINKED') {
    return {
      ...base,
      category: 'PROFILE_NOT_LINKED',
      because: 'No LeetCode profile has been added for this student yet.',
    };
  }
  if (profileState === 'DATA_UNAVAILABLE') {
    // A genuine sync failure — the profile is linked but could not be read reliably.
    // Reported as NOT_PARTICIPATING (no category of its own; see the module banner),
    // never as a fabricated solved/attempted figure: `weeks` here still carries whatever
    // real 0s the rollup persisted for this profile state, unchanged.
    return {
      ...base,
      category: 'NOT_PARTICIPATING',
      because: 'A LeetCode profile is linked but their submissions could not be reliably read.',
    };
  }

  if (considered.length === 0) {
    return {
      ...base,
      category: 'NOT_PARTICIPATING',
      because: 'No Infosys questions have been assigned yet for this student to be judged against.',
    };
  }

  // First category that fits wins — mirrors campus-analysis.ts's ordering discipline.
  if (considered.every((w) => solveShare(w) >= INFOSYS_STRONG_WEEK_THRESHOLD)) {
    return {
      ...base,
      category: 'CONSISTENT_SOLVER',
      because: `Solved ${INFOSYS_STRONG_WEEK_THRESHOLD * 100}% or more in all ${considered.length} observed weeks.`,
    };
  }

  if (considered.every((w) => attemptShare(w) < INFOSYS_NOT_PARTICIPATING_ATTEMPT_THRESHOLD)) {
    return {
      ...base,
      category: 'NOT_PARTICIPATING',
      because: `Attempted under ${INFOSYS_NOT_PARTICIPATING_ATTEMPT_THRESHOLD * 100}% of assigned questions in every one of the ${considered.length} observed weeks.`,
    };
  }

  if (
    considered.every(
      (w) =>
        attemptShare(w) >= INFOSYS_STRUGGLING_ATTEMPT_THRESHOLD &&
        solveShare(w) < INFOSYS_STRUGGLING_SOLVE_THRESHOLD,
    )
  ) {
    return {
      ...base,
      category: 'TRYING_BUT_STRUGGLING',
      because: `Attempted ${INFOSYS_STRUGGLING_ATTEMPT_THRESHOLD * 100}% or more of assigned questions every week, but solved under ${INFOSYS_STRUGGLING_SOLVE_THRESHOLD * 100}%.`,
    };
  }

  if (strongWeeks >= INFOSYS_INCONSISTENT_MIN_STRONG_WEEKS) {
    return {
      ...base,
      category: 'INCONSISTENT',
      because: `Solved ${INFOSYS_STRONG_WEEK_THRESHOLD * 100}% or more in ${strongWeeks} of ${considered.length} weeks, but not in all.`,
    };
  }

  const first = firstHalf ?? 0;
  const second = secondHalf ?? 0;
  if (second >= first) {
    return {
      ...base,
      category: 'IMPROVING',
      because: `Solved ${Math.round(second * 100)}% in the second half of the period against ${Math.round(first * 100)}% in the first.`,
    };
  }
  return {
    ...base,
    category: 'DECLINING',
    because: `Solved ${Math.round(second * 100)}% in the second half of the period against ${Math.round(first * 100)}% in the first.`,
  };
}

/* ------------------------------------------------------------------------- *
 * Response shapes — declared here, not in the API module, so the web client
 * and server are typed from one definition (see campus-analysis.ts's own note).
 * ------------------------------------------------------------------------- */

export interface InfosysStudentAnalysis {
  studentId: string;
  name: string;
  email: string | null;
  /** Informational only — carried through from `InfosysEnrollment.campusId` because
   * the roster happens to record it, exactly like a phone number or a squad name would
   * be. Never used to filter, scope, authorize, or aggregate Infosys data; see the
   * "one cohort" note at the top of this file. */
  campusName: string | null;
  leetcodeUsername: string | null;
  profileState: InfosysProfileState;
  assigned: number;
  solved: number;
  attemptedNotSolved: number;
  notAttempted: number;
  solvePercent: number | null;
  attemptPercent: number | null;
  weeks: InfosysStudentWeek[];
  verdict: InfosysCategoryVerdict;
}

/**
 * `assigned = solved + attemptedNotSolved + notAttempted` holds by construction: the
 * three outcomes partition the cohort's *distinct* assigned questions for the week —
 * "the same problem assigned to all 205 students" is one question, not 205 (the exact
 * rule campus-analysis.ts's `CampusQuestionWeek` already enforces for Coding Hours;
 * mirrored here at the whole-cohort level, deliberately with no per-campus grouping —
 * Infosys treats every enrolled student as one cohort, full stop).
 * `profileNotLinked`/`dataUnavailable` students are reported separately and are never
 * folded into `notAttempted` (§6/§9 of the brief).
 */
export interface InfosysCohortWeek {
  weekNumber: number;
  from: DayKey;
  to: DayKey;
  assigned: number;
  solved: number;
  attemptedNotSolved: number;
  notAttempted: number;
  solvePercent: number | null;
  attemptPercent: number | null;
}

/** The whole Infosys cohort, one row — never broken down by campus. See the file
 * banner: campus is informational only, and this type has no campus field at all so
 * that stays true structurally rather than by convention. */
export interface InfosysDashboardSummary {
  totalStudents: number;
  profilesLinked: number;
  assigned: number;
  solved: number;
  attemptedNotSolved: number;
  notAttempted: number;
  solvePercent: number | null;
  attemptPercent: number | null;
  categories: {
    category: InfosysCategory;
    label: string;
    rule: string;
    students: number;
  }[];
  weeks: InfosysCohortWeek[];
}

/** Checks the partition actually partitions for one cohort-week — see
 * `assertQuestionTotalsReconcile` in campus-analysis.ts, the pattern this mirrors,
 * itself written after that exact invariant was found broken in production. */
export function assertInfosysQuestionTotalsReconcile(
  week: Pick<InfosysCohortWeek, 'weekNumber' | 'assigned' | 'solved' | 'attemptedNotSolved' | 'notAttempted'>,
): string | null {
  const parts = week.solved + week.attemptedNotSolved + week.notAttempted;
  if (parts === week.assigned) return null;
  return (
    `Week ${week.weekNumber}: ${week.solved} solved + ${week.attemptedNotSolved} attempted ` +
    `+ ${week.notAttempted} not attempted = ${parts}, but ${week.assigned} were assigned.`
  );
}
