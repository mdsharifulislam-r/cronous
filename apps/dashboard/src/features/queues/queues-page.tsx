'use client';
import { useQuery } from '@tanstack/react-query';
import { Layers, MoreHorizontal, Pause, Play, Plus, Search, Send, Settings2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { StatusDot } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatNumber } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { useRealtime } from '@/providers/realtime-provider';
import { executionsService, queuesService } from '@/services';
import type { Queue } from '@/types/api';
import { QueueDialog } from './queue-dialog';
import { useQueueActions } from './use-queue-actions';

export function queueHealth(queue: Queue): { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' } {
  if (queue.paused) return { label: 'Paused', tone: 'warning' };
  const occupied = queue.counts.queued + queue.counts.running;
  if (queue.concurrencyLimit !== null && occupied >= queue.concurrencyLimit && queue.counts.waiting > 0) return { label: 'At limit', tone: 'info' };
  if (queue.counts.waiting + queue.counts.queued + queue.counts.running + queue.counts.delayed + queue.counts.retrying === 0) return { label: 'Idle', tone: 'neutral' };
  return { label: 'Active', tone: 'success' };
}

function QueueStats({ projectId, name }: { projectId: string; name: string }) {
  const stats = useQuery({ queryKey: qk.stats(projectId, { queue: name, hours: 24 }), queryFn: () => executionsService.stats(projectId, { queue: name, hours: 24 }), staleTime: 60_000 });
  const counts = stats.data?.executions ?? {};
  return (
    <>
      <TableCell className="text-right tabular">{stats.isLoading ? '…' : formatNumber(counts.SUCCEEDED ?? 0)}</TableCell>
      <TableCell className="text-right tabular">{stats.isLoading ? '…' : <span className={(counts.FAILED ?? 0) + (counts.DEAD_LETTERED ?? 0) ? 'text-danger' : ''}>{formatNumber((counts.FAILED ?? 0) + (counts.DEAD_LETTERED ?? 0))}</span>}</TableCell>
      <TableCell className="text-right text-xs tabular text-muted-foreground">{stats.isLoading ? '…' : `${((counts.SUCCEEDED ?? 0) / 24).toFixed(1)}/h`}</TableCell>
    </>
  );
}

export function QueuesPage() {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const router = useRouter();
  const { fallbackInterval } = useRealtime();
  const queues = useQuery({ queryKey: qk.queues(projectId), queryFn: () => queuesService.list(projectId), refetchInterval: fallbackInterval || 30_000 });
  const actions = useQueueActions(projectId);
  const [search, setSearch] = useState('');
  const [state, setState] = useState('all');
  const [dialog, setDialog] = useState<{ open: boolean; queue?: Queue }>({ open: false });
  const [deleting, setDeleting] = useState<Queue | null>(null);

  const rows = (queues.data ?? []).filter((queue) => {
    if (search && !queue.name.includes(search.toLowerCase()) && !(queue.description ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    if (state !== 'all' && queueHealth(queue).label !== state) return false;
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Queues"
        description="Admission lanes for all executions: concurrency limits, priority and pause. Submit jobs for immediate or delayed execution."
        actions={
          <>
            {can('MEMBER') ? <Button variant="secondary" asChild><Link href="/queues/submit"><Send /> Submit job</Link></Button> : null}
            {can('ADMIN') ? <Button onClick={() => setDialog({ open: true })}><Plus /> Create queue</Button> : null}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search queues" placeholder="Search queues" className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <Select value={state} onValueChange={setState}>
            <SelectTrigger className="w-36" aria-label="Queue state"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              {['Active', 'At limit', 'Paused', 'Idle'].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {queues.isLoading ? <TableSkeleton columns={8} /> : queues.error ? <div className="p-4"><ErrorState error={queues.error} onRetry={() => void queues.refetch()} /></div> : rows.length === 0 ? (
          <div className="p-4"><EmptyState icon={Layers} title={search || state !== 'all' ? 'No queues match' : 'No queues'} /></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Queue</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Jobs</TableHead>
                <TableHead className="text-right"><Tooltip content="Due, waiting for admission (paused or at limit)"><span>Waiting</span></Tooltip></TableHead>
                <TableHead className="text-right"><Tooltip content="Admitted, waiting for an executor"><span>Queued</span></Tooltip></TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Delayed</TableHead>
                <TableHead className="text-right">Retrying</TableHead>
                <TableHead className="text-right">Completed 24h</TableHead>
                <TableHead className="text-right">Failed 24h</TableHead>
                <TableHead className="text-right">Throughput</TableHead>
                <TableHead>Concurrency</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((queue) => {
                const health = queueHealth(queue);
                return (
                  <TableRow key={queue.id}>
                    <TableCell>
                      <Link href={`/queues/${queue.name}`} className="font-mono font-medium hover:underline">{queue.name}</Link>
                      {queue.description ? <p className="max-w-56 truncate text-xs text-muted-foreground">{queue.description}</p> : null}
                    </TableCell>
                    <TableCell><Badge tone={health.tone}><StatusDot tone={health.tone} />{health.label}</Badge></TableCell>
                    <TableCell className="text-right tabular">{queue.jobs}</TableCell>
                    <TableCell className="text-right tabular">{queue.counts.waiting}</TableCell>
                    <TableCell className="text-right tabular">{queue.counts.queued}</TableCell>
                    <TableCell className="text-right tabular">{queue.counts.running}</TableCell>
                    <TableCell className="text-right tabular">{queue.counts.delayed}</TableCell>
                    <TableCell className="text-right tabular">{queue.counts.retrying}</TableCell>
                    <QueueStats projectId={projectId} name={queue.name} />
                    <TableCell className="text-xs tabular">{queue.concurrencyLimit ? `${queue.counts.queued + queue.counts.running} / ${queue.concurrencyLimit}` : 'unlimited'}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for queue ${queue.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => router.push(`/queues/${queue.name}`)}><Layers /> Inspect jobs</DropdownMenuItem>
                          {can('MEMBER') ? <DropdownMenuItem onSelect={() => router.push(`/queues/submit?queue=${queue.name}`)}><Send /> Submit to this queue</DropdownMenuItem> : null}
                          {can('MEMBER') ? (queue.paused
                            ? <DropdownMenuItem onSelect={() => actions.resume.mutate(queue.name)}><Play /> Resume</DropdownMenuItem>
                            : <DropdownMenuItem onSelect={() => actions.pause.mutate(queue.name)}><Pause /> Pause</DropdownMenuItem>) : null}
                          {can('ADMIN') ? <DropdownMenuItem onSelect={() => setDialog({ open: true, queue })}><Settings2 /> Edit limits</DropdownMenuItem> : null}
                          {can('ADMIN') && queue.name !== 'default' ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive onSelect={() => setDeleting(queue)}><Trash2 /> Delete</DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      <QueueDialog projectId={projectId} {...(dialog.queue ? { queue: dialog.queue } : {})} open={dialog.open} onOpenChange={(open) => setDialog((current) => ({ ...current, open }))} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete queue ${deleting?.name}?`}
        description="Only empty queues can be deleted: move its jobs to another queue and let unfinished executions finish first. The server refuses otherwise."
        confirmLabel="Delete queue"
        destructive
        onConfirm={() => actions.remove.mutateAsync(deleting!.name)}
      />
    </div>
  );
}
