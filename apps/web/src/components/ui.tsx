'use client';

/**
 * UI primitives.
 *
 * Small, unstyled-by-default building blocks in the shadcn spirit: composable,
 * theme-token driven, no runtime theming logic. Everything reads its colours from the
 * CSS custom properties in `globals.css`, so light and dark are handled once.
 */

import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// --- Card -------------------------------------------------------------------

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card animate-rise', className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// --- Button -----------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-brand)] text-[var(--color-brand-fg)] hover:opacity-90 disabled:opacity-50',
  secondary:
    'border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-sunken)]',
  ghost: 'hover:bg-[var(--color-surface-sunken)]',
  danger: 'bg-[var(--color-danger)] text-white hover:opacity-90',
};

export function Button({
  variant = 'secondary',
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        className,
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}

// --- Badge ------------------------------------------------------------------

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--color-surface-sunken)] text-[var(--color-fg-muted)]',
  success: 'bg-[var(--color-success-soft)] text-[var(--color-success)]',
  warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
  info: 'bg-[var(--color-info-soft)] text-[var(--color-info)]',
  brand: 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const tone = difficulty === 'EASY' ? 'success' : difficulty === 'HARD' ? 'danger' : 'warning';
  return (
    <Badge tone={tone}>{difficulty.charAt(0) + difficulty.slice(1).toLowerCase()}</Badge>
  );
}

// --- Stat tile --------------------------------------------------------------

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: BadgeTone;
  icon?: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
            {label}
          </p>
          {/* Tabular numerals so a column of figures aligns as the value changes. */}
          <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
          {hint ? <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">{hint}</p> : null}
        </div>
        {icon ? (
          <span className={cn('rounded-lg p-2', BADGE_TONES[tone])} aria-hidden>
            {icon}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// --- Table ------------------------------------------------------------------

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]',
        'px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn('border-b border-[var(--color-border)] px-3 py-2.5 align-middle', className)}
      {...props}
    />
  );
}

// --- Feedback states --------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden />;
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: cols }).map((_, colIndex) => (
            <Skeleton key={colIndex} className={cn('h-8 flex-1', colIndex === 0 && 'flex-[2]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="text-[var(--color-fg-subtle)]">{icon}</div> : null}
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-fg-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <EmptyState
      title="Could not load this view"
      description={message}
      action={
        onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

// --- Misc -------------------------------------------------------------------

/** Streak flame whose intensity tracks the streak length. */
export function StreakFlame({ streak }: { streak: number }) {
  if (streak <= 0) {
    return <span className="text-[var(--color-fg-subtle)] tabular-nums">—</span>;
  }
  const tone =
    streak >= 30 ? 'danger' : streak >= 15 ? 'warning' : streak >= 7 ? 'brand' : 'neutral';
  return (
    <Badge tone={tone}>
      <span aria-hidden>🔥</span>
      <span className="tabular-nums">{streak}</span>
      <span className="sr-only">day streak</span>
    </Badge>
  );
}

// --- Modal ------------------------------------------------------------------

/**
 * A focused overlay for content that needs the user's full attention before they act —
 * the email preview, confirmations. Closes on Escape or backdrop click; body scroll is
 * locked while open so the page behind it cannot be scrolled accidentally.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cn(
          'relative flex max-h-[85vh] w-full flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-2xl animate-rise',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 id="modal-title" className="truncate text-sm font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] transition hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-fg)]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
    >
      <div
        className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-500"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
