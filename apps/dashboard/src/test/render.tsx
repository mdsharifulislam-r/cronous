import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

/** Renders with a fresh query client; `routes` maps "METHOD path" (or "path") to JSON data returned in the API envelope. */
export function renderWithApi(ui: React.ReactElement, routes: Record<string, unknown>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0]!;
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const key = `${method} ${path}` in routes ? `${method} ${path}` : path;
    if (!(key in routes)) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no mock for ${method} ${path}` } }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[key], meta: { requestId: 't' } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...result, calls, client };
}
