/**
 * How a student's six weeks are turned into one word.
 *
 * The five categories, their thresholds and the order they are tested in are taken from
 * the reference workbook's "Category Meaning" sheet, not invented here:
 *
 *   Consistent Solver  solved 60% or more of the questions in every one of the 6 weeks
 *   Not Participating  solved less than 20% in every one of the 6 weeks
 *   Inconsistent       solved 60% or more in at least 2 weeks, but not in all of them
 *   Improving          share solved in the second half is higher than in the first
 *   Declining          share solved in the second half is lower than in the first
 *
 *   Order of checking: Consistent Solver -> Not Participating -> Inconsistent ->
 *   Improving / Declining. A student is given the first category that fits.
 *
 * Two things the sheet could not express are added, and both exist to stop a measurement
 * gap from being reported as a student's behaviour:
 *
 *  * `DATA_UNAVAILABLE` — we could not read this student's LeetCode data, so we do not
 *    know what they did. The sheet had no way to say this, so its arithmetic put such a
 *    student at 0% and the ordering handed them "Not Participating". That is a statement
 *    about a student, made from the absence of a statement about a student.
 *
 *  * `NOT_OBSERVED` — the student was not in the tracker for enough of the period for any
 *    trend to mean anything. A student added in week 5 is not "Declining".
 *
 * Neither is a performance category and neither is ever counted as one.
 *
 * `Improving` and `Declining` split the period in half rather than fitting a line: the
 * sheet compares weeks 1-3 against weeks 4-6, and a report that management reads beside
 * last month's has to keep meaning the same thing.
 */

/** Share of a week's assigned questions that must be solved to count as a strong week. */
export const STRONG_WEEK_THRESHOLD = 0.6;
/** At or below this share, every week, is what the sheet calls not participating. */
export const NOT_PARTICIPATING_THRESHOLD = 0.2;
/** How many strong weeks make an otherwise uneven record "Inconsistent". */
export const INCONSISTENT_MIN_STRONG_WEEKS = 2;
/**
 * How much of the period a student must have been observable for a trend to be claimed.
 *
 * Below this they are `NOT_OBSERVED`: the tracker simply was not watching for enough of
 * the period, and a half-measured student placed in a performance bucket is the same
 * mistake as a zeroed one, made more quietly.
 */
export const MIN_OBSERVED_WEEKS = 3;

export type CampusCategory =
  | 'CONSISTENT_SOLVER'
  | 'INCONSISTENT'
  | 'IMPROVING'
  | 'DECLINING'
  | 'NOT_PARTICIPATING'
  | 'NOT_OBSERVED'
  | 'DATA_UNAVAILABLE';

/** Display order: the performance categories in the sheet's order, then the two states. */
export const CAMPUS_CATEGORIES: CampusCategory[] = [
  'CONSISTENT_SOLVER',
  'INCONSISTENT',
  'IMPROVING',
  'DECLINING',
  'NOT_PARTICIPATING',
  'NOT_OBSERVED',
  'DATA_UNAVAILABLE',
];

export const CAMPUS_CATEGORY_LABELS: Record<CampusCategory, string> = {
  CONSISTENT_SOLVER: 'Consistent Solver',
  INCONSISTENT: 'Inconsistent',
  IMPROVING: 'Improving',
  DECLINING: 'Declining',
  NOT_PARTICIPATING: 'Not Participating',
  NOT_OBSERVED: 'Not Observed',
  DATA_UNAVAILABLE: 'Data Unavailable',
};

/** Mentor-facing wording, in the sheet's own plain language where it had some. */
export const CAMPUS_CATEGORY_MEANINGS: Record<CampusCategory, string> = {
  CONSISTENT_SOLVER: 'Solves most of the questions, every single week.',
  INCONSISTENT: 'Does well in some weeks but not in others.',
  IMPROVING: 'Solving a bigger share of questions now than at the start.',
  DECLINING: 'Solving a smaller share of questions now than at the start.',
  NOT_PARTICIPATING: 'Hardly solving any questions.',
  NOT_OBSERVED: 'Joined partway through — too little of the period was measured to judge a trend.',
  DATA_UNAVAILABLE: 'Their LeetCode data could not be read. This is not a score of zero.',
};

/** How each category is decided, so a mentor can check the verdict rather than trust it. */
export const CAMPUS_CATEGORY_RULES: Record<CampusCategory, string> = {
  CONSISTENT_SOLVER: 'Solved 60% or more of the questions in every observed week.',
  INCONSISTENT: 'Solved 60% or more in at least 2 weeks, but not in all of them.',
  IMPROVING: 'Share of questions solved in the second half of the period is higher than in the first.',
  DECLINING: 'Share of questions solved in the second half of the period is lower than in the first.',
  NOT_PARTICIPATING: 'Solved less than 20% of the questions in every observed week.',
  NOT_OBSERVED: `Fewer than ${MIN_OBSERVED_WEEKS} weeks of the period fall inside this student's time in the tracker.`,
  DATA_UNAVAILABLE: 'No reliable reading of this student’s submissions for this period.',
};

/** One week of one student, as the canonical daily rows add up to. */
export interface StudentWeek {
  weekNumber: number;
  /** Inclusive program-day bounds. */
  from: string;
  to: string;
  assigned: number;
  /** Distinct assigned problems ever solved — never a windowed figure. */
  solved: number;
  /** Assigned problems submitted against without an accepted verdict. */
  attemptedNotSolved: number;
  /** Assigned problems with no submission at all. */
  notAttempted: number;
  /** False when the tracker was not watching this student for this week. */
  observed: boolean;
}

