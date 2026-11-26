import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithApi } from '@/test/render';
import type { Credential } from '@/types/api';
import { CredentialsPage, credentialState } from './credentials-page';
import { MembersPage } from './members-page';
import { passwordFormSchema } from './profile-page';

const workspace = { role: 'ADMIN' as 'ADMIN' | 'OWNER' | 'MEMBER' };
vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({
    organization: { id: 'o1', name: 'Acme', role: workspace.role },
    project: { id: 'p1', name: 'Storefront', slug: 'storefront' },
    me: { id: 'u-admin' },
    role: workspace.role,
    can: (required: string) => ({ VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 } as Record<string, number>)[workspace.role]! >= ({ VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 } as Record<string, number>)[required]!,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { vi.unstubAllGlobals(); workspace.role = 'ADMIN'; });

const credential = (patch: Partial<Credential> = {}): Credential => ({ id: 'c1', kind: 'AGENT', name: 'billing', displayPrefix: 'chr_a_AbCd', projectId: 'p1', expiresAt: null, lastUsedAt: null, revokedAt: null, rotatedFromId: null, createdAt: '2026-01-01T00:00:00Z', ...patch });

describe('settings logic', () => {
  it('derives credential states', () => {
    const now = Date.parse('2026-01-10T00:00:00Z');
    expect(credentialState(credential(), now).label).toBe('Active');
    expect(credentialState(credential({ revokedAt: '2026-01-02T00:00:00Z' }), now).label).toBe('Revoked');
    expect(credentialState(credential({ expiresAt: '2026-01-09T00:00:00Z' }), now).label).toBe('Expired');
    expect(credentialState(credential({ expiresAt: '2026-01-12T00:00:00Z' }), now).label).toBe('Expires soon');
  });

  it('validates password changes', () => {
    expect(passwordFormSchema.safeParse({ currentPassword: 'old-password-1', newPassword: 'a-new-long-password', confirmPassword: 'a-new-long-password' }).success).toBe(true);
    expect(passwordFormSchema.safeParse({ currentPassword: 'x', newPassword: 'short', confirmPassword: 'short' }).success).toBe(false);
    expect(passwordFormSchema.safeParse({ currentPassword: 'x', newPassword: 'a-new-long-password', confirmPassword: 'different-password' }).success).toBe(false);
    expect(passwordFormSchema.safeParse({ currentPassword: 'same-password-1', newPassword: 'same-password-1', confirmPassword: 'same-password-1' }).success).toBe(false);
  });
});

describe('MembersPage', () => {
  const members = [
    { id: 'u-owner', email: 'owner@example.com', name: 'Owner', isActive: true, role: 'OWNER', joinedAt: '2026-01-01T00:00:00Z' },
    { id: 'u-admin', email: 'admin@example.com', name: 'Me', isActive: true, role: 'ADMIN', joinedAt: '2026-01-01T00:00:00Z' },
    { id: 'u-viewer', email: 'viewer@example.com', name: 'Viewer', isActive: true, role: 'VIEWER', joinedAt: '2026-01-01T00:00:00Z' },
  ];

  it('lets admins manage lower roles but not owners, and lets them leave', async () => {
    renderWithApi(<MembersPage />, { '/api/chronos/v1/organizations/o1/members': members });
    const ownerRow = (await screen.findByText('owner@example.com')).closest('tr')!;
    expect(within(ownerRow).queryByRole('combobox')).toBeNull();
    expect(within(ownerRow).queryByRole('button')).toBeNull();
    const viewerRow = screen.getByText('viewer@example.com').closest('tr')!;
    expect(within(viewerRow).getByRole('combobox', { name: 'Role of viewer@example.com' })).toBeInTheDocument();
    expect(within(viewerRow).getByRole('button', { name: 'Remove viewer@example.com' })).toBeInTheDocument();
    expect(within(screen.getByText('admin@example.com').closest('tr')!).getByRole('button', { name: 'Leave organization' })).toBeInTheDocument();
  });

  it('hides member management from members', async () => {
    workspace.role = 'MEMBER';
    renderWithApi(<MembersPage />, { '/api/chronos/v1/organizations/o1/members': members });
    await screen.findByText('viewer@example.com');
    expect(screen.queryByRole('button', { name: /Add member/ })).toBeNull();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });
});

describe('CredentialsPage', () => {
  it('shows a new token exactly once', async () => {
    const { calls } = renderWithApi(<CredentialsPage />, {
      '/api/chronos/v1/projects/p1/credentials': [credential()],
      '/api/chronos/v1/projects/p1/agents': [{ id: 'a1', credentialId: 'c1', status: 'ONLINE' }],
      'POST /api/chronos/v1/projects/p1/credentials': { ...credential({ id: 'c2', kind: 'PROJECT', name: 'ci', displayPrefix: 'chr_p_ZzZz' }), token: 'chr_p_secret-token-value-1234567890' },
    });
    expect(await screen.findByText('1 connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /API key/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'ci');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('chr_p_secret-token-value-1234567890')).toBeInTheDocument();
    expect(JSON.parse(calls.find((call) => call.method === 'POST')!.body!)).toEqual({ kind: 'PROJECT', name: 'ci' });
    await userEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    await vi.waitFor(() => expect(screen.queryByText('chr_p_secret-token-value-1234567890')).toBeNull());
  });

  it('is limited to admins', () => {
    workspace.role = 'MEMBER';
    const { calls } = renderWithApi(<CredentialsPage />, {});
    expect(screen.getByText('Admins only')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
