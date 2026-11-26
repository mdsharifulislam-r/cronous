import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SubmitPage } from '@/features/queues/submit-page';

export const metadata: Metadata = { title: 'Submit job' };

export default function Page() {
  return (
    <Suspense>
      <SubmitPage />
    </Suspense>
  );
}
