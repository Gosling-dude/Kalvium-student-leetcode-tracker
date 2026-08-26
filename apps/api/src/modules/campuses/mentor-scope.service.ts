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

import { Injectable } from '@nestjs/common';
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
