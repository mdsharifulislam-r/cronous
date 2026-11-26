'use client';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Send, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as ChartTooltipBase, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/charts/chart-card';
import { CHART, ChartTooltip, axisProps, bucketLabel } from '@/components/charts/chart-theme';
import { PageHeader } from '@/components/shared/page-header';
import { StatCard } from '@/components/shared/stat-card';
import { ErrorState } from '@/components/shared/states';
import { StatusDot } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, formatDuration, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { EXECUTOR_STATUS, MODE_LABEL } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { activityService, executionsService, jobsService, queuesService, workersService } from '@/services';
import type { ExecutionFilters } from '@/types/api';
import { ExecutionInspector } from '../executions/execution-inspector';
import { ExecutionsTable } from '../executions/executions-table';
import { QueueDialog } from './queue-dialog';
import { queueHealth } from './queues-page';
import { useQueueActions } from './use-queue-actions';

/** Job states of a queue, as execution filters (the same vocabulary as everywhere else). */
export const QUEUE_TABS: { key: string; label: string; filters: ExecutionFilters; description: string }[] = [
  { key: 'waiting', label: 'Waiting', filters: { status: ['PENDING'], delayed: false }, description: 'Due, waiting to be admitted (queue paused or at its limit)' },
  { key: 'delayed', label: 'Delayed', filters: { delayed: true }, description: 'Submitted with a future run time' },
  { key: 'queued', label: 'Queued', filters: { status: ['QUEUED'] }, description: 'Admitted, waiting for an executor' },
  { key: 'active', label: 'Active', filters: { status: ['RUNNING'] }, description: 'Running now' },
  { key: 'retrying', label: 'Retrying', filters: { status: ['RETRY_SCHEDULED'] }, description: 'Waiting for the next attempt' },
  { key: 'completed', label: 'Completed', filters: { status: ['SUCCEEDED'] }, description: 'Finished successfully' },
  { key: 'failed', label: 'Failed', filters: { status: ['FAILED', 'DEAD_LETTERED'] }, description: 'Failed permanently or exhausted retries; retry them individually' },
  { key: 'cancelled', label: 'Cancelled', filters: { status: ['CANCELLED'] }, description: 'Cancelled before completion' },
];

