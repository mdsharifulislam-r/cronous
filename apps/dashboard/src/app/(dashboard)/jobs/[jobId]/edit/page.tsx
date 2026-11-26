import type { Metadata } from 'next';
import { EditJobPage } from '@/features/jobs/edit-job-page';

export const metadata: Metadata = { title: 'Edit job' };

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <EditJobPage jobId={jobId} />;
}
