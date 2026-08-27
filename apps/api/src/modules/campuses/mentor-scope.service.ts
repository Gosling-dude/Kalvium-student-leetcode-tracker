/**
 * Which campuses a given user may read.
 *
 * The one place that question is answered, so no endpoint can arrive at a different
 * conclusion than another about the same mentor.
 *
 * The contract is deliberately a *nullable* list rather than an array that happens to be
 * empty when unrestricted. `null` means "no restriction" and `[]` means "nothing" — with a
 * plain array those two collapse into the same value, and the direction they collapse in
 * decides whether a bug shows an admin nothing or shows a mentor everything. Naming them
 * apart is what keeps `[]` from being read as "don't filter".
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { UserRole } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';

/** `null` = unrestricted. `[]` = no campuses, therefore no students. */
export type CampusScope = string[] | null;

@Injectable()
export class MentorScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async allowedCampusIds(user: { id: string; role: UserRole }): Promise<CampusScope> {
    // Admins are unrestricted by definition; VIEWER predates campus scoping and keeps its
    // existing read-everything behaviour, which is a reporting role with no student PII
    // surface of its own. STUDENT never reaches these endpoints at all — `RolesGuard`
    // denies students on anything not explicitly opened to them.
    if (user.role !== 'MENTOR') return null;

    const grants = await this.prisma.mentorCampus.findMany({
      where: { userId: user.id },
      select: { campusId: true },
    });
    return grants.map((grant) => grant.campusId);
  }

  /**
   * The campus filter to apply, given what the caller asked for and what they may see.
   *
   * Returns `{ deny: true }` when the caller explicitly asked for a campus they have no
   * grant on. That is answered as an empty result rather than a 403 on purpose: a mentor
   * probing campus ids should not be able to tell "this campus exists and you may not see
   * it" from "no such campus".
   */
  narrow(
    requestedCampusId: string | null | undefined,
    allowed: CampusScope,
  ): { campusId?: string; campusIds?: string[]; deny?: true } {
    if (allowed === null) {
      return requestedCampusId ? { campusId: requestedCampusId } : {};
    }
    if (allowed.length === 0) return { deny: true };

    if (requestedCampusId) {
      return allowed.includes(requestedCampusId) ? { campusId: requestedCampusId } : { deny: true };
    }
    return { campusIds: allowed };
  }

  /**
   * The campus scope a *reporting* request must run under, given who is asking and what
   * they asked for.
   *
   * The difference from `narrow` is what "no campus named" means. On the student
   * directory it means "every campus you may see", and the caller passes `campusIds` to a
   * query that knows how to filter by a list. The dashboard, leaderboard and report
   * aggregates have no such list parameter — they take one `campusId`, where `null` means
   * *every campus in the system*. So for them "no campus named" cannot be left as `null`
   * for a mentor: that is precisely the value that returns the whole programme.
   *
   * A mentor with exactly one grant is therefore pinned to it, which is the case that
   * matters — every mentor today has one campus, and the request their browser sends on
   * page load names no campus at all.
   *
   * Returns `deny` when the answer cannot be expressed as a single campus id: a mentor
   * with no grants (nothing to show) or with several and no choice made between them.
   * Answering the multi-grant case with the whole programme would be a silent widening,
   * and these endpoints have no way to say "these two campuses but not the third".
   */
  reportingScope(
    requestedCampusId: string | null | undefined,
    allowed: CampusScope,
  ): { campusId: string | null } | { deny: true } {
    if (allowed === null) return { campusId: requestedCampusId ?? null };
    if (allowed.length === 0) return { deny: true };

    if (requestedCampusId) {
      // Asking for a campus you have no grant on is answered as "nothing", never as
      // "everything" and never as a 403 — see `narrow` for why not a 403.
      return allowed.includes(requestedCampusId) ? { campusId: requestedCampusId } : { deny: true };
    }

    if (allowed.length === 1) return { campusId: allowed[0]! };
    return { deny: true };
  }

  /**
   * Refuse unless this user may act on something belonging to `campusId`.
   *
   * For entities that *carry* a campus — an assignment, a baseline test, a squad — rather
   * than for a filter. Reading or editing one by id bypasses every list-level filter, so
   * the id has to be checked against the grants directly.
   *
   * Raises `NotFoundException` rather than `ForbiddenException`, and with the same message
   * a genuinely missing row produces. A 403 would confirm the row exists, which turns
   * sequential ids into a map of what every other campus has.
   *
   * `campusId: null` means the entity belongs to no campus in particular — an assignment
   * targeted at the whole programme. Those are readable by everyone (they were given to
   * everyone) but writable only by an admin, which is the `write` flag.
   */
  assertCampusAllowed(
    campusId: string | null,
    allowed: CampusScope,
    options: { entity: string; id: string; write?: boolean },
  ): void {
    if (allowed === null) return;

    if (campusId === null) {
      if (!options.write) return;
      throw new NotFoundException(`${options.entity} ${options.id} was not found`);
    }

    if (!allowed.includes(campusId)) {
      throw new NotFoundException(`${options.entity} ${options.id} was not found`);
    }
  }

  /**
   * The campus a mentor's *write* must land on, given what they asked for.
   *
   * Distinct from `reportingScope` because "no campus named" cannot be answered by pinning
   * here: creating an assignment with no campus targets the entire programme, which is a
   * thing only an admin may do. A mentor must name a campus they hold.
   */
  assertCanWriteCampus(campusId: string | null, allowed: CampusScope): void {
    if (allowed === null) return;

    if (campusId === null) {
      throw new ForbiddenException(
        'Only an admin can target every campus at once. Choose one of your campuses.',
      );
    }
    if (!allowed.includes(campusId)) {
      throw new ForbiddenException('You do not have access to that campus.');
    }
  }

  /** True when this user may read a student sitting at `campusId`. */
  canSeeCampus(campusId: string | null, allowed: CampusScope): boolean {
    if (allowed === null) return true;
    // A student with no campus belongs to no mentor's scope. Treating "unplaced" as
    // "visible to everyone" would make the one group nobody is accountable for the one
    // group everybody can read.
    if (campusId === null) return false;
    return allowed.includes(campusId);
  }
}
