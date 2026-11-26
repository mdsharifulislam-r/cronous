'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/hooks/use-workspace';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { href: '/settings/profile', label: 'Profile', role: 'VIEWER' },
  { href: '/settings/organization', label: 'Organization', role: 'VIEWER' },
  { href: '/settings/members', label: 'Members and roles', role: 'VIEWER' },
  { href: '/settings/projects', label: 'Projects', role: 'VIEWER' },
  { href: '/settings/credentials', label: 'API and agent credentials', role: 'ADMIN' },
] as const;

export function SettingsNav() {
  const pathname = usePathname();
  const { can } = useWorkspace();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
      {SECTIONS.filter((section) => can(section.role)).map((section) => (
        <Link
          key={section.href}
          href={section.href}
          aria-current={pathname === section.href ? 'page' : undefined}
          className={cn('rounded-md px-3 py-1.5 text-sm whitespace-nowrap', pathname === section.href ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
