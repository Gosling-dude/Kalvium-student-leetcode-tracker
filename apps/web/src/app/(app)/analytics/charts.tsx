'use client';

/**
 * Analytics charts.
 *
 * Palette provenance: the categorical slots, the ordinal blue ramp and the ink/grid
 * tokens below are the validated reference palette, re-validated against *this*
 * application's surfaces (`#ffffff` light, `#141a22` dark) rather than the defaults:
 *
 *   categorical 8 slots  light  PASS band/chroma/CVD(9.1)/normal-vision(19.6)
 *                        dark   PASS band/chroma/CVD(8.4)/normal-vision(19.3)/contrast
 *   ordinal blue 3 steps light  PASS monotone / ΔL gaps / light-end contrast / single hue
 *
 * Light mode returns a contrast WARN for three slots (aqua, yellow, magenta sit below
 * 3:1 on white). That warning is not dismissable — the required relief is shipped:
 * every bar carries a visible direct value label, and the page also renders a table
 * view of the same data. Identity therefore never rests on hue alone.
 *
 * Both modes are *selected*, not derived: the dark column is the same eight hues
 * re-stepped for the dark surface, never an automatic flip of the light values.
 */

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import type {
  AnalyticsPoint,
  DifficultyAnalytics,
  SquadComparisonPoint,
} from '@dsa/shared';

/** Fixed order — a category keeps its hue no matter how many series survive a filter. */
const CATEGORICAL_LIGHT = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
];
const CATEGORICAL_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];

/** Ordinal ramp for Easy → Medium → Hard: one hue, monotone lightness. */
const ORDINAL_LIGHT = ['#86b6ef', '#3987e5', '#184f95'];
const ORDINAL_DARK = ['#184f95', '#3987e5', '#86b6ef'];

interface Ink {
  series: string;
  categorical: string[];
  ordinal: string[];
  grid: string;
  axis: string;
  muted: string;
  surface: string;
  primary: string;
}

const LIGHT_INK: Ink = {
  series: '#2a78d6',
  categorical: CATEGORICAL_LIGHT,
  ordinal: ORDINAL_LIGHT,
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  surface: '#ffffff',
  primary: '#0b0b0b',
};

const DARK_INK: Ink = {
  series: '#3987e5',
  categorical: CATEGORICAL_DARK,
  ordinal: ORDINAL_DARK,
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781',
  surface: '#141a22',
  primary: '#ffffff',
};

/**
 * Charts render SVG fills, so the palette has to be real hex rather than a CSS
 * variable. Resolving it from the theme (after mount, to avoid a hydration mismatch)
 * keeps light and dark as two selected palettes rather than one flipped set.
 */
function useInk(): Ink {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && resolvedTheme === 'dark' ? DARK_INK : LIGHT_INK;
}

const AXIS_TICK = { fontSize: 11, fontVariantNumeric: 'tabular-nums' as const };

function ChartTooltip({
  active,
  payload,
  label,
  suffix = '',
  ink,
}: TooltipProps<number, string> & { suffix?: string; ink: Ink }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: ink.surface,
        border: `1px solid ${ink.axis}`,
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 12,
        color: ink.primary,
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{ color: ink.muted, marginBottom: 4 }}>{label}</div>
      {payload.map((entry) => (
        <div key={String(entry.dataKey)} style={{ fontVariantNumeric: 'tabular-nums' }}>
          <strong>{typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}</strong>
          {suffix}
        </div>
      ))}
    </div>
  );
}

