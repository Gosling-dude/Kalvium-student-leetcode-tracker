/**
 * Roster normalisation — turning a collected spreadsheet into importable students.
 *
 * A roster gathered through a form is never clean. The SRM intake arrived with 99 rows
 * for 92 people, seven of them submitted twice, and roughly one field in seven pointing
 * at something that is not a LeetCode profile: `/settings/`, `/problemset/`,
 * `/onboarding/`, the bare homepage, a Google share link, a page *title* pasted whole.
 *
 * The rule this module exists to enforce is that **a guess is worse than a gap** (§29).
 * A student whose handle we could not determine is imported with `leetcodeUsername =
 * null` and surfaces in "Profile needs verification", where a human fixes it in seconds.
 * A student whose handle we *invented* looks fine, syncs as `USER_NOT_FOUND` forever,
 * and reads to their mentor as "solved nothing". So nothing here strips a space out of a
 * handle to make it parse, and nothing derives a handle from an email local-part.
 *
 * Pure: no I/O. The importer supplies rows and decides what to do with the report.
 */

/** One raw row, exactly as read from the source file. */
export interface RawRosterRow {
  /** 1-based line number in the source, for error messages a human can act on. */
  rowNumber: number;
  name: string;
  email: string;
  squad: string | null;
  leetcode: string | null;
}

/**
 * Why a LeetCode value could not be used, or how it was recovered.
 *
 * These are reported per student and drive the admin data-quality list. They are
 * observations about the *source data*, never about the student.
 */
export type ProfileResolution =
  /** A canonical `/u/<handle>/` profile URL was supplied. */
  | 'PROFILE_URL'
  /** A bare handle was supplied and expanded into a profile URL. */
  | 'BARE_USERNAME'
  /** A profile URL was embedded in surrounding text and extracted. */
  | 'EXTRACTED_FROM_TEXT'
  /**
   * Only LeetCode's page *title* (`handle - LeetCode Profile`) was pasted, with no
   * usable URL beside it. The handle is taken from the title because LeetCode wrote that
   * string, not the student — but it is unconfirmed, so it is flagged for verification.
   */
  | 'DERIVED_FROM_PAGE_TITLE'
  /** The value points at a real LeetCode page that is not a profile. */
  | 'NON_PROFILE_URL'
  /** The value is a URL on some other host entirely. */
  | 'FOREIGN_URL'
  /** Something was supplied but it is not a handle and not a URL we can read. */
  | 'UNRECOGNISED'
  /** The field was empty. */
  | 'MISSING';

export interface ResolvedProfile {
  username: string | null;
  profileUrl: string | null;
  resolution: ProfileResolution;
  /** True when a human should confirm this before trusting a sync result. */
  needsVerification: boolean;
  /** The value as supplied, kept verbatim so an admin can see what was actually entered. */
  rawValue: string | null;
}

/**
 * LeetCode handles: letters, digits, underscore and hyphen, 1–39 characters.
 *
 * Deliberately strict. `Ananya _sharma` contains a space and therefore fails — and
 * that is the correct outcome, not a bug to work around by deleting the space, because
 * `Ananya_sharma` and `Ananya` are both plausible repairs and picking one would
 * be inventing a handle.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

/**
 * `https://leetcode.com/u/<handle>` — the only URL shape that names a profile.
 *
 * The capture deliberately grabs the *whole* path segment (everything up to the next
 * `/`, `?`, `#` or end of string) and validates it afterwards, rather than matching only
 * handle-shaped characters. A pattern that matched greedily-but-narrowly would read
 * `leetcode.com/u/Ananya _sharma/` as the handle `Ananya` — silently truncating
 * at the space and inventing an account that may not exist. Capturing the segment whole
 * means a malformed one fails validation and the student is flagged instead.
 */
