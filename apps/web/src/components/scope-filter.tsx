'use client';

/**
 * The global scope filter: `Campus [All] [Vels] [SRM]` + `Batch [All] [Foundation] …`
 *
 * One component, used on every page that can be narrowed, rather than a copy per page —
 * campuses and batches come from the API, so onboarding a third campus makes it appear
 * everywhere without touching a single page (§12).
 *
 * Two properties are worth being explicit about:
 *
 *  * **The batch control follows the campus.** Batches are campus-scoped, and both
 *    campuses have a "Foundation Level"; offering them side by side would give the user
 *    two identical-looking options that mean different things. With no campus selected
 *    the batch control therefore offers only "All" — an unnarrowed campus has no single
 *    batch list, and inventing one would be the ambiguity §8 rules out.
 *
 *  * **The filter is a request parameter, never a client-side slice.** Every page passes
 *    the selection to the API; nothing here filters rows in the browser. That is what
 *    keeps one campus's numbers out of another campus's view, and what keeps the payload
 *    from growing with the roster (§12, §27).
 *
 * The selection is remembered in `sessionStorage` and shared through a context, so moving
 * from the dashboard to the leaderboard keeps the mentor in the campus they were already
 * looking at instead of silently resetting to "All". `sessionStorage` rather than
 * `localStorage` deliberately: a filter is working state for this sitting, not a durable
 * preference that should still be applied next week.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  UNASSIGNED_BATCH_LABEL,
  UNASSIGNED_BATCH_SELECTOR,
  type BatchSummary,
  type CampusSummary,
} from '@dsa/shared';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** `null` means "all"; otherwise a campus `code` (`VELS`, `SRM`, …). */
export type CampusSelection = string | null;
/**
 * `null` means "all batches"; otherwise a batch `code` (`A`, `B`), or the reserved
 * `UNASSIGNED_BATCH_SELECTOR` for students who have no batch yet.
 *
 * "Not assigned" is deliberately a selector value rather than a batch: a student awaiting
 * their diagnostic assessment has no batch, and modelling that as one would put it in
 * every assignment target and leaderboard scope as somewhere work could be set.
 */
export type BatchSelection = string | null;

const CAMPUS_KEY = 'dsa.campusFilter';
const BATCH_KEY = 'dsa.batchFilter';

interface ScopeFilterContextValue {
  campus: CampusSelection;
  batch: BatchSelection;
  setCampus: (value: CampusSelection) => void;
  setBatch: (value: BatchSelection) => void;
  campuses: CampusSummary[];
  /** Batches at the selected campus; empty while every campus is in view. */
  batches: BatchSummary[];
  isLoading: boolean;
}

const ScopeFilterContext = createContext<ScopeFilterContextValue | null>(null);

export function ScopeFilterProvider({ children }: { children: React.ReactNode }) {
  // Both start null on server and client so the markup matches; the stored values are
  // applied after mount, which avoids a hydration mismatch on every page.
  const [campus, setCampusState] = useState<CampusSelection>(null);
  const [batch, setBatchState] = useState<BatchSelection>(null);

  useEffect(() => {
    const storedCampus = window.sessionStorage.getItem(CAMPUS_KEY);
    const storedBatch = window.sessionStorage.getItem(BATCH_KEY);
    if (storedCampus) setCampusState(storedCampus);
    // A stored batch is only meaningful alongside a campus, since codes repeat.
    if (storedCampus && storedBatch) setBatchState(storedBatch);
  }, []);

  const setBatch = useCallback((value: BatchSelection) => {
    setBatchState(value);
    if (value === null) window.sessionStorage.removeItem(BATCH_KEY);
    else window.sessionStorage.setItem(BATCH_KEY, value);
  }, []);

  const setCampus = useCallback(
    (value: CampusSelection) => {
      setCampusState(value);
      if (value === null) window.sessionStorage.removeItem(CAMPUS_KEY);
      else window.sessionStorage.setItem(CAMPUS_KEY, value);
      // Changing campus clears the batch. `SRM/A` and `VELS/A` share a code but are
      // different batches, so carrying the code across would silently re-point the
      // filter at another campus's cohort.
      setBatch(null);
    },
    [setBatch],
  );

  const { data: campuses, isLoading: campusesLoading } = useQuery({
    queryKey: ['campuses'],
    queryFn: api.campuses,
    // Campuses change when an admin onboards one, which is rare.
    staleTime: 5 * 60_000,
  });

  const selectedCampusId = useMemo(
    () => campuses?.find((entry) => entry.code === campus)?.id ?? null,
    [campuses, campus],
  );

  const { data: batches, isLoading: batchesLoading } = useQuery({
    queryKey: ['campus-batches', selectedCampusId],
    queryFn: () => api.campusBatches(selectedCampusId!),
    enabled: selectedCampusId !== null,
    staleTime: 5 * 60_000,
  });

  const value = useMemo(
    () => ({
      campus,
      batch,
      setCampus,
      setBatch,
      campuses: campuses ?? [],
      batches: selectedCampusId ? (batches ?? []) : [],
      isLoading: campusesLoading || batchesLoading,
    }),
    [campus, batch, setCampus, setBatch, campuses, batches, selectedCampusId, campusesLoading, batchesLoading],
  );

  return <ScopeFilterContext.Provider value={value}>{children}</ScopeFilterContext.Provider>;
}

