import { chronos } from '../../config/chronos';

chronos.task(
  'cleanup-inactive-users',
  {
    schedule: '*/30 * * * *',
    // Never run two cleanups at the same time.
    concurrencyPolicy: 'FORBID',
    // After downtime, run one catch-up instead of every missed occurrence.
    misfirePolicy: 'FIRE_ONCE',
  },
  async (ctx) => {
    ctx.log.info('Cleaning up inactive users');
    return { removed: 0 };
  },
);
