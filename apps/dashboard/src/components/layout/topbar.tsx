'use client';
import { Menu } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Breadcrumbs } from './breadcrumbs';
import { ConnectionStatus } from './connection-status';
import { NotificationCenter } from './notification-center';
import { SidebarContent } from './sidebar';
import { UserMenu } from './user-menu';

export function Topbar({ search }: { search?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:px-6">
      <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
        <Menu />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>
      {search}
      <ConnectionStatus />
      <NotificationCenter />
      <div className="lg:hidden">
        <UserMenu compact />
      </div>
    </header>
  );
}
