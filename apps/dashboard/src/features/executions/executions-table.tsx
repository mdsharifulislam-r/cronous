'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import Link from 'next/link';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { LoadMore } from '@/components/tables/pagination';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { durationBetween, formatDateTime, formatDuration, shortId, timeAgo } from '@/lib/format';
import { MODE_LABEL, executionKind, executionStatusView } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { executionsService } from '@/services';
import type { ExecutionFilters, ExecutionSummary } from '@/types/api';
import { ExecutionRowActions } from './execution-row-actions';

export type ExecutionColumn = 'id' | 'job' | 'kind' | 'queue' | 'mode' | 'status' | 'started' | 'duration' | 'attempt' | 'executor' | 'scheduled' | 'error' | 'actions';
const DEFAULT_COLUMNS: ExecutionColumn[] = ['id', 'job', 'kind', 'queue', 'mode', 'status', 'started', 'duration', 'attempt', 'actions'];

/** Cursor-paginated execution list (newest first) backed by GET /executions. */
export function ExecutionsTable({ projectId, filters, columns = DEFAULT_COLUMNS, pageSize = 50, emptyTitle = 'No executions', emptyDescription, onInspect }: { projectId: string; filters: ExecutionFilters; columns?: ExecutionColumn[]; pageSize?: number; emptyTitle?: string; emptyDescription?: string; /** Open an inspector instead of navigating when the id is clicked. */ onInspect?: (id: string) => void }) {
  const { fallbackInterval } = useRealtime();
  const query = useInfiniteQuery({
    queryKey: ['executions', projectId, { ...filters, pageSize }],
    queryFn: ({ pageParam, signal }) => executionsService.list(projectId, { ...filters, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: fallbackInterval,
  });
  const rows: ExecutionSummary[] = query.data?.pages.flatMap((page) => page.items) ?? [];
  const has = (column: ExecutionColumn) => columns.includes(column);

  if (query.isLoading) return <TableSkeleton columns={Math.min(columns.length, 7)} />;
  if (query.error) return <div className="p-4"><ErrorState error={query.error} onRetry={() => void query.refetch()} /></div>;
  if (rows.length === 0) return <div className="p-4"><EmptyState icon={Activity} title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} /></div>;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {has('id') ? <TableHead>Execution</TableHead> : null}
            {has('job') ? <TableHead>Job</TableHead> : null}
            {has('kind') ? <TableHead>Kind</TableHead> : null}
            {has('queue') ? <TableHead>Queue</TableHead> : null}
            {has('mode') ? <TableHead>Mode</TableHead> : null}
            {has('status') ? <TableHead>Status</TableHead> : null}
            {has('scheduled') ? <TableHead>Due</TableHead> : null}
            {has('started') ? <TableHead>Started</TableHead> : null}
            {has('duration') ? <TableHead>Duration</TableHead> : null}
            {has('attempt') ? <TableHead>Attempt</TableHead> : null}
            {has('executor') ? <TableHead>Executed by</TableHead> : null}
            {has('error') ? <TableHead>Last error</TableHead> : null}
            {has('actions') ? <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((execution) => {
            const kind = executionKind(execution);
            const duration = durationBetween(execution.startedAt, execution.finishedAt);
            return (
              <TableRow key={execution.id}>
                {has('id') ? <TableCell>{onInspect ? <button type="button" onClick={() => onInspect(execution.id)} className="font-mono text-xs text-primary hover:underline">{shortId(execution.id)}</button> : <Link href={`/executions/${execution.id}`} className="font-mono text-xs hover:underline">{shortId(execution.id)}</Link>}</TableCell> : null}
                {has('job') ? <TableCell className="max-w-56"><Link href={`/jobs/${execution.jobId}`} className="block truncate hover:underline">{execution.jobName}</Link></TableCell> : null}
                {has('kind') ? <TableCell><Badge tone={kind.tone}>{kind.label}</Badge></TableCell> : null}
                {has('queue') ? <TableCell className="font-mono text-xs">{execution.queue ? <Link href={`/queues/${execution.queue}`} className="hover:underline">{execution.queue}</Link> : '—'}</TableCell> : null}
                {has('mode') ? <TableCell className="text-xs whitespace-nowrap">{MODE_LABEL[execution.mode]}</TableCell> : null}
                {has('status') ? <TableCell><StatusBadge view={executionStatusView(execution)} /></TableCell> : null}
                {has('scheduled') ? <TableCell className="text-xs whitespace-nowrap tabular"><Tooltip content={formatDateTime(execution.nextAttemptAt ?? execution.scheduledFor)}><span>{timeAgo(execution.nextAttemptAt ?? execution.scheduledFor)}</span></Tooltip></TableCell> : null}
                {has('started') ? <TableCell className="text-xs whitespace-nowrap tabular">{execution.startedAt ? <Tooltip content={formatDateTime(execution.startedAt)}><span>{timeAgo(execution.startedAt)}</span></Tooltip> : <span className="text-muted-foreground">{execution.delayed ? `due ${timeAgo(execution.nextAttemptAt)}` : '—'}</span>}</TableCell> : null}
                {has('duration') ? <TableCell className="text-xs tabular">{formatDuration(duration)}</TableCell> : null}
                {has('attempt') ? <TableCell className="text-xs tabular">{execution.attemptCount}/{execution.maxAttempts}</TableCell> : null}
                {has('executor') ? (
                  <TableCell className="max-w-40 truncate text-xs">
                    {execution.executor ? <Link href={`/${execution.executor.kind === 'AGENT' ? 'agents' : 'workers'}/${execution.executor.id}`} className="hover:underline">{execution.executor.name}</Link> : <span className="text-muted-foreground">{execution.mode === 'HTTP' && execution.attemptCount > 0 ? 'server' : '—'}</span>}
                  </TableCell>
                ) : null}
                {has('error') ? <TableCell className="max-w-72 truncate font-mono text-xs text-danger">{execution.lastError ?? ''}</TableCell> : null}
                {has('actions') ? <TableCell><ExecutionRowActions projectId={projectId} execution={execution} /></TableCell> : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <LoadMore hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} onLoad={() => void query.fetchNextPage()} count={rows.length} />
    </>
  );
}
