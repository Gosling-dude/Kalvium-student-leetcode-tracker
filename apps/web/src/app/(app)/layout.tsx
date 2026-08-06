import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

/**
 * Route squad for every authenticated page. Placing the shell here means a new page
 * added under `(app)` is behind the auth gate by default.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
