import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ExecutionsTable } from './executions-table';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-workspace', () => ({ useWorkspace: () => ({ can: () => true }) }));
vi.mock('@/providers/realtime-provider', () => ({ useRealtime: () => ({ status: 'live', fallbackInterval: false }) }));
afterEach(() => vi.unstubAllGlobals());

const row = (id: string, patch: object = {}) => ({
  id, jobId: 'j', jobName: `job-${id}`, queue: 'emails', priority: 50, delayed: false, trigger: 'QUEUE', status: 'SUCCEEDED', mode: 'WORKER', scheduledFor: '2026-01-01T00:00:00Z', idempotencyKey: 'k',
  attemptCount: 1, maxAttempts: 3, nextAttemptAt: null, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z', lastError: null, createdAt: '2026-01-01T00:00:00Z',
  executor: { kind: 'WORKER', id: 'w1', name: 'worker-a' }, ...patch,
});

describe('ExecutionsTable', () => {
  it('pages with the API cursor and shows executor, kind and status', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      call += 1;
      const page = url.includes('cursor=c1') ? { items: [row('bbbbbbbb-2')], nextCursor: null } : { items: [row('aaaaaaaa-1', { status: 'PENDING', delayed: true, startedAt: null, executor: null })], nextCursor: 'c1' };
      return new Response(JSON.stringify({ data: page }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <ExecutionsTable projectId="p1" filters={{ queue: 'emails', status: ['SUCCEEDED', 'PENDING'] }} columns={['id', 'job', 'kind', 'status', 'executor', 'actions']} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('job-aaaaaaaa-1')).toBeInTheDocument();
    expect(screen.getAllByText('Delayed')).toHaveLength(2); // kind and status of the delayed row
    expect(fetchMock.mock.calls[0]![0]).toContain('queue=emails');
    expect(fetchMock.mock.calls[0]![0]).toContain('status=SUCCEEDED%2CPENDING');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('job-bbbbbbbb-2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'worker-a' })).toHaveAttribute('href', '/workers/w1');
    expect(screen.getByText(/end of results/)).toBeInTheDocument();
    expect(call).toBe(2);
  });
});
