'use client';
import { useQuery } from '@tanstack/react-query';
import { Search, Server } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, shortId, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { useRealtime } from '@/providers/realtime-provider';
import { workersService } from '@/services';
import { workerHealth } from '../agents/health';

export function WorkersPage() {
  const { fallbackInterval } = useRealtime();
  const workers = useQuery({ queryKey: qk.workers, queryFn: workersService.list, refetchInterval: fallbackInterval || 15_000 });
  const [search, setSearch] = useState('');
  const [state, setState] = useState('all');
  const rows = (workers.data ?? []).filter((worker) => {
    if (search && !`${worker.hostname ?? ''} ${worker.instanceId}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (state !== 'all' && workerHealth(worker).label !== state) return false;
    return true;
  });
  return (
    <div>
      <PageHeader title="Workers" description="Central worker processes of this Chronos installation (shared by all projects). They deliver webhooks and run central-worker handlers from every queue." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search workers" placeholder="Search host or instance" className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <Select value={state} onValueChange={setState}>
            <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {['Online', 'Busy', 'Unhealthy', 'Draining', 'Offline'].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {workers.isLoading ? <TableSkeleton columns={7} /> : workers.error ? <div className="p-4"><ErrorState error={workers.error} onRetry={() => void workers.refetch()} /></div> : rows.length === 0 ? (
          <div className="p-4"><EmptyState icon={Server} title={workers.data?.length ? 'No workers match' : 'No workers registered'} description={workers.data?.length ? undefined : 'Start workers with docker compose --profile workers, or the server delivers webhooks itself.'} /></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Worker</TableHead><TableHead>Status</TableHead><TableHead>Queues</TableHead><TableHead className="text-right">Running</TableHead><TableHead className="text-right">Concurrency</TableHead><TableHead>Last heartbeat</TableHead><TableHead>Version</TableHead><TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((worker) => (
                <TableRow key={worker.id}>
                  <TableCell>
                    <Link href={`/workers/${worker.id}`} className="font-medium hover:underline">{worker.hostname ?? worker.instanceId}</Link>
                    <p className="font-mono text-xs text-muted-foreground">{shortId(worker.id)}</p>
                  </TableCell>
                  <TableCell><StatusBadge view={workerHealth(worker)} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">All queues</TableCell>
                  <TableCell className="text-right tabular">{worker.runningExecutions ?? 0}</TableCell>
                  <TableCell className="text-right tabular">{worker.concurrency}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap" title={formatDateTime(worker.lastHeartbeatAt)}>{timeAgo(worker.lastHeartbeatAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{worker.version}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap" title={formatDateTime(worker.startedAt)}>{worker.status === 'OFFLINE' ? `stopped ${timeAgo(worker.stoppedAt)}` : timeAgo(worker.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
