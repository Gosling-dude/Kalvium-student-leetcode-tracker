import { describe, expect, it } from 'vitest';
import {
  aggregateSquad,
  compareForRanking,
  rankEntries,
  rankSquads,
  rankImprovement,
  type RankableEntry,
} from './ranking';

function entry(overrides: Partial<RankableEntry> & { id: string }): RankableEntry {
  return {
    displayName: overrides.id,
    score: 0,
    solvedCount: 0,
    completionMinuteOfDay: null,
    currentStreak: 0,
    consistency: 0,
    ...overrides,
  };
}

describe('compareForRanking', () => {
  it('sorts by score descending first', () => {
    expect(
      compareForRanking(entry({ id: 'a', score: 50 }), entry({ id: 'b', score: 100 })),
    ).toBeGreaterThan(0);
  });

  it('breaks equal scores by problems solved', () => {
    const a = entry({ id: 'a', score: 100, solvedCount: 4 });
    const b = entry({ id: 'b', score: 100, solvedCount: 3 });
    expect(compareForRanking(a, b)).toBeLessThan(0);
  });

  it('uses earlier completion time as the spec\'s tiebreaker', () => {
    const early = entry({ id: 'a', score: 100, solvedCount: 4, completionMinuteOfDay: 480 });
    const late = entry({ id: 'b', score: 100, solvedCount: 4, completionMinuteOfDay: 1300 });
    expect(compareForRanking(early, late)).toBeLessThan(0);
  });

  it('sorts students who never completed last, regardless of order', () => {
    const done = entry({ id: 'a', score: 100, solvedCount: 4, completionMinuteOfDay: 1300 });
    const never = entry({ id: 'b', score: 100, solvedCount: 4, completionMinuteOfDay: null });
    expect(compareForRanking(done, never)).toBeLessThan(0);
    expect(compareForRanking(never, done)).toBeGreaterThan(0);
  });

  it('is a total order — never returns 0 for distinct entries', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    expect(compareForRanking(a, b)).not.toBe(0);
  });
});

