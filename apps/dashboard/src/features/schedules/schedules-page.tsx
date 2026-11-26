'use client';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, ListOrdered, Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { StatusBadge, StatusDot } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { browserTimeZone, formatDateTime, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { EXECUTION_STATUS, jobStatus } from '@/lib/status';
import { cn } from '@/lib/utils';
import { useRealtime } from '@/providers/realtime-provider';
import { executionsService, jobsService, schedulesService } from '@/services';
import type { Job } from '@/types/api';
import { useJobActions } from '../jobs/use-job-actions';
import { cronCategory, dayKey, groupByDay, monthGrid, timeInZone } from './schedule-utils';

const MAX_RANGE_MS = 92 * 86_400_000; // the API allows 93 days

interface CalendarItem {
  at: string;
  jobId: string;
  jobName: string;
  past: boolean;
  status?: keyof typeof EXECUTION_STATUS;
  executionId?: string;
}

function NextOccurrences({ projectId, job }: { projectId: string; job: Job }) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({ queryKey: ['job-preview', projectId, job.id, job.schedule?.version], queryFn: () => schedulesService.jobPreview(projectId, job.id, 10), enabled: open });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Next occurrences of ${job.name}`}><ListOrdered /></Button></PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="mb-2 text-xs font-medium">Next 10 runs ({job.schedule?.timezone})</p>
        {preview.isLoading ? <Skeleton className="h-32" /> : preview.data?.occurrences.length ? (
          <ol className="space-y-0.5 font-mono text-xs">{preview.data.occurrences.map((at) => <li key={at}>{formatDateTime(at, job.schedule?.timezone)}</li>)}</ol>
        ) : <p className="text-xs text-muted-foreground">No upcoming runs.</p>}
      </PopoverContent>
    </Popover>
  );
}

export function SchedulesPage() {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const { fallbackInterval } = useRealtime();
  const [zoneChoice, setZoneChoice] = useState<'project' | 'browser' | 'UTC'>('project');
  const zone = zoneChoice === 'project' ? project!.timezone : zoneChoice === 'browser' ? browserTimeZone() : 'UTC';
  const today = dayKey(new Date(), zone);
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }));
  const [jobFilter, setJobFilter] = useState('all');
  const [selectedDay, setSelectedDay] = useState<string | null>(today);
  const actions = useJobActions(projectId);

  const weeks = monthGrid(cursor.year, cursor.month);
  const gridStart = new Date(`${weeks[0]![0]}T00:00:00Z`).getTime() - 14 * 3600_000; // margin for time zones
  const gridEnd = new Date(`${weeks.at(-1)![6]}T23:59:59Z`).getTime() + 14 * 3600_000;
  const now = Date.now();
  const upcomingFrom = Math.max(gridStart, now);
  const upcomingTo = Math.min(gridEnd, now + MAX_RANGE_MS);
  const jobId = jobFilter === 'all' ? undefined : jobFilter;

  const jobs = useQuery({ queryKey: qk.jobs(projectId, {}), queryFn: () => jobsService.list(projectId), refetchInterval: fallbackInterval || 60_000 });
  const upcoming = useQuery({
    queryKey: qk.upcoming(projectId, { from: Math.floor(upcomingFrom / 60_000), to: Math.floor(upcomingTo / 60_000), jobId }),
    queryFn: () => schedulesService.upcoming(projectId, { from: new Date(upcomingFrom).toISOString(), to: new Date(upcomingTo).toISOString(), ...(jobId ? { jobId } : {}) }),
    enabled: upcomingTo > upcomingFrom,
  });
  const past = useQuery({
    queryKey: qk.executions(projectId, { trigger: 'SCHEDULE', from: gridStart, to: Math.min(gridEnd, now), jobId, limit: 100 }),
    queryFn: () => executionsService.list(projectId, { trigger: 'SCHEDULE', from: new Date(gridStart).toISOString(), to: new Date(Math.min(gridEnd, now)).toISOString(), limit: 100, ...(jobId ? { jobId } : {}) }),
    enabled: gridStart < now,
  });
  const next7 = useQuery({
    queryKey: qk.upcoming(projectId, { next7: true, jobId }),
    queryFn: () => schedulesService.upcoming(projectId, { to: new Date(Date.now() + 7 * 86_400_000).toISOString(), ...(jobId ? { jobId } : {}) }),
  });

  const items: CalendarItem[] = useMemo(() => [
    ...(past.data?.items ?? []).map((execution) => ({ at: execution.scheduledFor, jobId: execution.jobId, jobName: execution.jobName, past: true, status: execution.status, executionId: execution.id })),
    ...(upcoming.data?.occurrences ?? []).map((occurrence) => ({ at: occurrence.at, jobId: occurrence.jobId, jobName: occurrence.jobName, past: false })),
  ], [past.data, upcoming.data]);
  const byDay = useMemo(() => groupByDay(items, zone), [items, zone]);
  const scheduled = (jobs.data ?? []).filter((job) => job.schedule && (!jobId || job.id === jobId));
  const monthLabel = new Date(Date.UTC(cursor.year, cursor.month, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const move = (delta: number) => setCursor((current) => {
    const date = new Date(Date.UTC(current.year, current.month + delta, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
  });
  const dayItems = selectedDay ? (byDay.get(selectedDay) ?? []).sort((a, b) => a.at.localeCompare(b.at)) : [];

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Cron and one-time schedules. Future runs are calculated by the server; past runs are recorded executions. Delayed queue jobs are not schedules; see Queues."
        actions={
          <>
            <Select value={jobFilter} onValueChange={setJobFilter}>
              <SelectTrigger className="w-48" aria-label="Job"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scheduled jobs</SelectItem>
                {(jobs.data ?? []).filter((job) => job.schedule).map((job) => <SelectItem key={job.id} value={job.id}>{job.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={zoneChoice} onValueChange={(value) => setZoneChoice(value as typeof zoneChoice)}>
              <SelectTrigger className="w-56" aria-label="Display time zone"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="project">Project zone ({project!.timezone})</SelectItem>
                <SelectItem value="browser">My zone ({browserTimeZone()})</SelectItem>
                <SelectItem value="UTC">UTC</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="items-center">
            <CardTitle>{monthLabel}</CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" onClick={() => move(-1)} aria-label="Previous month"><ChevronLeft /></Button>
              <Button variant="secondary" size="sm" onClick={() => { setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }); setSelectedDay(today); }}>Today</Button>
              <Button variant="ghost" size="icon-sm" onClick={() => move(1)} aria-label="Next month"><ChevronRight /></Button>
            </div>
          </CardHeader>
          <CardContent>
            {upcoming.error ? <ErrorState error={upcoming.error} className="mb-3" /> : null}
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border text-xs" role="grid" aria-label={`Calendar ${monthLabel}`}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div key={day} role="columnheader" className="bg-surface-raised px-2 py-1.5 font-medium text-muted-foreground">{day}</div>)}
              {weeks.flat().map((day) => {
                const inMonth = Number(day.slice(5, 7)) - 1 === cursor.month;
                const list = byDay.get(day) ?? [];
                return (
                  <button
                    key={day}
                    type="button"
                    role="gridcell"
                    aria-selected={selectedDay === day}
                    aria-label={`${day}: ${list.length} runs`}
                    onClick={() => setSelectedDay(day)}
                    className={cn('min-h-24 bg-surface p-1.5 text-left align-top transition-colors hover:bg-muted/60', !inMonth && 'bg-background text-muted-foreground', selectedDay === day && 'ring-2 ring-primary ring-inset')}
                  >
                    <span className={cn('mb-1 inline-flex size-5 items-center justify-center rounded-full tabular', day === today && 'bg-primary text-primary-foreground')}>{Number(day.slice(8))}</span>
                    <ul className="space-y-0.5">
                      {list.slice(0, 3).map((item) => (
                        <li key={`${item.jobId}-${item.at}`} className={cn('flex items-center gap-1 truncate rounded px-1', item.past ? 'text-muted-foreground' : 'bg-primary/10')}>
                          {item.past && item.status ? <StatusDot tone={EXECUTION_STATUS[item.status].tone} /> : null}
                          <span className="tabular">{timeInZone(item.at, zone)}</span>
                          <span className="truncate">{item.jobName}</span>
                        </li>
                      ))}
                      {list.length > 3 ? <li className="px-1 text-muted-foreground">+{list.length - 3} more</li> : null}
                    </ul>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {upcoming.data?.truncated ? 'Some frequent schedules were capped; pick a job to see all its runs. ' : ''}
              {past.data?.nextCursor ? 'Only the latest 100 past runs of this view are shown. ' : ''}
              Times in {zone}.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>{selectedDay ? new Date(`${selectedDay}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'Select a day'}</CardTitle></CardHeader>
            <CardContent>
              {dayItems.length ? (
                <ul className="divide-y divide-border">
                  {dayItems.map((item) => (
                    <li key={`${item.jobId}-${item.at}`} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="font-mono text-xs tabular">{timeInZone(item.at, zone)}</span>
                        <Link href={item.executionId ? `/executions/${item.executionId}` : `/jobs/${item.jobId}`} className="truncate hover:underline">{item.jobName}</Link>
                      </span>
                      {item.status ? <StatusBadge view={EXECUTION_STATUS[item.status]} /> : <Badge tone="primary">Upcoming</Badge>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">No scheduled runs on this day.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Next 7 days</CardTitle></CardHeader>
            <CardContent>
              {next7.isLoading ? <Skeleton className="h-32" /> : next7.data?.occurrences.length ? (
                <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                  {next7.data.occurrences.slice(0, 50).map((occurrence) => (
                    <li key={`${occurrence.jobId}-${occurrence.at}`} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <Link href={`/jobs/${occurrence.jobId}`} className="truncate hover:underline">{occurrence.jobName}</Link>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground" title={formatDateTime(occurrence.at, zone)}>{formatDateTime(occurrence.at, zone, false).slice(5)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">Nothing scheduled in the next 7 days.</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle>Scheduled jobs</CardTitle></CardHeader>
        {jobs.isLoading ? <TableSkeleton columns={7} /> : scheduled.length === 0 ? (
          <div className="p-4"><EmptyState icon={CalendarClock} title="No scheduled jobs" description="Give a job a cron expression or a one-time date to see it here." {...(can('MEMBER') ? { action: <Button asChild size="sm"><Link href="/jobs/new">Create job</Link></Button> } : {})} /></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Job</TableHead><TableHead>Schedule</TableHead><TableHead>Pattern</TableHead><TableHead>Time zone</TableHead><TableHead>Next run</TableHead><TableHead>Previous run</TableHead><TableHead>Status</TableHead><TableHead className="w-24"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scheduled.map((job) => {
                const schedule = job.schedule!;
                return (
                  <TableRow key={job.id}>
                    <TableCell><Link href={`/jobs/${job.id}`} className="font-medium hover:underline">{job.name}</Link></TableCell>
                    <TableCell className="font-mono text-xs">{schedule.type === 'CRON' ? schedule.cron : formatDateTime(schedule.runAt, schedule.timezone, false)}</TableCell>
                    <TableCell><Badge tone={schedule.type === 'ONCE' ? 'delayed' : 'info'}>{schedule.type === 'ONCE' ? 'One-time' : cronCategory(schedule.cron)}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{schedule.timezone}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap" title={formatDateTime(schedule.nextRunAt, schedule.timezone)}>{schedule.nextRunAt ? `${formatDateTime(schedule.nextRunAt, schedule.timezone, false)} · ${timeAgo(schedule.nextRunAt)}` : '—'}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{schedule.lastScheduledAt ? `${formatDateTime(schedule.lastScheduledAt, schedule.timezone, false)}` : '—'}</TableCell>
                    <TableCell><StatusBadge view={jobStatus(job)} /></TableCell>
                    <TableCell className="text-right">
                      <NextOccurrences projectId={projectId} job={job} />
                      {can('MEMBER') && schedule.state === 'ACTIVE' ? <Button variant="ghost" size="icon-sm" aria-label={`Pause ${job.name}`} onClick={() => actions.pause.mutate(job)}><Pause /></Button> : null}
                      {can('MEMBER') && schedule.state === 'PAUSED' ? <Button variant="ghost" size="icon-sm" aria-label={`Resume ${job.name}`} onClick={() => actions.resume.mutate(job)}><Play /></Button> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