/**
 * The current scope filter.
 *
 * Safe outside the provider (returns "everything"), so a page can use it without every
 * test and storybook needing the provider wired up.
 */
export function useScopeFilter(): ScopeFilterContextValue {
  const context = useContext(ScopeFilterContext);
  return (
    context ?? {
      campus: null,
      batch: null,
      setCampus: () => undefined,
      setBatch: () => undefined,
      campuses: [],
      batches: [],
      isLoading: false,
    }
  );
}

/** The selected audience's display name, for headings and empty states. */
export function useScopeLabel(): string {
  const { campus, batch, campuses, batches } = useScopeFilter();
  const campusName = campus
    ? (campuses.find((entry) => entry.code === campus)?.name ?? campus)
    : 'All campuses';
  const batchName =
    batch === UNASSIGNED_BATCH_SELECTOR
      ? UNASSIGNED_BATCH_LABEL
      : batch
        ? (batches.find((entry) => entry.code === batch)?.name ?? batch)
        : 'All batches';
  return `${campusName} — ${batchName}`;
}

interface SegmentOption {
  value: string | null;
  label: string;
  count?: number;
}

function Segmented({
  label,
  options,
  selected,
  onSelect,
  className,
}: {
  label: string;
  options: SegmentOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
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
            onClick={() => onSelect(option.value)}
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
 * The campus + batch filter pair.
 *
 * Each control hides itself when there is nothing to choose between — a single campus
 * makes the campus control noise, and an unselected campus makes the batch control
 * meaningless. Both reappear the moment a second campus exists.
 */
export function ScopeFilter({
  className,
  batchOnly = false,
  unassignedCount,
}: {
  className?: string;
  /** For surfaces where the campus is already fixed by context (a campus detail page). */
  batchOnly?: boolean;
  /** Shown against the "Not Assigned" chip when the caller knows the figure. */
  unassignedCount?: number;
}) {
  const { campus, batch, setCampus, setBatch, campuses, batches, isLoading } = useScopeFilter();

  if (isLoading && campuses.length === 0) return null;

  const campusOptions: SegmentOption[] = [
    { value: null, label: 'All' },
    ...campuses.map((entry) => ({
      value: entry.code,
      label: entry.code,
      count: entry.studentCount,
    })),
  ];

  const batchOptions: SegmentOption[] = [
    { value: null, label: 'All' },
    ...batches.map((entry) => ({
      value: entry.code,
      label: entry.name.replace(/\s*Level$/i, ''),
      count: entry.studentCount,
    })),
    // Last, and visually just another option — but it filters on the *absence* of a
    // batch, not on one.
    {
      value: UNASSIGNED_BATCH_SELECTOR,
      label: UNASSIGNED_BATCH_LABEL,
      count: unassignedCount,
    },
  ];

  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      {!batchOnly && campuses.length > 1 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            Campus
          </span>
          <Segmented
            label="Filter by campus"
            options={campusOptions}
            selected={campus}
            onSelect={setCampus}
          />
        </div>
      ) : null}

      {batches.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            Batch
          </span>
          <Segmented
            label="Filter by batch"
            options={batchOptions}
            selected={batch}
            onSelect={setBatch}
          />
        </div>
      ) : campuses.length > 1 && campus === null ? (
        // Explaining the absence beats leaving a gap the user reads as a bug.
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Pick a campus to filter by batch
        </span>
      ) : null}
    </div>
  );
}

/**
 * A code as a coloured chip, for tables where a whole name is too wide.
 *
 * Colour is derived from the code so it is stable per batch or campus without needing a
 * stored palette, and a new one gets a distinct colour automatically.
 */
function Chip({
  code,
  name,
  className,
  palette,
}: {
  code: string | null;
  name?: string | null;
  className?: string;
  palette: string[];
}) {
  if (!code) {
    return <span className={cn('text-xs text-[var(--color-fg-subtle)]', className)}>—</span>;
  }

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

const BATCH_PALETTE = [
  'bg-[var(--color-brand-soft)] text-[var(--color-brand)]',
  'bg-[var(--color-info-soft)] text-[var(--color-info)]',
  'bg-[var(--color-success-soft)] text-[var(--color-success)]',
  'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
];

/**
 * Campuses get their own palette so a campus chip and a batch chip are never mistaken
 * for each other in a table where both appear side by side.
 */
const CAMPUS_PALETTE = [
  'bg-[var(--color-fg)]/10 text-[var(--color-fg)]',
  'bg-[var(--color-brand)]/15 text-[var(--color-brand)]',
];

export function BatchChip(props: { code: string | null; name?: string | null; className?: string }) {
  return <Chip {...props} palette={BATCH_PALETTE} />;
}

export function CampusChip(props: { code: string | null; name?: string | null; className?: string }) {
  return <Chip {...props} palette={CAMPUS_PALETTE} />;
}

/**
 * Campus + batch as one inline pair, for table cells and page headers.
 *
 * Rendered together rather than in separate columns because they are one fact: "SRM
 * Foundation" is the answer to "which group is this student in", and splitting it across
 * two columns makes the reader reassemble it every row.
 */
export function ScopeChips({
  campusCode,
  campusName,
  batchCode,
  batchName,
  className,
}: {
  campusCode: string | null;
  campusName?: string | null;
  batchCode: string | null;
  batchName?: string | null;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <CampusChip code={campusCode} name={campusName} />
      <BatchChip code={batchCode} name={batchName} />
    </span>
  );
}
