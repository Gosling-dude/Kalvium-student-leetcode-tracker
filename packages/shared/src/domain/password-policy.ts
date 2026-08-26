/**
 * The password policy, as one pure rule.
 *
 * It exists here rather than only as `class-validator` decorators on the DTO because the
 * DTO is not the only place a password is set. `SEED_STUDENT_PASSWORD` is read from the
 * environment at boot and handed to every student account created from then on — if that
 * value is weak, the DTO never sees it and 250 accounts get provisioned below the policy
 * the same system enforces on every password a person chooses.
 *
 * Returns the reason it fails, so a caller can say *why* rather than "invalid password".
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/** `null` when the password satisfies the policy; otherwise the first rule it breaks. */
export function passwordPolicyViolation(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  if (!/[a-z]/.test(password)) return 'must contain a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'must contain an uppercase letter';
  if (!/[0-9]/.test(password)) return 'must contain a digit';
  return null;
}

export function satisfiesPasswordPolicy(password: string): boolean {
  return passwordPolicyViolation(password) === null;
}
