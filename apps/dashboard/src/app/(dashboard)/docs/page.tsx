import type { Metadata } from 'next';
import { DocsPage } from '@/features/docs/docs-page';

export const metadata: Metadata = { title: 'Documentation' };

export default function Page() {
  return <DocsPage />;
}
