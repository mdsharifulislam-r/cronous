'use client';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useWorkspace } from '@/hooks/use-workspace';
import { qk } from '@/lib/query-keys';
import { jobsService } from '@/services';
import { JobForm } from './job-form';
import { useJobActions } from './use-job-actions';

export function EditJobPage({ jobId }: { jobId: string }) {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const job = useQuery({ queryKey: qk.job(projectId, jobId), queryFn: () => jobsService.get(projectId, jobId) });
  const actions = useJobActions(projectId);

  if (!can('MEMBER')) return <EmptyState title="You cannot edit jobs" description="Editing jobs requires the Member role or higher." />;
  if (job.isLoading) return <Skeleton className="h-64" />;
  if (job.error || !job.data) return <ErrorState error={job.error} />;

  if (job.data.source === 'SDK') {
    // The API only lets operators toggle SDK-managed jobs; everything else lives in code.
    return (
      <div>
        <PageHeader title={`Edit ${job.data.name}`} description="This job is declared in application code with the SDK. Change its schedule and settings in code; here you can only enable or disable it." />
        <Card className="max-w-lg">
          <CardContent className="flex items-center justify-between gap-4 pt-5">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">Disabled jobs do not run, and submissions are rejected.</p>
            </div>
            <Switch checked={job.data.enabled} disabled={actions.setEnabled.isPending} onCheckedChange={(enabled) => actions.setEnabled.mutate({ job: job.data!, enabled })} aria-label="Enabled" />
          </CardContent>
        </Card>
      </div>
    );
  }
  return (
    <div>
      <PageHeader title={`Edit ${job.data.name}`} />
      <JobForm projectId={projectId} projectTimeZone={project!.timezone} job={job.data} />
    </div>
  );
}
