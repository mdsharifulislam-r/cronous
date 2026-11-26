import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';
import type { Tone } from '@/lib/status';
import { cn } from '@/lib/utils';

const ACCENT: Record<Tone, string> = {
  neutral: 'text-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  delayed: 'text-delayed',
};

export function StatCard({ label, value, hint, tone = 'neutral', icon: Icon, href, loading }: { label: string; value: number | string | null | undefined; hint?: string; tone?: Tone; icon?: React.ComponentType<{ className?: string }>; href?: string; loading?: boolean }) {
  const body = (
    <Card className={cn('h-full p-4 transition-colors', href && 'hover:border-border-strong')}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      </div>
      {loading ? <Skeleton className="mt-2 h-7 w-16" /> : <p className={cn('mt-1.5 text-2xl font-semibold tracking-tight tabular', value ? ACCENT[tone] : 'text-foreground')}>{typeof value === 'number' ? formatNumber(value) : (value ?? '—')}</p>}
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
  return href ? <Link href={href} className="block focus-visible:rounded-lg">{body}</Link> : body;
}
