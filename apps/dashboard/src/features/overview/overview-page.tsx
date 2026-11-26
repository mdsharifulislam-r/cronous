'use client';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Bot, Clock, Layers, ListChecks, PauseCircle, Play, Server, Timer } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as ChartTooltipBase, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/charts/chart-card';
import { CHART, ChartTooltip, axisProps, bucketLabel } from '@/components/charts/chart-theme';
import { PageHeader } from '@/components/shared/page-header';
import { RANGES, RangeSelect, rangeOf, type RangeKey } from '@/components/shared/range-select';
import { StatCard } from '@/components/shared/stat-card';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { StatusBadge, StatusDot } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, formatDuration, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { EXECUTOR_STATUS, MODE_LABEL, executionStatusView } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { activityService, agentsService, executionsService, queuesService, schedulesService, workersService } from '@/services';
import type { Timeseries } from '@/types/api';

const sum = (values: (number | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

function SectionCard({ title, href, linkLabel = 'View all', children }: { title: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {href ? <Link href={href} className="text-xs text-muted-foreground hover:text-foreground">{linkLabel}</Link> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ListSkeleton() {
  return <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
}

export function OverviewPage() {
  const { project, organization, can } = useWorkspace();
  const projectId = project!.id;
  const [range, setRange] = useState<RangeKey>('24h');
  const { hours, bucket } = rangeOf(range);
  const { fallbackInterval } = useRealtime();
  const poll = { refetchInterval: fallbackInterval || 60_000 };

  const stats = useQuery({ queryKey: qk.stats(projectId, { hours }), queryFn: () => executionsService.stats(projectId, { hours }), ...poll });
  const series = useQuery({ queryKey: qk.timeseries(projectId, { hours, bucket }), queryFn: () => executionsService.timeseries(projectId, { hours, bucket }), ...poll });
  const queues = useQuery({ queryKey: qk.queues(projectId), queryFn: () => queuesService.list(projectId), ...poll });
  const workers = useQuery({ queryKey: qk.workers, queryFn: workersService.list, ...poll });
  const agents = useQuery({ queryKey: qk.agents(projectId), queryFn: () => agentsService.list(projectId), ...poll });
  const recent = useQuery({ queryKey: qk.executions(projectId, { limit: 8 }), queryFn: () => executionsService.list(projectId, { limit: 8 }), ...poll });
  const failed = useQuery({ queryKey: qk.executions(projectId, { status: 'failed', limit: 6 }), queryFn: () => executionsService.list(projectId, { status: ['FAILED', 'DEAD_LETTERED'], limit: 6 }), ...poll });
  const [upcomingTo] = useState(() => new Date(Date.now() + 24 * 3600_000).toISOString());
  const upcoming = useQuery({ queryKey: qk.upcoming(projectId, { to: '24h' }), queryFn: () => schedulesService.upcoming(projectId, { to: upcomingTo }), ...poll });
  const activity = useQuery({
    queryKey: qk.activity(organization!.id, { projectId, limit: 8 }),
    queryFn: () => activityService.list(organization!.id, { projectId, limit: 8 }),
    enabled: can('ADMIN'),
  });

  // Queue throughput: one time series per queue (top 5 by backlog), completed executions per bucket.
  const topQueues = (queues.data ?? []).slice().sort((a, b) => b.counts.waiting + b.counts.queued - (a.counts.waiting + a.counts.queued)).slice(0, 5);
  const throughput = useQueries({
    queries: topQueues.map((queue) => ({
      queryKey: qk.timeseries(projectId, { hours, bucket, queue: queue.name }),
      queryFn: () => executionsService.timeseries(projectId, { hours, bucket, queue: queue.name }),
    })),
  });

  const executions = stats.data?.executions ?? {};
  const failedCount = sum([executions.FAILED, executions.DEAD_LETTERED]);
  const queueCounts = queues.data ?? [];
  const onlineWorkers = (workers.data ?? []).filter((worker) => worker.status === 'ONLINE').length;
  const points = series.data?.points ?? [];
  const volume = points.map((point) => ({
    at: point.at,
    Completed: point.counts.SUCCEEDED ?? 0,
    Failed: (point.counts.FAILED ?? 0) + (point.counts.DEAD_LETTERED ?? 0),
    Other: sum([point.counts.PENDING, point.counts.QUEUED, point.counts.RUNNING, point.counts.RETRY_SCHEDULED, point.counts.CANCELLED]),
  }));
  const anyVolume = volume.some((point) => point.Completed + point.Failed + point.Other > 0);
  const durations = points.map((point) => ({ at: point.at, p50: point.durationMs?.p50 ?? null, p95: point.durationMs?.p95 ?? null }));
  const kinds = points.map((point) => ({ at: point.at, Immediate: point.byKind?.immediate ?? 0, Delayed: point.byKind?.delayed ?? 0, Scheduled: point.byKind?.scheduled ?? 0, Manual: point.byKind?.manual ?? 0 }));
  const modes = (Object.entries(stats.data?.byMode ?? {}) as [keyof typeof MODE_LABEL, number][]).map(([mode, value]) => ({ name: MODE_LABEL[mode], value, mode }));
  const throughputData = points.map((point, index) => {
    const row: Record<string, string | number> = { at: point.at };
    topQueues.forEach((queue, queueIndex) => {
      const queuePoint = (throughput[queueIndex]?.data as Timeseries | undefined)?.points[index];
      row[queue.name] = queuePoint?.counts.SUCCEEDED ?? 0;
    });
    return row;
  });
  const QUEUE_COLORS = [CHART.primary, CHART.success, CHART.warning, CHART.delayed, CHART.info];
  const tick = (at: string) => bucketLabel(at, bucket);

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`${project!.name} · statistics for the last ${RANGES.find((r) => r.key === range)?.label}`}
        actions={
          <>
            <RangeSelect value={range} onChange={setRange} />
            <Button asChild size="sm"><Link href="/queues/submit"><Play /> Submit job</Link></Button>
          </>
        }
      />

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Total jobs" value={stats.data?.jobs} icon={ListChecks} href="/jobs" loading={stats.isLoading} />
        <StatCard label="Enabled jobs" value={stats.data?.jobsEnabled} icon={Activity} tone="success" loading={stats.isLoading} href="/jobs" />
        <StatCard label="Paused schedules" value={stats.data?.jobsPaused} icon={PauseCircle} tone="warning" loading={stats.isLoading} href="/schedules" />
        <StatCard label="Queues" value={queueCounts.length} icon={Layers} href="/queues" loading={queues.isLoading} />
        <StatCard label="Waiting jobs" value={sum(queueCounts.map((q) => q.counts.waiting + q.counts.queued + q.counts.retrying))} hint="Due, not yet running" icon={Clock} tone="info" loading={queues.isLoading} href="/queues" />
        <StatCard label="Active executions" value={sum(queueCounts.map((q) => q.counts.running))} icon={Timer} tone="primary" loading={queues.isLoading} href="/executions?status=RUNNING" />
        <StatCard label="Delayed jobs" value={sum(queueCounts.map((q) => q.counts.delayed))} hint="Waiting for their run time" icon={Clock} tone="delayed" loading={queues.isLoading} href="/executions?delayed=true" />
        <StatCard label="Failed executions" value={failedCount} hint={`In the last ${RANGES.find((r) => r.key === range)?.label}`} icon={AlertTriangle} tone="danger" loading={stats.isLoading} href="/executions?status=FAILED,DEAD_LETTERED" />
        <StatCard label="Connected agents" value={stats.data?.agentsOnline} icon={Bot} tone="success" loading={stats.isLoading} href="/agents" />
        <StatCard label="Active workers" value={onlineWorkers} hint="Installation-wide" icon={Server} tone="success" loading={workers.isLoading} href="/workers" />
      </section>

      <section aria-label="Analytics" className="mt-6 grid gap-4 xl:grid-cols-2">
        <ChartCard title="Execution volume" description="Executions created per period, by outcome" loading={series.isLoading} error={series.error} onRetry={() => void series.refetch()} empty={!anyVolume}>
          <ResponsiveContainer>
            <BarChart data={volume}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="at" tickFormatter={tick} {...axisProps} minTickGap={24} />
              <YAxis allowDecimals={false} width={32} {...axisProps} />
              <ChartTooltipBase content={<ChartTooltip />} cursor={{ fill: 'var(--color-muted)' }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Completed" stackId="a" fill={CHART.success} />
              <Bar dataKey="Failed" stackId="a" fill={CHART.danger} />
              <Bar dataKey="Other" stackId="a" fill={CHART.neutral} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Successful vs failed" loading={series.isLoading} error={series.error} empty={!anyVolume}>
          <ResponsiveContainer>
            <LineChart data={volume}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="at" tickFormatter={tick} {...axisProps} minTickGap={24} />
              <YAxis allowDecimals={false} width={32} {...axisProps} />
              <ChartTooltipBase content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="Completed" stroke={CHART.success} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Failed" stroke={CHART.danger} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Execution duration" description={`Successful executions, start to finish · p50 ${formatDuration(stats.data?.durationMs.p50)} · p95 ${formatDuration(stats.data?.durationMs.p95)}`} loading={series.isLoading} error={series.error} empty={!durations.some((point) => point.p50 !== null)} emptyText="No successful executions in this period">
          <ResponsiveContainer>
            <LineChart data={durations}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="at" tickFormatter={tick} {...axisProps} minTickGap={24} />
              <YAxis width={56} tickFormatter={(value: number) => formatDuration(value)} {...axisProps} />
              <ChartTooltipBase content={<ChartTooltip formatter={formatDuration} />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="p50" name="p50" stroke={CHART.primary} strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="p95" name="p95" stroke={CHART.warning} strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Queue throughput" description="Completed executions per period, busiest queues" loading={queues.isLoading || throughput.some((query) => query.isLoading)} error={queues.error} empty={!throughputData.some((row) => topQueues.some((queue) => Number(row[queue.name]) > 0))}>
          <ResponsiveContainer>
            <LineChart data={throughputData}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="at" tickFormatter={tick} {...axisProps} minTickGap={24} />
              <YAxis allowDecimals={false} width={32} {...axisProps} />
              <ChartTooltipBase content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              {topQueues.map((queue, index) => <Line key={queue.id} type="monotone" dataKey={queue.name} stroke={QUEUE_COLORS[index]} strokeWidth={2} dot={false} />)}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Queue backlog" description="Current executions per queue (live counts; history is not recorded)" loading={queues.isLoading} error={queues.error} empty={!queueCounts.some((q) => q.counts.waiting + q.counts.queued + q.counts.delayed + q.counts.running + q.counts.retrying > 0)} emptyText="All queues are empty">
          <ResponsiveContainer>
            <BarChart data={queueCounts.map((q) => ({ name: q.name, Waiting: q.counts.waiting + q.counts.queued, Delayed: q.counts.delayed, Retrying: q.counts.retrying, Running: q.counts.running }))}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="name" {...axisProps} />
              <YAxis allowDecimals={false} width={32} {...axisProps} />
              <ChartTooltipBase content={<ChartTooltip />} cursor={{ fill: 'var(--color-muted)' }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Running" stackId="q" fill={CHART.primary} />
              <Bar dataKey="Waiting" stackId="q" fill={CHART.info} />
              <Bar dataKey="Retrying" stackId="q" fill={CHART.warning} />
              <Bar dataKey="Delayed" stackId="q" fill={CHART.delayed} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <div className="grid gap-4 md:grid-cols-2">
          <ChartCard title="By execution mode" loading={stats.isLoading} error={stats.error} empty={modes.length === 0}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={modes} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={2} stroke="var(--color-surface)">
                  {modes.map((entry) => <Cell key={entry.mode} fill={entry.mode === 'HTTP' ? CHART.info : entry.mode === 'AGENT' ? CHART.primary : CHART.success} />)}
                </Pie>
                <ChartTooltipBase content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Delayed vs immediate" description="Queue submissions over time" loading={series.isLoading} error={series.error} empty={!kinds.some((k) => k.Delayed + k.Immediate > 0)} emptyText="No queue submissions in this period">
            <ResponsiveContainer>
              <AreaChart data={kinds}>
                <XAxis dataKey="at" tickFormatter={tick} {...axisProps} minTickGap={24} />
                <YAxis allowDecimals={false} width={28} {...axisProps} />
                <ChartTooltipBase content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="Immediate" stackId="k" stroke={CHART.primary} fill={CHART.primary} fillOpacity={0.25} />
                <Area type="monotone" dataKey="Delayed" stackId="k" stroke={CHART.delayed} fill={CHART.delayed} fillOpacity={0.25} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <SectionCard title="Upcoming scheduled runs" href="/schedules">
          {upcoming.isLoading ? <ListSkeleton /> : upcoming.error ? <ErrorState error={upcoming.error} /> : upcoming.data?.occurrences.length ? (
            <ul className="divide-y divide-border">
              {upcoming.data.occurrences.slice(0, 8).map((occurrence) => (
                <li key={`${occurrence.jobId}-${occurrence.at}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link href={`/jobs/${occurrence.jobId}`} className="truncate hover:underline">{occurrence.jobName}</Link>
                  <span className="shrink-0 text-xs text-muted-foreground tabular" title={formatDateTime(occurrence.at)}>{timeAgo(occurrence.at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No scheduled runs in the next 24 hours</p>}
        </SectionCard>

        <SectionCard title="Recent executions" href="/executions">
          {recent.isLoading ? <ListSkeleton /> : recent.error ? <ErrorState error={recent.error} /> : recent.data?.items.length ? (
            <ul className="divide-y divide-border">
              {recent.data.items.map((execution) => (
                <li key={execution.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link href={`/executions/${execution.id}`} className="min-w-0 truncate hover:underline">{execution.jobName}</Link>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusBadge view={executionStatusView(execution)} />
                    <span className="w-16 text-right text-xs text-muted-foreground">{timeAgo(execution.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No executions yet" description="Executions appear here when jobs run." />}
        </SectionCard>

        <SectionCard title="Recent failures" href="/executions?status=FAILED,DEAD_LETTERED">
          {failed.isLoading ? <ListSkeleton /> : failed.error ? <ErrorState error={failed.error} /> : failed.data?.items.length ? (
            <ul className="divide-y divide-border">
              {failed.data.items.map((execution) => (
                <li key={execution.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/executions/${execution.id}`} className="truncate font-medium hover:underline">{execution.jobName}</Link>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(execution.finishedAt ?? execution.createdAt)}</span>
                  </div>
                  {execution.lastError ? <p className="mt-0.5 truncate font-mono text-xs text-danger">{execution.lastError}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No failed executions</p>}
        </SectionCard>

        <SectionCard title="Queue health" href="/queues">
          {queues.isLoading ? <ListSkeleton /> : queues.error ? <ErrorState error={queues.error} /> : (
            <ul className="divide-y divide-border">
              {queueCounts.map((queue) => {
                const atLimit = queue.concurrencyLimit !== null && queue.counts.queued + queue.counts.running >= queue.concurrencyLimit && queue.counts.waiting > 0;
                return (
                  <li key={queue.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link href={`/queues/${queue.name}`} className="flex min-w-0 items-center gap-2 hover:underline">
                      <StatusDot tone={queue.paused ? 'warning' : atLimit ? 'info' : 'success'} />
                      <span className="truncate font-mono">{queue.name}</span>
                    </Link>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular">
                      {queue.paused ? <Badge tone="warning">Paused</Badge> : atLimit ? <Badge tone="info">At limit</Badge> : null}
                      {queue.counts.running} running · {queue.counts.waiting + queue.counts.queued} waiting
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Agents" href="/agents">
          {agents.isLoading ? <ListSkeleton /> : agents.error ? <ErrorState error={agents.error} /> : agents.data?.length ? (
            <ul className="divide-y divide-border">
              {agents.data.slice(0, 6).map((agent) => (
                <li key={agent.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link href={`/agents/${agent.id}`} className="flex min-w-0 items-center gap-2 hover:underline">
                    <StatusDot tone={EXECUTOR_STATUS[agent.status].tone} />
                    <span className="truncate">{agent.hostname ?? agent.instanceId}</span>
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{agent.handlers.length} handlers · {timeAgo(agent.lastHeartbeatAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No agents have connected to this project</p>}
        </SectionCard>

        <SectionCard title="Workers" href="/workers">
          {workers.isLoading ? <ListSkeleton /> : workers.error ? <ErrorState error={workers.error} /> : workers.data?.length ? (
            <ul className="divide-y divide-border">
              {workers.data.slice(0, 6).map((worker) => (
                <li key={worker.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link href={`/workers/${worker.id}`} className="flex min-w-0 items-center gap-2 hover:underline">
                    <StatusDot tone={EXECUTOR_STATUS[worker.status].tone} />
                    <span className="truncate">{worker.hostname ?? worker.instanceId}</span>
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground tabular">{worker.runningExecutions ?? 0}/{worker.concurrency} busy</span>
                </li>
              ))}
            </ul>
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No central workers registered (the server delivers webhooks itself)</p>}
        </SectionCard>

        {can('ADMIN') ? (
          <SectionCard title="Recent activity" href="/activity">
            {activity.isLoading ? <ListSkeleton /> : activity.error ? <ErrorState error={activity.error} /> : activity.data?.items.length ? (
              <ul className="divide-y divide-border">
                {activity.data.items.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate"><span className="font-mono text-xs">{entry.action}</span> <span className="text-muted-foreground">by {entry.actor.name ?? entry.actor.type.toLowerCase()}</span></span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="py-6 text-center text-sm text-muted-foreground">No activity yet</p>}
          </SectionCard>
        ) : null}
      </section>
    </div>
  );
}
