'use client';
import { Ban, Edit, Eye, MoreHorizontal, Pause, Play, Power, RotateCcw, Send, Trash2, Zap } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/hooks/use-workspace';
import type { Job } from '@/types/api';
import { useJobActions } from './use-job-actions';

/** What a user may do with a job right now, mirroring the API's rules. */
export function jobCapabilities(job: Job, canWrite: boolean) {
  const last = job.lastExecution;
  return {
    edit: canWrite,
    pause: canWrite && job.schedule?.state === 'ACTIVE',
    resume: canWrite && job.schedule?.state === 'PAUSED',
    trigger: canWrite && job.enabled,
    submit: canWrite && job.enabled,
    toggle: canWrite,
    retryLast: canWrite && (last?.status === 'FAILED' || last?.status === 'DEAD_LETTERED' || last?.status === 'CANCELLED'),
    cancelLast: canWrite && (last?.status === 'PENDING' || last?.status === 'QUEUED' || last?.status === 'RETRY_SCHEDULED'),
    remove: canWrite,
  };
}

export function JobActionsMenu({ job, projectId, align = 'end', trigger }: { job: Job; projectId: string; align?: 'start' | 'end'; trigger?: React.ReactNode }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const actions = useJobActions(projectId);
  const caps = jobCapabilities(job, can('MEMBER'));
  const [confirm, setConfirm] = useState<'delete' | 'disable' | null>(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${job.name}`}><MoreHorizontal /></Button>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          <DropdownMenuItem onSelect={() => router.push(`/jobs/${job.id}`)}><Eye /> View</DropdownMenuItem>
          {caps.edit ? <DropdownMenuItem onSelect={() => router.push(`/jobs/${job.id}/edit`)}><Edit /> {job.source === 'SDK' ? 'Enable / disable' : 'Edit'}</DropdownMenuItem> : null}
          {caps.trigger ? <DropdownMenuItem onSelect={() => actions.trigger.mutate(job)}><Zap /> Run now</DropdownMenuItem> : null}
          {caps.submit ? <DropdownMenuItem onSelect={() => router.push(`/queues/submit?job=${encodeURIComponent(job.name)}`)}><Send /> Submit with payload…</DropdownMenuItem> : null}
          {caps.pause ? <DropdownMenuItem onSelect={() => actions.pause.mutate(job)}><Pause /> Pause schedule</DropdownMenuItem> : null}
          {caps.resume ? <DropdownMenuItem onSelect={() => actions.resume.mutate(job)}><Play /> Resume schedule</DropdownMenuItem> : null}
          {caps.retryLast ? <DropdownMenuItem onSelect={() => actions.retryLast.mutate(job)}><RotateCcw /> Retry last execution</DropdownMenuItem> : null}
          {caps.cancelLast ? <DropdownMenuItem onSelect={() => actions.cancelLast.mutate(job)}><Ban /> Cancel pending execution</DropdownMenuItem> : null}
          {caps.toggle ? (
            <DropdownMenuItem onSelect={() => (job.enabled ? setConfirm('disable') : actions.setEnabled.mutate({ job, enabled: true }))}>
              <Power /> {job.enabled ? 'Disable' : 'Enable'}
            </DropdownMenuItem>
          ) : null}
          {caps.remove ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setConfirm('delete')}><Trash2 /> Delete</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete ${job.name}?`}
        description={
          <>
            <p>The job and <strong>its entire execution history</strong> are deleted. This cannot be undone.</p>
            {job.source === 'SDK' ? <p className="mt-2">This job is defined in application code; it is recreated the next time an agent with this task connects.</p> : <p className="mt-2">To stop it without losing history, disable it instead.</p>}
          </>
        }
        confirmLabel="Delete job"
        destructive
        onConfirm={async () => {
          await actions.remove.mutateAsync(job);
          router.push('/jobs');
        }}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Disable ${job.name}?`}
        description="Disabled jobs do not run: scheduled occurrences are skipped and submissions are rejected until the job is enabled again. Executions already queued still run."
        confirmLabel="Disable"
        onConfirm={() => actions.setEnabled.mutateAsync({ job, enabled: false })}
      />
    </>
  );
}
