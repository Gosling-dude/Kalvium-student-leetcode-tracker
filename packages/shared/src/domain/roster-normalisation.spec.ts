/**
 * The data-quality rules, exercised against every malformed *shape* that appeared in a
 * real campus intake.
 *
 * The shapes are real; the identities are not. Every name, address and handle below is
 * invented, because this repository is public and the roster files it describes are
 * gitignored for exactly that reason — reproducing student identities in a test file
 * would leak precisely what the ignore rule protects. What matters for coverage is the
 * *form* of each value, and that is preserved exactly: the `/settings/` paste, the
 * pasted page title, the auto-generated handle, the space inside a handle, the
 * off-domain address, the same person submitting twice in different letter case.
 *
 * The property every case here defends is the same: **a gap beats a guess**. A student
 * whose handle we could not read must import with `null`, not with something plausible,
 * because a fabricated handle syncs as "user not found" forever and reads to a mentor as
 * "this student solved nothing".
 */

import { describe, expect, it } from 'vitest';

import {
  hasUsableProfile,
  isProgrammeEmail,
  normaliseEmail,
  normaliseRoster,
  normaliseSquadNumber,
  resolveLeetcodeProfile,
  type RawRosterRow,
} from './roster-normalisation';

describe('resolveLeetcodeProfile — values that are real profiles', () => {
  it('accepts a canonical profile URL', () => {
    const result = resolveLeetcodeProfile('https://leetcode.com/u/aparnaiyer/');
    expect(result).toMatchObject({
      username: 'aparnaiyer',
      profileUrl: 'https://leetcode.com/u/aparnaiyer/',
      resolution: 'PROFILE_URL',
      needsVerification: false,
    });
  });

  it('accepts a profile URL with no trailing slash', () => {
    expect(resolveLeetcodeProfile('https://leetcode.com/u/devsharma').username).toBe('devsharma');
  });

  it('normalises to the canonical URL rather than storing what was pasted', () => {
    // Two students who pasted the same handle differently must end up identical, or the
    // "one student, one handle" unique index stops being able to see the collision.
    const withSlash = resolveLeetcodeProfile('https://leetcode.com/u/arjun_14/');
    const withoutSlash = resolveLeetcodeProfile('https://leetcode.com/u/arjun_14');
    expect(withSlash.profileUrl).toBe(withoutSlash.profileUrl);
  });

  it('accepts a bare handle and builds the URL', () => {
    expect(resolveLeetcodeProfile('nikhilrao')).toMatchObject({
      username: 'nikhilrao',
      profileUrl: 'https://leetcode.com/u/nikhilrao/',
      resolution: 'BARE_USERNAME',
      needsVerification: false,
    });
  });

  it('accepts a LeetCode auto-generated handle, which looks like noise but is real', () => {
    // LeetCode assigns handles of this shape when someone never picks a username.
    // Rejecting them as "not name-shaped" would drop real accounts.
    expect(resolveLeetcodeProfile('7bQx2Kp9Lm').username).toBe('7bQx2Kp9Lm');
    expect(resolveLeetcodeProfile('3vT8mNq2Rz').username).toBe('3vT8mNq2Rz');
  });

  it('extracts a profile URL embedded in pasted page text', () => {
    const result = resolveLeetcodeProfile(
      'PriyaMenon - LeetCode Profile https://leetcode.com/u/PriyaMenon/',
    );
    expect(result).toMatchObject({
      username: 'PriyaMenon',
      resolution: 'EXTRACTED_FROM_TEXT',
      needsVerification: false,
    });
  });

  it('prefers the embedded URL over the page title when both are present', () => {
    // The URL is confirmation; the title alone is not. Reading the title here would
    // downgrade a perfectly good row to "needs verification" for no reason.
    const result = resolveLeetcodeProfile(
      'RAHULVERMA - LeetCode Profile https://leetcode.com/u/RAHULVERMA/',
    );
    expect(result.resolution).toBe('EXTRACTED_FROM_TEXT');
    expect(result.needsVerification).toBe(false);
  });
});

