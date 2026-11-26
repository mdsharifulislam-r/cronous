'use client';
import { cn } from '@/lib/utils';

export const RANGES = [
  { key: '24h', label: '24h', hours: 24, bucket: 'hour' as const },
  { key: '7d', label: '7d', hours: 24 * 7, bucket: 'day' as const },
  { key: '30d', label: '30d', hours: 24 * 30, bucket: 'day' as const },
];
export type RangeKey = (typeof RANGES)[number]['key'];

export function rangeOf(key: RangeKey) {
  return RANGES.find((range) => range.key === key) ?? RANGES[0]!;
}

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (value: RangeKey) => void }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {RANGES.map((range) => (
        <button
          key={range.key}
          type="button"
          role="radio"
          aria-checked={value === range.key}
          onClick={() => onChange(range.key)}
          className={cn('rounded px-2.5 py-1 text-xs font-medium transition-colors', value === range.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
