'use client';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/hooks/use-workspace';
import { NAV_ITEMS } from './nav';

const LABELS: Record<string, string> = { new: 'New', edit: 'Edit', submit: 'Submit', docs: 'Documentation', profile: 'Profile', organization: 'Organization', projects: 'Projects', credentials: 'Credentials', members: 'Members' };

function label(segment: string): string {
  const nav = NAV_ITEMS.find((item) => item.href === `/${segment}`);
  if (nav) return nav.label;
  if (LABELS[segment]) return LABELS[segment]!;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return segment.slice(0, 8);
  return decodeURIComponent(segment);
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const { organization, project } = useWorkspace();
  const segments = pathname.split('/').filter(Boolean);
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      <span className="hidden truncate text-muted-foreground md:inline">{organization?.name}</span>
      <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground md:inline" />
      <span className="hidden truncate text-muted-foreground sm:inline">{project?.name ?? 'No project'}</span>
      {segments.length === 0 ? (
        <>
          <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground sm:inline" />
          <span className="font-medium">Overview</span>
        </>
      ) : (
        segments.map((segment, index) => {
          const href = `/${segments.slice(0, index + 1).join('/')}`;
          const last = index === segments.length - 1;
          return (
            <span key={href} className="flex min-w-0 items-center gap-1">
              <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground ${index === 0 ? 'hidden sm:inline' : ''}`} />
              {last ? <span className="truncate font-medium">{label(segment)}</span> : <Link href={href} className="truncate text-muted-foreground hover:text-foreground">{label(segment)}</Link>}
            </span>
          );
        })
      )}
    </nav>
  );
}
