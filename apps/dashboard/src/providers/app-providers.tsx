'use client';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryProvider } from './query-provider';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <TooltipProvider>
          {children}
          <Toaster position="bottom-right" toastOptions={{ classNames: { toast: '!bg-surface !text-foreground !border-border' } }} />
        </TooltipProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
