'use client';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/hooks/use-workspace';
import { cn } from '@/lib/utils';
import { authService } from '@/services';
import { useWorkspaceStore } from '@/stores/workspace';

function initials(name: string | undefined): string {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
}

export function UserMenu({ compact = false, collapsed = false }: { compact?: boolean; collapsed?: boolean }) {
  const { me, role } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const client = useQueryClient();
  const reset = useWorkspaceStore((state) => state.reset);

  const signOut = async () => {
    try {
      await authService.logout();
    } catch {
      toast.error('Sign-out request failed; your local session was cleared');
    }
    client.clear();
    reset();
    router.replace('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn('flex items-center gap-2 rounded-md text-left text-sm hover:bg-muted', compact ? 'p-1' : 'w-full px-2 py-1.5', collapsed && 'justify-center px-0')}
          aria-label="Account menu"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-primary">{initials(me?.name)}</span>
          {compact || collapsed ? null : (
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{me?.name ?? '…'}</span>
              <span className="block truncate text-xs text-muted-foreground">{me?.email}</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <span className="block truncate text-foreground">{me?.name}</span>
          <span className="block truncate font-normal">{me?.email}{role ? ` · ${role.toLowerCase()}` : ''}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/settings/profile')}>
          <UserRound /> Profile and password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? 'dark'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="dark"><Moon className="size-4" /> Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light"><Sun className="size-4" /> Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><Monitor className="size-4" /> System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
