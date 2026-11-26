'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Field, fieldAria } from '@/components/forms/field';
import { errorMessage } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { queuesService } from '@/services';
import type { Queue } from '@/types/api';

export const queueFormSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'Lowercase letters, digits, "_" and "-" (max 63)'),
  description: z.string().max(500),
  concurrencyLimit: z.string().refine((value) => value.trim() === '' || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100_000), 'Empty for unlimited, or 1–100000'),
  defaultPriority: z.string().refine((value) => /^\d+$/.test(value) && Number(value) <= 100, '0–100'),
});
export type QueueFormValues = z.infer<typeof queueFormSchema>;

/** Create (no `queue`) or edit a queue. Requires the ADMIN role server-side. */
export function QueueDialog({ projectId, queue, open, onOpenChange }: { projectId: string; queue?: Queue; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const form = useForm<QueueFormValues>({ resolver: zodResolver(queueFormSchema), defaultValues: { name: '', description: '', concurrencyLimit: '', defaultPriority: '50' } });
  const errors = form.formState.errors;

  useEffect(() => {
    if (open) form.reset(queue ? { name: queue.name, description: queue.description ?? '', concurrencyLimit: queue.concurrencyLimit ? String(queue.concurrencyLimit) : '', defaultPriority: String(queue.defaultPriority) } : { name: '', description: '', concurrencyLimit: '', defaultPriority: '50' });
  }, [open, queue, form]);

  const save = useMutation({
    mutationFn: (values: QueueFormValues) => {
      const body = { description: values.description.trim() || null, concurrencyLimit: values.concurrencyLimit.trim() ? Number(values.concurrencyLimit) : null, defaultPriority: Number(values.defaultPriority) };
      return queue ? queuesService.update(projectId, queue.name, body) : queuesService.create(projectId, { name: values.name, ...body });
    },
    onSuccess: (saved) => {
      toast.success(queue ? `Saved queue ${saved.name}` : `Created queue ${saved.name}`);
      void client.invalidateQueries({ queryKey: ['queues', projectId] });
      void client.invalidateQueries({ queryKey: ['queue', projectId, saved.name] });
      onOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) form.setError('name', { message: error.message });
      else toast.error('Saving the queue failed', { description: errorMessage(error) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{queue ? `Edit queue ${queue.name}` : 'Create queue'}</DialogTitle>
          <DialogDescription>A queue is an admission lane: it limits how many of its executions run at once and orders waiting work by priority.</DialogDescription>
        </DialogHeader>
        <form id="queue-form" className="space-y-4" noValidate onSubmit={form.handleSubmit((values) => save.mutate(values))}>
          <Field id="name" label="Name" required error={errors.name?.message} hint={queue ? 'Queue names cannot change.' : 'e.g. emails, reports, bulk'}>
            <Input className="font-mono" disabled={Boolean(queue)} {...fieldAria('name', errors.name?.message)} {...form.register('name')} />
          </Field>
          <Field id="description" label="Description" error={errors.description?.message}><Input {...form.register('description')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="concurrencyLimit" label="Concurrency limit" hint="Running + queued at once; empty = unlimited" error={errors.concurrencyLimit?.message}>
              <Input inputMode="numeric" placeholder="unlimited" {...fieldAria('concurrencyLimit', errors.concurrencyLimit?.message)} {...form.register('concurrencyLimit')} />
            </Field>
            <Field id="defaultPriority" label="Default priority" hint="0–100, higher runs first" error={errors.defaultPriority?.message}>
              <Input inputMode="numeric" {...fieldAria('defaultPriority', errors.defaultPriority?.message)} {...form.register('defaultPriority')} />
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="queue-form" loading={save.isPending}>{queue ? 'Save' : 'Create queue'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
