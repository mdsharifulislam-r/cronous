import type { Metadata } from 'next';
import { OrganizationPage } from '@/features/settings/organization-page';

export const metadata: Metadata = { title: 'Organization' };

export default function Page() {
  return <OrganizationPage />;
}
