'use client';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Activity, Bot, FolderKanban, Layers, ListChecks, Search, Server } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkspace } from '@/hooks/use-workspace';
import { qk } from '@/lib/query-keys';
import { useWorkspaceStore } from '@/stores/workspace';
import { agentsService, executionsService, jobsService, queuesService, workersService } from '@/services';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Case-insensitive substring match over a few fields. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length > 0 && fields.some((field) => field?.toLowerCase().includes(needle));
}

function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Global search over real API data: jobs are searched on the server (?q=), an execution
 * is looked up by its full id, and queues, agents, workers and projects are matched
 * against their complete lists (the API returns them whole).
 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const query = useDebounced(text.trim());
  const router = useRouter();
  const { project, projects } = useWorkspace();
  const setProject = useWorkspaceStore((state) => state.setProject);
  const projectId = project?.id;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const enabled = open && Boolean(projectId) && query.length > 0;
  const jobs = useQuery({ queryKey: qk.jobs(projectId ?? 'none', { q: query }), queryFn: () => jobsService.list(projectId!, { q: query }), enabled });
  const queues = useQuery({ queryKey: qk.queues(projectId ?? 'none'), queryFn: () => queuesService.list(projectId!), enabled });
  const agents = useQuery({ queryKey: qk.agents(projectId ?? 'none'), queryFn: () => agentsService.list(projectId!), enabled });
  const workers = useQuery({ queryKey: qk.workers, queryFn: workersService.list, enabled });
  const execution = useQuery({ queryKey: qk.execution(projectId ?? 'none', query), queryFn: () => executionsService.get(projectId!, query), enabled: enabled && UUID.test(query), retry: false });

  const go = (href: string) => {
    setOpen(false);
    setText('');
    router.push(href);
  };
  const loading = enabled && (jobs.isFetching || queues.isLoading || agents.isLoading || workers.isLoading || execution.isFetching);
  const queueHits = (queues.data ?? []).filter((queue) => matches(query, queue.name, queue.description)).slice(0, 6);
  const agentHits = (agents.data ?? []).filter((agent) => matches(query, agent.hostname, agent.instanceId, agent.id, ...agent.handlers)).slice(0, 6);
  const workerHits = (workers.data ?? []).filter((worker) => matches(query, worker.hostname, worker.instanceId, worker.id)).slice(0, 6);
  const projectHits = projects.filter((item) => matches(query, item.name, item.slug)).slice(0, 6);
  const jobHits = (jobs.data ?? []).slice(0, 8);
  const none = query && !loading && !jobHits.length && !queueHits.length && !agentHits.length && !workerHits.length && !projectHits.length && !execution.data;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-8 w-56 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm text-muted-foreground hover:border-border-strong md:inline-flex"
        aria-label="Search (Ctrl+K)"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded border border-border px-1 font-mono text-[10px]">Ctrl K</kbd>
      </button>
      <button type="button" onClick={() => setOpen(true)} className="md:hidden" aria-label="Search"><Search className="size-4 text-muted-foreground" /></button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl gap-0 overflow-hidden p-0" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <Command shouldFilter={false} label="Global search" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input value={text} onValueChange={setText} placeholder="Jobs, queues, agents, workers, projects, or an execution ID" className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            </div>
            <Command.List className="max-h-96 overflow-y-auto pb-2">
              {!query ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">Type to search {project?.name ?? 'this project'}. Paste a full execution ID to open it.</p> : null}
              {loading ? <Command.Loading><p className="px-4 py-3 text-sm text-muted-foreground">Searching…</p></Command.Loading> : null}
              {none ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">No results for “{query}”.</p> : null}
              {execution.data ? (
                <Command.Group heading="Execution">
                  <Item icon={Activity} label={`${execution.data.jobName} · ${execution.data.status.toLowerCase()}`} hint={execution.data.id.slice(0, 8)} onSelect={() => go(`/executions/${execution.data!.id}`)} />
                </Command.Group>
              ) : null}
              {jobHits.length ? <Command.Group heading="Jobs">{jobHits.map((job) => <Item key={job.id} icon={ListChecks} label={job.name} hint={job.queue} onSelect={() => go(`/jobs/${job.id}`)} />)}</Command.Group> : null}
              {queueHits.length ? <Command.Group heading="Queues">{queueHits.map((queue) => <Item key={queue.id} icon={Layers} label={queue.name} hint={`${queue.counts.waiting + queue.counts.queued} waiting`} onSelect={() => go(`/queues/${queue.name}`)} />)}</Command.Group> : null}
              {agentHits.length ? <Command.Group heading="Agents">{agentHits.map((agent) => <Item key={agent.id} icon={Bot} label={agent.hostname ?? agent.instanceId} hint={agent.status.toLowerCase()} onSelect={() => go(`/agents/${agent.id}`)} />)}</Command.Group> : null}
              {workerHits.length ? <Command.Group heading="Workers">{workerHits.map((worker) => <Item key={worker.id} icon={Server} label={worker.hostname ?? worker.instanceId} hint={worker.status.toLowerCase()} onSelect={() => go(`/workers/${worker.id}`)} />)}</Command.Group> : null}
              {projectHits.length ? (
                <Command.Group heading="Projects">
                  {projectHits.map((item) => <Item key={item.id} icon={FolderKanban} label={item.name} hint={item.slug} onSelect={() => { setProject(item.id); go('/'); }} />)}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Item({ icon: Icon, label, hint, onSelect }: { icon: React.ComponentType<{ className?: string }>; label: string; hint?: string; onSelect: () => void }) {
  return (
    <Command.Item onSelect={onSelect} className="mx-1.5 flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-muted">
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="font-mono text-xs text-muted-foreground">{hint}</span> : null}
    </Command.Item>
  );
}
