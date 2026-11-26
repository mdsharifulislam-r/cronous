'use client';
import type { TooltipContentProps } from 'recharts';
import { formatDateTime } from '@/lib/format';

/** Colours come from CSS variables so charts follow the theme. */
export const CHART = {
  primary: 'var(--color-chart-1)',
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  delayed: 'var(--color-delayed)',
  neutral: 'var(--color-neutral)',
  grid: 'var(--color-border)',
  axis: 'var(--color-muted-foreground)',
};

export const axisProps = { stroke: CHART.axis, fontSize: 11, tickLine: false, axisLine: false } as const;

export function bucketLabel(at: string, bucket: 'hour' | 'day'): string {
  const date = new Date(at);
  return bucket === 'hour'
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ChartTooltip({ active, payload, label, formatter }: Partial<TooltipContentProps<number, string>> & { formatter?: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface-raised px-3 py-2 text-xs shadow-md">
      {label ? <p className="mb-1 font-medium">{typeof label === 'string' && /^\d{4}-/.test(label) ? formatDateTime(label, undefined, false) : String(label)}</p> : null}
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="ml-auto font-medium tabular">{formatter ? formatter(Number(entry.value)) : String(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}
