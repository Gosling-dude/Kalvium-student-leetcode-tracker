import type { ReactNode } from 'react';
import { StudentShell } from '@/components/student-shell';

/**
 * Route group for the entire student portal — separate from `(app)`'s `AppShell` on
 * purpose (§20). Every page under `/student` is behind this shell's own auth+role gate.
 */
export default function StudentLayout({ children }: { children: ReactNode }) {
  return <StudentShell>{children}</StudentShell>;
}
