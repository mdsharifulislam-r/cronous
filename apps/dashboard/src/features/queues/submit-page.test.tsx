import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithApi } from '@/test/render';
import { SubmitPage } from './submit-page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('job=send-email'), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-workspace', () => ({ useWorkspace: () => ({ project: { id: 'p1', name: 'Storefront', timezone: 'UTC' }, can: () => true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.unstubAllGlobals());

const job = { id: 'j1', name: 'send-email', mode: 'WORKER', queue: 'emails', enabled: true, payload: { to: 'default@example.com' }, payloadSchema: null, maxAttempts: 3, timeoutMs: 60_000 };
const execution = { id: 'e1', jobId: 'j1', jobName: 'send-email', queue: 'emails', status: 'PENDING', trigger: 'QUEUE', priority: 50, delayed: true, scheduledFor: '2099-01-01T00:05:00Z', nextAttemptAt: '2099-01-01T00:05:00Z', idempotencyKey: 'k', maxAttempts: 3, timeoutMs: 60_000, createdAt: '2099-01-01T00:00:00Z' };

describe('SubmitPage', () => {
  it('submits a delayed job with the default payload and shows the result', async () => {
    const { calls } = renderWithApi(<SubmitPage />, {
      '/api/chronos/v1/projects/p1/jobs': [job],
      '/api/chronos/v1/projects/p1/queues': [{ id: 'q', name: 'emails', paused: false }],
      'POST /api/chronos/v1/projects/p1/queue': { execution, created: true },
      '/api/chronos/v1/projects/p1/executions/e1': { ...execution, attempts: [], logs: [] },
    });
    // Default payload of the selected job is prefilled.
    await vi.waitFor(() => expect((screen.getByLabelText(/Payload/) as HTMLTextAreaElement).value).toContain('default@example.com'));
    await userEvent.click(screen.getByRole('radio', { name: /Delayed/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit delayed job' }));

    expect(await screen.findByText('Submitted')).toBeInTheDocument();
    const post = calls.find((call) => call.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({ job: 'send-email', payload: { to: 'default@example.com' }, delayMs: 300_000 });
    expect(post.url).toBe('/api/chronos/v1/projects/p1/queue');
    expect(screen.getByText('e1')).toBeInTheDocument();
    expect(screen.getByText(/Starts in/)).toBeInTheDocument();
  });

  it('blocks invalid JSON before calling the API', async () => {
    const { calls } = renderWithApi(<SubmitPage />, { '/api/chronos/v1/projects/p1/jobs': [job], '/api/chronos/v1/projects/p1/queues': [] });
    const payload = await screen.findByLabelText(/Payload/);
    await vi.waitFor(() => expect((payload as HTMLTextAreaElement).value).not.toBe(''));
    await userEvent.clear(payload);
    await userEvent.type(payload, '{{"oops"');
    await userEvent.click(screen.getByRole('button', { name: 'Submit now' }));
    expect((await screen.findAllByText(/Invalid JSON/)).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
