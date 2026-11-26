import type { Metadata } from 'next';
import { WorkersPage } from '@/features/workers/workers-page';

export const metadata: Metadata = { title: 'Workers' };

export default function Page() {
  return <WorkersPage />;
}
