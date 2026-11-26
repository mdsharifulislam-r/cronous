import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'border-border bg-muted text-muted-foreground',
      primary: 'border-primary/30 bg-primary/10 text-primary',
      success: 'border-success/30 bg-success/10 text-success',
      warning: 'border-warning/35 bg-warning/10 text-warning',
      danger: 'border-danger/30 bg-danger/10 text-danger',
      info: 'border-info/30 bg-info/10 text-info',
      delayed: 'border-delayed/30 bg-delayed/10 text-delayed',
      outline: 'border-border-strong text-foreground',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
