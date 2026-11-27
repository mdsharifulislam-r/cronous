'use client';
import { useQuery } from '@tanstack/react-query';
import { Bot, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, shortId, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { useRealtime } from '@/providers/realtime-provider';
import { agentsService, projectService } from '@/services';
import { agentHealth } from './health';

export function AgentsPage() {
  const { project } = useWorkspace();
  const projectId = project!.id;
  const { fallbackInterval } = useRealtime();
  const agents = useQuery({ queryKey: qk.agents(projectId), queryFn: () => agentsService.list(projectId), refetchInterval: fallbackInterval || 30_000 });
  const system = useQuery({ queryKey: qk.system, queryFn: projectService.system, staleTime: 300_000 });
  const heartbeat = system.data?.limits.agentHeartbeatMs ?? 10_000;
  const [search, setSearch] = useState('');
  const [state, setState] = useState('all');

  const rows = (agents.data ?? []).filter((agent) => {
    const text = `${agent.hostname ?? ''} ${agent.instanceId} ${agent.handlers.join(' ')}`.toLowerCase();
    if (search && !text.includes(search.toLowerCase())) return false;
    if (state !== 'all' && agentHealth(agent, heartbeat).label !== state) return false;
    return true;
  });

  return (
    <div>
      <PageHeader title="Agents" description="Application processes running @sharifulislam1/cronous for this project. They connect outbound over WebSocket and run agent-mode jobs in-process." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search agents" placeholder="Search host, instance or handler" className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <Select value={state} onValueChange={setState}>
            <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {['Connected', 'Unhealthy', 'Draining', 'Disconnected'].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {agents.isLoading ? <TableSkeleton columns={7} /> : agents.error ? <div className="p-4"><ErrorState error={agents.error} onRetry={() => void agents.refetch()} /></div> : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Bot} title={agents.data?.length ? 'No agents match' : 'No agents have connected'} description={agents.data?.length ? undefined : 'Start your application with new Chronos({ server, project, token }) and chronos.start(). See Documentation.'} />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Agent</TableHead><TableHead>Status</TableHead><TableHead>Handlers</TableHead><TableHead>SDK</TableHead><TableHead>Last heartbeat</TableHead><TableHead>Connected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <Link href={`/agents/${agent.id}`} className="font-medium hover:underline">{agent.hostname ?? agent.instanceId}</Link>
                    <p className="font-mono text-xs text-muted-foreground">{shortId(agent.id)} · {agent.instanceId.slice(0, 12)}</p>
                  </TableCell>
                  <TableCell><StatusBadge view={agentHealth(agent, heartbeat)} /></TableCell>
                  <TableCell className="max-w-72">
                    <div className="flex flex-wrap gap-1">
                      {agent.handlers.slice(0, 4).map((handler) => <Badge key={handler} tone="outline" className="font-mono">{handler}</Badge>)}
                      {agent.handlers.length > 4 ? <Tooltip content={agent.handlers.slice(4).join(', ')}><Badge tone="neutral">+{agent.handlers.length - 4}</Badge></Tooltip> : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{agent.sdkVersion}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap" title={formatDateTime(agent.lastHeartbeatAt)}>{timeAgo(agent.lastHeartbeatAt)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap" title={formatDateTime(agent.connectedAt)}>{agent.status === 'OFFLINE' ? `left ${timeAgo(agent.disconnectedAt)}` : timeAgo(agent.connectedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
