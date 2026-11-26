'use client';
import { useQuery } from '@tanstack/react-query';
import { Ban, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { PageHeader } from '@/components/shared/page-header';
import { ErrorState } from '@/components/shared/states';
import { StatusBadge, StatusDot } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { durationBetween, formatDateTime, formatDelay, formatDuration, shortId, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { ATTEMPT_STATUS, MODE_LABEL, executionKind, executionStatusView } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { executionsService } from '@/services';
import { ExecutionLogs } from './execution-logs';
import { executionCapabilities, useExecutionMutations } from './execution-row-actions';
import { buildTimeline } from './execution-timeline';

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

function Json({ value, empty = 'none' }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

export function ExecutionDetailPage({ executionId }: { executionId: string }) {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const { fallbackInterval } = useRealtime();
  const query = useQuery({
    queryKey: qk.execution(projectId, executionId),
    queryFn: () => executionsService.get(projectId, executionId),
    refetchInterval: (q) => (q.state.data && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'].includes(q.state.data.status) ? false : (fallbackInterval || 5000)),
  });
  const { cancel, retry } = useExecutionMutations(projectId);
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (query.isLoading) return <Skeleton className="h-72" />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const execution = query.data;
  const view = executionStatusView(execution);
  const kind = executionKind(execution);
  const caps = executionCapabilities(execution.status, can('MEMBER'));
  const active = ['PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED'].includes(execution.status);
  const timeline = buildTimeline(execution);
  const lastAttempt = execution.attempts.at(-1);

  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3"><Link href={`/jobs/${execution.jobId}`} className="hover:underline">{execution.jobName}</Link><StatusBadge view={view} /><Badge tone={kind.tone}>{kind.label}</Badge></span>}
        description={<span className="inline-flex items-center gap-1 font-mono text-xs">{execution.id}<CopyButton value={execution.id} label="Copy execution ID" /></span>}
        actions={
          <>
            {caps.retry ? <Button variant="secondary" loading={retry.isPending} onClick={() => retry.mutate(execution.id)}><RotateCcw /> Retry</Button> : null}
            {caps.cancel ? <Button variant="destructive" onClick={() => setConfirmCancel(true)}><Ban /> Cancel</Button> : null}
          </>
        }
      />
      {execution.delayed && execution.nextAttemptAt ? (
        <p className="-mt-3 mb-4 rounded-md border border-delayed/30 bg-delayed/10 px-3 py-2 text-sm">Delayed: runs at {formatDateTime(execution.nextAttemptAt)} ({timeAgo(execution.nextAttemptAt)}, in {formatDelay(new Date(execution.nextAttemptAt).getTime() - Date.now())}).</p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <dl className="grid gap-4 sm:grid-cols-3">
                <Item label="Job"><Link href={`/jobs/${execution.jobId}`} className="hover:underline">{execution.jobName}</Link> <span className="font-mono text-xs text-muted-foreground">{shortId(execution.jobId)}</span></Item>
                <Item label="Queue">{execution.queue ? <Link href={`/queues/${execution.queue}`} className="font-mono hover:underline">{execution.queue}</Link> : '—'}</Item>
                <Item label="Execution mode">{MODE_LABEL[execution.mode]}</Item>
                <Item label="Priority"><span className="tabular">{execution.priority}</span></Item>
                <Item label="Attempt"><span className="tabular">{execution.attemptCount} of {execution.maxAttempts}</span></Item>
                <Item label="Executed by">{lastAttempt?.agent ? <Link className="hover:underline" href={`/agents/${lastAttempt.agent.id}`}>agent {lastAttempt.agent.hostname ?? lastAttempt.agent.instanceId}</Link> : lastAttempt?.worker ? <Link className="hover:underline" href={`/workers/${lastAttempt.worker.id}`}>worker {lastAttempt.worker.hostname ?? lastAttempt.worker.instanceId}</Link> : '—'}</Item>
                <Item label="Created">{formatDateTime(execution.createdAt)}</Item>
                <Item label="Due">{formatDateTime(execution.scheduledFor)}</Item>
                <Item label="Started">{formatDateTime(execution.startedAt)}</Item>
                <Item label="Finished">{formatDateTime(execution.finishedAt)}</Item>
                <Item label="Duration">{formatDuration(durationBetween(execution.startedAt, execution.finishedAt))}{active && execution.startedAt ? ' (running)' : ''}</Item>
                <Item label="Timeout">{formatDuration(execution.timeoutMs)}</Item>
                <Item label="Idempotency key"><span className="font-mono text-xs break-all">{execution.idempotencyKey}</span></Item>
                <Item label="Retry backoff">{formatDuration(execution.retryBackoffMs)} → {formatDuration(execution.retryBackoffMaxMs)}</Item>
                {lastAttempt?.httpStatus ? <Item label="HTTP status"><span className="tabular">{lastAttempt.httpStatus}</span></Item> : null}
              </dl>
            </CardContent>
          </Card>

          {execution.lastError ? (
            <Card className="border-danger/30">
              <CardHeader><CardTitle className="text-danger">Error</CardTitle></CardHeader>
              <CardContent><pre className="overflow-auto rounded-md bg-danger/10 p-3 font-mono text-xs whitespace-pre-wrap text-danger">{execution.lastError}</pre></CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Payload</CardTitle></CardHeader><CardContent><Json value={execution.payload} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Result</CardTitle></CardHeader><CardContent><Json value={execution.result} empty={execution.status === 'SUCCEEDED' ? 'The handler returned nothing' : 'No result yet'} /></CardContent></Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Attempts</CardTitle></CardHeader>
            {execution.attempts.length === 0 ? <CardContent><p className="text-sm text-muted-foreground">No attempt has started yet.</p></CardContent> : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>#</TableHead><TableHead>Status</TableHead><TableHead>Executor</TableHead><TableHead>Started</TableHead><TableHead>Duration</TableHead><TableHead>Error</TableHead><TableHead>Response</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {execution.attempts.map((attempt) => (
                    <TableRow key={attempt.id}>
                      <TableCell className="tabular">{attempt.attemptNumber}</TableCell>
                      <TableCell><StatusBadge view={ATTEMPT_STATUS[attempt.status]} /></TableCell>
                      <TableCell className="text-xs">{attempt.agent ? `agent ${attempt.agent.hostname ?? attempt.agent.instanceId}` : attempt.worker ? `worker ${attempt.worker.hostname ?? attempt.worker.instanceId}` : '—'}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(attempt.startedAt)}</TableCell>
                      <TableCell className="text-xs tabular">{formatDuration(durationBetween(attempt.startedAt, attempt.finishedAt))}</TableCell>
                      <TableCell className="max-w-64 truncate font-mono text-xs text-danger" title={attempt.errorMessage ?? ''}>{[attempt.errorCode, attempt.errorMessage].filter(Boolean).join(': ')}</TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-xs">{attempt.httpStatus ? `HTTP ${attempt.httpStatus} ` : ''}{attempt.output !== null && attempt.output !== undefined ? JSON.stringify(attempt.output) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>Logs</CardTitle></CardHeader>
            <CardContent><ExecutionLogs projectId={projectId} executionId={execution.id} live={active} /></CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
          <CardContent>
            <ol className="relative space-y-4 border-l border-border pl-5">
              {timeline.map((event) => (
                <li key={event.key} className="relative">
                  <StatusDot tone={event.tone} className="absolute top-1.5 -left-[24.5px] ring-4 ring-surface" />
                  <p className="text-sm font-medium">{event.title}</p>
                  <p className="text-xs text-muted-foreground tabular">{formatDateTime(event.at)}</p>
                  {event.detail ? <p className="mt-0.5 font-mono text-xs break-words text-muted-foreground">{event.detail}</p> : null}
                </li>
              ))}
              {active && execution.status !== 'RETRY_SCHEDULED' ? (
                <li className="relative">
                  <StatusDot tone="primary" pulse className="absolute top-1.5 -left-[24.5px] ring-4 ring-surface" />
                  <p className="text-sm text-muted-foreground">{execution.status === 'RUNNING' ? 'Running…' : execution.delayed ? 'Waiting for its run time…' : 'Waiting in the queue…'}</p>
                </li>
              ) : null}
            </ol>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this execution?"
        description={execution.status === 'RUNNING' ? 'The executor is asked to stop; its result will be discarded.' : 'It has not started and will not run.'}
        confirmLabel="Cancel execution"
        destructive
        onConfirm={() => cancel.mutateAsync(execution.id)}
      />
    </div>
  );
}
