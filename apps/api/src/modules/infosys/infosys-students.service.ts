/**
 * Editing an Infosys student's own record — the interactive counterpart to the one-off
 * `infosys-profile-update-*.ts` scripts, with the same safety rules enforced at request
 * time instead of read from a hardcoded table:
 *
 *  - A LeetCode profile is never trusted on format alone: the extracted username is
 *    checked against the live LeetCode API before it is saved (§2 of the program brief).
 *  - A valid existing profile is never silently overwritten by blank/invalid input.
 *  - A username already claimed by another student is refused, not reassigned.
 *  - `Student.leetcodeUsername`/`name`/`email` are Coding-Hours-owned fields (see the
 *    schema.prisma section banner above `InfosysEnrollment`); this endpoint only ever
 *    touches them for a student who is genuinely Infosys-only — an `ACTIVE`
 *    Coding-Hours student is refused outright, exactly like the profile-update scripts
 *    refuse via `assertInfosysOnly`-style checks. Edit an active Coding-Hours student
 *    from the Coding Hours Students page, not here.
 *  - A successful profile change immediately triggers `InfosysRollupService.recomputeStudent`
 *    so the student's whole Infosys history reflects the new profile without a manual
 *    follow-up call (§14).
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { resolveLeetcodeProfile, type InfosysStudentAnalysis } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { isProviderError, ProviderUserNotFoundError } from '../providers/provider.errors';
import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAnalyticsService } from './infosys-analytics.service';
import type { UpdateInfosysStudentDto } from './dto/infosys-student.dto';

@Injectable()
export class InfosysStudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollup: InfosysRollupService,
    private readonly analytics: InfosysAnalyticsService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  async update(studentId: string, dto: UpdateInfosysStudentDto): Promise<InfosysStudentAnalysis> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: { infosysEnrollment: true },
    });
    if (!student || !student.infosysEnrollment) {
      throw new NotFoundException('No active Infosys student with this id.');
    }
    if (student.status === 'ACTIVE') {
      throw new ForbiddenException(
        'This student has an active Coding-Hours record — edit their details from the Coding Hours Students page, not from Infosys Preparation.',
      );
    }

    const data: { name?: string; email?: string; leetcodeUsername?: string | null } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('name cannot be blank.');
      data.name = name;
    }

    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      const existing = await this.prisma.student.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, id: { not: studentId } },
        select: { id: true },
      });
      if (existing) throw new ConflictException(`${email} is already used by another student.`);
      data.email = email;
    }

    if (dto.campusId !== undefined) {
      const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId } });
      if (!campus) throw new BadRequestException(`No campus with id ${dto.campusId}.`);
      await this.prisma.infosysEnrollment.update({
        where: { studentId },
        data: { campusId: dto.campusId },
      });
    }

    let profileChanged = false;
    if (dto.leetcodeProfileUrl !== undefined) {
      const raw = dto.leetcodeProfileUrl.trim();

      if (raw === '') {
        // Explicit clear — the only way a valid profile may be blanked (§ never silently).
        if (student.leetcodeUsername) {
          data.leetcodeUsername = null;
          profileChanged = true;
        }
      } else {
        const resolved = resolveLeetcodeProfile(raw);
        if (!resolved.username) {
          throw new BadRequestException(
            `"${raw}" could not be read as a LeetCode profile URL or handle. Expected a link like https://leetcode.com/u/<handle>/.`,
          );
        }

        const current = student.leetcodeUsername;
        if (current && current.toLowerCase() === resolved.username.toLowerCase()) {
          // No-op — already this username, no need to re-verify or recompute.
        } else {
          const conflict = await this.prisma.student.findFirst({
            where: { leetcodeUsername: { equals: resolved.username, mode: 'insensitive' }, id: { not: studentId } },
            select: { id: true, name: true, email: true },
          });
          if (conflict) {
            throw new ConflictException(
              `"${resolved.username}" is already assigned to ${conflict.name} (${conflict.email ?? 'no email'}) — not written.`,
            );
          }

          try {
            await this.provider.fetchUserProfile(resolved.username);
          } catch (error) {
            if (error instanceof ProviderUserNotFoundError) {
              throw new BadRequestException(`"${resolved.username}" does not resolve on LeetCode — not saved.`);
            }
            if (isProviderError(error)) {
              throw new ServiceUnavailableException(
                `Could not verify "${resolved.username}" against LeetCode right now (${error.message}). Try again shortly.`,
              );
            }
            throw error;
          }

          data.leetcodeUsername = resolved.username;
          profileChanged = true;
        }
      }
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.student.update({ where: { id: studentId }, data });
    }

    if (profileChanged) {
      // Force the next sync to treat this as a fresh profile, then immediately recompute
      // this student's whole Infosys history against it (§14) — no manual follow-up call.
      await this.prisma.studentSyncState.updateMany({
        where: { studentId },
        data: { providerProfileFetchedAt: null },
      });
      await this.rollup.recomputeStudent(studentId);
    }

    const updated = await this.analytics.studentAnalysisFor(studentId);
    if (!updated) throw new NotFoundException('No active Infosys student with this id.');
    return updated;
  }
}
