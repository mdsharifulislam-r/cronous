import { Activity, Bot, CalendarClock, Gauge, Layers, ListChecks, ScrollText, Server, Settings } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: Gauge },
  { href: '/jobs', label: 'Jobs', icon: ListChecks },
  { href: '/queues', label: 'Queues', icon: Layers },
  { href: '/schedules', label: 'Schedules', icon: CalendarClock },
  { href: '/executions', label: 'Executions', icon: Activity },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/workers', label: 'Workers', icon: Server },
  { href: '/activity', label: 'Activity Logs', icon: ScrollText },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
