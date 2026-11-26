import { AppShell } from '@/components/layout/app-shell';
import { GlobalSearch } from '@/features/search/global-search';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell search={<GlobalSearch />}>{children}</AppShell>;
}
