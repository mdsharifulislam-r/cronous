import { cn } from '@/lib/utils';

/** Chronos mark: a clock face whose hand is a forward arrow. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <circle cx="16" cy="16" r="8.5" fill="none" strokeWidth="2.2" className="stroke-primary-foreground" />
      <path d="M16 11.2V16l3.4 2.2" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="stroke-primary-foreground" />
    </svg>
  );
}
