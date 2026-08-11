'use client';

/**
 * Application chrome: sidebar navigation, theme toggle, sync button, command palette.
 *
 * The shell also owns the auth gate — an unauthenticated visitor is redirected here
 * rather than in every page, so a new page cannot accidentally ship unprotected.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Command } from 'cmdk';
import { toast } from 'sonner';
import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  ListChecks,
  Mail,
  Moon,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Trophy,
  Users,
} from 'lucide-react';

import { api, tokenStore } from '@/lib/api';
import { cn, initials, timeAgo } from '@/lib/utils';
import { Badge, Button } from './ui';

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/mentor', label: 'Mentor View', icon: ListChecks },
  { href: '/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/students', label: 'Students', icon: Users },
  { href: '/assignments', label: 'Assignments', icon: CalendarDays },
  { href: '/email-reports', label: 'Email Reports', icon: Mail },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/admin', label: 'Admin', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [checkedAuth, setCheckedAuth] = useState(false);

  // Auth gate. Runs client-side because tokens live in localStorage.
  useEffect(() => {
    if (!tokenStore.access) {
      router.replace('/login');
      return;
    }
    setCheckedAuth(true);
  }, [router]);

  // Command palette: Cmd/Ctrl-K, the shortcut every tool of this kind has.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: checkedAuth,
  });

  const { data: latestSync } = useQuery({
    queryKey: ['sync', 'latest'],
    queryFn: api.latestSync,
    enabled: checkedAuth,
    // Keeps the "last synced" label and any running progress bar honest.
    refetchInterval: 15_000,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.startSync({ mode: 'INCREMENTAL' }),
    onSuccess: (job) => {
      toast.success('Sync started', {
        description: `Checking ${job.totalStudents} students against LeetCode.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (error: Error) => toast.error('Could not start sync', { description: error.message }),
  });

  if (!checkedAuth) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="skeleton size-10 rounded-full" />
      </div>
    );
  }

  const isRunning =
    latestSync?.status === 'RUNNING' || latestSync?.status === 'QUEUED';

  return (
    <div className="flex min-h-screen">
      {/* Sidebar. Hidden on small screens; the top bar carries navigation there. */}
      <aside className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface-raised)] lg:flex lg:flex-col">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="grid size-8 place-items-center rounded-lg bg-[var(--color-brand)] text-sm font-bold text-[var(--color-brand-fg)]">
            DS
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">DSA Tracker</p>
            <p className="truncate text-xs text-[var(--color-fg-subtle)]">Kalvium</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-2">
          {NAV.map((item) => {
            const active = pathname === item.href;
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
              <p className="truncate text-xs text-[var(--color-fg-subtle)]">{user?.role}</p>
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
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]/90 px-4 py-2.5 backdrop-blur">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex flex-1 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg-subtle)] transition hover:border-[var(--color-border-strong)] sm:max-w-sm"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="hidden rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] sm:inline">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-2">
            {latestSync ? (
              <Badge tone={isRunning ? 'info' : latestSync.failedStudents > 0 ? 'warning' : 'success'}>
                {isRunning
                  ? `Syncing ${latestSync.progressPercent}%`
                  : `Synced ${timeAgo(latestSync.finishedAt)}`}
              </Badge>
            ) : null}

            <Button
              variant="primary"
              onClick={() => syncMutation.mutate()}
              loading={syncMutation.isPending || isRunning}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Sync</span>
            </Button>

            <ThemeToggle />
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Rendering a theme-dependent icon before hydration causes a mismatch, so the
  // button renders a neutral placeholder until mounted.
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

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');

  const { data: students } = useQuery({
    queryKey: ['students', 'palette', search],
    queryFn: () => api.students({ search, pageSize: 8 }),
    // Only search once the term is worth a round trip.
    enabled: open && search.length >= 2,
  });

  if (!open) return null;

  const go = (href: string): void => {
    onOpenChange(false);
    setSearch('');
    router.push(href);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <Command
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        shouldFilter={false}
        label="Command palette"
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Search students or jump to a page…"
          className="w-full border-b border-[var(--color-border)] bg-transparent px-4 py-3 text-sm outline-none placeholder:text-[var(--color-fg-subtle)]"
        />
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
            {search.length >= 2 ? 'No matches found.' : 'Type at least two characters to search.'}
          </Command.Empty>

          <Command.Group
            heading="Pages"
            className="px-2 py-1 text-xs font-medium text-[var(--color-fg-subtle)]"
          >
            {NAV.filter((item) =>
              item.label.toLowerCase().includes(search.toLowerCase()),
            ).map((item) => (
              <Command.Item
                key={item.href}
                onSelect={() => go(item.href)}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-fg)] data-[selected=true]:bg-[var(--color-brand-soft)]"
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Command.Item>
            ))}
          </Command.Group>

          {students && students.items.length > 0 ? (
            <Command.Group
              heading="Students"
              className="px-2 py-1 text-xs font-medium text-[var(--color-fg-subtle)]"
            >
              {students.items.map((student) => (
                <Command.Item
                  key={student.id}
                  onSelect={() => go(`/students/${student.id}`)}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2 text-sm text-[var(--color-fg)] data-[selected=true]:bg-[var(--color-brand-soft)]"
                >
                  <span className="truncate">{student.name}</span>
                  <span className="shrink-0 text-xs text-[var(--color-fg-subtle)]">
                    {student.squadName ?? student.leetcodeUsername}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command>
    </div>
  );
}
