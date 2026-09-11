/**
 * `MentorScopeService` — the one place "which campuses may this caller see" is answered.
 *
 * Every filter bug this suite guards against had the same shape: a list that could not
 * tell "no restriction" from "no campuses", and collapsed the two in whichever direction
 * the code happened to be written. `null` shows a mentor the whole programme; `[]` shows
 * an admin nothing. They are different values here, and these tests are what keeps them
 * that way.
 *
 * The three request shapes are covered separately because the correct answer to "you
 * named no campus" genuinely differs between them:
 *
 *  - `narrow` backs list endpoints, which accept a *set* of campuses, so a mentor naming
 *    none is answered with their grants.
 *  - `reportingScope` backs aggregate endpoints, which take one `campusId` where null
 *    means the whole programme — so "none named" cannot be left null for a mentor.
 *  - `assertCanWriteCampus` backs writes, where "no campus" targets every campus at once
 *    and must be refused rather than pinned.
 */

import { describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { MentorScopeService } from './mentor-scope.service';

const VELS = 'campus-vels';
const SRM = 'campus-srm';
const ALLIANCE = 'campus-alliance';

/** No database is reached by any method under test here. */
const scope = new MentorScopeService({} as never);

describe('narrow — list endpoints, which accept a set of campuses', () => {
  it('leaves an admin unfiltered when they name no campus', () => {
    expect(scope.narrow(undefined, null)).toEqual({});
  });

  it('honours an admin naming one campus', () => {
    expect(scope.narrow(SRM, null)).toEqual({ campusId: SRM });
  });

  it('pins a mentor naming no campus to their grants', () => {
    expect(scope.narrow(undefined, [VELS, SRM])).toEqual({ campusIds: [VELS, SRM] });
  });

  it('honours a mentor naming a campus they hold', () => {
    expect(scope.narrow(VELS, [VELS, SRM])).toEqual({ campusId: VELS });
  });

  it('denies a mentor naming a campus they do not hold', () => {
    // Answered as an empty result rather than a 403 — a 403 would confirm the campus
    // exists, turning ids into a map of the programme.
    expect(scope.narrow(ALLIANCE, [VELS])).toEqual({ deny: true });
  });

  it('denies a mentor with no grants rather than showing them everything', () => {
    // The whole reason the scope is `string[] | null`: with a plain array, `[]` and
    // "unrestricted" are the same value, and this is the case that goes wrong.
    expect(scope.narrow(undefined, [])).toEqual({ deny: true });
    expect(scope.narrow(VELS, [])).toEqual({ deny: true });
  });
});

describe('reportingScope — aggregates, which take exactly one campus', () => {
  it('lets an admin mean the whole programme', () => {
    expect(scope.reportingScope(undefined, null)).toEqual({ campusId: null });
  });

  it('pins a single-campus mentor to it when they name none', () => {
    // The case that matters in practice: every mentor today holds one campus, and the
    // request their browser sends on page load names no campus at all. Left as null this
    // would return the entire programme.
    expect(scope.reportingScope(undefined, [VELS])).toEqual({ campusId: VELS });
  });

  it('refuses to guess for a mentor holding several', () => {
    // These endpoints have no way to say "these two campuses but not the third", and
    // answering with the whole programme would be a silent widening.
    expect(scope.reportingScope(undefined, [VELS, SRM])).toEqual({ deny: true });
  });

  it('honours a multi-campus mentor once they choose', () => {
    expect(scope.reportingScope(SRM, [VELS, SRM])).toEqual({ campusId: SRM });
  });

  it('denies a campus the mentor does not hold, and a mentor with no grants', () => {
    expect(scope.reportingScope(ALLIANCE, [VELS, SRM])).toEqual({ deny: true });
    expect(scope.reportingScope(undefined, [])).toEqual({ deny: true });
  });
});

describe('assertCampusAllowed — entities fetched by their own id', () => {
  it('permits an admin anything', () => {
    expect(() =>
      scope.assertCampusAllowed(SRM, null, { entity: 'Assignment', id: 'a1' }),
    ).not.toThrow();
  });

  it('permits a mentor their own campus', () => {
    expect(() =>
      scope.assertCampusAllowed(VELS, [VELS], { entity: 'Assignment', id: 'a1' }),
    ).not.toThrow();
  });

  it("refuses another campus's entity as 'not found', never 'forbidden'", () => {
    expect(() =>
      scope.assertCampusAllowed(SRM, [VELS], { entity: 'Assignment', id: 'a1' }),
    ).toThrow(NotFoundException);
    expect(() =>
      scope.assertCampusAllowed(SRM, [VELS], { entity: 'Assignment', id: 'a1' }),
    ).toThrow('Assignment a1 was not found');
  });

  it('lets a mentor read a programme-wide entity but not write it', () => {
    // It genuinely applied to their campus, so hiding it would be wrong; editing it
    // changes every campus's work, so that stays admin-only.
    expect(() =>
      scope.assertCampusAllowed(null, [VELS], { entity: 'Assignment', id: 'a1' }),
    ).not.toThrow();
    expect(() =>
      scope.assertCampusAllowed(null, [VELS], { entity: 'Assignment', id: 'a1', write: true }),
    ).toThrow(NotFoundException);
  });
});

describe('assertEntityCampusAllowed — the same, for a lookup that can miss', () => {
  it('answers a missing entity exactly as it answers a forbidden one', () => {
    const missing = () =>
      scope.assertEntityCampusAllowed(undefined, [VELS], { entity: 'Baseline test', id: 'b1' });
    const forbidden = () =>
      scope.assertEntityCampusAllowed(SRM, [VELS], { entity: 'Baseline test', id: 'b1' });

    expect(missing).toThrow('Baseline test b1 was not found');
    expect(forbidden).toThrow('Baseline test b1 was not found');
  });

  it('still refuses a missing entity to an admin, since it does not exist', () => {
    expect(() =>
      scope.assertEntityCampusAllowed(undefined, null, { entity: 'Baseline test', id: 'b1' }),
    ).toThrow(NotFoundException);
  });

  it('permits an entity the caller holds', () => {
    expect(() =>
      scope.assertEntityCampusAllowed(VELS, [VELS], { entity: 'Baseline test', id: 'b1' }),
    ).not.toThrow();
  });
});

describe('assertCanWriteCampus — writes name their target or are refused', () => {
  it('permits an admin to target every campus', () => {
    expect(() => scope.assertCanWriteCampus(null, null)).not.toThrow();
  });

  it('refuses a mentor targeting every campus, even with grants', () => {
    // "No campus" on a write means *all* campuses, which is not a thing a mentor may do.
    // Unlike a read, this is a `Forbidden` with an explanation: the caller is authoring
    // something and needs to know what to change, and no id is being probed.
    expect(() => scope.assertCanWriteCampus(null, [VELS])).toThrow(ForbiddenException);
  });

  it('refuses a campus the mentor does not hold', () => {
    expect(() => scope.assertCanWriteCampus(SRM, [VELS])).toThrow(ForbiddenException);
  });

  it('permits a campus the mentor holds', () => {
    expect(() => scope.assertCanWriteCampus(VELS, [VELS, SRM])).not.toThrow();
  });
});

describe('canSeeCampus', () => {
  it('shows an admin everything, including unplaced students', () => {
    expect(scope.canSeeCampus(SRM, null)).toBe(true);
    expect(scope.canSeeCampus(null, null)).toBe(true);
  });

  it('hides an unplaced student from every mentor', () => {
    // Treating "nobody is accountable for them" as "everybody can see them" would make
    // the one group with no owner the one group with no boundary.
    expect(scope.canSeeCampus(null, [VELS])).toBe(false);
  });

  it('shows a mentor only their own campuses', () => {
    expect(scope.canSeeCampus(VELS, [VELS, SRM])).toBe(true);
    expect(scope.canSeeCampus(ALLIANCE, [VELS, SRM])).toBe(false);
    expect(scope.canSeeCampus(VELS, [])).toBe(false);
  });
});
