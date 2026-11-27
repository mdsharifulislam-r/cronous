'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/forms/field';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { EmptyState, ErrorState, TableSkeleton, errorMessage } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, timeAgo } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { agentsService, projectService } from '@/services';
import type { Credential, IssuedCredential } from '@/types/api';
import { usePublicUrl } from '@/hooks/use-public-url';

export function credentialState(credential: Credential, now = Date.now()): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (credential.revokedAt) return { label: 'Revoked', tone: 'danger' };
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() <= now) return { label: 'Expired', tone: 'neutral' };
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() - now < 7 * 86_400_000) return { label: 'Expires soon', tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

/** Shows a newly issued token exactly once, with usage snippets. */
function IssuedToken({ issued, projectSlug, onClose }: { issued: IssuedCredential | null; projectSlug: string; onClose: () => void }) {
  const server = usePublicUrl();
  return (
    <Dialog open={issued !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{issued?.kind === 'AGENT' ? 'Agent token' : 'Project API key'} created</DialogTitle>
          <DialogDescription>Copy it now. Chronos stores only a hash; it cannot be shown again.</DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="space-y-3">
            <div className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{issued.token}</code>
              <CopyButton value={issued.token} label="Copy token" />
            </div>
            <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"><AlertTriangle className="size-4 shrink-0 text-warning" />Store it in your secret manager. Anyone with this token can {issued.kind === 'AGENT' ? 'connect agents and submit jobs' : 'manage jobs'} in project {projectSlug}.</p>
            <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {issued.kind === 'AGENT'
                ? `CHRONOS_SERVER=${server}\nCHRONOS_AGENT_TOKEN=${issued.token.slice(0, 10)}…\n\nnew Chronos({ server: process.env.CHRONOS_SERVER, project: '${projectSlug}' })`
                : `curl -H "Authorization: Bearer ${issued.token.slice(0, 10)}…" \\\n  ${server}/v1/projects/<project-id>/jobs`}
            </pre>
          </div>
        ) : null}
        <DialogFooter><Button onClick={onClose}>I saved it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CredentialsPage() {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const client = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const credentials = useQuery({ queryKey: qk.credentials(projectId, includeRevoked), queryFn: () => projectService.credentials(projectId, includeRevoked), enabled: can('ADMIN') });
  const agents = useQuery({ queryKey: qk.agents(projectId), queryFn: () => agentsService.list(projectId), enabled: can('ADMIN') });
  const [creating, setCreating] = useState<{ kind: 'PROJECT' | 'AGENT'; name: string; expiresInDays: string } | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [rotating, setRotating] = useState<{ credential: Credential; grace: string } | null>(null);
  const [revoking, setRevoking] = useState<Credential | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ['credentials', projectId] });

  const create = useMutation({
    mutationFn: () => projectService.createCredential(projectId, { kind: creating!.kind, name: creating!.name.trim(), ...(creating!.expiresInDays ? { expiresInDays: Number(creating!.expiresInDays) } : {}) }),
    onSuccess: (result) => { setCreating(null); setIssued(result); refresh(); },
    onError: (error) => toast.error('Create failed', { description: errorMessage(error) }),
  });
  const rotate = useMutation({
    mutationFn: () => projectService.rotateCredential(projectId, rotating!.credential.id, Number(rotating!.grace)),
    onSuccess: (result) => { setRotating(null); setIssued(result.credential); toast.success(Number(rotating?.grace) === 0 ? 'Rotated; the old token was revoked' : 'Rotated; the old token keeps working during the grace period'); refresh(); },
    onError: (error) => toast.error('Rotate failed', { description: errorMessage(error) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => projectService.revokeCredential(projectId, id),
    onSuccess: () => { toast.success('Credential revoked'); refresh(); },
    onError: (error) => toast.error('Revoke failed', { description: errorMessage(error) }),
  });

  if (!can('ADMIN')) return <EmptyState icon={KeyRound} title="Admins only" description="Managing credentials requires the Admin role." />;
  const agentsByCredential = new Map<string, number>();
  for (const agent of agents.data ?? []) if (agent.credentialId && agent.status !== 'OFFLINE') agentsByCredential.set(agent.credentialId, (agentsByCredential.get(agent.credentialId) ?? 0) + 1);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Credentials of {project!.name}</CardTitle>
            <CardDescription>API keys (chr_p_) call the REST API from your servers. Agent tokens (chr_a_) connect @sharifulislam1/cronous agents and submit jobs. Tokens are shown once.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setCreating({ kind: 'AGENT', name: '', expiresInDays: '' })}><Plus /> Agent token</Button>
            <Button size="sm" onClick={() => setCreating({ kind: 'PROJECT', name: '', expiresInDays: '' })}><Plus /> API key</Button>
          </div>
        </CardHeader>
        <div className="flex items-center gap-2 border-y border-border px-5 py-2 text-sm">
          <Switch id="include-revoked" checked={includeRevoked} onCheckedChange={setIncludeRevoked} />
          <label htmlFor="include-revoked">Show revoked</label>
        </div>
        {credentials.isLoading ? <TableSkeleton columns={6} /> : credentials.error ? <div className="p-4"><ErrorState error={credentials.error} /></div> : credentials.data?.length ? (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Token</TableHead><TableHead>State</TableHead><TableHead>Last used</TableHead><TableHead>Expires</TableHead><TableHead>Agents</TableHead><TableHead className="w-24"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {credentials.data.map((credential) => {
                const state = credentialState(credential);
                const usable = state.label !== 'Revoked' && state.label !== 'Expired';
                return (
                  <TableRow key={credential.id}>
                    <TableCell className="font-medium">{credential.name}{credential.rotatedFromId ? <span className="ml-1 text-xs text-muted-foreground">(rotated)</span> : null}</TableCell>
                    <TableCell><Badge tone={credential.kind === 'AGENT' ? 'info' : 'neutral'}>{credential.kind === 'AGENT' ? 'Agent token' : 'API key'}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{credential.displayPrefix}…</TableCell>
                    <TableCell><Badge tone={state.tone}>{state.label}</Badge></TableCell>
                    <TableCell className="text-xs" title={formatDateTime(credential.lastUsedAt)}>{credential.lastUsedAt ? timeAgo(credential.lastUsedAt) : 'never'}</TableCell>
                    <TableCell className="text-xs">{credential.expiresAt ? formatDateTime(credential.expiresAt, undefined, false) : 'never'}</TableCell>
                    <TableCell className="text-xs">{credential.kind === 'AGENT' ? <Link href="/agents" className="hover:underline">{agentsByCredential.get(credential.id) ?? 0} connected</Link> : '—'}</TableCell>
                    <TableCell className="text-right">
                      {usable ? (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={`Rotate ${credential.name}`} onClick={() => setRotating({ credential, grace: '3600' })}><RefreshCw /></Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`Revoke ${credential.name}`} onClick={() => setRevoking(credential)}><Trash2 /></Button>
                        </>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : <div className="p-4"><EmptyState icon={KeyRound} title="No credentials" /></div>}
      </Card>

      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>New {creating?.kind === 'AGENT' ? 'agent token' : 'API key'}</DialogTitle></DialogHeader>
          {creating ? (
            <div className="space-y-4">
              <Field id="cred-name" label="Name" hint="Where it is used, e.g. billing-service production"><Input value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value })} /></Field>
              <Field id="cred-expiry" label="Expires after (days)" hint="Empty: never"><Input inputMode="numeric" value={creating.expiresInDays} onChange={(event) => setCreating({ ...creating, expiresInDays: event.target.value.replace(/\D/g, '') })} /></Field>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
            <Button loading={create.isPending} disabled={!creating?.name.trim() || (creating.expiresInDays !== '' && (Number(creating.expiresInDays) < 1 || Number(creating.expiresInDays) > 3650))} onClick={() => create.mutate()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rotating !== null} onOpenChange={(open) => !open && setRotating(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rotate {rotating?.credential.name}</DialogTitle><DialogDescription>A new token is issued. Keep the old one working long enough to redeploy your applications.</DialogDescription></DialogHeader>
          <Field id="grace" label="Old token keeps working for">
            <Select value={rotating?.grace ?? '3600'} onValueChange={(grace) => setRotating((current) => (current ? { ...current, grace } : current))}>
              <SelectTrigger id="grace"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Revoke immediately</SelectItem>
                <SelectItem value="3600">1 hour</SelectItem>
                <SelectItem value="86400">1 day</SelectItem>
                <SelectItem value="604800">7 days (maximum)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRotating(null)}>Cancel</Button>
            <Button loading={rotate.isPending} onClick={() => rotate.mutate()}>Rotate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name}?`}
        description={revoking?.kind === 'AGENT' ? 'Agents using this token are disconnected within about 30 seconds and cannot reconnect. Submissions with it are rejected.' : 'Requests with this API key are rejected immediately.'}
        confirmLabel="Revoke"
        destructive
        onConfirm={() => revoke.mutateAsync(revoking!.id)}
      />
      <IssuedToken issued={issued} projectSlug={project!.slug} onClose={() => setIssued(null)} />
    </div>
  );
}
