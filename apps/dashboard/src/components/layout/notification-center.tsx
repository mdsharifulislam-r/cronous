'use client';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StatusDot } from '@/components/shared/status-badge';
import { timeAgo } from '@/lib/format';
import { useNotifications } from '@/stores/notifications';

/** Failures and disconnects observed on the live event stream during this session. */
export function NotificationCenter() {
  const { items, markAllRead, clear } = useNotifications();
  const unread = items.filter((item) => !item.read).length;
  return (
    <Popover onOpenChange={(open) => !open && markAllRead()}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
          <Bell />
          {unread > 0 ? <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">{unread > 9 ? '9+' : unread}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          {items.length > 0 ? <button type="button" onClick={clear} className="text-xs text-muted-foreground hover:text-foreground">Clear</button> : null}
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">Failed executions and disconnected agents or workers appear here while you are signed in.</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="border-b border-border last:border-0">
                <Link href={item.href ?? '#'} className="flex gap-2.5 px-3 py-2.5 hover:bg-muted">
                  <StatusDot tone={item.tone} className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{item.title}</span>
                    {item.description ? <span className="block truncate text-xs text-muted-foreground">{item.description}</span> : null}
                    <span className="block text-xs text-muted-foreground">{timeAgo(item.at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
