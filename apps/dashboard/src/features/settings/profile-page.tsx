'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Field, fieldAria } from '@/components/forms/field';
import { errorMessage } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/hooks/use-workspace';
import { ApiError } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { authService } from '@/services';

export const passwordFormSchema = z
  .object({
    currentPassword: z.string().min(1, 'Required'),
    newPassword: z.string().min(12, 'At least 12 characters').max(256),
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })
  .refine((value) => value.newPassword !== value.currentPassword, { path: ['newPassword'], message: 'Must differ from the current password' });

export function ProfilePage() {
  const { me } = useWorkspace();
  const client = useQueryClient();
  const profile = useForm<{ name: string }>({ resolver: zodResolver(z.object({ name: z.string().trim().min(1, 'Required').max(120) })), values: { name: me?.name ?? '' } });
  const password = useForm<z.infer<typeof passwordFormSchema>>({ resolver: zodResolver(passwordFormSchema), defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' } });

  const saveName = useMutation({
    mutationFn: (name: string) => authService.updateProfile(name),
    onSuccess: () => { toast.success('Profile updated'); void client.invalidateQueries({ queryKey: qk.me }); },
    onError: (error) => toast.error('Update failed', { description: errorMessage(error) }),
  });
  const changePassword = useMutation({
    mutationFn: (values: z.infer<typeof passwordFormSchema>) => authService.changePassword(values.currentPassword, values.newPassword),
    onSuccess: (result) => {
      toast.success('Password changed', { description: result.revokedSessions ? `${result.revokedSessions} other session(s) were signed out.` : 'No other sessions were active.' });
      password.reset();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400 && /incorrect/i.test(error.message)) password.setError('currentPassword', { message: 'Current password is incorrect' });
      else if (error instanceof ApiError && error.status === 429) password.setError('currentPassword', { message: `Too many attempts; try again in ${Math.ceil((error.retryAfterSeconds ?? 900) / 60)} minutes` });
      else toast.error('Password change failed', { description: errorMessage(error) });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><div><CardTitle>Profile</CardTitle><CardDescription>{me?.email} · signed in since {formatDateTime(me?.lastLoginAt)}</CardDescription></div></CardHeader>
        <CardContent>
          <form className="flex max-w-md items-end gap-2" noValidate onSubmit={profile.handleSubmit((values) => saveName.mutate(values.name))}>
            <Field id="name" label="Name" error={profile.formState.errors.name?.message} className="flex-1"><Input {...fieldAria('name', profile.formState.errors.name?.message)} {...profile.register('name')} /></Field>
            <Button type="submit" variant="secondary" loading={saveName.isPending}>Save</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Change password</CardTitle><CardDescription>Your other sessions are signed out; this one stays active.</CardDescription></div></CardHeader>
        <CardContent>
          <form className="max-w-md space-y-4" noValidate onSubmit={password.handleSubmit((values) => changePassword.mutate(values))}>
            {(['currentPassword', 'newPassword', 'confirmPassword'] as const).map((key) => (
              <Field key={key} id={key} label={{ currentPassword: 'Current password', newPassword: 'New password', confirmPassword: 'Confirm new password' }[key]} error={password.formState.errors[key]?.message}>
                <Input type="password" autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'} {...fieldAria(key, password.formState.errors[key]?.message)} {...password.register(key)} />
              </Field>
            ))}
            <Button type="submit" loading={changePassword.isPending}>Change password</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
