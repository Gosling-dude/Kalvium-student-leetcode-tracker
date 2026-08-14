/**
 * CSPRNG password generation, shared by every path that hands someone a one-time
 * password rather than letting them choose one (student provisioning/reset, the admin
 * deployment-secret recovery path). Never `Math.random`, never a predictable value
 * (email, name, id) — see the callers' own doc comments for why that matters.
 */

import { randomInt } from 'node:crypto';

const LOWER = 'abcdefghjkmnpqrstuvwxyz'; // i/l/o excluded — visually ambiguous when handed over verbally or on paper
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789'; // 0/1 excluded for the same reason
const ALL = LOWER + UPPER + DIGITS;
const TEMP_PASSWORD_LENGTH = 14;

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!;
}

/** Fisher–Yates using a CSPRNG, so the three guaranteed-class characters aren't always
 *  in the first three positions of the string. */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Satisfies `PasswordPolicy` (lower + upper + digit, 10+ chars) by construction. */
export function generateTempPassword(): string {
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  const rest = Array.from({ length: TEMP_PASSWORD_LENGTH - required.length }, () => pick(ALL));
  return shuffle([...required, ...rest]).join('');
}
