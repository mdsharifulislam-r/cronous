'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from '@/components/shared/states';
import { executionsService, jobsService } from '@/services';
import type { Job } from '@/types/api';

/** Job mutations with consistent feedback and cache invalidation. */
export function useJobActions(projectId: string) {
  const client = useQueryClient();
  const refresh = (jobId?: string) => {
    void client.invalidateQueries({ queryKey: ['jobs', projectId] });
    if (jobId) void client.invalidateQueries({ queryKey: ['job', projectId, jobId] });
    void client.invalidateQueries({ queryKey: ['stats', projectId] });
    void client.invalidateQueries({ queryKey: ['executions', projectId] });
    void client.invalidateQueries({ queryKey: ['upcoming', projectId] });
  };
  const fail = (action: string) => (error: unknown) => {
    toast.error(`${action} failed`, { description: errorMessage(error) });
  };

  const pause = useMutation({ mutationFn: (job: Job) => jobsService.pause(projectId, job.id), onSuccess: (job) => { toast.success(`Paused schedule of ${job.name}`); refresh(job.id); }, onError: fail('Pause') });
  const resume = useMutation({ mutationFn: (job: Job) => jobsService.resume(projectId, job.id), onSuccess: (job) => { toast.success(`Resumed ${job.name}`); refresh(job.id); }, onError: fail('Resume') });
  const setEnabled = useMutation({
    mutationFn: ({ job, enabled }: { job: Job; enabled: boolean }) => jobsService.update(projectId, job.id, { enabled }),
    onSuccess: (job) => { toast.success(`${job.name} ${job.enabled ? 'enabled' : 'disabled'}`); refresh(job.id); },
    onError: fail('Update'),
  });
  const trigger = useMutation({
    mutationFn: (job: Job) => jobsService.trigger(projectId, job.id, {}),
    onSuccess: (result, job) => { toast.success(`${job.name} triggered`, { description: `Execution ${result.execution.id.slice(0, 8)} created`, action: { label: 'View', onClick: () => window.location.assign(`/executions/${result.execution.id}`) } }); refresh(job.id); },
    onError: fail('Trigger'),
  });
  const remove = useMutation({ mutationFn: (job: Job) => jobsService.remove(projectId, job.id), onSuccess: (_result, job) => { toast.success(`Deleted ${job.name}`); refresh(); }, onError: fail('Delete') });
  const retryLast = useMutation({
    mutationFn: (job: Job) => executionsService.retry(projectId, job.lastExecution!.id),
    onSuccess: (_result, job) => { toast.success(`Retrying the last execution of ${job.name}`); refresh(job.id); },
    onError: fail('Retry'),
  });
  const cancelLast = useMutation({
    mutationFn: (job: Job) => executionsService.cancel(projectId, job.lastExecution!.id),
    onSuccess: (_result, job) => { toast.success(`Cancelled the pending execution of ${job.name}`); refresh(job.id); },
    onError: fail('Cancel'),
  });
  return { pause, resume, setEnabled, trigger, remove, retryLast, cancelLast };
}
