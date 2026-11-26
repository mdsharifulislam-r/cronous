'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from '@/components/shared/states';
import { queuesService } from '@/services';

export function useQueueActions(projectId: string) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['queues', projectId] });
    void client.invalidateQueries({ queryKey: ['queue', projectId] });
  };
  const fail = (action: string) => (error: unknown) => toast.error(`${action} failed`, { description: errorMessage(error) });
  return {
    pause: useMutation({ mutationFn: (name: string) => queuesService.pause(projectId, name), onSuccess: (queue) => { toast.success(`Queue ${queue.name} paused: running executions finish, nothing new starts`); refresh(); }, onError: fail('Pause') }),
    resume: useMutation({ mutationFn: (name: string) => queuesService.resume(projectId, name), onSuccess: (queue) => { toast.success(`Queue ${queue.name} resumed`); refresh(); }, onError: fail('Resume') }),
    remove: useMutation({ mutationFn: (name: string) => queuesService.remove(projectId, name), onSuccess: (_r, name) => { toast.success(`Queue ${name} deleted`); refresh(); }, onError: fail('Delete') }),
  };
}