describe('resolveLeetcodeProfile — values that are not profiles', () => {
  const nonProfiles = [
    'https://leetcode.com/settings/profile/',
    'https://leetcode.com/settings/',
    'https://leetcode.com/settings/account/',
    'https://leetcode.com/problemset/',
    'https://leetcode.com/onboarding/?next=%2F',
    'https://leetcode.com/',
  ];

  it.each(nonProfiles)('refuses to treat %s as a profile', (value) => {
    const result = resolveLeetcodeProfile(value);
    expect(result.username).toBeNull();
    expect(result.profileUrl).toBeNull();
    expect(result.needsVerification).toBe(true);
    expect(hasUsableProfile(result)).toBe(false);
  });

  it('keeps the raw value so an admin can see what was actually entered', () => {
    expect(resolveLeetcodeProfile('https://leetcode.com/problemset/').rawValue).toBe(
      'https://leetcode.com/problemset/',
    );
  });

  it('does not invent a handle from a URL containing a space', () => {
    // `Ananya _sharma` could plausibly be repaired to `Ananya_sharma` or to `Ananya`.
    // Picking either would be inventing a handle, so it stays null.
    const result = resolveLeetcodeProfile('https://leetcode.com/u/Ananya _sharma/');
    expect(result.username).toBeNull();
    expect(result.needsVerification).toBe(true);
  });

  it('treats an empty value as missing rather than as an error', () => {
    expect(resolveLeetcodeProfile('').resolution).toBe('MISSING');
    expect(resolveLeetcodeProfile(null).resolution).toBe('MISSING');
  });
});

describe('resolveLeetcodeProfile — the ambiguous middle', () => {
  it('reads a handle from a pasted page title but flags it', () => {
    // The shape is `<handle> - LeetCode Profile <link to somewhere else>`. LeetCode wrote
    // the title, so the handle is not invented — but the link goes somewhere we cannot
    // follow, so nothing in the row confirms the handle still resolves.
    const result = resolveLeetcodeProfile(
      'tanvi_200711 - LeetCode Profile https://share.google/aBcDeFgHiJkLmNoPq',
    );
    expect(result).toMatchObject({
      username: 'tanvi_200711',
      resolution: 'DERIVED_FROM_PAGE_TITLE',
      needsVerification: true,
    });
  });

  it('flags a link to another host with no title beside it', () => {
    const result = resolveLeetcodeProfile('https://share.google/aBcDeFgHiJkLmNoPq');
    expect(result.username).toBeNull();
    expect(result.resolution).toBe('FOREIGN_URL');
  });
});

describe('identity and squad normalisation', () => {
  it('lowercases and trims email as the canonical identity', () => {
    expect(normaliseEmail('  Rahul.Verma.s.142@Kalvium.Community ')).toBe(
      'rahul.verma.s.142@kalvium.community',
    );
  });

  it('reads a squad number out of whatever shape it was written in', () => {
    expect(normaliseSquadNumber('144')).toBe(144);
    expect(normaliseSquadNumber('Squad 83')).toBe(83);
    expect(normaliseSquadNumber('squad-146')).toBe(146);
  });

  it('returns null rather than guessing when no number is present', () => {
    expect(normaliseSquadNumber('')).toBeNull();
    expect(normaliseSquadNumber('unknown')).toBeNull();
    expect(normaliseSquadNumber(null)).toBeNull();
  });

  it('recognises programme domains without rejecting anything else', () => {
    expect(isProgrammeEmail('a.b.s.144@kalvium.community')).toBe(true);
    expect(isProgrammeEmail('lakshmi.menon.s.142@gmail.com')).toBe(false);
  });
});

