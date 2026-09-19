-- CreateEnum
CREATE TYPE "InfosysQuestionStatus" AS ENUM ('SOLVED', 'ATTEMPTED_NOT_SOLVED', 'NOT_ATTEMPTED', 'PROFILE_NOT_LINKED', 'DATA_UNAVAILABLE');

-- CreateTable
CREATE TABLE "infosys_enrollments" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infosys_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infosys_assignments" (
    "id" UUID NOT NULL,
    "dayKey" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infosys_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infosys_assignment_problems" (
    "id" UUID NOT NULL,
    "infosysAssignmentId" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "infosys_assignment_problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infosys_daily_statuses" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "dayKey" TEXT NOT NULL,
    "infosysAssignmentId" UUID,
    "campusId" UUID,
    "assignedCount" INTEGER NOT NULL DEFAULT 0,
    "solvedCount" INTEGER NOT NULL DEFAULT 0,
    "attemptedNotSolvedCount" INTEGER NOT NULL DEFAULT 0,
    "notAttemptedCount" INTEGER NOT NULL DEFAULT 0,
    "profileNotLinkedCount" INTEGER NOT NULL DEFAULT 0,
    "dataUnavailableCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infosys_daily_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infosys_daily_problem_statuses" (
    "id" UUID NOT NULL,
    "infosysDailyStatusId" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "InfosysQuestionStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "solvedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "infosys_daily_problem_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "infosys_enrollments_studentId_key" ON "infosys_enrollments"("studentId");

-- CreateIndex
CREATE INDEX "infosys_enrollments_campusId_idx" ON "infosys_enrollments"("campusId");

-- CreateIndex
CREATE UNIQUE INDEX "infosys_assignments_dayKey_key" ON "infosys_assignments"("dayKey");

-- CreateIndex
CREATE INDEX "infosys_assignments_dayKey_idx" ON "infosys_assignments"("dayKey");

-- CreateIndex
CREATE INDEX "infosys_assignment_problems_problemId_idx" ON "infosys_assignment_problems"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "infosys_assignment_problems_infosysAssignmentId_position_key" ON "infosys_assignment_problems"("infosysAssignmentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "infosys_assignment_problems_infosysAssignmentId_problemId_key" ON "infosys_assignment_problems"("infosysAssignmentId", "problemId");

-- CreateIndex
CREATE INDEX "infosys_daily_statuses_dayKey_idx" ON "infosys_daily_statuses"("dayKey");

-- CreateIndex
CREATE INDEX "infosys_daily_statuses_dayKey_campusId_idx" ON "infosys_daily_statuses"("dayKey", "campusId");

-- CreateIndex
CREATE INDEX "infosys_daily_statuses_studentId_idx" ON "infosys_daily_statuses"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "infosys_daily_statuses_studentId_dayKey_key" ON "infosys_daily_statuses"("studentId", "dayKey");

-- CreateIndex
CREATE INDEX "infosys_daily_problem_statuses_problemId_idx" ON "infosys_daily_problem_statuses"("problemId");

-- CreateIndex
CREATE INDEX "infosys_daily_problem_statuses_status_idx" ON "infosys_daily_problem_statuses"("status");

-- CreateIndex
CREATE UNIQUE INDEX "infosys_daily_problem_statuses_infosysDailyStatusId_problem_key" ON "infosys_daily_problem_statuses"("infosysDailyStatusId", "problemId");

-- AddForeignKey
ALTER TABLE "infosys_enrollments" ADD CONSTRAINT "infosys_enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_enrollments" ADD CONSTRAINT "infosys_enrollments_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_assignments" ADD CONSTRAINT "infosys_assignments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_assignment_problems" ADD CONSTRAINT "infosys_assignment_problems_infosysAssignmentId_fkey" FOREIGN KEY ("infosysAssignmentId") REFERENCES "infosys_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_assignment_problems" ADD CONSTRAINT "infosys_assignment_problems_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_daily_statuses" ADD CONSTRAINT "infosys_daily_statuses_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_daily_statuses" ADD CONSTRAINT "infosys_daily_statuses_infosysAssignmentId_fkey" FOREIGN KEY ("infosysAssignmentId") REFERENCES "infosys_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_daily_statuses" ADD CONSTRAINT "infosys_daily_statuses_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_daily_problem_statuses" ADD CONSTRAINT "infosys_daily_problem_statuses_infosysDailyStatusId_fkey" FOREIGN KEY ("infosysDailyStatusId") REFERENCES "infosys_daily_statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infosys_daily_problem_statuses" ADD CONSTRAINT "infosys_daily_problem_statuses_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
