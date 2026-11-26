'use client';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/hooks/use-workspace';
import { qk } from '@/lib/query-keys';
import { EXECUTION_STATUS, MODE_LABEL } from '@/lib/status';
import { agentsService, jobsService, queuesService, workersService } from '@/services';
import type { ExecutionFilters, ExecutionMode, ExecutionStatus, ExecutionTrigger } from '@/types/api';
import { ExecutionInspector } from './execution-inspector';
import { ExecutionsTable } from './executions-table';

const ALL = 'all';
const STATUSES = Object.keys(EXECUTION_STATUS) as ExecutionStatus[];
/** "Kind" filter: delayed and immediate are both trigger QUEUE, split by `delayed`. */
const KINDS = { SCHEDULE: 'Scheduled', MANUAL: 'Manual', QUEUE: 'Queue (immediate + delayed)' } as const;

/** URL search params → API filters. Unknown or invalid values are ignored. */
export function filtersFromParams(params: URLSearchParams): ExecutionFilters {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const status = (params.get('status') ?? '').split(',').filter((item): item is ExecutionStatus => (STATUSES as string[]).includes(item));
  const trigger = params.get('trigger');
  const mode = params.get('mode');
  const date = (key: string, endOfDay: boolean) => {
    const value = params.get(key);
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`).toISOString() : undefined;
  };
  const filters: ExecutionFilters = {};
  if (status.length) filters.status = status;
  if (trigger && trigger in KINDS) filters.trigger = trigger as ExecutionTrigger;
  if (mode && mode in MODE_LABEL) filters.mode = mode as ExecutionMode;
  if (params.get('delayed') === 'true') filters.delayed = true;
  const queue = params.get('queue');
  if (queue && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(queue)) filters.queue = queue;
  for (const key of ['jobId', 'agentId', 'workerId'] as const) {
    const value = params.get(key);
    if (value && uuid.test(value)) filters[key] = value;
  }
  const from = date('from', false);
  const to = date('to', true);
  if (from) filters.from = from;
  if (to) filters.to = to;
  return filters;
}

export function ExecutionsPage() {
  const { project } = useWorkspace();
  const projectId = project!.id;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = filtersFromParams(new URLSearchParams(params.toString()));
  const [inspect, setInspect] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: qk.jobs(projectId, {}), queryFn: () => jobsService.list(projectId) });
  const queues = useQuery({ queryKey: qk.queues(projectId), queryFn: () => queuesService.list(projectId) });
  const agents = useQuery({ queryKey: qk.agents(projectId), queryFn: () => agentsService.list(projectId) });
  const workers = useQuery({ queryKey: qk.workers, queryFn: workersService.list });

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '' || value === ALL) next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };
  const statusValue = params.get('delayed') === 'true' ? 'DELAYED' : (filters.status?.length === 1 ? filters.status[0] : filters.status?.join(',')) ?? ALL;
  const active = params.toString() !== '';

  return (
    <div>
      <PageHeader title="Executions" description="Every run of every job: scheduled, manual, immediate and delayed. Newest first; updates live." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Select
            value={statusValue}
            onValueChange={(value) => {
              const next = new URLSearchParams(params.toString());
              next.delete('delayed');
              next.delete('status');
              if (value === 'DELAYED') next.set('delayed', 'true');
              else if (value !== ALL) next.set('status', value);
              router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false });
            }}
          >
            <SelectTrigger className="w-44" aria-label="Status"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectItem value="DELAYED">Delayed</SelectItem>
              {STATUSES.map((status) => <SelectItem key={status} value={status}>{EXECUTION_STATUS[status].label}</SelectItem>)}
              <SelectItem value="FAILED,DEAD_LETTERED">Failed + dead-lettered</SelectItem>
              <SelectItem value="PENDING,QUEUED,RUNNING,RETRY_SCHEDULED">All unfinished</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.jobId ?? ALL} onValueChange={(value) => set('jobId', value)}>
            <SelectTrigger className="w-48" aria-label="Job"><SelectValue placeholder="All jobs" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All jobs</SelectItem>
              {(jobs.data ?? []).map((job) => <SelectItem key={job.id} value={job.id}>{job.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.trigger ?? ALL} onValueChange={(value) => set('trigger', value)}>
            <SelectTrigger className="w-48" aria-label="Kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All kinds</SelectItem>
              {Object.entries(KINDS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.queue ?? ALL} onValueChange={(value) => set('queue', value)}>
            <SelectTrigger className="w-36" aria-label="Queue"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All queues</SelectItem>
              {(queues.data ?? []).map((queue) => <SelectItem key={queue.id} value={queue.name}>{queue.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.mode ?? ALL} onValueChange={(value) => set('mode', value)}>
            <SelectTrigger className="w-40" aria-label="Mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All modes</SelectItem>
              {(Object.keys(MODE_LABEL) as ExecutionMode[]).map((mode) => <SelectItem key={mode} value={mode}>{MODE_LABEL[mode]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.agentId ?? ALL} onValueChange={(value) => set('agentId', value)}>
            <SelectTrigger className="w-40" aria-label="Agent"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any agent</SelectItem>
              {(agents.data ?? []).map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.hostname ?? agent.instanceId}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.workerId ?? ALL} onValueChange={(value) => set('workerId', value)}>
            <SelectTrigger className="w-40" aria-label="Worker"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any worker</SelectItem>
              {(workers.data ?? []).map((worker) => <SelectItem key={worker.id} value={worker.id}>{worker.hostname ?? worker.instanceId}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <Input type="date" aria-label="Created from" className="w-38" value={params.get('from') ?? ''} onChange={(event) => set('from', event.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" aria-label="Created to" className="w-38" value={params.get('to') ?? ''} onChange={(event) => set('to', event.target.value)} />
          </div>
          {active ? <Button variant="ghost" size="sm" onClick={() => router.replace(pathname)}><X /> Reset</Button> : null}
        </div>
        <ExecutionsTable
          projectId={projectId}
          filters={filters}
          columns={['id', 'job', 'kind', 'queue', 'mode', 'status', 'started', 'duration', 'attempt', 'executor', 'actions']}
          emptyTitle={active ? 'No executions match these filters' : 'No executions yet'}
          onInspect={setInspect}
        />
      </Card>
      <ExecutionInspector projectId={projectId} executionId={inspect} onClose={() => setInspect(null)} />
    </div>
  );
}
