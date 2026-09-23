/**
 * The Coding-Hours Daily Report — a wide, date-wise submission matrix, one row per
 * active student across the campuses this caller may see, one column per day that had a
 * real `DailyStatus` row (never an invented "0 assigned" day). Deliberately its own file,
 * not an extension of `campus-analysis.ts`: that file's `StudentAnalysis` already
 * supplies the category/campus/batch/squad a row needs, and this type only adds the
 * day-by-day matrix shape on top of it, mirroring `infosys-analysis.ts`'s
 * `InfosysDailyReport*` types for exactly the reason those exist — the on-screen table
 * and the Excel export read from one function's output, so they cannot disagree.
 */

import type { CampusCategory } from './campus-analysis';
import type { DayKey } from './time';

export interface CampusDailyReportDay {
  dayKey: DayKey;
  weekNumber: number;
  /** Distinct problems assigned this day, to *this report's filtered student set* —
   * never students x problems, and never a count assuming every student in the report
   * shared one identical assignment (Coding Hours assigns per campus/batch audience,
   * unlike Infosys's one-set-for-everyone model). */
  assignedCount: number;
}

export interface CampusDailyReportWeek {
  weekNumber: number;
  label: string;
  days: DayKey[];
}

export interface CampusDailyReportRow {
  rank: number;
  studentId: string;
  name: string;
  /** e.g. "VELS", "SRM", "ALLIANCE" — the same code the campus picker and every other
   * Coding-Hours screen already display, not the full institution name. */
  campusCode: string | null;
  batch: string | null;
  squad: string | null;
  category: CampusCategory;
  leetcodeUsername: string | null;
  leetcodeUrl: string | null;
  daily: Record<string, number>;
  total: number;
}

export interface CampusDailyReportResponse {
  asOf: DayKey;
  trackingStart: DayKey | null;
  days: CampusDailyReportDay[];
  weeks: CampusDailyReportWeek[];
  /** Sorted by Total Solved descending, student name ascending as the tiebreak. */
  rows: CampusDailyReportRow[];
}