describe('rankEntries', () => {
  it('assigns competition ranks with gaps after ties', () => {
    const ranked = rankEntries([
      entry({ id: 'a', displayName: 'Asha', score: 100, solvedCount: 4, completionMinuteOfDay: 600 }),
      entry({ id: 'b', displayName: 'Bilal', score: 100, solvedCount: 4, completionMinuteOfDay: 600 }),
      entry({ id: 'c', displayName: 'Chen', score: 75, solvedCount: 3 }),
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
    expect(ranked[0]!.isTied).toBe(true);
    expect(ranked[1]!.isTied).toBe(true);
    expect(ranked[2]!.isTied).toBe(false);
  });

  it('does not treat entries separated only by name as tied', () => {
    const ranked = rankEntries([
      entry({ id: 'a', displayName: 'Asha', score: 100, solvedCount: 4, completionMinuteOfDay: 600 }),
      entry({ id: 'b', displayName: 'Bilal', score: 100, solvedCount: 4, completionMinuteOfDay: 599 }),
    ]);
    // Different completion minutes — genuinely ordered, so ranks 1 and 2.
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked.every((r) => !r.isTied)).toBe(true);
  });

  it('is deterministic across input orderings', () => {
    const input = [
      entry({ id: 'a', displayName: 'Asha', score: 50 }),
      entry({ id: 'b', displayName: 'Bilal', score: 50 }),
      entry({ id: 'c', displayName: 'Chen', score: 50 }),
    ];
    const first = rankEntries(input).map((r) => r.entry.id);
    const second = rankEntries([...input].reverse()).map((r) => r.entry.id);
    expect(first).toEqual(second);
  });

  it('does not mutate its input', () => {
    const input = [entry({ id: 'b', score: 10 }), entry({ id: 'a', score: 90 })];
    rankEntries(input);
    expect(input.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('handles an empty board', () => {
    expect(rankEntries([])).toEqual([]);
  });
});

describe('aggregateSquad', () => {
  it('averages rather than totals so unequal squad sizes compare fairly', () => {
    const small = aggregateSquad({
      squadId: 'g1',
      squadName: 'Alpha',
      assignedPerMember: 4,
      members: [
        entry({ id: 's1', score: 100, solvedCount: 4, currentStreak: 10, consistency: 100 }),
        entry({ id: 's2', score: 100, solvedCount: 4, currentStreak: 10, consistency: 100 }),
      ],
    });
    const large = aggregateSquad({
      squadId: 'g2',
      squadName: 'Beta',
      assignedPerMember: 4,
      members: Array.from({ length: 8 }, (_, i) =>
        entry({ id: `t${i}`, score: 50, solvedCount: 2, currentStreak: 2, consistency: 50 }),
      ),
    });
    // Beta has 16 total solved vs Alpha's 8, but Alpha is clearly the stronger squad.
    expect(large.totalSolved).toBeGreaterThan(small.totalSolved);
    expect(small.averageCompletion).toBe(100);
    expect(large.averageCompletion).toBe(50);
    expect(small.score).toBeGreaterThan(large.score);
  });

  it('uses the median completion time so one early finisher cannot mask the squad', () => {
    const squad = aggregateSquad({
      squadId: 'g1',
      squadName: 'Alpha',
      assignedPerMember: 4,
      members: [
        entry({ id: 'a', completionMinuteOfDay: 60 }),
        entry({ id: 'b', completionMinuteOfDay: 1400 }),
        entry({ id: 'c', completionMinuteOfDay: 1410 }),
      ],
    });
    expect(squad.completionMinuteOfDay).toBe(1400);
  });

  it('survives an empty squad without dividing by zero', () => {
    const squad = aggregateSquad({
      squadId: 'g',
      squadName: 'Empty',
      assignedPerMember: 4,
      members: [],
    });
    expect(squad.memberCount).toBe(0);
    expect(squad.averageCompletion).toBe(0);
    expect(Number.isNaN(squad.score)).toBe(false);
  });
});

describe('rankSquads', () => {
  it('ranks squads by average performance', () => {
    const ranked = rankSquads([
      {
        squadId: 'g1',
        squadName: 'Alpha',
        assignedPerMember: 4,
        members: [entry({ id: 'a', score: 100, solvedCount: 4 })],
      },
      {
        squadId: 'g2',
        squadName: 'Beta',
        assignedPerMember: 4,
        members: [entry({ id: 'b', score: 25, solvedCount: 1 })],
      },
    ]);
    expect(ranked[0]!.entry.squadId).toBe('g1');
    expect(ranked[0]!.rank).toBe(1);
  });
});

describe('rankImprovement', () => {
  it('ranks by absolute delta, not percentage', () => {
    const results = rankImprovement([
      { id: 'a', displayName: 'Asha', previousScore: 20, currentScore: 60 },
      { id: 'b', displayName: 'Bilal', previousScore: 1, currentScore: 4 },
    ]);
    // Bilal quadrupled but Asha improved far more meaningfully.
    expect(results[0]!.id).toBe('a');
    expect(results[0]!.delta).toBe(40);
  });

  it('reports null percent change when the baseline was zero', () => {
    const results = rankImprovement([
      { id: 'a', displayName: 'Asha', previousScore: 0, currentScore: 50 },
    ]);
    expect(results[0]!.percentChange).toBeNull();
    expect(results[0]!.delta).toBe(50);
  });

  it('finds the steepest decliners in BOTTOM mode', () => {
    const results = rankImprovement(
      [
        { id: 'a', displayName: 'Asha', previousScore: 100, currentScore: 20 },
        { id: 'b', displayName: 'Bilal', previousScore: 50, currentScore: 60 },
      ],
      'BOTTOM',
    );
    expect(results[0]!.id).toBe('a');
    expect(results[0]!.delta).toBe(-80);
  });

  it('respects the limit', () => {
    const inputs = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      displayName: `S${i}`,
      previousScore: 0,
      currentScore: i,
    }));
    expect(rankImprovement(inputs, 'TOP', 5)).toHaveLength(5);
  });
});
