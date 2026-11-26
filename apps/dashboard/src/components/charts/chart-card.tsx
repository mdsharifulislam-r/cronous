import { BarChart3 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/states';

export function ChartCard({ title, description, loading, error, empty, emptyText = 'No executions in this period', actions, children, onRetry, className }: { title: string; description?: string; loading?: boolean; error?: unknown; empty?: boolean; emptyText?: string; actions?: React.ReactNode; children: React.ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState error={error} {...(onRetry ? { onRetry } : {})} className="h-56 py-4" />
        ) : loading ? (
          <Skeleton className="h-56 w-full" />
        ) : empty ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <BarChart3 className="size-5" />
            {emptyText}
          </div>
        ) : (
          <div className="h-56 w-full">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}
