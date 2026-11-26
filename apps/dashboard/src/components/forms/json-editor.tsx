'use client';
import { Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Returns an error message, or null when `text` is empty or valid JSON. */
export function jsonError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    return `Invalid JSON: ${(error as Error).message}`;
  }
}

export function parseJsonOrUndefined(text: string): unknown {
  return text.trim() ? (JSON.parse(text) as unknown) : undefined;
}

export function JsonEditor({ id, value, onChange, placeholder = '{\n  \n}', rows = 8, className, invalid }: { id: string; value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; className?: string; invalid?: boolean }) {
  const error = jsonError(value);
  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        value={value}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={invalid || Boolean(error) || undefined}
        className={cn('font-mono', className)}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          if (!error && value.trim()) onChange(JSON.stringify(JSON.parse(value), null, 2));
        }}
      />
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
