'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { PageHeader } from '@/components/shared/page-header';
import { ErrorState, errorMessage } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { useRealtime } from '@/providers/realtime-provider';
import { agentsService, jobsService, projectService } from '@/services';
import { ExecutionsTable } from '../executions/executions-table';
import { agentHealth } from './health';

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const router = useRouter();
  const client = useQueryClient();
  const { fallbackInterval } = useRealtime();
  const agent = useQuery({ queryKey: qk.agent(projectId, agentId), queryFn: () => agentsService.get(projectId, agentId), refetchInterval: fallbackInterval || 15_000 });
  const jobs = useQuery({ queryKey: qk.jobs(projectId, {}), queryFn: () => jobsService.list(projectId) });
  const system = useQuery({ queryKey: qk.system, queryFn: projectService.system, staleTime: 300_000 });
  const credentials = useQuery({ queryKey: qk.credentials(projectId, true), queryFn: () => projectService.credentials(projectId, true), enabled: can('ADMIN') });
  const [confirm, setConfirm] = useState<'revoke' | 'remove' | null>(null);

  const revoke = useMutation({
    mutationFn: (credentialId: string) => projectService.revokeCredential(projectId, credentialId),
    onSuccess: () => { toast.success('Credential revoked: connected agents using it disconnect within about 30 seconds'); void client.invalidateQueries({ queryKey: ['credentials', projectId] }); },
    onError: (error) => toast.error('Revoke failed', { description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => agentsService.remove(projectId, agentId),
    onSuccess: () => { toast.success('Agent record removed'); void client.invalidateQueries({ queryKey: ['agents', projectId] }); router.push('/agents'); },
    onError: (error) => toast.error('Remove failed', { description: errorMessage(error) }),
  });

  if (agent.isLoading) return <Skeleton className="h-64" />;
  if (agent.error || !agent.data) return <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />;
  const data = agent.data;
  const health = agentHealth(data, system.data?.limits.agentHeartbeatMs ?? 10_000);
  const credential = credentials.data?.find((item) => item.id === data.credentialId);
  const jobByName = new Map((jobs.data ?? []).map((job) => [job.name, job]));

  return (
    <div>
      <PageHeader
        title={<span className="flex items-center gap-3">{data.hostname ?? data.instanceId}<StatusBadge view={health} /></span>}
        description={<span className="inline-flex items-center gap-1 font-mono text-xs">{data.id}<CopyButton value={data.id} label="Copy agent ID" /></span>}
        actions={
          <>
            {can('ADMIN') && data.credentialId && !credential?.revokedAt ? <Button variant="secondary" onClick={() => setConfirm('revoke')}><KeyRound /> Revoke credential</Button> : null}
            {can('ADMIN') && data.status === 'OFFLINE' ? <Button variant="destructive" onClick={() => setConfirm('remove')}><Trash2 /> Remove</Button> : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <dl className="grid gap-4 sm:grid-cols-3">
                <Item label="Instance ID"><span className="font-mono text-xs">{data.instanceId}</span></Item>
                <Item label="Host">{data.hostname ?? '—'}</Item>
                <Item label="Project">{project!.name}</Item>
                <Item label="SDK version"><span className="font-mono">{data.sdkVersion}</span></Item>
                <Item label="Protocol">v{data.protocolVersion}</Item>
                <Item label="Running now"><span className="tabular">{data.runningExecutions}</span></Item>
                <Item label="Connected">{formatDateTime(data.connectedAt)}</Item>
                <Item label="Last heartbeat">{formatDateTime(data.lastHeartbeatAt)} <span className="text-xs text-muted-foreground">({timeAgo(data.lastHeartbeatAt)})</span></Item>
                <Item label="Disconnected">{formatDateTime(data.disconnectedAt)}</Item>
                <Item label="Credential">{credential ? <span><span className="font-mono text-xs">{credential.displayPrefix}…</span> {credential.name}{credential.revokedAt ? <Badge tone="danger" className="ml-1">revoked</Badge> : null}</span> : data.credentialId ? <span className="font-mono text-xs">{data.credentialId.slice(0, 8)}</span> : '—'}</Item>
              </dl>
              {data.metadata ? <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{JSON.stringify(data.metadata, null, 2)}</pre> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Recent executions</CardTitle></CardHeader>
            <ExecutionsTable projectId={projectId} filters={{ agentId }} columns={['id', 'job', 'kind', 'status', 'started', 'duration', 'attempt', 'actions']} pageSize={20} emptyTitle="This agent has not run anything yet" />
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Registered handlers ({data.handlers.length})</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1">
                {data.handlers.map((handler) => {
                  const job = jobByName.get(handler);
                  return (
                    <li key={handler} className="flex items-center justify-between gap-2 text-sm">
                      {job ? <Link href={`/jobs/${job.id}`} className="font-mono hover:underline">{handler}</Link> : <span className="font-mono">{handler}</span>}
                      {job ? <Badge tone={job.source === 'SDK' ? 'outline' : 'info'}>{job.source === 'SDK' ? 'from code' : 'API job'}</Badge> : null}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>The agent opens an outbound WebSocket to Chronos and heartbeats every {Math.round((system.data?.limits.agentHeartbeatMs ?? 10_000) / 1000)}s. Running executions keep their lease across reconnects.</p>
              <p>Chronos stores only the latest heartbeat, not a heartbeat history, and does not collect agent process logs; execution logs are on each execution.</p>
              <p>To disconnect an agent, revoke its credential (it is closed within about 30 seconds and the SDK stops).</p>
            </CardContent>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirm === 'revoke'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Revoke this agent's credential?"
        description={<><p>Every application using <span className="font-mono">{credential?.displayPrefix ?? 'this token'}…</span> is disconnected within about 30 seconds and cannot reconnect.</p><p className="mt-2">Create or rotate a token in Settings → Credentials first if other applications share it.</p></>}
        confirmLabel="Revoke"
        destructive
        onConfirm={() => revoke.mutateAsync(data.credentialId!)}
      />
      <ConfirmDialog open={confirm === 'remove'} onOpenChange={(open) => !open && setConfirm(null)} title="Remove this agent record?" description="Only the record of this offline agent is removed; its execution history stays." confirmLabel="Remove" destructive onConfirm={() => remove.mutateAsync()} />
    </div>
  );
}
