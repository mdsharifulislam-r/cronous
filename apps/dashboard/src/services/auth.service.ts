import { request } from '@/lib/api/client';
import type { BootstrapResult, Me } from '@/types/api';

export interface SetupInput {
  bootstrapToken: string;
  admin: { email: string; name: string; password: string };
  organization: { name: string; slug: string };
  project: { name: string; slug: string; timezone: string };
}

export const authService = {
  me: () => request<Me>('GET', '/api/session'),
  login: (email: string, password: string) => request<{ user: { id: string; email: string; name: string }; expiresAt: string }>('POST', '/api/session', { body: { email, password } }),
  logout: () => request<void>('DELETE', '/api/session'),
  bootstrapStatus: () => request<{ bootstrapped: boolean }>('GET', '/api/session/bootstrap'),
  setup: (input: SetupInput) => request<BootstrapResult>('POST', '/api/session/bootstrap', { body: input }),
  updateProfile: (name: string) => request<Me>('PATCH', '/api/chronos/v1/auth/me', { body: { name } }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ revokedSessions: number }>('POST', '/api/chronos/v1/auth/password', { body: { currentPassword, newPassword } }),
};
