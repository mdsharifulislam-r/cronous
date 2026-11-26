import type { Metadata } from 'next';
import { JobDetailPage } from '@/features/jobs/job-detail-page';

export const metadata: Metadata = { title: 'Job' };

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <JobDetailPage jobId={jobId} />;
}
