import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithApi } from '@/test/render';
import type { AuditEntry } from '@/types/api';
import { ActivityPage, actorLabel } from './activity-page';

const workspace = { role: 'ADMIN' };
vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ organization: { id: 'o1', name: 'Acme' }, projects: [{ id: 'p1', name: 'Storefront' }], can: (role: string) => workspace.role === 'ADMIN' || role === 'VIEWER' }),
}));
afterEach(() => { vi.unstubAllGlobals(); workspace.role = 'ADMIN'; });

const entry = (patch: Partial<AuditEntry> = {}): AuditEntry => ({
  id: '1', action: 'job.created', projectId: 'p1', targetType: 'job', targetId: 'abcdef12-0000', metadata: { name: 'sync' }, requestId: 'r1', ipAddress: '10.0.0.1', createdAt: '2026-01-01T00:00:00Z',
  actor: { type: 'USER', id: 'u1', name: 'Ada', email: 'ada@example.com', credentialKind: null, credentialPrefix: null }, ...patch,
});

describe('activity log', () => {
  it('labels actors', () => {
    expect(actorLabel(entry())).toBe('Ada');
    expect(actorLabel(entry({ actor: { type: 'CREDENTIAL', id: 'c', name: 'ci key', email: null, credentialKind: 'PROJECT', credentialPrefix: 'chr_p_AbC' } }))).toBe('API key ci key (chr_p_AbC…)');
    expect(actorLabel(entry({ actor: { type: 'SYSTEM', id: null, name: null, email: null, credentialKind: null, credentialPrefix: null } }))).toBe('System');
  });

  it('is hidden from non-admins without calling the API', async () => {
    workspace.role = 'MEMBER';
    const { calls } = renderWithApi(<ActivityPage />, {});
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('audit-logs'))).toBe(false);
  });

  it('loads entries and sends event-type filters to the server', async () => {
    const { calls } = renderWithApi(<ActivityPage />, {
      '/api/chronos/v1/organizations/o1/audit-logs': { items: [entry()], nextCursor: null },
      '/api/chronos/v1/organizations/o1/members': [],
    });
    expect(await screen.findByText('job.created')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search event type'), 'credential.');
    await vi.waitFor(() => expect(calls.some((call) => call.url.includes('action=credential.'))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('r1')).toBeInTheDocument();
  });
});