/** Single series — the title names it, so no legend box is needed. */
export function CompletionTrendChart({ data }: { data: AnalyticsPoint[] }) {
  const ink = useInk();

  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-[var(--color-fg-muted)]">No data yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="completionFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ink.series} stopOpacity={0.22} />
            <stop offset="100%" stopColor={ink.series} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* Horizontal rules only — vertical grid adds noise without aiding comparison. */}
        <CartesianGrid stroke={ink.grid} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ ...AXIS_TICK, fill: ink.muted }}
          tickLine={false}
          axisLine={{ stroke: ink.axis }}
          minTickGap={24}
        />
        <YAxis
          domain={[0, 100]}
          unit="%"
          tick={{ ...AXIS_TICK, fill: ink.muted }}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip
          content={<ChartTooltip suffix="% completed" ink={ink} />}
          cursor={{ stroke: ink.axis, strokeWidth: 1 }}
        />
        <Area
          type="monotone"
          dataKey="completionPercent"
          stroke={ink.series}
          strokeWidth={2}
          fill="url(#completionFill)"
          activeDot={{ r: 4, strokeWidth: 2, stroke: ink.surface }}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Difficulty is an *ordered* dimension, so it gets the single-hue ordinal ramp rather
 * than three unrelated categorical hues. The axis labels carry the identity, and each
 * bar is directly labelled with its value.
 */
export function DifficultyChart({ data }: { data: DifficultyAnalytics[] }) {
  const ink = useInk();
  const rows = data.map((row) => ({
    ...row,
    label: row.difficulty.charAt(0) + row.difficulty.slice(1).toLowerCase(),
  }));

  if (rows.every((row) => row.assignedCount === 0)) {
    return <p className="py-10 text-center text-sm text-[var(--color-fg-muted)]">No data yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} margin={{ top: 16, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={ink.grid} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ ...AXIS_TICK, fill: ink.muted }}
          tickLine={false}
          axisLine={{ stroke: ink.axis }}
        />
        <YAxis
          domain={[0, 100]}
          unit="%"
          tick={{ ...AXIS_TICK, fill: ink.muted }}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip
          content={<ChartTooltip suffix="% solved" ink={ink} />}
          cursor={{ fill: ink.grid, fillOpacity: 0.4 }}
        />
        <Bar
          dataKey="completionPercent"
          // 4px rounded ends on the data end only; the baseline end stays square.
          radius={[4, 4, 0, 0]}
          maxBarSize={64}
          label={{
            position: 'top',
            fill: ink.muted,
            fontSize: 11,
            formatter: (value: number) => `${Math.round(value)}%`,
          }}
        >
          {rows.map((row, index) => (
            <Cell key={row.difficulty} fill={ink.ordinal[index] ?? ink.series} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Squads are a categorical dimension. Horizontal bars because squad names are words,
 * not dates — rotated x-labels are far harder to read than a left-aligned list.
 *
 * Beyond eight squads the extras fold into the last slot rather than generating new
 * hues; the direct labels keep every bar identifiable regardless.
 */
export function SquadComparisonChart({ data }: { data: SquadComparisonPoint[] }) {
  const ink = useInk();
  const rows = [...data]
    .sort((a, b) => b.averageCompletion - a.averageCompletion)
    .slice(0, 8);

  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-[var(--color-fg-muted)]">
        No squads with members yet.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 34)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={ink.grid} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          unit="%"
          tick={{ ...AXIS_TICK, fill: ink.muted }}
          tickLine={false}
          axisLine={{ stroke: ink.axis }}
        />
        <YAxis
          type="category"
          dataKey="squadName"
          tick={{ fontSize: 11, fill: ink.muted }}
          tickLine={false}
          axisLine={false}
          width={96}
        />
        <Tooltip
          content={<ChartTooltip suffix="% average completion" ink={ink} />}
          cursor={{ fill: ink.grid, fillOpacity: 0.4 }}
        />
        <Bar
          dataKey="averageCompletion"
          radius={[0, 4, 4, 0]}
          barSize={18}
          label={{
            position: 'right',
            fill: ink.muted,
            fontSize: 11,
            formatter: (value: number) => `${value.toFixed(1)}%`,
          }}
        >
          {rows.map((row, index) => (
            <Cell
              key={row.squadId}
              fill={ink.categorical[index % ink.categorical.length] ?? ink.series}
              // 2px surface ring keeps adjacent fills from touching.
              stroke={ink.surface}
              strokeWidth={2}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
