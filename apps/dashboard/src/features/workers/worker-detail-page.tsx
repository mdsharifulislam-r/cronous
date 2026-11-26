'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { CopyButton } from '@/components/shared/copy-button';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { ErrorState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { durationBetween, formatDateTime, formatDuration, shortId, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { ATTEMPT_STATUS, MODE_LABEL } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { workersService } from '@/services';
import { ExecutionsTable } from '../executions/executions-table';
import { workerHealth } from '../agents/health';

export function WorkerDetailPage({ workerId }: { workerId: string }) {
  const { project, projects } = useWorkspace();
  const { fallbackInterval } = useRealtime();
  const worker = useQuery({ queryKey: qk.worker(workerId), queryFn: () => workersService.get(workerId), refetchInterval: fallbackInterval || 15_000 });
  if (worker.isLoading) return <Skeleton className="h-64" />;
  if (worker.error || !worker.data) return <ErrorState error={worker.error} onRetry={() => void worker.refetch()} />;
  const data = worker.data;
  const projectName = new Map(projects.map((item) => [item.id, item.name]));
  const total = data.attempts24h.succeeded + data.attempts24h.failed + data.attempts24h.timedOut + data.attempts24h.abandoned;

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3">{data.hostname ?? data.instanceId}<StatusBadge view={workerHealth(data)} /></span>}
        description={<span className="inline-flex items-center gap-1 font-mono text-xs">{data.id}<CopyButton value={data.id} label="Copy worker ID" /></span>}
      />
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Running now" value={data.runningExecutions} hint={`of ${data.concurrency} slots`} tone="primary" />
        <StatCard label="Attempts 24h" value={total} />
        <StatCard label="Succeeded 24h" value={data.attempts24h.succeeded} tone="success" />
        <StatCard label="Failed 24h" value={data.attempts24h.failed} tone="danger" />
        <StatCard label="Timed out 24h" value={data.attempts24h.timedOut} tone="warning" />
        <StatCard label="Abandoned 24h" value={data.attempts24h.abandoned} tone="warning" hint="Lease lost (crash or restart)" />
      </section>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Running in {project!.name}</CardTitle></CardHeader>
            <ExecutionsTable projectId={project!.id} filters={{ workerId, status: ['RUNNING'] }} columns={['id', 'job', 'queue', 'status', 'started', 'attempt', 'actions']} pageSize={20} emptyTitle="Nothing from this project is running on this worker" />
          </Card>
          <Card>
            <CardHeader><CardTitle>Recent attempts</CardTitle></CardHeader>
            {data.recentAttempts.length === 0 ? <CardContent><p className="text-sm text-muted-foreground">No attempts in projects you can access.</p></CardContent> : (
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Job</TableHead><TableHead>Project</TableHead><TableHead>Attempt</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>Duration</TableHead></TableRow></TableHeader>
                <TableBody>
                  {data.recentAttempts.map((attempt) => (
                    <TableRow key={`${attempt.executionId}-${attempt.attemptNumber}`}>
                      <TableCell>{attempt.projectId === project!.id ? <Link href={`/executions/${attempt.executionId}`} className="hover:underline">{attempt.jobName}</Link> : attempt.jobName}</TableCell>
                      <TableCell className="text-xs">{projectName.get(attempt.projectId) ?? shortId(attempt.projectId)}</TableCell>
                      <TableCell className="tabular">#{attempt.attemptNumber}</TableCell>
                      <TableCell><StatusBadge view={ATTEMPT_STATUS[attempt.status]} /></TableCell>
                      <TableCell className="text-xs whitespace-nowrap" title={formatDateTime(attempt.startedAt)}>{timeAgo(attempt.startedAt)}</TableCell>
                      <TableCell className="text-xs tabular">{formatDuration(durationBetween(attempt.startedAt, attempt.finishedAt))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader><CardTitle>Worker</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Instance</dt><dd className="font-mono text-xs">{data.instanceId}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Version</dt><dd className="font-mono">{data.version}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Concurrency</dt><dd className="tabular">{data.concurrency} per queue type</dd></div>
              <div><dt className="text-xs text-muted-foreground">Recently processed</dt><dd>{data.modes.length ? data.modes.map((mode) => MODE_LABEL[mode as keyof typeof MODE_LABEL] ?? mode).join(', ') : '—'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Queues</dt><dd>All queues (queues limit admission, not routing)</dd></div>
              <div><dt className="text-xs text-muted-foreground">Started</dt><dd>{formatDateTime(data.startedAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Last heartbeat</dt><dd>{formatDateTime(data.lastHeartbeatAt)} ({timeAgo(data.lastHeartbeatAt)})</dd></div>
              {data.stoppedAt ? <div><dt className="text-xs text-muted-foreground">Stopped</dt><dd>{formatDateTime(data.stoppedAt)}</dd></div> : null}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
