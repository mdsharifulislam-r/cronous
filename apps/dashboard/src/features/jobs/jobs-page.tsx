'use client';
import { useQuery } from '@tanstack/react-query';
import { ListChecks, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Pagination } from '@/components/tables/pagination';
import { SortableHead, compareValues, type SortState } from '@/components/tables/sortable-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { EXECUTION_STATUS, MODE_LABEL, jobStatus, jobType } from '@/lib/status';
import { useRealtime } from '@/providers/realtime-provider';
import { jobsService, queuesService } from '@/services';
import type { ExecutionMode, Job } from '@/types/api';
import { JobActionsMenu } from './job-actions-menu';

type SortKey = 'name' | 'next' | 'last' | 'created' | 'queue';
const PAGE_SIZE = 25;
const ALL = 'all';

export function scheduleText(job: Job): string {
  if (!job.schedule) return 'On demand';
  return job.schedule.type === 'CRON' ? (job.schedule.cron ?? '') : `Once at ${formatDateTime(job.schedule.runAt, job.schedule.timezone, false)}`;
}

/** Filtering, sorting and pagination of the complete job list returned by the API. */
export function filterJobs(jobs: Job[], filters: { type: string; status: string; createdFrom: string; createdTo: string }, sort: SortState<SortKey>): Job[] {
  const from = filters.createdFrom ? new Date(`${filters.createdFrom}T00:00:00`).getTime() : null;
  const to = filters.createdTo ? new Date(`${filters.createdTo}T23:59:59`).getTime() : null;
  const result = jobs.filter((job) => {
    if (filters.type !== ALL && jobType(job).label !== filters.type) return false;
    if (filters.status !== ALL && jobStatus(job).label !== filters.status) return false;
    const created = new Date(job.createdAt).getTime();
    if (from !== null && created < from) return false;
    if (to !== null && created > to) return false;
    return true;
  });
  const value = (job: Job) =>
    sort.key === 'name' ? job.name : sort.key === 'queue' ? job.queue : sort.key === 'next' ? job.schedule?.nextRunAt ?? null : sort.key === 'last' ? job.lastExecution?.createdAt ?? null : job.createdAt;
  return result.sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * compareValues(value(a), value(b)));
}

