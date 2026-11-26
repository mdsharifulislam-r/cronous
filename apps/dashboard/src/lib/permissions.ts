import type { OrgRole } from '@/types/api';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

/** Mirrors the server's role ranking. The server enforces; the UI only hides what would fail. */
export function hasRole(actual: OrgRole | undefined, required: OrgRole): boolean {
  return actual !== undefined && RANK[actual] >= RANK[required];
}

export function canManageRole(actor: OrgRole | undefined, target: OrgRole): boolean {
  if (actor === 'OWNER') return true;
  return actor === 'ADMIN' && target !== 'OWNER';
}