export function QueueDetailPage({ name }: { name: string }) {
  const { project, organization, can } = useWorkspace();
  const projectId = project!.id;
  const { fallbackInterval } = useRealtime();
  const queue = useQuery({ queryKey: qk.queue(projectId, name), queryFn: () => queuesService.get(projectId, name), refetchInterval: fallbackInterval || 15_000 });
  const stats = useQuery({ queryKey: qk.stats(projectId, { queue: name, hours: 24 }), queryFn: () => executionsService.stats(projectId, { queue: name, hours: 24 }) });
  const series = useQuery({ queryKey: qk.timeseries(projectId, { queue: name, hours: 24, bucket: 'hour' }), queryFn: () => executionsService.timeseries(projectId, { queue: name, hours: 24, bucket: 'hour' }) });
  const jobs = useQuery({ queryKey: qk.jobs(projectId, { queue: name }), queryFn: () => jobsService.list(projectId, { queue: name }) });
  const workers = useQuery({ queryKey: qk.workers, queryFn: workersService.list });
  const activity = useQuery({
    queryKey: qk.activity(organization!.id, { targetId: queue.data?.id }),
    queryFn: () => activityService.list(organization!.id, { targetId: queue.data!.id, limit: 20 }),
    enabled: can('ADMIN') && Boolean(queue.data),
  });
  const actions = useQueueActions(projectId);
  const [tab, setTab] = useState('waiting');
  const [editing, setEditing] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);

  if (queue.isLoading) return <Skeleton className="h-64" />;
  if (queue.error || !queue.data) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;
  const data = queue.data;
  const health = queueHealth(data);
  const counts = stats.data?.executions ?? {};
  const failed = (counts.FAILED ?? 0) + (counts.DEAD_LETTERED ?? 0);
  const chart = (series.data?.points ?? []).map((point) => ({ at: point.at, Completed: point.counts.SUCCEEDED ?? 0, Failed: (point.counts.FAILED ?? 0) + (point.counts.DEAD_LETTERED ?? 0) }));
  const modes = new Set((jobs.data ?? []).map((job) => job.mode));
  const onlineWorkers = (workers.data ?? []).filter((worker) => worker.status === 'ONLINE');

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3"><span className="font-mono">{data.name}</span><Badge tone={health.tone}><StatusDot tone={health.tone} />{health.label}</Badge></span>}
        description={data.description ?? `Concurrency ${data.concurrencyLimit ?? 'unlimited'} · default priority ${data.defaultPriority}`}
        actions={
          <>
            {can('MEMBER') ? <Button variant="secondary" asChild><Link href={`/queues/submit?queue=${data.name}`}><Send /> Submit</Link></Button> : null}
            {can('MEMBER') ? (data.paused
              ? <Button variant="secondary" loading={actions.resume.isPending} onClick={() => actions.resume.mutate(data.name)}><Play /> Resume</Button>
              : <Button variant="secondary" loading={actions.pause.isPending} onClick={() => actions.pause.mutate(data.name)}><Pause /> Pause</Button>) : null}
            {can('ADMIN') ? <Button variant="secondary" onClick={() => setEditing(true)}><Settings2 /> Edit</Button> : null}
          </>
        }
      />
      {data.paused ? <p className="-mt-3 mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">This queue is paused: submissions are accepted and wait; running executions continue; nothing new starts until it is resumed.</p> : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Waiting" value={data.counts.waiting} tone="neutral" />
        <StatCard label="Queued" value={data.counts.queued} tone="info" />
        <StatCard label="Active" value={data.counts.running} tone="primary" hint={data.concurrencyLimit ? `limit ${data.concurrencyLimit}` : 'no limit'} />
        <StatCard label="Delayed" value={data.counts.delayed} tone="delayed" />
        <StatCard label="Retrying" value={data.counts.retrying} tone="warning" />
        <StatCard label="Completed 24h" value={counts.SUCCEEDED ?? 0} tone="success" loading={stats.isLoading} />
        <StatCard label="Failed 24h" value={failed} tone="danger" loading={stats.isLoading} />
        <StatCard label="Duration p50" value={formatDuration(stats.data?.durationMs.p50)} hint={`p95 ${formatDuration(stats.data?.durationMs.p95)}`} loading={stats.isLoading} />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <ChartCard title="Throughput" description={`Executions per hour (24h) · ${((counts.SUCCEEDED ?? 0) / 24).toFixed(1)} completed/h on average`} loading={series.isLoading} error={series.error} empty={!chart.some((point) => point.Completed + point.Failed > 0)}>
          <ResponsiveContainer>
            <BarChart data={chart}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="at" tickFormatter={(at: string) => bucketLabel(at, 'hour')} {...axisProps} minTickGap={24} />
              <YAxis allowDecimals={false} width={32} {...axisProps} />
              <ChartTooltipBase content={<ChartTooltip />} cursor={{ fill: 'var(--color-muted)' }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Completed" stackId="t" fill={CHART.success} />
              <Bar dataKey="Failed" stackId="t" fill={CHART.danger} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <Card>
          <CardHeader><CardTitle>Executors</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">Jobs in this queue use: {modes.size ? [...modes].map((mode) => MODE_LABEL[mode]).join(', ') : 'no jobs yet'}. Queues are admission lanes; executors are not assigned per queue.</p>
            {modes.has('WORKER') || modes.has('HTTP') ? (
              <div>
                <p className="mb-1 text-xs font-medium">Online workers ({onlineWorkers.length})</p>
                {onlineWorkers.length ? (
                  <ul className="space-y-1">
                    {onlineWorkers.slice(0, 6).map((worker) => (
                      <li key={worker.id} className="flex items-center justify-between gap-2">
                        <Link href={`/workers/${worker.id}`} className="flex items-center gap-2 truncate hover:underline"><StatusDot tone={EXECUTOR_STATUS[worker.status].tone} />{worker.hostname ?? worker.instanceId}</Link>
                        <span className="text-xs text-muted-foreground tabular">{worker.runningExecutions ?? 0}/{worker.concurrency}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">None (webhooks may still be delivered by the server&apos;s embedded worker).</p>}
              </div>
            ) : null}
            {modes.has('AGENT') ? <p className="text-xs"><Link href="/agents" className="text-primary hover:underline">Agents</Link> pick up agent jobs that match their registered handlers.</p> : null}
            <div>
              <p className="mb-1 text-xs font-medium">Jobs ({jobs.data?.length ?? 0})</p>
              <ul className="flex flex-wrap gap-1">{(jobs.data ?? []).slice(0, 12).map((job) => <li key={job.id}><Link href={`/jobs/${job.id}`}><Badge tone="outline" className="font-mono hover:bg-muted">{job.name}</Badge></Link></li>)}</ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <div className="px-3 pt-2">
            <TabsList>
              {QUEUE_TABS.map((item) => {
                const live = { waiting: data.counts.waiting, delayed: data.counts.delayed, queued: data.counts.queued, active: data.counts.running, retrying: data.counts.retrying } as Record<string, number>;
                return <TabsTrigger key={item.key} value={item.key}>{item.label}{live[item.key] !== undefined ? <Badge tone="neutral" className="px-1 py-0 text-[10px]">{live[item.key]}</Badge> : null}</TabsTrigger>;
              })}
            </TabsList>
          </div>
          {QUEUE_TABS.map((item) => (
            <TabsContent key={item.key} value={item.key} className="pt-0">
              <p className="px-4 py-2 text-xs text-muted-foreground">{item.description}</p>
              {tab === item.key ? (
                <ExecutionsTable
                  projectId={projectId}
                  filters={{ ...item.filters, queue: data.name }}
                  columns={item.key === 'delayed' || item.key === 'waiting' ? ['id', 'job', 'kind', 'status', 'scheduled', 'attempt', 'actions'] : item.key === 'failed' ? ['id', 'job', 'status', 'started', 'attempt', 'error', 'actions'] : ['id', 'job', 'kind', 'status', 'started', 'duration', 'attempt', 'actions']}
                  emptyTitle={`No ${item.label.toLowerCase()} jobs`}
                  onInspect={setInspect}
                />
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      </Card>

      {can('ADMIN') ? (
        <Card className="mt-4">
          <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
          <CardContent>
            {activity.isLoading ? <Skeleton className="h-16" /> : activity.data?.items.length ? (
              <ul className="divide-y divide-border">
                {activity.data.items.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span><span className="font-mono text-xs">{entry.action}</span> <span className="text-muted-foreground">by {entry.actor.name ?? entry.actor.type.toLowerCase()}</span></span>
                    <span className="text-xs text-muted-foreground" title={formatDateTime(entry.createdAt)}>{timeAgo(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">No queue changes recorded.</p>}
          </CardContent>
        </Card>
      ) : null}

      <QueueDialog projectId={projectId} queue={data} open={editing} onOpenChange={setEditing} />
      <ExecutionInspector projectId={projectId} executionId={inspect} onClose={() => setInspect(null)} />
    </div>
  );
}
