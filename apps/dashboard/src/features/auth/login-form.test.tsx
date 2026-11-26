import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm, safeNext } from './login-form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams('next=/jobs'),
}));

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoginForm />
    </QueryClientProvider>,
  );
}

describe('safeNext', () => {
  it('only allows same-site relative paths', () => {
    expect(safeNext('/jobs?x=1')).toBe('/jobs?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('LoginForm', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    replace.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('validates before calling the API', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{"bootstrapped":true}}'));
    renderForm();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => url !== '/api/session')).toBe(true);
  });

  it('signs in and returns to the requested page', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/session'
        ? new Response('{"data":{"user":{"id":"u"},"expiresAt":"2030-01-01T00:00:00Z"}}')
        : new Response('{"data":{"bootstrapped":true}}'),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/jobs'));
  });

  it('shows the lockout duration on 429', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/session'
        ? new Response('{"error":{"code":"TOO_MANY_REQUESTS","message":"locked"}}', { status: 429, headers: { 'retry-after': '600' } })
        : new Response('{"data":{"bootstrapped":true}}'),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Try again in 10 minutes/)).toBeInTheDocument();
  });
});
