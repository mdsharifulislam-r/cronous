import { Children, cloneElement, isValidElement } from 'react';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Gives a direct <Input>/<Textarea> child the field id (and error wiring) when it has none, so the label always points at the control. */
function wire(children: React.ReactNode, id: string, error: string | undefined): React.ReactNode {
  const only = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  if (!isValidElement<{ id?: string }>(only) || (only.type !== Input && only.type !== Textarea) || only.props.id) return children;
  return cloneElement(only as React.ReactElement<Record<string, unknown>>, { id, ...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {}) });
}

/** Label + control + hint/error, wired for accessibility. */
export function Field({ id, label, hint, error, children, className, required }: { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: string | undefined; children: React.ReactNode; className?: string; required?: boolean }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden>*</span> : null}
      </Label>
      {wire(children, id, error)}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** aria props for an input inside <Field>. */
export function fieldAria(id: string, error: string | undefined) {
  return { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : `${id}-hint` } as const;
}
