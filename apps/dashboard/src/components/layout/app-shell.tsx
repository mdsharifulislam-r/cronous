'use client';
import { useQueryClient } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { EmptyState, ErrorState } from '@/components/shared/states';
import { Logo } from '@/components/shared/logo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/hooks/use-workspace';
import { UNAUTHORIZED_EVENT } from '@/lib/api/client';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

/** Authenticated application frame. Any 401 from the API ends the session here. */
export function AppShell({ children, search }: { children: React.ReactNode; search?: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const client = useQueryClient();
  const { me, isLoading, error, organization, project, can } = useWorkspace();

  useEffect(() => {
    const onUnauthorized = () => {
      client.clear();
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [client, router]);

  if (isLoading && !me) {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Logo className="size-9 animate-pulse" />
      </div>
    );
  }
  if (error && !me) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <ErrorState error={error} onRetry={() => router.refresh()} className="max-w-md" />
      </div>
    );
  }

  // Settings that make sense without an organization/project stay reachable, so users can
  // create their first organization or project from the empty states below.
  const worksWithoutOrg = pathname === '/settings/organization' || pathname === '/settings/profile';
  const worksWithoutProject = worksWithoutOrg || pathname === '/settings/projects' || pathname === '/settings/members';
  let content = children;
  if (!organization && !worksWithoutOrg) {
    content = <EmptyState title="You are not a member of any organization" description="Ask an organization admin to add you, or create one in Settings." action={<Button asChild><Link href="/settings/organization">Organization settings</Link></Button>} />;
  } else if (organization && !project && !worksWithoutProject) {
    content = (
      <EmptyState
        icon={FolderPlus}
        title={`${organization.name} has no projects yet`}
        description={can('ADMIN') ? 'Create a project to start scheduling and queueing jobs.' : 'Ask an admin of this organization to create a project.'}
        {...(can('ADMIN') ? { action: <Button asChild><Link href="/settings/projects">Create a project</Link></Button> } : {})}
      />
    );
  }

  return (
    <RealtimeProvider projectId={project?.id ?? null}>
      <a href="#main" className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2">Skip to content</a>
      <div className="flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar search={search} />
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] flex-1 animate-fade-in px-4 py-6 md:px-6">{isLoading ? <Skeleton className="h-40 w-full" /> : content}</main>
        </div>
      </div>
    </RealtimeProvider>
  );
}
