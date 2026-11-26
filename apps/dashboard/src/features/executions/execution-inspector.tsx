'use client';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { CopyButton } from '@/components/shared/copy-button';
import { ErrorState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { durationBetween, formatDateTime, formatDuration, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { ATTEMPT_STATUS, MODE_LABEL, executionKind, executionStatusView } from '@/lib/status';
import { executionsService } from '@/services';
import { ExecutionRowActions } from './execution-row-actions';

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

/** Side panel to inspect one execution without leaving a list (queue jobs, executions). */
export function ExecutionInspector({ projectId, executionId, onClose }: { projectId: string; executionId: string | null; onClose: () => void }) {
  const query = useQuery({ queryKey: qk.execution(projectId, executionId ?? 'none'), queryFn: () => executionsService.get(projectId, executionId!), enabled: Boolean(executionId) });
  const execution = query.data;
  return (
    <Sheet open={Boolean(executionId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-[480px] max-w-[95vw] overflow-y-auto p-5" aria-describedby={undefined}>
        <SheetTitle className="mb-4 text-base font-semibold">Execution</SheetTitle>
        {query.isLoading ? <Skeleton className="h-64" /> : query.error ? <ErrorState error={query.error} /> : execution ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge view={executionStatusView(execution)} />
              <Badge tone={executionKind(execution).tone}>{executionKind(execution).label}</Badge>
              <span className="ml-auto flex items-center gap-1">
                <ExecutionRowActions projectId={projectId} execution={execution} />
                <Button variant="secondary" size="sm" asChild><Link href={`/executions/${execution.id}`}><ExternalLink /> Open</Link></Button>
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4">
              <Item label="Execution ID"><span className="inline-flex items-center gap-1 font-mono text-xs">{execution.id.slice(0, 18)}…<CopyButton value={execution.id} label="Copy execution ID" /></span></Item>
              <Item label="Job"><Link href={`/jobs/${execution.jobId}`} className="hover:underline">{execution.jobName}</Link></Item>
              <Item label="Queue"><span className="font-mono">{execution.queue ?? '—'}</span></Item>
              <Item label="Priority"><span className="tabular">{execution.priority}</span></Item>
              <Item label="Mode">{MODE_LABEL[execution.mode]}</Item>
              <Item label="Attempts"><span className="tabular">{execution.attemptCount} of {execution.maxAttempts}</span></Item>
              <Item label="Created">{formatDateTime(execution.createdAt)}</Item>
              <Item label={execution.delayed ? 'Runs at' : 'Due'}>{formatDateTime(execution.nextAttemptAt ?? execution.scheduledFor)}{execution.delayed ? <span className="block text-xs text-delayed">{timeAgo(execution.nextAttemptAt)}</span> : null}</Item>
              <Item label="Started">{formatDateTime(execution.startedAt)}</Item>
              <Item label="Duration">{formatDuration(durationBetween(execution.startedAt, execution.finishedAt))}</Item>
            </dl>
            {execution.lastError ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Last error</p>
                <pre className="max-h-32 overflow-auto rounded-md bg-danger/10 p-2 font-mono text-xs whitespace-pre-wrap text-danger">{execution.lastError}</pre>
              </div>
            ) : null}
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Payload</p>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{execution.payload === null || execution.payload === undefined ? 'none' : JSON.stringify(execution.payload, null, 2)}</pre>
            </div>
            {execution.result !== null && execution.result !== undefined ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Result</p>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{JSON.stringify(execution.result, null, 2)}</pre>
              </div>
            ) : null}
            {execution.attempts.length ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Attempts</p>
                <ul className="space-y-1 text-xs">
                  {execution.attempts.map((attempt) => (
                    <li key={attempt.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5">
                      <span>#{attempt.attemptNumber} <StatusBadge view={ATTEMPT_STATUS[attempt.status]} /></span>
                      <span className="truncate text-muted-foreground">{attempt.errorCode ?? ''} {formatDuration(durationBetween(attempt.startedAt, attempt.finishedAt))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
