import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { scheduleDefinitionSchema } from '@chronos/protocol';
import { upcomingCronOccurrences } from '@chronos/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ZodValidationPipe, uuidParam } from '../../common/http/zod-validation.pipe';
import { AppException } from '../../common/http/app-exception';
import { AllowPrincipals, RequireRole } from '../auth/auth.decorators';

const MAX_RANGE_DAYS = 93;
const MAX_OCCURRENCES_PER_JOB = 2_000;
const MAX_OCCURRENCES_TOTAL = 10_000;

export const previewScheduleSchema = z
  .object({
    schedule: scheduleDefinitionSchema,
    count: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export type PreviewScheduleInput = z.infer<typeof previewScheduleSchema>;

export const upcomingQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date(),
    jobId: z.string().uuid().optional(),
  })
  .strict();
export type UpcomingQuery = z.infer<typeof upcomingQuerySchema>;

/**
 * Schedule tooling for the dashboard: validate a definition before saving it, and
 * project future occurrences of every active schedule into a calendar range.
 */
@Controller('projects/:projectId/schedule')
@AllowPrincipals('user', 'project')
export class ScheduleController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates a schedule definition and returns its next occurrences without saving
   * anything. Invalid cron expressions or time zones produce a 400 VALIDATION_FAILED.
   */
  @Post('preview')
  @RequireRole('VIEWER')
  @HttpCode(HttpStatus.OK)
  async preview(@Param('projectId', uuidParam) projectId: string, @Body(new ZodValidationPipe(previewScheduleSchema)) body: PreviewScheduleInput) {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { timezone: true } });
    const timezone = body.schedule.timezone ?? project.timezone;
    const now = new Date();
    if (body.schedule.runAt) {
      return { type: 'ONCE' as const, timezone, occurrences: [body.schedule.runAt], inPast: body.schedule.runAt < now };
    }
    return { type: 'CRON' as const, timezone, occurrences: upcomingCronOccurrences(body.schedule.cron!, timezone, now, body.count), inPast: false };
  }

  /**
   * Planned occurrences of all ACTIVE schedules within [from, to] (default from = now),
   * sorted by time. Paused, completed and disabled jobs are excluded. This is a
   * projection of the current definitions, not a record: past runs come from
   * GET /executions with from/to.
   */
  @Get('upcoming')
  @RequireRole('VIEWER')
  async upcoming(@Param('projectId', uuidParam) projectId: string, @Query(new ZodValidationPipe(upcomingQuerySchema)) query: UpcomingQuery) {
    const now = new Date();
    const from = query.from && query.from > now ? query.from : now;
    if (query.to <= from) throw AppException.badRequest('"to" must be in the future and after "from"');
    if (query.to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw AppException.badRequest(`range must not exceed ${MAX_RANGE_DAYS} days`);
    }

    const schedules = await this.prisma.jobSchedule.findMany({
      where: { state: 'ACTIVE', job: { projectId, enabled: true, ...(query.jobId ? { id: query.jobId } : {}) } },
      select: { type: true, cronExpression: true, runAt: true, timezone: true, nextRunAt: true, job: { select: { id: true, name: true, mode: true } } },
    });

    const occurrences: { at: Date; jobId: string; jobName: string; mode: string }[] = [];
    const truncatedJobs: string[] = [];
    for (const schedule of schedules) {
      const base = { jobId: schedule.job.id, jobName: schedule.job.name, mode: schedule.job.mode };
      if (schedule.type === 'ONCE') {
        const at = schedule.nextRunAt ?? schedule.runAt;
        if (at && at >= from && at <= query.to) occurrences.push({ at, ...base });
        continue;
      }
      // Start just before `from` so an occurrence exactly at `from` is included.
      let cursor = new Date(from.getTime() - 1);
      let count = 0;
      while (count < MAX_OCCURRENCES_PER_JOB) {
        const batch = upcomingCronOccurrences(schedule.cronExpression!, schedule.timezone, cursor, 100);
        let done = false;
        for (const at of batch) {
          if (at > query.to) {
            done = true;
            break;
          }
          occurrences.push({ at, ...base });
          count += 1;
          if (count >= MAX_OCCURRENCES_PER_JOB) break;
        }
        if (done || batch.length === 0) break;
        cursor = batch[batch.length - 1]!;
      }
      if (count >= MAX_OCCURRENCES_PER_JOB) truncatedJobs.push(schedule.job.id);
    }

    occurrences.sort((a, b) => a.at.getTime() - b.at.getTime() || a.jobName.localeCompare(b.jobName));
    return {
      from,
      to: query.to,
      occurrences: occurrences.slice(0, MAX_OCCURRENCES_TOTAL),
      /** True when results were capped (per job or overall); narrow the range or filter by job. */
      truncated: truncatedJobs.length > 0 || occurrences.length > MAX_OCCURRENCES_TOTAL,
      truncatedJobs,
    };
  }
}
