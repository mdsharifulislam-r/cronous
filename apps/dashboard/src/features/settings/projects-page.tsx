'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/forms/field';
import { TimezoneInput } from '@/components/forms/timezone-input';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { EmptyState, errorMessage } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { browserTimeZone } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { isValidTimeZone } from '@/lib/timezone';
import { projectService } from '@/services';
import { useWorkspaceStore } from '@/stores/workspace';
import type { Project } from '@/types/api';
import { slugify } from '../auth/schemas';

export function ProjectsPage() {
  const { organization, projects, project: current, can } = useWorkspace();
  const orgId = organization!.id;
  const client = useQueryClient();
  const setProject = useWorkspaceStore((state) => state.setProject);
  const [editing, setEditing] = useState<{ project?: Project; name: string; slug: string; timezone: string } | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const [confirmSlug, setConfirmSlug] = useState('');
  const refresh = () => void client.invalidateQueries({ queryKey: qk.projects(orgId) });

  const save = useMutation({
    mutationFn: () => (editing!.project ? projectService.update(editing!.project.id, { name: editing!.name.trim(), timezone: editing!.timezone }) : projectService.create(orgId, { name: editing!.name.trim(), slug: editing!.slug, timezone: editing!.timezone })),
    onSuccess: (saved) => { toast.success(editing!.project ? `Saved ${saved.name}` : `Created ${saved.name}`); if (!editing!.project) setProject(saved.id); setEditing(null); refresh(); },
    onError: (error) => toast.error('Saving the project failed', { description: errorMessage(error) }),
  });
  const archive = useMutation({
    mutationFn: (id: string) => projectService.archive(id),
    onSuccess: () => { toast.success('Project archived; its credentials were revoked'); refresh(); },
    onError: (error) => toast.error('Archive failed', { description: errorMessage(error) }),
  });
  const valid = editing && editing.name.trim() && (editing.project || editing.slug.length >= 2) && isValidTimeZone(editing.timezone);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div><CardTitle>Projects</CardTitle><CardDescription>Each project has its own jobs, queues, credentials and agents. The slug is what the SDK uses: new Chronos({'{'} project: &apos;slug&apos; {'}'}).</CardDescription></div>
          {can('ADMIN') ? <Button size="sm" onClick={() => setEditing({ name: '', slug: '', timezone: browserTimeZone() })}><Plus /> Create project</Button> : null}
        </CardHeader>
        {projects.length === 0 ? <div className="p-4"><EmptyState title="No projects" /></div> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Project</TableHead><TableHead>Slug (SDK identifier)</TableHead><TableHead>Project ID</TableHead><TableHead>Default time zone</TableHead><TableHead className="w-24"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {projects.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.name}{item.id === current?.id ? <Badge tone="primary" className="ml-2">current</Badge> : null}</TableCell>
                  <TableCell><span className="inline-flex items-center gap-1 font-mono text-xs">{item.slug}<CopyButton value={item.slug} label="Copy slug" /></span></TableCell>
                  <TableCell><span className="inline-flex items-center gap-1 font-mono text-xs">{item.id.slice(0, 8)}<CopyButton value={item.id} label="Copy project ID" /></span></TableCell>
                  <TableCell className="text-sm">{item.timezone}</TableCell>
                  <TableCell className="text-right">
                    {can('ADMIN') ? (
                      <>
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${item.name}`} onClick={() => setEditing({ project: item, name: item.name, slug: item.slug, timezone: item.timezone })}><Pencil /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Archive ${item.name}`} onClick={() => { setArchiving(item); setConfirmSlug(''); }}><Archive /></Button>
                      </>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.project ? `Edit ${editing.project.name}` : 'Create project'}</DialogTitle></DialogHeader>
          {editing ? (
            <div className="space-y-4">
              <Field id="project-name" label="Name"><Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value, ...(editing.project ? {} : { slug: slugify(event.target.value) }) })} /></Field>
              <Field id="project-slug" label="Slug" hint={editing.project ? 'Slugs cannot change (SDK configuration refers to them).' : 'Lowercase letters, digits and hyphens'}><Input className="font-mono" disabled={Boolean(editing.project)} value={editing.slug} onChange={(event) => setEditing({ ...editing, slug: event.target.value })} /></Field>
              <Field id="project-tz" label="Default time zone" hint="Used by schedules that do not set their own zone" error={isValidTimeZone(editing.timezone) ? undefined : 'Unknown time zone'}><TimezoneInput id="project-tz" value={editing.timezone} onChange={(timezone) => setEditing({ ...editing, timezone })} /></Field>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>{editing?.project ? 'Save' : 'Create project'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name}?`}
        description={
          <div className="space-y-2">
            <p>Its schedules stop, all its API keys and agent tokens are revoked (connected agents disconnect), and it disappears from the dashboard. Execution history is kept in the database. Archiving cannot be undone from the dashboard.</p>
            <Field id="archive-confirm" label={`Type ${archiving?.slug} to confirm`}><Input className="font-mono" value={confirmSlug} onChange={(event) => setConfirmSlug(event.target.value)} /></Field>
          </div>
        }
        confirmLabel="Archive project"
        destructive
        onConfirm={async () => {
          if (confirmSlug !== archiving?.slug) {
            toast.error('Type the slug exactly to confirm');
            throw new Error('not confirmed');
          }
          await archive.mutateAsync(archiving.id);
        }}
      />
    </div>
  );
}
