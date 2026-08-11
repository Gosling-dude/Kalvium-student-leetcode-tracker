import { describe, expect, it } from 'vitest';
import {
  actionTierFor,
  buildActionRequiredText,
  buildBucketShapes,
  defaultEmailSubject,
  formatDayKeyLong,
  formatDayKeyShort,
  isPlausibleEmail,
  statusLabelFor,
} from './daily-email-report';

describe('actionTierFor — 4-assignment day (the spec\'s worked example)', () => {
  it('solved all 4 → COMPLETE', () => {
    expect(actionTierFor(4, 4)).toBe('COMPLETE');
  });
  it('solved 3 of 4 → NEAR_COMPLETE (1 remaining)', () => {
    expect(actionTierFor(3, 4)).toBe('NEAR_COMPLETE');
  });
  it('solved 2 of 4 → FOLLOW_UP (2 remaining)', () => {
    expect(actionTierFor(2, 4)).toBe('FOLLOW_UP');
  });
  it('solved 1 of 4 → INTERVENTION (3 remaining)', () => {
    expect(actionTierFor(1, 4)).toBe('INTERVENTION');
  });
  it('solved 0 of 4 → URGENT', () => {
    expect(actionTierFor(0, 4)).toBe('URGENT');
  });
});

describe('actionTierFor — different assignment sizes', () => {
  it('3-assignment day: solved 0 is still URGENT, not a misleading partial tier', () => {
    expect(actionTierFor(0, 3)).toBe('URGENT');
  });
  it('3-assignment day: solved 2 of 3 (1 remaining) → NEAR_COMPLETE', () => {
    expect(actionTierFor(2, 3)).toBe('NEAR_COMPLETE');
  });
  it('3-assignment day: solved 1 of 3 (2 remaining) → FOLLOW_UP', () => {
    expect(actionTierFor(1, 3)).toBe('FOLLOW_UP');
  });
  it('5-assignment day: solved 1 of 5 (4 remaining) → INTERVENTION, not NEAR_COMPLETE', () => {
    expect(actionTierFor(1, 5)).toBe('INTERVENTION');
  });
  it('5-assignment day: solved all 5 → COMPLETE', () => {
    expect(actionTierFor(5, 5)).toBe('COMPLETE');
  });
  it('no assignment that day → NOT_ASSIGNED regardless of solved count', () => {
    expect(actionTierFor(0, 0)).toBe('NOT_ASSIGNED');
  });
  it('clamps an impossible solved count above assigned to COMPLETE', () => {
    expect(actionTierFor(9, 4)).toBe('COMPLETE');
  });
});

describe('statusLabelFor — the student table Status column', () => {
  it('matches the §6 worked example exactly', () => {
    expect(statusLabelFor(4, 4)).toBe('Complete');
    expect(statusLabelFor(3, 4)).toBe('Follow-up');
    expect(statusLabelFor(1, 4)).toBe('Intervention');
    expect(statusLabelFor(0, 4)).toBe('Urgent');
  });
});

describe('buildBucketShapes — dynamic sizing (§4)', () => {
  it('a 4-problem day gets exactly 5 buckets: 4,3,2,1,0', () => {
    expect(buildBucketShapes(4).map((b) => b.solvedCount)).toEqual([4, 3, 2, 1, 0]);
  });
  it('a 3-problem day gets exactly 4 buckets — no phantom "Completed 4"', () => {
    const shapes = buildBucketShapes(3);
    expect(shapes.map((b) => b.solvedCount)).toEqual([3, 2, 1, 0]);
    expect(shapes.some((b) => b.solvedCount === 4)).toBe(false);
  });
  it('a 5-problem day gets exactly 6 buckets: 5,4,3,2,1,0', () => {
    expect(buildBucketShapes(5).map((b) => b.solvedCount)).toEqual([5, 4, 3, 2, 1, 0]);
  });
  it('no assignment produces no buckets', () => {
    expect(buildBucketShapes(0)).toEqual([]);
  });
  it('labels the top bucket "Completed All" and the rest by count', () => {
    const shapes = buildBucketShapes(3);
    expect(shapes[0]!.label).toBe('Completed All (3/3)');
    expect(shapes[1]!.label).toBe('Completed 2');
  });
});

describe('formatDayKeyLong / formatDayKeyShort', () => {
  it('renders the spec\'s example date both ways', () => {
    expect(formatDayKeyLong('2026-08-08')).toBe('08 August 2026');
    expect(formatDayKeyShort('2026-08-08')).toBe('08 Aug 2026');
  });
});

describe('defaultEmailSubject', () => {
  it('matches the spec\'s default subject line exactly', () => {
    expect(defaultEmailSubject('2026-08-08')).toBe('Daily DSA Assignment Report — 08 Aug 2026');
  });
});

describe('buildActionRequiredText — blocker awareness (§8)', () => {
  it('a completed student never needs intervention text, blocker or not', () => {
    expect(buildActionRequiredText('COMPLETE', null)).toBe('No intervention required.');
  });

  it('no blocker recorded at all → generic tier guidance plus an explicit "not reported" note', () => {
    const text = buildActionRequiredText('URGENT', null);
    expect(text).toContain('Contact this student today');
    expect(text).toContain('No blocker reported.');
  });

  it('a mentor explicitly recorded NO_BLOCKER → the spec\'s exact phrasing', () => {
    const text = buildActionRequiredText('INTERVENTION', { category: 'NO_BLOCKER', description: null });
    expect(text).toBe('No blocker reported — student should complete the remaining assignments.');
  });

  it('a real blocker is on file → names the category and quotes the description', () => {
    const text = buildActionRequiredText('INTERVENTION', {
      category: 'UNABLE_TO_IDENTIFY_PATTERN',
      description: 'Unable to understand sliding window.',
    });
    expect(text).toContain('Unable to identify pattern');
    expect(text).toContain('Unable to understand sliding window.');
  });

  it('a real blocker with no free-text description still names the category', () => {
    const text = buildActionRequiredText('FOLLOW_UP', {
      category: 'TIME_MANAGEMENT',
      description: null,
    });
    expect(text).toContain('Time management');
  });
});

describe('isPlausibleEmail', () => {
  it('accepts a normal address', () => {
    expect(isPlausibleEmail('mentor@kalvium.community')).toBe(true);
  });
  it('rejects addresses missing a domain or local part', () => {
    expect(isPlausibleEmail('mentor@')).toBe(false);
    expect(isPlausibleEmail('@kalvium.community')).toBe(false);
    expect(isPlausibleEmail('not-an-email')).toBe(false);
  });
});
