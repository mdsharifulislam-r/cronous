import type { Metadata } from 'next';
import { NewJobPage } from '@/features/jobs/new-job-page';

export const metadata: Metadata = { title: 'Create job' };

export default function Page() {
  return <NewJobPage />;
}
