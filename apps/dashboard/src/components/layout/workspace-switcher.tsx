'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronsUpDown, FolderKanban } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/hooks/use-workspace';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspace';

function SwitcherButton({ icon: Icon, label, value, collapsed }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; collapsed: boolean }) {
  return (
    <button
      type="button"
      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', collapsed && 'justify-center px-0')}
      aria-label={`${label}: ${value}`}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] leading-tight text-muted-foreground">{label}</span>
            <span className="block truncate font-medium">{value}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      )}
    </button>
  );
}

export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { organizations, organization, projects, project, can } = useWorkspace();
  const { setOrg, setProject } = useWorkspaceStore();
  const client = useQueryClient();
  const router = useRouter();

  const switchProject = (id: string) => {
    setProject(id);
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' && query.queryKey[0] !== 'projects' });
  };

  return (
    <div className="space-y-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div>
            <SwitcherButton icon={Building2} label="Organization" value={organization?.name ?? '—'} collapsed={collapsed} />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={organization?.id ?? ''} onValueChange={(id) => { setOrg(id); client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' }); }}>
            {organizations.map((org) => (
              <DropdownMenuRadioItem key={org.id} value={org.id}>
                <span className="truncate">{org.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{org.role.toLowerCase()}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push('/settings/organization')}>Organization settings</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div>
            <SwitcherButton icon={FolderKanban} label="Project" value={project?.name ?? 'No project'} collapsed={collapsed} />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Projects in {organization?.name}</DropdownMenuLabel>
          {projects.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">No projects yet</p> : null}
          <DropdownMenuRadioGroup value={project?.id ?? ''} onValueChange={switchProject}>
            {projects.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id}>
                <span className="truncate">{item.name}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{item.slug}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {can('ADMIN') ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push('/settings/projects')}>Manage projects</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
