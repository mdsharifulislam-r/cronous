'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Page controls for client-side paginated lists (the API returns the complete list). */
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return total > 0 ? <p className="px-3 py-2.5 text-xs text-muted-foreground">{total} {total === 1 ? 'item' : 'items'}</p> : null;
  const first = page * pageSize + 1;
  const last = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
      <p className="text-xs text-muted-foreground tabular">{first}–{last} of {total}</p>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
        <span className="text-xs tabular text-muted-foreground">{page + 1} / {pages}</span>
        <Button variant="ghost" size="icon-sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
      </div>
    </div>
  );
}

/** "Load more" for cursor-paginated API lists (executions, activity). */
export function LoadMore({ hasMore, loading, onLoad, count }: { hasMore: boolean; loading: boolean; onLoad: () => void; count: number }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
      <p className="text-xs text-muted-foreground tabular">{count} loaded{hasMore ? '' : ' · end of results'}</p>
      {hasMore ? <Button variant="secondary" size="sm" loading={loading} onClick={onLoad}>Load more</Button> : null}
    </div>
  );
}
