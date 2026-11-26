'use client';
import { useQuery } from '@tanstack/react-query';
import { Edit, MoreHorizontal, Send, Zap } from 'lucide-react';
import Link from 'next/link';
import { CopyButton } from '@/components/shared/copy-button';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, formatDuration, shortId, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { EXECUTION_STATUS, MODE_LABEL, jobStatus, jobType } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { activityService, executionsService, jobsService, schedulesService } from '@/services';
import type { Job } from '@/types/api';
import { ExecutionsTable } from '../executions/executions-table';
import { ExecutionLogs } from '../executions/execution-logs';
import { JobActionsMenu, jobCapabilities } from './job-actions-menu';
import { scheduleText } from './jobs-page';
import { useJobActions } from './use-job-actions';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">none</span>;
  return <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

function OverviewTab({ job, projectId }: { job: Job; projectId: string }) {
  const preview = useQuery({ queryKey: ['job-preview', projectId, job.id, job.schedule?.version], queryFn: () => schedulesService.jobPreview(projectId, job.id, 5), enabled: Boolean(job.schedule && job.schedule.state === 'ACTIVE') });
  const stats = useQuery({ queryKey: qk.stats(projectId, { jobId: job.id, hours: 168 }), queryFn: () => executionsService.stats(projectId, { jobId: job.id, hours: 168 }) });
  const counts = stats.data?.executions ?? {};
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <dl className="divide-y divide-border">
            <Row label="Job ID"><span className="inline-flex items-center gap-1 font-mono text-xs">{job.id}<CopyButton value={job.id} label="Copy job ID" /></span></Row>
            <Row label="Description">{job.description ?? <span className="text-muted-foreground">none</span>}</Row>
            <Row label="Type"><Badge tone={jobType(job).tone}>{jobType(job).label}</Badge> <span className="ml-2 font-mono text-xs">{scheduleText(job)}</span></Row>
            <Row label="Queue"><Link href={`/queues/${job.queue}`} className="font-mono hover:underline">{job.queue}</Link></Row>
            <Row label="Execution mode">{MODE_LABEL[job.mode]}{job.mode === 'HTTP' && job.http ? <span className="ml-2 font-mono text-xs text-muted-foreground">{job.http.method} {job.http.url}</span> : null}</Row>
            <Row label="Defined by">{job.source === 'SDK' ? 'Application code (SDK)' : 'API / dashboard'}</Row>
            <Row label="Next run">{job.schedule?.nextRunAt ? `${formatDateTime(job.schedule.nextRunAt, job.schedule.timezone)} (${job.schedule.timezone}) · ${timeAgo(job.schedule.nextRunAt)}` : '—'}</Row>
            <Row label="Last run">{job.lastExecution ? <Link className="hover:underline" href={`/executions/${job.lastExecution.id}`}>{EXECUTION_STATUS[job.lastExecution.status].label} · {timeAgo(job.lastExecution.createdAt)}</Link> : 'Never'}</Row>
            <Row label="Retries">{job.maxAttempts} attempts · backoff {formatDuration(job.retryBackoffMs)} → {formatDuration(job.retryBackoffMaxMs)}</Row>
            <Row label="Timeout">{formatDuration(job.timeoutMs)}</Row>
            <Row label="Created">{formatDateTime(job.createdAt)}</Row>
            <Row label="Updated">{formatDateTime(job.updatedAt)}</Row>
          </dl>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Last 7 days</CardTitle></CardHeader>
          <CardContent>
            {stats.isLoading ? <Skeleton className="h-16" /> : (
              <dl className="grid grid-cols-3 gap-3 text-center">
                <div><dt className="text-xs text-muted-foreground">Runs</dt><dd className="text-lg font-semibold tabular">{total}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Completed</dt><dd className="text-lg font-semibold text-success tabular">{counts.SUCCEEDED ?? 0}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Failed</dt><dd className="text-lg font-semibold text-danger tabular">{(counts.FAILED ?? 0) + (counts.DEAD_LETTERED ?? 0)}</dd></div>
              </dl>
            )}
            {stats.data?.durationMs.p50 !== null && stats.data ? <p className="mt-3 text-center text-xs text-muted-foreground">p50 {formatDuration(stats.data.durationMs.p50)} · p95 {formatDuration(stats.data.durationMs.p95)}</p> : null}
          </CardContent>
        </Card>
        {job.schedule ? (
          <Card>
            <CardHeader><CardTitle>Upcoming runs</CardTitle></CardHeader>
            <CardContent>
              {job.schedule.state !== 'ACTIVE' ? <p className="text-sm text-muted-foreground">Schedule is {job.schedule.state.toLowerCase()}.</p> : preview.isLoading ? <Skeleton className="h-24" /> : (
                <ul className="space-y-1 font-mono text-xs">{preview.data?.occurrences.map((at) => <li key={at}>{formatDateTime(at, job.schedule!.timezone)}</li>)}</ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">Times in {job.schedule.timezone}</p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ConfigurationTab({ job }: { job: Job }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Execution</CardTitle></CardHeader>
        <CardContent>
          <dl className="divide-y divide-border">
            <Row label="Mode">{MODE_LABEL[job.mode]}</Row>
            <Row label="Priority">{job.priority ?? 'queue default'}</Row>
            <Row label="Max concurrent">{job.maxConcurrency ?? 'unlimited'}</Row>
            <Row label="Overlap">{job.concurrencyPolicy === 'FORBID' ? 'Forbidden' : 'Allowed'}</Row>
            <Row label="Enabled">{job.enabled ? 'Yes' : 'No'}</Row>
            {job.schedule ? (
              <>
                <Row label="Schedule">{job.schedule.type === 'CRON' ? <span className="font-mono">{job.schedule.cron}</span> : formatDateTime(job.schedule.runAt, job.schedule.timezone)}</Row>
                <Row label="Time zone">{job.schedule.timezone}</Row>
                <Row label="Missed runs">{{ FIRE_ONCE: 'Run once to catch up', SKIP: 'Skip', FIRE_ALL: `Run all (max ${job.schedule.maxCatchUp})` }[job.schedule.misfirePolicy]}</Row>
                <Row label="Misfire grace">{formatDuration(job.schedule.misfireGraceMs)}</Row>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      {job.http ? (
        <Card>
          <CardHeader><CardTitle>Webhook</CardTitle></CardHeader>
          <CardContent>
            <dl className="divide-y divide-border">
              <Row label="Request"><span className="font-mono text-xs">{job.http.method} {job.http.url}</span></Row>
              <Row label="Headers">{Object.keys(job.http.headers).length ? <Json value={job.http.headers} /> : 'none'}</Row>
              <Row label="Authentication">{job.http.auth ? `${job.http.auth.type} (secret hidden)` : 'none'}</Row>
              <Row label="Signing">{job.http.signingSecret ? 'X-Chronos-Signature (secret hidden)' : 'off'}</Row>
            </dl>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Default payload</CardTitle></CardHeader>
        <CardContent><Json value={job.payload} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Payload schema</CardTitle></CardHeader>
        <CardContent><Json value={job.payloadSchema} /></CardContent>
      </Card>
    </div>
  );
}

function LogsTab({ job, projectId }: { job: Job; projectId: string }) {
  if (!job.lastExecution) return <EmptyState title="No executions yet" description="Logs appear once the job has run." />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs of the latest execution</CardTitle>
        <Link href={`/executions/${job.lastExecution.id}`} className="text-xs text-muted-foreground hover:text-foreground">Execution {shortId(job.lastExecution.id)}</Link>
      </CardHeader>
      <CardContent><ExecutionLogs projectId={projectId} executionId={job.lastExecution.id} live={['PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED'].includes(job.lastExecution.status)} /></CardContent>
    </Card>
  );
}

function ActivityTab({ job, orgId }: { job: Job; orgId: string }) {
  const activity = useQuery({ queryKey: qk.activity(orgId, { targetId: job.id }), queryFn: () => activityService.list(orgId, { targetId: job.id, limit: 50 }) });
  if (activity.isLoading) return <Skeleton className="h-32" />;
  if (activity.error) return <ErrorState error={activity.error} />;
  if (!activity.data?.items.length) return <EmptyState title="No recorded changes" />;
  return (
    <Card>
      <ul className="divide-y divide-border">
        {activity.data.items.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span><span className="font-mono text-xs">{entry.action}</span> <span className="text-muted-foreground">by {entry.actor.name ?? entry.actor.credentialPrefix ?? entry.actor.type.toLowerCase()}</span></span>
            <span className="text-xs text-muted-foreground" title={formatDateTime(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function JobDetailPage({ jobId }: { jobId: string }) {
  const { project, organization, can } = useWorkspace();
  const projectId = project!.id;
  const { fallbackInterval } = useRealtime();
  const job = useQuery({ queryKey: qk.job(projectId, jobId), queryFn: () => jobsService.get(projectId, jobId), refetchInterval: fallbackInterval });
  // The list endpoint carries lastExecution; the detail endpoint does not, so read it from the latest execution.
  const latest = useQuery({ queryKey: qk.executions(projectId, { jobId, limit: 1 }), queryFn: () => executionsService.list(projectId, { jobId, limit: 1 }), refetchInterval: fallbackInterval });
  const actions = useJobActions(projectId);

  if (job.isLoading) return <Skeleton className="h-64" />;
  if (job.error || !job.data) return <ErrorState error={job.error} onRetry={() => void job.refetch()} />;
  const last = latest.data?.items[0];
  const data: Job = { ...job.data, lastExecution: last ? { id: last.id, status: last.status, trigger: last.trigger, createdAt: last.createdAt, finishedAt: last.finishedAt } : null };
  const caps = jobCapabilities(data, can('MEMBER'));

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3"><span className="font-mono">{data.name}</span><StatusBadge view={jobStatus(data)} /></span>}
        description={data.description ?? undefined}
        actions={
          <>
            {caps.trigger ? <Button variant="secondary" onClick={() => actions.trigger.mutate(data)} loading={actions.trigger.isPending}><Zap /> Run now</Button> : null}
            {caps.submit ? <Button variant="secondary" asChild><Link href={`/queues/submit?job=${encodeURIComponent(data.name)}`}><Send /> Submit</Link></Button> : null}
            {caps.edit ? <Button variant="secondary" asChild><Link href={`/jobs/${data.id}/edit`}><Edit /> {data.source === 'SDK' ? 'Enable/disable' : 'Edit'}</Link></Button> : null}
            <JobActionsMenu job={data} projectId={projectId} trigger={<Button variant="secondary" size="icon" aria-label="More actions"><MoreHorizontal /></Button>} />
          </>
        }
      />
      {data.source === 'SDK' ? <p className="-mt-3 mb-4 text-xs text-muted-foreground">Defined in application code with the SDK: change its configuration there. Here you can enable or disable it, run it and inspect it.</p> : null}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="executions">Executions</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          {can('ADMIN') ? <TabsTrigger value="activity">Activity</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="overview"><OverviewTab job={data} projectId={projectId} /></TabsContent>
        <TabsContent value="executions"><Card><ExecutionsTable projectId={projectId} filters={{ jobId: data.id }} columns={['id', 'kind', 'status', 'scheduled', 'started', 'duration', 'attempt', 'actions']} emptyTitle="This job has not run yet" /></Card></TabsContent>
        <TabsContent value="configuration"><ConfigurationTab job={data} /></TabsContent>
        <TabsContent value="logs"><LogsTab job={data} projectId={projectId} /></TabsContent>
        {can('ADMIN') ? <TabsContent value="activity"><ActivityTab job={data} orgId={organization!.id} /></TabsContent> : null}
      </Tabs>
    </div>
  );
}
