import { NonRetryableError } from '@chronos/sdk';
import { chronos } from '../../config/chronos';

chronos.task(
  'daily-report',
  {
    schedule: '0 2 * * *',
    timezone: 'Asia/Dhaka',
    timeoutMs: 10 * 60_000,
    maxAttempts: 3,
  },
  async (ctx) => {
    ctx.log.info('Generating daily report...', { scheduledFor: ctx.scheduledFor.toISOString() });
    // Delivery is at-least-once: use the idempotency key to avoid duplicate side effects,
    // e.g. as a unique key when storing the report.
    const reportId = `report:${ctx.idempotencyKey}`;
    if (ctx.signal.aborted) throw new Error('aborted');
    return { reportId };
  },
);

// No schedule: runs only when triggered through the API or dashboard.
chronos.task<{ email: string }>('send-report', { maxAttempts: 5, retryBackoffMs: 30_000 }, async (ctx) => {
  if (!ctx.payload?.email) throw new NonRetryableError('payload.email is required', 'MISSING_EMAIL');
  ctx.log.info(`Sending report to ${ctx.payload.email}`);
});
