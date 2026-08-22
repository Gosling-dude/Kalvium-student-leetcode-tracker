'use client';

/**
 * Student portal chrome — deliberately not `AppShell`. Same design tokens (brand color,
 * surfaces, radii) so it still reads as "DSA Tracker", but a different, smaller nav and
 * no admin/mentor affordances anywhere in the tree: no Sync button, no Students/
 * Assignments-management/Email Reports/Admin links, no command palette that can jump to
 * another student's page. What a student can reach here is exactly what §6 lists.
 *
 * Owns its own auth gate, same pattern as `AppShell`: an unauthenticated visitor goes to
 * `/login`, and a non-STUDENT role (admin/mentor testing a link, a stale bookmark) is
 * sent back to the console they actually belong to — the backend enforces this too, this
 * is just so it never shows a screen the visitor cannot use.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import {
  CalendarCheck,
  ClipboardCheck,
  LayoutDashboard,
  LineChart,
  Moon,
  Sun,
  Trophy,
  UserRound,
} from 'lucide-react';

import { api, tokenStore } from '@/lib/api';
import { cn, initials } from '@/lib/utils';
import { Button } from './ui';

const NAV = [
  { href: '/student', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/student/assignments', label: 'Assignments', icon: CalendarCheck },
  { href: '/student/baseline-tests', label: 'Baseline Tests', icon: ClipboardCheck },
  { href: '/student/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/student/progress', label: 'My Progress', icon: LineChart },
  { href: '/student/profile', label: 'Profile', icon: UserRound },
];

export function StudentShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [checkedAuth, setCheckedAuth] = useState(false);

  useEffect(() => {
    if (!tokenStore.access) {
      router.replace('/login');
      return;
    }
    setCheckedAuth(true);
  }, [router]);

  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: checkedAuth,
  });

  useEffect(() => {
    // Not a student at all — send them to the console they actually have.
    if (user && user.role !== 'STUDENT') router.replace('/');
  }, [user, router]);

  if (!checkedAuth || (user && user.role !== 'STUDENT')) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="skeleton size-10 rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-raised)] lg:flex lg:flex-col">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="grid size-8 place-items-center rounded-lg bg-[var(--color-brand)] text-sm font-bold text-[var(--color-brand-fg)]">
            DS
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">DSA Tracker</p>
            <p className="truncate text-xs text-[var(--color-fg-subtle)]">Student</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-2">
          {NAV.map((item) => {
            const active = item.href === '/student' ? pathname === item.href : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
                  active
                    ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-fg)]',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--color-border)] p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-surface-sunken)] text-xs font-semibold">
              {user ? initials(user.name) : '··'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{user?.name ?? 'Loading…'}</p>
              <p className="truncate text-xs text-[var(--color-fg-subtle)]">{user?.email}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start text-xs text-[var(--color-fg-muted)]"
            onClick={() => {
              const refresh = tokenStore.refresh;
              if (refresh) void api.logout(refresh).catch(() => undefined);
              tokenStore.clear();
              router.replace('/login');
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2">
            <div className="grid size-7 place-items-center rounded-lg bg-[var(--color-brand)] text-xs font-bold text-[var(--color-brand-fg)]">
              DS
            </div>
            <p className="text-sm font-semibold">DSA Tracker</p>
          </div>
          <ThemeToggle />
        </header>

        {/* Mobile/tablet nav — the sidebar is desktop-only, so small screens get a top
            scroll strip instead of a hidden drawer, matching the "keep it simple" brief. */}
        <nav className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 lg:hidden">
          {NAV.map((item) => {
            const active = item.href === '/student' ? pathname === item.href : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  active
                    ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-sunken)]',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <header className="sticky top-0 z-10 hidden items-center justify-end border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]/90 px-4 py-2.5 backdrop-blur lg:flex">
          <ThemeToggle />
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Button
      variant="ghost"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {mounted && resolvedTheme === 'dark' ? (
        <Sun className="size-4" aria-hidden />
      ) : (
        <Moon className="size-4" aria-hidden />
      )}
    </Button>
  );
}