export function JobsPage() {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const { fallbackInterval } = useRealtime();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<string>(ALL);
  const [queue, setQueue] = useState<string>(ALL);
  const [type, setType] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [sort, setSort] = useState<SortState<SortKey>>({ key: 'name', dir: 'asc' });
  const [page, setPage] = useState(0);

  const serverFilters = { ...(q.trim() ? { q: q.trim() } : {}), ...(mode !== ALL ? { mode: mode as ExecutionMode } : {}), ...(queue !== ALL ? { queue } : {}) };
  const jobs = useQuery({ queryKey: qk.jobs(projectId, serverFilters), queryFn: () => jobsService.list(projectId, serverFilters), refetchInterval: fallbackInterval || 60_000, placeholderData: (previous) => previous });
  const queues = useQuery({ queryKey: qk.queues(projectId), queryFn: () => queuesService.list(projectId) });

  const rows = useMemo(() => filterJobs(jobs.data ?? [], { type, status, createdFrom, createdTo }, sort), [jobs.data, type, status, createdFrom, createdTo, sort]);
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const filtered = Boolean(q || mode !== ALL || queue !== ALL || type !== ALL || status !== ALL || createdFrom || createdTo);
  const reset = () => { setQ(''); setMode(ALL); setQueue(ALL); setType(ALL); setStatus(ALL); setCreatedFrom(''); setCreatedTo(''); setPage(0); };
  const onFilter = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPage(0); };

  return (
    <div>
      <PageHeader
        title="Jobs"
        description="Job definitions: scheduled (cron or one-time) and on-demand jobs you submit for immediate or delayed execution."
        actions={can('MEMBER') ? <Button asChild><Link href="/jobs/new"><Plus /> Create job</Link></Button> : null}
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-border p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search jobs" placeholder="Search name or description" value={q} onChange={(event) => onFilter(setQ)(event.target.value)} className="pl-8" />
          </div>
          <Select value={type} onValueChange={onFilter(setType)}>
            <SelectTrigger className="w-36" aria-label="Job type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              <SelectItem value="Cron">Cron</SelectItem>
              <SelectItem value="One-time">One-time</SelectItem>
              <SelectItem value="On demand">On demand</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={onFilter(setMode)}>
            <SelectTrigger className="w-40" aria-label="Execution mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All modes</SelectItem>
              {(Object.keys(MODE_LABEL) as ExecutionMode[]).map((item) => <SelectItem key={item} value={item}>{MODE_LABEL[item]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={onFilter(setStatus)}>
            <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {['Scheduled', 'Paused', 'Ready', 'Completed', 'Disabled'].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={queue} onValueChange={onFilter(setQueue)}>
            <SelectTrigger className="w-36" aria-label="Queue"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All queues</SelectItem>
              {(queues.data ?? []).map((item) => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <Input type="date" aria-label="Created from" value={createdFrom} onChange={(event) => onFilter(setCreatedFrom)(event.target.value)} className="w-38" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" aria-label="Created to" value={createdTo} onChange={(event) => onFilter(setCreatedTo)(event.target.value)} className="w-38" />
          </div>
          {filtered ? <Button variant="ghost" size="sm" onClick={reset}><X /> Reset</Button> : null}
        </div>

        {jobs.isLoading ? (
          <TableSkeleton columns={7} />
        ) : jobs.error ? (
          <div className="p-4"><ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} /></div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            {filtered ? (
              <EmptyState icon={Search} title="No jobs match these filters" action={<Button variant="secondary" size="sm" onClick={reset}>Reset filters</Button>} />
            ) : (
              <EmptyState icon={ListChecks} title="No jobs yet" description="Create a job here, or declare tasks in your application with the SDK: they appear automatically when the agent connects." {...(can('MEMBER') ? { action: <Button asChild size="sm"><Link href="/jobs/new"><Plus /> Create job</Link></Button> } : {})} />
            )}
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead label="Job" sortKey="name" sort={sort} onSort={setSort} />
                  <TableHead>Type</TableHead>
                  <SortableHead label="Queue" sortKey="queue" sort={sort} onSort={setSort} />
                  <TableHead>Mode</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Time zone</TableHead>
                  <SortableHead label="Next run" sortKey="next" sort={sort} onSort={setSort} />
                  <SortableHead label="Last run" sortKey="last" sort={sort} onSort={setSort} />
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((job) => {
                  const kind = jobType(job);
                  const last = job.lastExecution;
                  return (
                    <TableRow key={job.id}>
                      <TableCell className="max-w-64">
                        <Link href={`/jobs/${job.id}`} className="block truncate font-medium hover:underline">{job.name}</Link>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          {job.source === 'SDK' ? <Tooltip content="Declared in application code with the SDK"><Badge tone="outline" className="px-1 py-0 text-[10px]">SDK</Badge></Tooltip> : null}
                          <span className="truncate">{job.description ?? ''}</span>
                        </span>
                      </TableCell>
                      <TableCell><Badge tone={kind.tone}>{kind.label}</Badge></TableCell>
                      <TableCell><Link href={`/queues/${job.queue}`} className="font-mono text-xs hover:underline">{job.queue}</Link></TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{MODE_LABEL[job.mode]}</TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-xs">{scheduleText(job)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{job.schedule?.timezone ?? '—'}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap tabular">
                        {job.schedule?.nextRunAt ? <Tooltip content={formatDateTime(job.schedule.nextRunAt, job.schedule.timezone)}><span>{timeAgo(job.schedule.nextRunAt)}</span></Tooltip> : '—'}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {last ? (
                          <Link href={`/executions/${last.id}`} className="inline-flex items-center gap-1.5 hover:underline">
                            <span className={`size-1.5 rounded-full ${EXECUTION_STATUS[last.status].tone === 'danger' ? 'bg-danger' : EXECUTION_STATUS[last.status].tone === 'success' ? 'bg-success' : 'bg-neutral'}`} aria-hidden />
                            {timeAgo(last.createdAt)}
                          </Link>
                        ) : <span className="text-muted-foreground">Never</span>}
                      </TableCell>
                      <TableCell><StatusBadge view={jobStatus(job)} /></TableCell>
                      <TableCell><JobActionsMenu job={job} projectId={projectId} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
