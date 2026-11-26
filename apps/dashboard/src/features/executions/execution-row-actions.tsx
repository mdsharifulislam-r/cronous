'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Eye, MoreHorizontal, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { errorMessage } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/hooks/use-workspace';
import { executionsService } from '@/services';
import type { ExecutionStatus } from '@/types/api';

/** The API only allows these transitions (cancel: not finished; retry: failed, dead-lettered, cancelled). */
export function executionCapabilities(status: ExecutionStatus, canWrite: boolean) {
  return {
    cancel: canWrite && ['PENDING', 'QUEUED', 'RUNNING', 'RETRY_SCHEDULED'].includes(status),
    retry: canWrite && ['FAILED', 'DEAD_LETTERED', 'CANCELLED'].includes(status),
  };
}

export function useExecutionMutations(projectId: string) {
  const client = useQueryClient();
  const refresh = (id: string) => {
    void client.invalidateQueries({ queryKey: ['executions', projectId] });
    void client.invalidateQueries({ queryKey: ['execution', projectId, id] });
    void client.invalidateQueries({ queryKey: ['queues', projectId] });
    void client.invalidateQueries({ queryKey: ['stats', projectId] });
  };
  const cancel = useMutation({
    mutationFn: (id: string) => executionsService.cancel(projectId, id),
    onSuccess: (result) => { toast.success(result.previousStatus === 'RUNNING' ? 'Cancellation sent to the running executor' : 'Execution cancelled; it will not run'); refresh(result.id); },
    onError: (error) => toast.error('Cancel failed', { description: errorMessage(error) }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => executionsService.retry(projectId, id),
    onSuccess: (result) => { toast.success('Execution re-queued with a fresh attempt budget'); refresh(result.id); },
    onError: (error) => toast.error('Retry failed', { description: errorMessage(error) }),
  });
  return { cancel, retry };
}

export function ExecutionRowActions({ projectId, execution }: { projectId: string; execution: { id: string; status: ExecutionStatus; jobName: string } }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const caps = executionCapabilities(execution.status, can('MEMBER'));
  const { cancel, retry } = useExecutionMutations(projectId);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for execution ${execution.id.slice(0, 8)}`}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => router.push(`/executions/${execution.id}`)}><Eye /> View details</DropdownMenuItem>
          {caps.retry ? <DropdownMenuItem onSelect={() => retry.mutate(execution.id)}><RotateCcw /> Retry</DropdownMenuItem> : null}
          {caps.cancel ? <DropdownMenuItem destructive onSelect={() => setConfirm(true)}><Ban /> Cancel</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancel this execution?"
        description={execution.status === 'RUNNING' ? `${execution.jobName} is running. The executor is asked to stop; its result will be discarded.` : `${execution.jobName} has not started; it will not run.`}
        confirmLabel="Cancel execution"
        destructive
        onConfirm={() => cancel.mutateAsync(execution.id)}
      />
    </>
  );
}
