import type { Metadata } from 'next';
import { AgentsPage } from '@/features/agents/agents-page';

export const metadata: Metadata = { title: 'Agents' };

export default function Page() {
  return <AgentsPage />;
}
