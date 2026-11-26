'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/forms/field';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, TableSkeleton, errorMessage } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/hooks/use-workspace';
import { formatDateTime } from '@/lib/format';
import { canManageRole } from '@/lib/permissions';
import { qk } from '@/lib/query-keys';
import { organizationService } from '@/services';
import type { Member, OrgRole } from '@/types/api';

const ROLES: OrgRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
export const PERMISSIONS: { label: string; role: OrgRole }[] = [
  { label: 'View jobs, queues, schedules, executions, agents, workers', role: 'VIEWER' },
  { label: 'Create, edit, trigger, submit, pause and delete jobs; cancel and retry executions; pause queues', role: 'MEMBER' },
  { label: 'Projects, queues limits, credentials, members (except owners), activity log', role: 'ADMIN' },
  { label: 'Delete the organization, manage owners', role: 'OWNER' },
];

export function MembersPage() {
  const { organization, me, role, can } = useWorkspace();
  const orgId = organization!.id;
  const client = useQueryClient();
  const members = useQuery({ queryKey: qk.members(orgId), queryFn: () => organizationService.members(orgId) });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'MEMBER' as OrgRole, createUser: false, name: '', password: '' });
  const [removing, setRemoving] = useState<Member | null>(null);
  const refresh = () => { void client.invalidateQueries({ queryKey: qk.members(orgId) }); void client.invalidateQueries({ queryKey: qk.organization(orgId) }); };

  const add = useMutation({
    mutationFn: () => organizationService.addMember(orgId, { email: form.email.trim(), role: form.role, ...(form.createUser ? { name: form.name.trim(), password: form.password } : {}) }),
    onSuccess: (member) => { toast.success(`${member.email} added as ${member.role.toLowerCase()}`, form.createUser ? { description: 'Share the initial password with them securely; they can change it in their profile.' } : undefined); setAdding(false); setForm({ email: '', role: 'MEMBER', createUser: false, name: '', password: '' }); refresh(); },
    onError: (error) => toast.error('Could not add member', { description: errorMessage(error) }),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: OrgRole }) => organizationService.updateMember(orgId, userId, next),
    onSuccess: (member) => { toast.success(`${member.email} is now ${member.role.toLowerCase()}`); refresh(); },
    onError: (error) => toast.error('Role change failed', { description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => organizationService.removeMember(orgId, userId),
    onSuccess: (_r, userId) => { toast.success(userId === me?.id ? 'You left the organization' : 'Member removed'); refresh(); if (userId === me?.id) void client.invalidateQueries({ queryKey: qk.me }); },
    onError: (error) => toast.error('Remove failed', { description: errorMessage(error) }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div><CardTitle>Members</CardTitle><CardDescription>People with access to {organization!.name}. There is no email delivery: add existing users, or create a user with an initial password.</CardDescription></div>
          {can('ADMIN') ? <Button size="sm" onClick={() => setAdding(true)}><UserPlus /> Add member</Button> : null}
        </CardHeader>
        {members.isLoading ? <TableSkeleton columns={4} /> : members.error ? <div className="p-4"><ErrorState error={members.error} /></div> : (
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Joined</TableHead><TableHead className="w-12"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {(members.data ?? []).map((member) => {
                const self = member.id === me?.id;
                const manageable = !self && canManageRole(role, member.role);
                return (
                  <TableRow key={member.id}>
                    <TableCell>
                      <p className="font-medium">{member.name}{self ? <span className="ml-1 text-xs text-muted-foreground">(you)</span> : null}{member.isActive ? null : <Badge tone="danger" className="ml-2">inactive</Badge>}</p>
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    </TableCell>
                    <TableCell>
                      {manageable ? (
                        <Select value={member.role} onValueChange={(next) => changeRole.mutate({ userId: member.id, next: next as OrgRole })}>
                          <SelectTrigger className="w-32" aria-label={`Role of ${member.email}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{ROLES.filter((item) => canManageRole(role, item)).map((item) => <SelectItem key={item} value={item}>{item.toLowerCase()}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : <Badge tone={member.role === 'OWNER' ? 'primary' : 'neutral'}>{member.role.toLowerCase()}</Badge>}
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(member.joinedAt, undefined, false)}</TableCell>
                    <TableCell>
                      {self ? <Button variant="ghost" size="icon-sm" aria-label="Leave organization" onClick={() => setRemoving(member)}><LogOut /></Button>
                        : manageable ? <Button variant="ghost" size="icon-sm" aria-label={`Remove ${member.email}`} onClick={() => setRemoving(member)}><Trash2 /></Button> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader><CardTitle>Roles and permissions</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Permission</TableHead>{ROLES.slice().reverse().map((item) => <TableHead key={item} className="text-center">{item.toLowerCase()}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {PERMISSIONS.map((permission) => (
                <TableRow key={permission.label}>
                  <TableCell className="text-sm">{permission.label}</TableCell>
                  {ROLES.slice().reverse().map((item) => <TableCell key={item} className="text-center">{ROLES.indexOf(item) <= ROLES.indexOf(permission.role) ? '✓' : <span className="text-muted-foreground">—</span>}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-2 text-xs text-muted-foreground">Project API keys act with Member rights inside their own project. Agent tokens can only connect agents, submit jobs and cancel not-yet-started executions.</p>
        </CardContent>
      </Card>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add member</DialogTitle><DialogDescription>Add an existing Chronos user by email, or create a new user.</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <Field id="member-email" label="Email"><Input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
            <Field id="member-role" label="Role">
              <Select value={form.role} onValueChange={(next) => setForm({ ...form, role: next as OrgRole })}>
                <SelectTrigger id="member-role"><SelectValue /></SelectTrigger>
                <SelectContent>{ROLES.filter((item) => canManageRole(role, item)).map((item) => <SelectItem key={item} value={item}>{item.toLowerCase()}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">Create a new user account<Switch checked={form.createUser} onCheckedChange={(checked) => setForm({ ...form, createUser: checked })} /></label>
            {form.createUser ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="member-name" label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
                <Field id="member-password" label="Initial password" hint="12+ characters"><Input type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button loading={add.isPending} disabled={!form.email.includes('@') || (form.createUser && (!form.name.trim() || form.password.length < 12))} onClick={() => add.mutate()}>Add member</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.id === me?.id ? `Leave ${organization!.name}?` : `Remove ${removing?.email}?`}
        description={removing?.id === me?.id ? 'You lose access to all its projects. The last owner cannot leave.' : 'They lose access to every project of this organization. Their user account remains.'}
        confirmLabel={removing?.id === me?.id ? 'Leave' : 'Remove'}
        destructive
        onConfirm={() => remove.mutateAsync(removing!.id)}
      />
    </div>
  );
}