describe('normaliseRoster', () => {
  const row = (
    rowNumber: number,
    name: string,
    email: string,
    squad: string | null,
    leetcode: string | null,
  ): RawRosterRow => ({ rowNumber, name, email, squad, leetcode });

  it('produces exactly one student per email however many times they submitted', () => {
    const result = normaliseRoster([
      row(1, 'Rohan Desai', 'rohan.desai.s.144@kalvium.community', '144', 'https://leetcode.com/u/KiranNair/'),
      row(2, 'Rohan Desai', 'rohan.desai.s.144@kalvium.community', '144', 'https://leetcode.com/u/KiranNair/'),
    ]);

    expect(result.students).toHaveLength(1);
    expect(result.duplicateRows).toHaveLength(1);
    expect(result.duplicateRows[0]).toMatchObject({ rowNumber: 2, firstSeenRow: 1 });
    expect(result.students[0]?.sourceRows).toEqual([1, 2]);
  });

  it('treats differently-cased addresses as the same person', () => {
    const result = normaliseRoster([
      row(1, 'Kavya Reddy', 'kavya.reddy.s83@kalvium.community', '83', 'https://leetcode.com/u/xTpQ8vWzYb/'),
      row(2, 'kavya reddy', 'KAVYA.REDDY.S83@kalvium.community', '83', 'https://leetcode.com/u/xTpQ8vWzYb/'),
    ]);
    expect(result.students).toHaveLength(1);
  });

  it('merges field by field, taking the best of each rather than one whole row', () => {
    // Row 1 has the fuller name but a useless link; row 2 has a real profile but a
    // shorter name. Neither row is right on its own.
    const result = normaliseRoster([
      row(1, 'Vikram Chandra Joshi', 'vikram.joshi.s83@kalvium.community', '83', 'https://leetcode.com/problemset/'),
      row(2, 'Vikram Joshi', 'vikram.joshi.s83@kalvium.community', null, 'https://leetcode.com/u/mKr4nHs6Td/'),
    ]);

    expect(result.students[0]).toMatchObject({
      name: 'Vikram Chandra Joshi',
      squad: 83,
    });
    expect(result.students[0]?.profile.username).toBe('mKr4nHs6Td');
  });

  it('does not let a worse later row overwrite a good earlier one', () => {
    const result = normaliseRoster([
      row(1, 'Meera Pillai', 'meera.pillai.s.145@kalvium.community', '145', 'https://leetcode.com/u/meerap/'),
      row(2, 'M Pillai', 'meera.pillai.s.145@kalvium.community', '145', 'https://leetcode.com/problemset/'),
    ]);
    expect(result.students[0]?.profile.username).toBe('meerap');
    expect(result.students[0]?.name).toBe('Meera Pillai');
  });

  it('keeps a student whose profile could not be read, and flags them', () => {
    const result = normaliseRoster([
      row(1, 'Sanjay Gupta', 'sanjay.gupta.s.146@kalvium.community', '146', 'https://leetcode.com/problemset/'),
    ]);

    // Identity is clear, so the student is preserved — only the handle is missing (§29).
    expect(result.students).toHaveLength(1);
    expect(result.students[0]?.profile.username).toBeNull();
    expect(result.issues.some((issue) => issue.field === 'leetcode')).toBe(true);
  });

  it('imports an off-domain address but raises it for review', () => {
    const result = normaliseRoster([
      row(1, 'lakshmi', 'lakshmi.menon.s.142@gmail.com', '142', 'https://leetcode.com/settings/'),
    ]);

    expect(result.students).toHaveLength(1);
    expect(result.students[0]?.offDomainEmail).toBe(true);
    expect(result.issues.some((issue) => issue.field === 'email')).toBe(true);
  });

  it('rejects only rows that cannot identify anyone at all', () => {
    const result = normaliseRoster([
      row(1, 'No Email', 'not-an-address', '144', null),
      row(2, '', 'nameless.s.144@kalvium.community', '144', null),
    ]);

    expect(result.students).toHaveLength(0);
    expect(result.rejectedRows).toHaveLength(2);
    expect(result.rejectedRows.map((r) => r.field)).toEqual(['email', 'name']);
  });

  it('reports a squad disagreement instead of silently picking one', () => {
    const result = normaliseRoster([
      row(1, 'Someone', 'someone.s.142@kalvium.community', '142', 'https://leetcode.com/u/x1/'),
      row(2, 'Someone', 'someone.s.142@kalvium.community', '143', 'https://leetcode.com/u/x1/'),
    ]);

    expect(result.students[0]?.squad).toBe(142);
    expect(result.issues.some((issue) => issue.field === 'squad')).toBe(true);
  });

  it('counts every source row even the ones it folded away', () => {
    const rows = [
      row(1, 'A', 'a.s.142@kalvium.community', '142', 'https://leetcode.com/u/a/'),
      row(2, 'A', 'a.s.142@kalvium.community', '142', 'https://leetcode.com/u/a/'),
      row(3, 'B', 'b.s.142@kalvium.community', '142', 'https://leetcode.com/u/b/'),
    ];
    const result = normaliseRoster(rows);
    expect(result.totalRows).toBe(3);
    expect(result.students).toHaveLength(2);
    expect(result.duplicateRows).toHaveLength(1);
  });

  it('is order-independent for the count of unique students', () => {
    const rows = [
      row(1, 'A', 'a@kalvium.community', '1', null),
      row(2, 'B', 'b@kalvium.community', '2', null),
      row(3, 'A', 'a@kalvium.community', '1', null),
    ];
    expect(normaliseRoster(rows).students).toHaveLength(2);
    expect(normaliseRoster([...rows].reverse()).students).toHaveLength(2);
  });
});
