'use client';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export type DurationUnit = keyof typeof UNITS;

export function toMs(value: number, unit: DurationUnit): number {
  return Math.round(value * UNITS[unit]);
}

/** Best unit to display a millisecond value. */
export function fromMs(ms: number): { value: number; unit: DurationUnit } {
  for (const unit of ['d', 'h', 'm', 's'] as const) if (ms >= UNITS[unit] && ms % UNITS[unit] === 0) return { value: ms / UNITS[unit], unit };
  return { value: ms, unit: 'ms' };
}

export function DurationInput({ id, value, unit, onChange, units = ['s', 'm', 'h'], min = 0 }: { id: string; value: number; unit: DurationUnit; onChange: (value: number, unit: DurationUnit) => void; units?: DurationUnit[]; min?: number }) {
  return (
    <div className="flex gap-2">
      <Input id={id} type="number" inputMode="numeric" min={min} value={Number.isFinite(value) ? value : ''} onChange={(event) => onChange(Number(event.target.value), unit)} className="tabular" />
      <Select value={unit} onValueChange={(next) => onChange(value, next as DurationUnit)}>
        <SelectTrigger className="w-28" aria-label="Unit"><SelectValue /></SelectTrigger>
        <SelectContent>
          {units.map((item) => <SelectItem key={item} value={item}>{{ ms: 'ms', s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }[item]}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