export interface CategoryInput {
  weeks: StudentWeek[];
  /** False when the provider could not be read for this student at all. */
  dataAvailable: boolean;
}

export interface CategoryVerdict {
  category: CampusCategory;
  /** The weeks the verdict was actually computed over — observed, with work assigned. */
  consideredWeeks: number;
  strongWeeks: number;
  firstHalfPercent: number | null;
  secondHalfPercent: number | null;
  overallPercent: number | null;
  /** One sentence naming the evidence, for the drill-down to show beside the word. */
  because: string;
}

const pct = (solved: number, assigned: number): number | null =>
  assigned === 0 ? null : solved / assigned;

const share = (weeks: StudentWeek[]): number | null => {
  const assigned = weeks.reduce((sum, w) => sum + w.assigned, 0);
  const solved = weeks.reduce((sum, w) => sum + w.solved, 0);
  return pct(solved, assigned);
};

/**
 * Place one student, from their weekly rows alone.
 *
 * Pure, and takes the weeks rather than fetching them, so the category shown on a campus
 * summary card and the category shown in that card's drill-down are the same function of
 * the same rows. Two code paths producing "Not Participating" independently is how a
 * summary and its detail come to disagree.
 */
export function categoriseStudent(input: CategoryInput): CategoryVerdict {
  const { weeks, dataAvailable } = input;

  // Weeks with nothing assigned carry no evidence either way and are excluded from every
  // figure below — otherwise a campus that set no work in week 3 would push its whole
  // cohort towards "Not Participating" for not solving questions nobody asked for.
  const considered = weeks.filter((w) => w.observed && w.assigned > 0);
  const strongWeeks = considered.filter(
    (w) => (pct(w.solved, w.assigned) ?? 0) >= STRONG_WEEK_THRESHOLD,
  ).length;

  const midpoint = Math.ceil(considered.length / 2);
  const firstHalf = share(considered.slice(0, midpoint));
  const secondHalf = share(considered.slice(midpoint));
  const overall = share(considered);

  const base = {
    consideredWeeks: considered.length,
    strongWeeks,
    firstHalfPercent: firstHalf,
    secondHalfPercent: secondHalf,
    overallPercent: overall,
  };

  // Checked before anything else: every category below is a claim about what the student
  // did, and we have no basis for one.
  if (!dataAvailable) {
    return {
      ...base,
      category: 'DATA_UNAVAILABLE',
      because: 'Their LeetCode data could not be read for this period, so no verdict is claimed.',
    };
  }

  if (considered.length < MIN_OBSERVED_WEEKS) {
    return {
      ...base,
      category: 'NOT_OBSERVED',
      because:
        `Only ${considered.length} week(s) of this period fall inside their time in the ` +
        `tracker, which is fewer than the ${MIN_OBSERVED_WEEKS} a trend needs.`,
    };
  }

  // The sheet's order, kept exactly: first category that fits wins.
  if (considered.every((w) => (pct(w.solved, w.assigned) ?? 0) >= STRONG_WEEK_THRESHOLD)) {
    return {
      ...base,
      category: 'CONSISTENT_SOLVER',
      because: `Solved 60% or more in all ${considered.length} observed weeks.`,
    };
  }

  if (considered.every((w) => (pct(w.solved, w.assigned) ?? 0) < NOT_PARTICIPATING_THRESHOLD)) {
    return {
      ...base,
      category: 'NOT_PARTICIPATING',
      because: `Solved under 20% in every one of the ${considered.length} observed weeks.`,
    };
  }

  if (strongWeeks >= INCONSISTENT_MIN_STRONG_WEEKS) {
    return {
      ...base,
      category: 'INCONSISTENT',
      because: `Solved 60% or more in ${strongWeeks} of ${considered.length} weeks, but not in all.`,
    };
  }

  const first = firstHalf ?? 0;
  const second = secondHalf ?? 0;
  if (second >= first) {
    return {
      ...base,
      category: 'IMPROVING',
      because:
        `Solved ${Math.round(second * 100)}% in the second half of the period against ` +
        `${Math.round(first * 100)}% in the first.`,
    };
  }
  return {
    ...base,
    category: 'DECLINING',
    because:
      `Solved ${Math.round(second * 100)}% in the second half of the period against ` +
      `${Math.round(first * 100)}% in the first.`,
  };
}

/**
 * Monday-to-Sunday weeks covering `[from, to]`, numbered from 1.
 *
 * The first and last weeks are clipped to the period rather than extended outside it, so
 * "Week 1 (06 Aug - 09 Aug)" stays four days long and its percentage is measured against
 * the four days of work actually set — which is how the reference workbook reads.
 */
export function analysisWeeks(from: string, to: string): { weekNumber: number; from: string; to: string }[] {
  const weeks: { weekNumber: number; from: string; to: string }[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return weeks;

  const key = (d: Date): string => d.toISOString().slice(0, 10);
  let cursor = new Date(start);
  let n = 1;
  while (cursor <= end) {
    // 0 = Sunday, so Monday-based offset is (dow + 6) % 7.
    const daysToSunday = 6 - ((cursor.getUTCDay() + 6) % 7);
    const weekEnd = new Date(cursor);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + daysToSunday);
    const clipped = weekEnd > end ? end : weekEnd;
    weeks.push({ weekNumber: n, from: key(cursor), to: key(clipped) });
    cursor = new Date(clipped);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    n += 1;
  }
  return weeks;
}
