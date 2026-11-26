'use client';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { useWorkspace } from '@/hooks/use-workspace';
import { JobForm } from './job-form';

export function NewJobPage() {
  const { project, can } = useWorkspace();
  if (!can('MEMBER')) return <EmptyState title="You cannot create jobs" description="Creating jobs requires the Member role or higher in this organization." />;
  return (
    <div>
      <PageHeader title="Create job" description={`In project ${project!.name}. Scheduled jobs run by themselves; immediate and delayed jobs are submitted to a queue.`} />
      <JobForm projectId={project!.id} projectTimeZone={project!.timezone} />
    </div>
  );
}
