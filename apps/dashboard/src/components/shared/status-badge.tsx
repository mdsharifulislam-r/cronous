import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import type { StatusView, Tone } from '@/lib/status';
import { cn } from '@/lib/utils';

const DOT: Record<Tone, string> = {
  neutral: 'bg-neutral',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  delayed: 'bg-delayed',
};

export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse ? <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', DOT[tone])} /> : null}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT[tone])} />
    </span>
  );
}

export function StatusBadge({ view, className }: { view: StatusView; className?: string }) {
  return (
    <Tooltip content={view.description}>
      <Badge tone={view.tone} className={className}>
        <StatusDot tone={view.tone} pulse={view.label === 'Active'} />
        {view.label}
      </Badge>
    </Tooltip>
  );
}
