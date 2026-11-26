import type { Metadata } from 'next';
import { WorkerDetailPage } from '@/features/workers/worker-detail-page';

export const metadata: Metadata = { title: 'Worker' };

export default async function Page({ params }: { params: Promise<{ workerId: string }> }) {
  const { workerId } = await params;
  return <WorkerDetailPage workerId={workerId} />;
}
