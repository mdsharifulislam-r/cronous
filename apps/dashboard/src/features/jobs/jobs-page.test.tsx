import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithApi } from '@/test/render';
import { JobsPage } from './jobs-page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/jobs' }));
vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ project: { id: 'p1', name: 'Storefront', timezone: 'UTC' }, organization: { id: 'o1' }, can: (role: string) => role !== 'ADMIN' && role !== 'OWNER' }),
}));
vi.mock('@/providers/realtime-provider', () => ({ useRealtime: () => ({ status: 'live', fallbackInterval: false }) }));

afterEach(() => vi.unstubAllGlobals());

const job = (name: string, patch: object = {}) => ({
  id: name, projectId: 'p1', name, description: null, mode: 'WORKER', source: 'API', enabled: true, queueId: 'q', queue: 'default', priority: null, maxConcurrency: null, payloadSchema: null,
  http: null, payload: null, timeoutMs: 1000, maxAttempts: 3, retryBackoffMs: 0, retryBackoffMaxMs: 0, concurrencyPolicy: 'ALLOW', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  schedule: null, lastExecution: null, ...patch,
});

describe('JobsPage', () => {
  it('lists jobs from the API with type, queue and status', async () => {
    renderWithApi(<JobsPage />, {
      '/api/chronos/v1/projects/p1/jobs': [
        job('nightly-sync', { mode: 'HTTP', schedule: { type: 'CRON', cron: '0 2 * * *', runAt: null, timezone: 'Asia/Dhaka', state: 'ACTIVE', nextRunAt: '2099-01-01T00:00:00Z' } }),
        job('send-email', { queue: 'emails', source: 'SDK' }),
      ],
      '/api/chronos/v1/projects/p1/queues': [{ id: 'q', name: 'default' }, { id: 'q2', name: 'emails' }],
    });
    const row = (await screen.findByText('nightly-sync')).closest('tr')!;
    expect(within(row).getByText('Cron')).toBeInTheDocument();
    expect(within(row).getByText('0 2 * * *')).toBeInTheDocument();
    expect(within(row).getByText('Asia/Dhaka')).toBeInTheDocument();
    expect(within(row).getByText('Scheduled')).toBeInTheDocument();
    const sdkRow = screen.getByText('send-email').closest('tr')!;
    expect(within(sdkRow).getAllByText('On demand')).toHaveLength(2); // type badge and schedule column
    expect(within(sdkRow).getByText('SDK')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create job/ })).toBeInTheDocument();
  });

  it('sends the search to the server', async () => {
    const { calls } = renderWithApi(<JobsPage />, { '/api/chronos/v1/projects/p1/jobs': [], '/api/chronos/v1/projects/p1/queues': [] });
    await screen.findByText('No jobs yet');
    await userEvent.type(screen.getByLabelText('Search jobs'), 'sync');
    await vi.waitFor(() => expect(calls.some((call) => call.url.includes('q=sync'))).toBe(true));
  });
});
