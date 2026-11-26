'use client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ScrollText, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/shared/states';
import { LoadMore } from '@/components/tables/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime, shortId } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { activityService, organizationService } from '@/services';
import type { ActivityFilters } from '@/services/activity.service';
import type { AuditEntry } from '@/types/api';

/** Event families recorded by the API (docs/API_REFERENCE.md, activity log). */
export const EVENT_TYPES = [
  ['job.', 'Jobs (create, update, delete, pause, trigger, queue)'],
  ['execution.', 'Executions (cancel, retry)'],
  ['queue.', 'Queues'],
  ['credential.', 'Credentials'],
  ['membership.', 'Members and roles'],
  ['project.', 'Projects'],
  ['organization.', 'Organization'],
  ['agent.', 'Agents'],
  ['system.', 'System'],
] as const;

export function actorLabel(entry: AuditEntry): string {
  if (entry.actor.type === 'SYSTEM') return 'System';
  if (entry.actor.type === 'USER') return entry.actor.name ?? entry.actor.email ?? 'Deleted user';
  return `${entry.actor.credentialKind === 'AGENT' ? 'Agent token' : 'API key'} ${entry.actor.name ?? ''}${entry.actor.credentialPrefix ? ` (${entry.actor.credentialPrefix}…)` : ''}`.trim();
}

export function ActivityPage() {
  const { organization, projects, can } = useWorkspace();
  const orgId = organization!.id;
  const [action, setAction] = useState('all');
  const [actorId, setActorId] = useState('all');
  const [projectId, setProjectId] = useState('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const members = useQuery({ queryKey: qk.members(orgId), queryFn: () => organizationService.members(orgId), enabled: can('ADMIN') });

  const typed = search.trim().toLowerCase();
  const actionFilter = typed && /^[a-z_]+(\.[a-z_]*)?$/.test(typed) ? typed : action !== 'all' ? action : undefined;
  const filters: ActivityFilters = {
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(actorId !== 'all' ? { actorId } : {}),
    ...(projectId !== 'all' ? { projectId } : {}),
    ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
  };
  const query = useInfiniteQuery({
    queryKey: qk.activity(orgId, filters),
    queryFn: ({ pageParam }) => activityService.list(orgId, { ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: can('ADMIN'),
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const filtered = action !== 'all' || actorId !== 'all' || projectId !== 'all' || search || from || to;

  if (!can('ADMIN')) return <div><PageHeader title="Activity Logs" /><EmptyState icon={ScrollText} title="Admins only" description="The activity log contains client IP addresses and credential changes, so it is visible to organization admins and owners." /></div>;

  return (
    <div>
      <PageHeader title="Activity Logs" description={`Who changed what in ${organization!.name}. Entries are append-only and kept even when their target is deleted.`} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Input aria-label="Search event type" placeholder="Event, e.g. job.created or credential." value={search} onChange={(event) => setSearch(event.target.value)} className="w-64 font-mono" />
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="w-64" aria-label="Event type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {EVENT_TYPES.map(([prefix, label]) => <SelectItem key={prefix} value={prefix}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={actorId} onValueChange={setActorId}>
            <SelectTrigger className="w-44" aria-label="User"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              {(members.data ?? []).map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-44" aria-label="Project"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <Input type="date" aria-label="From" className="w-38" value={from} onChange={(event) => setFrom(event.target.value)} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" aria-label="To" className="w-38" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          {filtered ? <Button variant="ghost" size="sm" onClick={() => { setAction('all'); setActorId('all'); setProjectId('all'); setSearch(''); setFrom(''); setTo(''); }}><X /> Reset</Button> : null}
        </div>
        {query.isLoading ? <TableSkeleton columns={6} /> : query.error ? <div className="p-4"><ErrorState error={query.error} onRetry={() => void query.refetch()} /></div> : rows.length === 0 ? (
          <div className="p-4"><EmptyState icon={ScrollText} title="No activity matches" /></div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-8" /><TableHead>Time</TableHead><TableHead>Event</TableHead><TableHead>Actor</TableHead><TableHead>Target</TableHead><TableHead>Project</TableHead><TableHead>IP address</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <Fragment key={entry.id}>
                    <TableRow>
                      <TableCell>
                        <button type="button" onClick={() => setExpanded(expanded === entry.id ? null : entry.id)} aria-expanded={expanded === entry.id} aria-label="Details" className="text-muted-foreground hover:text-foreground">
                          {expanded === entry.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap tabular">{formatDateTime(entry.createdAt)}</TableCell>
                      <TableCell><Badge tone={entry.action.endsWith('deleted') || entry.action.endsWith('revoked') || entry.action.endsWith('removed') ? 'danger' : 'outline'} className="font-mono">{entry.action}</Badge></TableCell>
                      <TableCell className="text-sm">{actorLabel(entry)}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.targetType ? `${entry.targetType} ${shortId(entry.targetId)}` : '—'}</TableCell>
                      <TableCell className="text-xs">{entry.projectId ? (projectName.get(entry.projectId) ?? shortId(entry.projectId)) : '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.ipAddress ?? '—'}</TableCell>
                    </TableRow>
                    {expanded === entry.id ? (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell />
                        <TableCell colSpan={6}>
                          <dl className="grid gap-2 text-xs sm:grid-cols-3">
                            <div><dt className="text-muted-foreground">Request ID</dt><dd className="font-mono">{entry.requestId ?? '—'}</dd></div>
                            <div><dt className="text-muted-foreground">Target ID</dt><dd className="font-mono break-all">{entry.targetId ?? '—'}</dd></div>
                            <div><dt className="text-muted-foreground">Actor ID</dt><dd className="font-mono break-all">{entry.actor.id ?? '—'}</dd></div>
                          </dl>
                          {entry.metadata ? <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface p-2 font-mono text-xs">{JSON.stringify(entry.metadata, null, 2)}</pre> : null}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
            <LoadMore hasMore={Boolean(query.hasNextPage)} loading={query.isFetchingNextPage} onLoad={() => void query.fetchNextPage()} count={rows.length} />
          </>
        )}
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">Sign-ins and password changes are recorded without an organization and do not appear here. Agent connections and worker status changes are shown live on the Agents and Workers pages; they are not audit events.</p>
    </div>
  );
}
