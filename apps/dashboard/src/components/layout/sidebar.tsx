'use client';
import { BookOpen, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/shared/logo';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspace';
import { NAV_ITEMS, isActive } from './nav';
import { UserMenu } from './user-menu';
import { WorkspaceSwitcher } from './workspace-switcher';

function NavLink({ href, label, icon: Icon, collapsed, onNavigate }: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  const link = (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
        active ? 'bg-primary-subtle font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active && 'text-primary')} />
      {collapsed ? <span className="sr-only">{label}</span> : label}
    </Link>
  );
  return collapsed ? <Tooltip content={label} side="right">{link}</Tooltip> : link;
}

/** Sidebar body, shared by the desktop sidebar and the mobile drawer. */
export function SidebarContent({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex h-14 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <Logo />
        {collapsed ? null : <span className="text-[15px] font-semibold tracking-tight">Chronos</span>}
      </div>
      <div className="px-2 pb-2">
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>
      <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto border-t border-border px-2 pt-3">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} {...item} collapsed={collapsed} {...(onNavigate ? { onNavigate } : {})} />
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-border p-2">
        <NavLink href="/docs" label="Documentation" icon={BookOpen} collapsed={collapsed} {...(onNavigate ? { onNavigate } : {})} />
        <UserMenu collapsed={collapsed} />
      </div>
    </div>
  );
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useWorkspaceStore();
  return (
    <aside className={cn('sticky top-0 hidden h-dvh shrink-0 border-r border-border bg-surface transition-[width] duration-200 lg:block', sidebarCollapsed ? 'w-16' : 'w-60')}>
      <SidebarContent collapsed={sidebarCollapsed} />
      <button
        type="button"
        onClick={toggleSidebar}
        className="absolute top-4 -right-3 flex size-6 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground shadow-sm hover:text-foreground"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <PanelLeftOpen className="size-3.5" /> : <PanelLeftClose className="size-3.5" />}
      </button>
    </aside>
  );
}
