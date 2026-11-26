import type { Metadata } from 'next';
import { QueueDetailPage } from '@/features/queues/queue-detail-page';

export const metadata: Metadata = { title: 'Queue' };

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <QueueDetailPage name={decodeURIComponent(name)} />;
}
