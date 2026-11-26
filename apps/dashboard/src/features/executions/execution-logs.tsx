'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ErrorState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { executionsService } from '@/services';
import type { ExecutionLog, LogLevel } from '@/types/api';

const LEVEL_TONE: Record<LogLevel, 'neutral' | 'info' | 'warning' | 'danger'> = { DEBUG: 'neutral', INFO: 'info', WARN: 'warning', ERROR: 'danger' };

/**
 * Execution logs, paged with `afterId`. While the execution is active, new lines are
 * tailed by polling every 2 s (logs are not part of the event stream).
 */
export function ExecutionLogs({ projectId, executionId, live }: { projectId: string; executionId: string; live: boolean }) {
  const [lines, setLines] = useState<ExecutionLog[]>([]);
  const cursor = useRef<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    setLines([]);
    cursor.current = undefined;
  }, [executionId]);

  const query = useQuery({
    queryKey: ['execution-logs', projectId, executionId],
    queryFn: async () => {
      let added: ExecutionLog[] = [];
      // Drain everything available (pages of 500) so long logs load completely.
      for (let page = 0; page < 20; page += 1) {
        const result = await executionsService.logs(projectId, executionId, cursor.current, 500);
        added = added.concat(result.items);
        cursor.current = result.nextAfterId ?? cursor.current;
        if (result.items.length < 500) break;
      }
      if (added.length) setLines((previous) => [...previous, ...added.filter((line) => !previous.some((existing) => existing.id === line.id))]);
      return cursor.current ?? null;
    },
    refetchInterval: live ? 2000 : false,
  });

  useEffect(() => {
    if (follow && live) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length, follow, live]);

  if (query.isLoading && lines.length === 0) return <Skeleton className="h-40" />;
  if (query.error && lines.length === 0) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (lines.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{live ? 'No log lines yet; new lines appear here as the execution writes them.' : 'This execution wrote no log lines.'}</p>;

  return (
    <div className="space-y-2">
      {live ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow new lines (live)
        </label>
      ) : null}
      <div className="max-h-[480px] overflow-auto rounded-md border border-border bg-background font-mono text-xs" role="log" aria-live={live ? 'polite' : 'off'}>
        {lines.map((line) => (
          <div key={line.id} className={cn('grid grid-cols-[150px_56px_1fr] gap-2 border-b border-border/60 px-3 py-1.5 last:border-0', line.level === 'ERROR' && 'bg-danger/5')}>
            <span className="text-muted-foreground tabular">{formatDateTime(line.createdAt)}</span>
            <span><Badge tone={LEVEL_TONE[line.level]} className="px-1 py-0 text-[10px]">{line.level}</Badge></span>
            <span className="break-words whitespace-pre-wrap">
              {line.message}
              {line.data !== null && line.data !== undefined ? <span className="block text-muted-foreground">{JSON.stringify(line.data)}</span> : null}
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}
