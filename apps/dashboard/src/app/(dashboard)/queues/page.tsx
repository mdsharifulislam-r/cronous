import type { Metadata } from 'next';
import { QueuesPage } from '@/features/queues/queues-page';

export const metadata: Metadata = { title: 'Queues' };

export default function Page() {
  return <QueuesPage />;
}
