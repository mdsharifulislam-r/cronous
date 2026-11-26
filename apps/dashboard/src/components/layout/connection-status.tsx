'use client';
import { useQuery } from '@tanstack/react-query';
import { Tooltip } from '@/components/ui/tooltip';
import { StatusDot } from '@/components/shared/status-badge';
import { useRealtime } from '@/providers/realtime-provider';

interface Readiness {
  status: 'ready' | 'not_ready';
}

/** API readiness (PostgreSQL + Redis, via /health/ready) and the live event stream state. */
export function ConnectionStatus() {
  const { status } = useRealtime();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<Readiness> => {
      const response = await fetch('/api/chronos/health/ready', { cache: 'no-store' });
      const body = (await response.json().catch(() => null)) as { data?: Readiness } | null;
      return { status: response.ok && body?.data?.status === 'ready' ? 'ready' : 'not_ready' };
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const apiOk = health.data?.status === 'ready';
  const tone = health.isLoading ? 'neutral' : !apiOk ? 'danger' : status === 'live' ? 'success' : 'warning';
  const label = health.isLoading ? 'Checking' : !apiOk ? 'API degraded' : status === 'live' ? 'Live' : status === 'unavailable' ? 'Polling' : 'Connecting';
  const detail = health.isLoading
    ? 'Checking the Chronos API'
    : !apiOk
      ? 'The Chronos API or its database/Redis is not ready'
      : status === 'live'
        ? 'Connected; changes appear in real time'
        : 'Live updates unavailable; refreshing periodically';
  return (
    <Tooltip content={detail}>
      <span className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground sm:inline-flex" role="status">
        <StatusDot tone={tone} pulse={tone === 'success'} />
        {label}
      </span>
    </Tooltip>
  );
}
