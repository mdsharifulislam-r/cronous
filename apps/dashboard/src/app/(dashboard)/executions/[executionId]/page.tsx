import type { Metadata } from 'next';
import { ExecutionDetailPage } from '@/features/executions/execution-detail-page';

export const metadata: Metadata = { title: 'Execution' };

export default async function Page({ params }: { params: Promise<{ executionId: string }> }) {
  const { executionId } = await params;
  return <ExecutionDetailPage executionId={executionId} />;
}
