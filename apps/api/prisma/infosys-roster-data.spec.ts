import { describe, expect, it } from 'vitest';

import { EXPECTED_CAMPUS_COUNTS, EXPECTED_TOTAL, INFOSYS_ROSTER } from './infosys-roster-data';

describe('INFOSYS_ROSTER', () => {
  it('has exactly the expected total (§24)', () => {
    expect(INFOSYS_ROSTER.length).toBe(EXPECTED_TOTAL);
  });

  it('matches every expected per-campus count (§24)', () => {
    const counts = new Map<string, number>();
    for (const row of INFOSYS_ROSTER) {
      counts.set(row.campusName, (counts.get(row.campusName) ?? 0) + 1);
    }
    for (const [campus, expected] of Object.entries(EXPECTED_CAMPUS_COUNTS)) {
      expect(counts.get(campus), `${campus} count`).toBe(expected);
    }
    expect(counts.size).toBe(Object.keys(EXPECTED_CAMPUS_COUNTS).length);
  });

  it('has no duplicate emails across the whole roster (§24)', () => {
    const emails = INFOSYS_ROSTER.map((r) => r.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('every email is a well-formed kalvium.community address', () => {
    for (const row of INFOSYS_ROSTER) {
      expect(row.email).toMatch(/^[a-z0-9.]+@kalvium\.community$/);
    }
  });

  it('every email is lowercase', () => {
    for (const row of INFOSYS_ROSTER) {
      expect(row.email).toBe(row.email.toLowerCase());
    }
  });
});
