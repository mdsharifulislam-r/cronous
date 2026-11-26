import type { OrgRole } from '@chronos/database';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

export function roleSatisfies(actual: OrgRole, required: OrgRole): boolean {
  return RANK[actual] >= RANK[required];
}

/**
 * Project and agent credentials act inside their own project with at most MEMBER
 * privileges: they can manage jobs but never credentials, members or settings.
 */
export const MACHINE_PRINCIPAL_MAX_ROLE: OrgRole = 'MEMBER';

/** Whether `actor` may assign or modify a membership holding `target` role. */
export function canManageRole(actor: OrgRole, target: OrgRole): boolean {
  if (actor === 'OWNER') return true;
  // Admins manage members below OWNER, and may not create owners.
  return actor === 'ADMIN' && target !== 'OWNER';
}
