import type { Metadata } from 'next';
import { CredentialsPage } from '@/features/settings/credentials-page';

export const metadata: Metadata = { title: 'Credentials' };

export default function Page() {
  return <CredentialsPage />;
}
