'use client';
import { useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { listTimeZones } from '@/lib/format';

/** Free-text IANA zone with suggestions; the server validates the name. */
export function TimezoneInput({ id, value, onChange, ...rest }: { id: string; value: string; onChange: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const zones = useMemo(() => listTimeZones(), []);
  return (
    <>
      <Input id={id} list={`${id}-zones`} value={value} onChange={(event) => onChange(event.target.value)} className="font-mono" autoComplete="off" {...rest} />
      <datalist id={`${id}-zones`}>
        {zones.map((zone) => <option key={zone} value={zone} />)}
      </datalist>
    </>
  );
}
