'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/forms/field';
import { CopyButton } from '@/components/shared/copy-button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, errorMessage } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { organizationService } from '@/services';
import { useWorkspaceStore } from '@/stores/workspace';
import { slugify } from '../auth/schemas';

export function OrganizationPage() {
  const { organization, can } = useWorkspace();
  const orgId = organization?.id;
  const client = useQueryClient();
  const setOrg = useWorkspaceStore((state) => state.setOrg);
  const details = useQuery({ queryKey: qk.organization(orgId ?? 'none'), queryFn: () => organizationService.get(orgId!), enabled: Boolean(orgId) });
  const [name, setName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newOrg, setNewOrg] = useState({ name: '', slug: '' });
  const [deleting, setDeleting] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState('');

  const rename = useMutation({
    mutationFn: (value: string) => organizationService.update(orgId!, { name: value }),
    onSuccess: () => { toast.success('Organization renamed'); setName(null); void client.invalidateQueries({ queryKey: qk.me }); void client.invalidateQueries({ queryKey: qk.organization(orgId!) }); },
    onError: (error) => toast.error('Rename failed', { description: errorMessage(error) }),
  });
  const create = useMutation({
    mutationFn: () => organizationService.create(newOrg),
    onSuccess: (created) => { toast.success(`Created ${created.name}; you are its owner`); setCreating(false); setNewOrg({ name: '', slug: '' }); void client.invalidateQueries({ queryKey: qk.me }); setOrg(created.id); },
    onError: (error) => toast.error('Create failed', { description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => organizationService.remove(orgId!),
    onSuccess: () => { toast.success('Organization deleted'); void client.invalidateQueries({ queryKey: qk.me }); },
    onError: (error) => toast.error('Delete failed', { description: errorMessage(error) }),
  });

  return (
    <div className="space-y-4">
      {orgId ? (
        <Card>
          <CardHeader>
            <div><CardTitle>Organization</CardTitle><CardDescription>Your role: {organization?.role.toLowerCase()}</CardDescription></div>
          </CardHeader>
          <CardContent>
            {details.isLoading ? <Skeleton className="h-24" /> : details.error ? <ErrorState error={details.error} /> : details.data ? (
              <div className="space-y-4">
                <div className="flex max-w-md items-end gap-2">
                  <Field id="org-name" label="Name" className="flex-1">
                    <Input value={name ?? details.data.name} disabled={!can('ADMIN')} onChange={(event) => setName(event.target.value)} />
                  </Field>
                  {can('ADMIN') ? <Button variant="secondary" disabled={!name || name.trim() === details.data.name || !name.trim()} loading={rename.isPending} onClick={() => rename.mutate(name!.trim())}>Save</Button> : null}
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-muted-foreground">Slug</dt><dd className="font-mono">{details.data.slug}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">ID</dt><dd className="flex items-center gap-1 font-mono text-xs">{details.data.id.slice(0, 8)}<CopyButton value={details.data.id} label="Copy organization ID" /></dd></div>
                  <div><dt className="text-xs text-muted-foreground">Projects / members</dt><dd className="tabular">{details.data.projectCount} / {details.data.memberCount}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{formatDateTime(details.data.createdAt, undefined, false)}</dd></div>
                </dl>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div><CardTitle>New organization</CardTitle><CardDescription>Separate teams or customers get separate organizations; you become the owner.</CardDescription></div>
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus /> Create</Button>
        </CardHeader>
      </Card>

      {can('OWNER') && details.data ? (
        <Card className="border-danger/30">
          <CardHeader>
            <div><CardTitle className="text-danger">Delete organization</CardTitle><CardDescription>Deletes every project, job, execution and credential of {details.data.name}. The activity log is kept.</CardDescription></div>
            <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}><Trash2 /> Delete</Button>
          </CardHeader>
        </Card>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create organization</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <Field id="new-org-name" label="Name"><Input value={newOrg.name} onChange={(event) => setNewOrg({ name: event.target.value, slug: slugify(event.target.value) })} /></Field>
            <Field id="new-org-slug" label="Slug" hint="Lowercase letters, digits and hyphens"><Input className="font-mono" value={newOrg.slug} onChange={(event) => setNewOrg({ ...newOrg, slug: event.target.value })} /></Field>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
            <Button loading={create.isPending} disabled={!newOrg.name.trim() || newOrg.slug.length < 2} onClick={() => create.mutate()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => { setDeleting(open); setConfirmSlug(''); }}
        title={`Delete ${details.data?.name}?`}
        description={
          <div className="space-y-2">
            <p>This permanently deletes all projects, jobs, executions and credentials of this organization. Running applications using its tokens stop working.</p>
            <Field id="confirm-slug" label={`Type ${details.data?.slug} to confirm`}><Input className="font-mono" value={confirmSlug} onChange={(event) => setConfirmSlug(event.target.value)} /></Field>
          </div>
        }
        confirmLabel="Delete organization"
        destructive
        onConfirm={async () => {
          if (confirmSlug !== details.data?.slug) {
            toast.error('Type the slug exactly to confirm');
            throw new Error('not confirmed');
          }
          await remove.mutateAsync();
        }}
      />
    </div>
  );
}
