'use client';

/**
 * The global batch filter: `[All] [Foundation] [Intermediate] …`
 *
 * One component, used on every page that can be scoped to a batch, rather than a copy
 * per page — the batches come from the API, so adding a third batch makes it appear
 * everywhere without touching a single page (§25).
 *
 * The selection is remembered in `sessionStorage` and shared through a context, so
 * moving from the dashboard to the leaderboard keeps the mentor in the batch they were
 * already looking at instead of silently resetting to "All". `sessionStorage` rather
 * than `localStorage` deliberately: a filter is a working state for this sitting, not a
 * durable preference that should still be applied next week.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BatchSummary } from '@dsa/shared';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** `null` means "all batches"; otherwise a batch `code` (`A`, `B`, …). */
export type BatchSelection = string | null;

const STORAGE_KEY = 'dsa.batchFilter';

interface BatchFilterContextValue {
  selected: BatchSelection;
  setSelected: (value: BatchSelection) => void;
  batches: BatchSummary[];
  isLoading: boolean;
}

const BatchFilterContext = createContext<BatchFilterContextValue | null>(null);

export function BatchFilterProvider({ children }: { children: React.ReactNode }) {
  // Starts null on both server and client so the markup matches; the stored value is
  // applied after mount, which avoids a hydration mismatch on every page.
  const [selected, setSelectedState] = useState<BatchSelection>(null);

  useEffect(() => {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) setSelectedState(stored);
  }, []);

  const setSelected = useCallback((value: BatchSelection) => {
    setSelectedState(value);
    if (value === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, value);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['batches'],
    queryFn: api.batches,
    // Batches change when an admin creates one, which is rare; refetching them on every
    // page mount would be pure overhead.
    staleTime: 5 * 60_000,
  });

  const value = useMemo(
    () => ({ selected, setSelected, batches: data ?? [], isLoading }),
    [selected, setSelected, data, isLoading],
  );

  return <BatchFilterContext.Provider value={value}>{children}</BatchFilterContext.Provider>;
}

/**
 * The current batch filter.
 *
 * Safe outside the provider (returns "all"), so a page can use it without every test and
 * storybook needing the provider wired up.
 */
export function useBatchFilter(): BatchFilterContextValue {
  const context = useContext(BatchFilterContext);
  return (
    context ?? { selected: null, setSelected: () => undefined, batches: [], isLoading: false }
  );
}

/** The selected batch's display name, for headings and empty states. */
export function useBatchLabel(): string {
  const { selected, batches } = useBatchFilter();
  if (selected === null) return 'All batches';
  return batches.find((batch) => batch.code === selected)?.name ?? selected;
}

export function BatchFilter({ className }: { className?: string }) {
  const { selected, setSelected, batches, isLoading } = useBatchFilter();

  // Nothing to choose between: one batch (or none) makes the control noise.
  if (isLoading || batches.length < 2) return null;

  const options: { value: BatchSelection; label: string; count?: number }[] = [
    { value: null, label: 'All' },
    ...batches.map((batch) => ({
      value: batch.code,
      label: batch.name.replace(/\s*Level$/i, ''),
      count: batch.studentCount,
    })),
  ];

  return (
    <div
      role="group"
      aria-label="Filter by batch"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg bg-[var(--color-surface-sunken)] p-1',
        className,
      )}
    >
      {options.map((option) => {
        const isActive = option.value === selected;
        return (
          <button
            key={option.value ?? 'all'}
            type="button"
            aria-pressed={isActive}
            onClick={() => setSelected(option.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
              isActive
                ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="text-xs text-[var(--color-fg-subtle)]">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A batch's short code as a coloured chip, for tables where a whole name is too wide.
 *
 * Colour is derived from the code so it is stable per batch without needing a stored
 * palette, and a new batch gets a distinct colour automatically.
 */
export function BatchChip({
  code,
  name,
  className,
}: {
  code: string | null;
  name?: string | null;
  className?: string;
}) {
  if (!code) {
    return <span className={cn('text-xs text-[var(--color-fg-subtle)]', className)}>—</span>;
  }

  const palette = [
    'bg-[var(--color-brand-soft)] text-[var(--color-brand)]',
    'bg-[var(--color-info-soft)] text-[var(--color-info)]',
    'bg-[var(--color-success-soft)] text-[var(--color-success)]',
    'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  ];
  const index = [...code].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;

  return (
    <span
      title={name ?? undefined}
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold',
        palette[index],
        className,
      )}
    >
      {code}
    </span>
  );
}
