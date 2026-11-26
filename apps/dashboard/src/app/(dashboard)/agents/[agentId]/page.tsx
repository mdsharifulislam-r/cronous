import type { Metadata } from 'next';
import { AgentDetailPage } from '@/features/agents/agent-detail-page';

export const metadata: Metadata = { title: 'Agent' };

export default async function Page({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return <AgentDetailPage agentId={agentId} />;
}