const PROFILE_URL_PATTERN = /leetcode\.com\/u\/([^/?#\n\r]*)/i;

/**
 * The routes people reach for when asked for "your LeetCode profile link" and copy the
 * address bar instead. Each is a real LeetCode page, which is why a naive
 * "does it contain leetcode.com" check accepts all of them.
 */
const NON_PROFILE_PATH_PATTERN =
  /leetcode\.com\/(?:settings|problemset|problems|onboarding|contest|discuss|explore|profile|accounts|u)?\/?(?:[?#].*)?$/i;

/** `someHandle - LeetCode Profile` — LeetCode's own `<title>`, pasted whole. */
const PAGE_TITLE_PATTERN = /^([A-Za-z0-9_-]{1,39})\s+-\s+LeetCode\s+Profile\b/i;

export function leetcodeProfileUrlFor(username: string): string {
  return `https://leetcode.com/u/${username}/`;
}

/**
 * Resolve whatever was pasted into the LeetCode column into a handle, or into nothing.
 *
 * Order matters. An embedded profile URL is checked before the page-title pattern so
 * that `handle - LeetCode Profile https://leetcode.com/u/handle/` resolves from the URL
 * (confirmed) rather than from the title (unconfirmed), even though both are present.
 */
export function resolveLeetcodeProfile(raw: string | null | undefined): ResolvedProfile {
  const value = (raw ?? '').trim();
  if (value === '') {
    return {
      username: null,
      profileUrl: null,
      resolution: 'MISSING',
      needsVerification: true,
      rawValue: null,
    };
  }

  const looksLikeUrl = /https?:\/\//i.test(value) || /\b[\w-]+\.[a-z]{2,}\//i.test(value);

  // 1 & 2 — a canonical profile URL, whether it stands alone or sits inside a sentence.
  // The captured segment must be a valid handle *in full*; a segment containing a space
  // or any other stray character is malformed and falls through to the flagged paths
  // below rather than being trimmed into something that parses.
  const profileMatch = PROFILE_URL_PATTERN.exec(value);
  const candidate = profileMatch?.[1]?.trim() ?? '';
  if (candidate !== '' && USERNAME_PATTERN.test(candidate)) {
    const username = candidate;
    const standalone = /^https?:\/\/(?:www\.)?leetcode\.com\/u\/[A-Za-z0-9_-]{1,39}\/?$/i.test(
      value,
    );
    return {
      username,
      profileUrl: leetcodeProfileUrlFor(username),
      resolution: standalone ? 'PROFILE_URL' : 'EXTRACTED_FROM_TEXT',
      needsVerification: false,
      rawValue: value,
    };
  }

  // 4 — a LeetCode URL that is not a profile. Never treated as one.
  if (/leetcode\.com/i.test(value)) {
    return {
      username: null,
      profileUrl: null,
      resolution: NON_PROFILE_PATH_PATTERN.test(value) ? 'NON_PROFILE_URL' : 'UNRECOGNISED',
      needsVerification: true,
      rawValue: value,
    };
  }

  // A link to somewhere else entirely — a Google share redirect, say. We cannot follow it
  // from a pure function and will not assume where it lands, but the row may still carry
  // LeetCode's page title beside it, which the next check picks up.
  const titleMatch = PAGE_TITLE_PATTERN.exec(value);
  if (titleMatch?.[1]) {
    const username = titleMatch[1];
    return {
      username,
      profileUrl: leetcodeProfileUrlFor(username),
      resolution: 'DERIVED_FROM_PAGE_TITLE',
      // Flagged even though a handle was produced: LeetCode wrote the title, but nothing
      // in the row confirms the handle still resolves.
      needsVerification: true,
      rawValue: value,
    };
  }

  if (looksLikeUrl) {
    return {
      username: null,
      profileUrl: null,
      resolution: 'FOREIGN_URL',
      needsVerification: true,
      rawValue: value,
    };
  }

  // 3 — a bare handle.
  if (USERNAME_PATTERN.test(value)) {
    return {
      username: value,
      profileUrl: leetcodeProfileUrlFor(value),
      resolution: 'BARE_USERNAME',
      needsVerification: false,
      rawValue: value,
    };
  }

  return {
    username: null,
    profileUrl: null,
    resolution: 'UNRECOGNISED',
    needsVerification: true,
    rawValue: value,
  };
}

/** Canonical student identity. Everything in the importer keys off this and only this. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `144`, `Squad 83`, `squad-146` → `144`, `83`, `146`.
 *
 * Returns null when no number is present rather than guessing, so a squad-less student
 * imports with no squad instead of a fabricated one.
 */
export function normaliseSquadNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = /(\d{1,6})/.exec(raw.trim());
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

/** Display form of a squad number, used for `Squad.name`. */
export function squadName(squadNumber: number): string {
  return `Squad ${squadNumber}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A domain the programme issues addresses on. Anything else is imported but flagged. */
export const KALVIUM_EMAIL_DOMAINS = ['kalvium.community', 'kalvium.com'] as const;

export function isProgrammeEmail(email: string): boolean {
  const domain = normaliseEmail(email).split('@')[1] ?? '';
  return (KALVIUM_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

/** One person, after every row bearing their email has been folded together. */
export interface NormalisedRosterStudent {
  email: string;
  name: string;
  squad: number | null;
  profile: ResolvedProfile;
  /** Every source line that carried this email, in file order. */
  sourceRows: number[];
  /** True when the address is outside the programme's domains — imported, but flagged. */
  offDomainEmail: boolean;
}

export interface RosterRowIssue {
  rowNumber: number;
  email: string;
  field: 'email' | 'name' | 'leetcode' | 'squad';
  message: string;
}

export interface NormalisedRoster {
  students: NormalisedRosterStudent[];
  /** Rows dropped as exact repeats of an email already seen. */
  duplicateRows: { rowNumber: number; email: string; firstSeenRow: number }[];
  /** Rows that could not be turned into a student at all (no usable email). */
  rejectedRows: RosterRowIssue[];
  /** Non-fatal observations worth an admin's attention. */
  issues: RosterRowIssue[];
  totalRows: number;
}

/**
 * Fold raw rows into one student per email.
 *
 * "Most complete valid information wins" is applied field by field rather than
 * row-by-row, because the fullest row is rarely the same one for every column. Someone
 * who submitted twice may have given their proper name the first time and a working
 * profile link the second; taking either row wholesale would discard half of what they
 * told us. So: a resolvable profile beats an unresolvable one, a longer name beats a
 * shorter one, and a present squad beats a missing one — regardless of which line each
 * came from.
 *
 * Later rows do not otherwise overwrite earlier ones. A second submission that is
 * strictly worse than the first changes nothing.
 */
export function normaliseRoster(rows: readonly RawRosterRow[]): NormalisedRoster {
  const byEmail = new Map<string, NormalisedRosterStudent>();
  const firstRowForEmail = new Map<string, number>();
  const duplicateRows: NormalisedRoster['duplicateRows'] = [];
  const rejectedRows: RosterRowIssue[] = [];
  const issues: RosterRowIssue[] = [];

  for (const row of rows) {
    const email = normaliseEmail(row.email ?? '');
    const name = (row.name ?? '').trim();

    if (!EMAIL_PATTERN.test(email)) {
      rejectedRows.push({
        rowNumber: row.rowNumber,
        email,
        field: 'email',
        message: `"${row.email}" is not a usable email address, so this row cannot identify a student.`,
      });
      continue;
    }

    if (name === '') {
      rejectedRows.push({
        rowNumber: row.rowNumber,
        email,
        field: 'name',
        message: 'No name supplied; a student cannot be created without one.',
      });
      continue;
    }

    const profile = resolveLeetcodeProfile(row.leetcode);
    const squad = normaliseSquadNumber(row.squad);
    const existing = byEmail.get(email);

    if (!existing) {
      firstRowForEmail.set(email, row.rowNumber);
      byEmail.set(email, {
        email,
        name,
        squad,
        profile,
        sourceRows: [row.rowNumber],
        offDomainEmail: !isProgrammeEmail(email),
      });
      continue;
    }

    duplicateRows.push({
      rowNumber: row.rowNumber,
      email,
      firstSeenRow: firstRowForEmail.get(email) ?? row.rowNumber,
    });
    existing.sourceRows.push(row.rowNumber);

    // Field-by-field merge — see the doc comment.
    if (existing.profile.username === null && profile.username !== null) {
      existing.profile = profile;
    } else if (
      existing.profile.needsVerification &&
      profile.username !== null &&
      !profile.needsVerification
    ) {
      existing.profile = profile;
    }

    if (name.length > existing.name.length) existing.name = name;
    if (existing.squad === null && squad !== null) existing.squad = squad;

    if (squad !== null && existing.squad !== null && squad !== existing.squad) {
      issues.push({
        rowNumber: row.rowNumber,
        email,
        field: 'squad',
        message:
          `Rows disagree about the squad (${existing.squad} vs ${squad}). ` +
          `Kept ${existing.squad} from the first submission — confirm with the student.`,
      });
    }
  }

  const students = [...byEmail.values()];

  for (const student of students) {
    // Always defined: a student is only ever created together with its first source row.
    const firstRow = student.sourceRows[0] ?? 0;

    if (student.profile.needsVerification) {
      issues.push({
        rowNumber: firstRow,
        email: student.email,
        field: 'leetcode',
        message: describeProfileIssue(student.profile),
      });
    }
    if (student.offDomainEmail) {
      issues.push({
        rowNumber: firstRow,
        email: student.email,
        field: 'email',
        message:
          'Address is outside the programme domains. Imported as supplied — confirm it is ' +
          'the right student and, if not, correct it before provisioning a portal account.',
      });
    }
    if (student.squad === null) {
      issues.push({
        rowNumber: firstRow,
        email: student.email,
        field: 'squad',
        message: 'No squad number could be read from the source.',
      });
    }
  }

  return { students, duplicateRows, rejectedRows, issues, totalRows: rows.length };
}

/** Mentor-readable explanation of why a profile needs a human look. */
export function describeProfileIssue(profile: ResolvedProfile): string {
  switch (profile.resolution) {
    case 'MISSING':
      return 'No LeetCode value was supplied.';
    case 'NON_PROFILE_URL':
      return `"${profile.rawValue}" is a LeetCode page but not a profile — ask for the /u/ link.`;
    case 'FOREIGN_URL':
      return `"${profile.rawValue}" points somewhere other than LeetCode.`;
    case 'DERIVED_FROM_PAGE_TITLE':
      return `Handle "${profile.username}" was read from a pasted page title; confirm it resolves.`;
    case 'UNRECOGNISED':
      return `"${profile.rawValue}" is neither a LeetCode profile URL nor a valid handle.`;
    default:
      return 'Profile could not be verified.';
  }
}

/** Whether this resolution produced a handle the sync can actually use. */
export function hasUsableProfile(profile: ResolvedProfile): boolean {
  return profile.username !== null;
}
