import type { Metadata } from 'next';
import { ProjectsPage } from '@/features/settings/projects-page';

export const metadata: Metadata = { title: 'Projects' };

export default function Page() {
  return <ProjectsPage />;
}
