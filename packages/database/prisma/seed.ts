/**
 * Development seed. Creates an admin user, an organization, a project and one project
 * plus one agent credential, and marks the installation as bootstrapped.
 *
 * Production installations must use the bootstrap flow (POST /v1/bootstrap) instead;
 * this script refuses to run when NODE_ENV=production.
 *
 * Required env: DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
 * Optional env: SEED_ORG_SLUG (default "dev"), SEED_PROJECT_SLUG (default "dev"),
 *               SEED_PROJECT_TIMEZONE (default "UTC")
 */
import { z } from 'zod';
import { emailSchema, generateToken, hashPassword, parseEnv, passwordSchema, slugSchema, timeZoneSchema } from '@chronos/shared';
import { PrismaClient } from '@prisma/client';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  SEED_ADMIN_EMAIL: emailSchema,
  SEED_ADMIN_PASSWORD: passwordSchema,
  SEED_ORG_SLUG: slugSchema.default('dev'),
  SEED_PROJECT_SLUG: slugSchema.default('dev'),
  SEED_PROJECT_TIMEZONE: timeZoneSchema.default('UTC'),
});

async function main(): Promise<void> {
  const env = parseEnv(envSchema);
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database. Use the bootstrap flow instead.');
  }

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const projectToken = generateToken('project');
    const agentToken = generateToken('agent');
    const passwordHash = await hashPassword(env.SEED_ADMIN_PASSWORD);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email: env.SEED_ADMIN_EMAIL },
        update: {},
        create: { email: env.SEED_ADMIN_EMAIL, name: 'Admin', passwordHash },
      });
      const org = await tx.organization.upsert({
        where: { slug: env.SEED_ORG_SLUG },
        update: {},
        create: { name: env.SEED_ORG_SLUG, slug: env.SEED_ORG_SLUG },
      });
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        update: { role: 'OWNER' },
        create: { organizationId: org.id, userId: user.id, role: 'OWNER' },
      });
      const project = await tx.project.upsert({
        where: { organizationId_slug: { organizationId: org.id, slug: env.SEED_PROJECT_SLUG } },
        update: {},
        create: {
          organizationId: org.id,
          name: env.SEED_PROJECT_SLUG,
          slug: env.SEED_PROJECT_SLUG,
          timezone: env.SEED_PROJECT_TIMEZONE,
        },
      });
      await tx.apiCredential.createMany({
        data: [
          {
            kind: 'PROJECT',
            name: 'seed project key',
            projectId: project.id,
            tokenHash: projectToken.hash,
            displayPrefix: projectToken.displayPrefix,
            createdByUserId: user.id,
          },
          {
            kind: 'AGENT',
            name: 'seed agent token',
            projectId: project.id,
            tokenHash: agentToken.hash,
            displayPrefix: agentToken.displayPrefix,
            createdByUserId: user.id,
          },
        ],
      });
      await tx.systemState.upsert({
        where: { id: 1 },
        update: { bootstrappedAt: new Date(), bootstrapTokenHash: null },
        create: { id: 1, bootstrappedAt: new Date() },
      });
      await tx.auditLog.create({
        data: { organizationId: org.id, projectId: project.id, actorType: 'SYSTEM', action: 'seed.applied' },
      });
      return { org, project, user };
    });

    // Plaintext tokens are shown once; only their hashes are stored.
    process.stdout.write(
      [
        'Seed complete.',
        `  organization: ${result.org.slug} (${result.org.id})`,
        `  project:      ${result.project.slug} (${result.project.id})`,
        `  admin:        ${result.user.email}`,
        `  project key:  ${projectToken.token}`,
        `  agent token:  ${agentToken.token}`,
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
