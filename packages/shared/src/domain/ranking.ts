/**
 * Leaderboard ranking.
 *
 * Ranking is competition-style ("1224"): tied entries share a rank and the next
 * distinct entry skips ahead. Two students who both cleared all four problems at the
 * same minute genuinely tie, and inventing an order between them would be arbitrary.
 *
 * The comparator is total and deterministic — it always ends at a stable tiebreak —
 * so the same inputs produce the same board on every recomputation.
 */

export interface RankableEntry {
  /** Stable identity used as the final, deterministic tiebreak. */
  id: string;
  displayName: string;
  score: number;
  solvedCount: number;
  /**
   * Minute-of-day the assignment was completed; `null` when incomplete.
   * Earlier is better, and `null` always sorts last.
   */
  completionMinuteOfDay: number | null;
  currentStreak: number;
  /** Qualifying days ÷ assigned days over the window, 0–100. */
  consistency: number;
}

export interface RankedEntry<T extends RankableEntry = RankableEntry> {
  rank: number;
  /** Position among ties — useful for stable table keys and "moved up/down" arrows. */
  index: number;
  entry: T;
  /** True when at least one other entry shares this rank. */
  isTied: boolean;
}

/**
 * Ordering, most significant first:
 *   1. score            (desc) — the headline number
 *   2. solvedCount      (desc) — raw output breaks equal-score ties
 *   3. completionTime   (asc)  — the spec's explicit tiebreaker; nulls last
 *   4. currentStreak    (desc) — reward sustained work
 *   5. consistency      (desc)
 *   6. displayName      (asc)  — deterministic and human-sensible
 *   7. id               (asc)  — guarantees totality
 */
export function compareForRanking(a: RankableEntry, b: RankableEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;

  const aTime = a.completionMinuteOfDay;
  const bTime = b.completionMinuteOfDay;
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return aTime - bTime;
  }

  if (a.currentStreak !== b.currentStreak) return b.currentStreak - a.currentStreak;
  if (a.consistency !== b.consistency) return b.consistency - a.consistency;

  const byName = a.displayName.localeCompare(b.displayName);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

/**
 * Two entries tie only when every *meaningful* field matches. Identity fields
 * (`displayName`, `id`) are excluded — they exist to make the sort deterministic,
 * not to separate genuinely equal performances.
 */
function isTie(a: RankableEntry, b: RankableEntry): boolean {
  return (
    a.score === b.score &&
    a.solvedCount === b.solvedCount &&
    a.completionMinuteOfDay === b.completionMinuteOfDay &&
    a.currentStreak === b.currentStreak &&
    a.consistency === b.consistency
  );
}

export function rankEntries<T extends RankableEntry>(entries: T[]): RankedEntry<T>[] {
  const sorted = [...entries].sort(compareForRanking);
  const ranked: RankedEntry<T>[] = [];

  let currentRank = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i]!;
    const previous = i > 0 ? sorted[i - 1]! : null;

    // Competition ranking: a tie reuses the previous rank, otherwise the rank jumps
    // to this entry's 1-based position, skipping the numbers the tie consumed.
    if (previous && isTie(previous, entry)) {
      // keep currentRank
    } else {
      currentRank = i + 1;
    }

    ranked.push({ rank: currentRank, index: i, entry, isTied: false });
  }

  // Second pass marks ties, which can only be known once neighbours are ranked.
  const rankCounts = new Map<number, number>();
  for (const row of ranked) {
    rankCounts.set(row.rank, (rankCounts.get(row.rank) ?? 0) + 1);
  }
  for (const row of ranked) {
    row.isTied = (rankCounts.get(row.rank) ?? 0) > 1;
  }

  return ranked;
}

export interface SquadAggregateInput {
  squadId: string;
  squadName: string;
  members: RankableEntry[];
  /** Assigned problems per member over the window — the denominator for completion %. */
  assignedPerMember: number;
}

export interface SquadAggregate extends RankableEntry {
  squadId: string;
  memberCount: number;
  averageCompletion: number;
  totalSolved: number;
  averageStreak: number;
  averageScore: number;
}

/**
 * Roll a squad up into a single rankable entry.
 *
 * Averages rather than totals, because squads are not guaranteed to be the same size
 * and ranking a 12-person squad against an 8-person squad on totals would be meaningless.
 */
export function aggregateSquad(input: SquadAggregateInput): SquadAggregate {
  const memberCount = input.members.length;
  const safeCount = memberCount > 0 ? memberCount : 1;

  const totalSolved = input.members.reduce((sum, m) => sum + m.solvedCount, 0);
  const totalScore = input.members.reduce((sum, m) => sum + m.score, 0);
  const totalStreak = input.members.reduce((sum, m) => sum + m.currentStreak, 0);
  const totalConsistency = input.members.reduce((sum, m) => sum + m.consistency, 0);

  const denominator = input.assignedPerMember * memberCount;
  const averageCompletion =
    denominator > 0 ? Math.round((totalSolved / denominator) * 10000) / 100 : 0;

  // Squad completion time is the point at which the squad's *typical* member finished:
  // the median across members who actually completed. A mean would let one very early
  // finisher mask a squad that mostly finished at midnight.
  const completionTimes = input.members
    .map((m) => m.completionMinuteOfDay)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const medianCompletion =
    completionTimes.length > 0
      ? completionTimes[Math.floor((completionTimes.length - 1) / 2)]!
      : null;

  const averageScore = Math.round((totalScore / safeCount) * 100) / 100;

  return {
    id: input.squadId,
    squadId: input.squadId,
    displayName: input.squadName,
    memberCount,
    score: averageScore,
    averageScore,
    solvedCount: totalSolved,
    totalSolved,
    completionMinuteOfDay: medianCompletion,
    currentStreak: Math.round((totalStreak / safeCount) * 100) / 100,
    averageStreak: Math.round((totalStreak / safeCount) * 100) / 100,
    consistency: Math.round((totalConsistency / safeCount) * 100) / 100,
    averageCompletion,
  };
}

export function rankSquads(inputs: SquadAggregateInput[]): RankedEntry<SquadAggregate>[] {
  return rankEntries(inputs.map(aggregateSquad));
}

/**
 * Students whose score improved most between two windows.
 *
 * Ranked by absolute delta rather than percentage change: a student going from 20 to 60
 * has improved more meaningfully than one going from 1 to 4, even though the latter
 * tripled. Percentage change is also undefined for the very common `previous === 0` case.
 */
export interface ImprovementInput {
  id: string;
  displayName: string;
  previousScore: number;
  currentScore: number;
}

export interface ImprovementResult extends ImprovementInput {
  delta: number;
  percentChange: number | null;
}

export function rankImprovement(
  inputs: ImprovementInput[],
  direction: 'TOP' | 'BOTTOM' = 'TOP',
  limit = 10,
): ImprovementResult[] {
  const results = inputs.map((input) => ({
    ...input,
    delta: input.currentScore - input.previousScore,
    percentChange:
      input.previousScore > 0
        ? Math.round(
            ((input.currentScore - input.previousScore) / input.previousScore) * 10000,
          ) / 100
        : null,
  }));

  results.sort((a, b) =>
    direction === 'TOP'
      ? b.delta - a.delta || a.displayName.localeCompare(b.displayName)
      : a.delta - b.delta || a.displayName.localeCompare(b.displayName),
  );

  return results.slice(0, limit);
}
