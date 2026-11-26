import { chronos } from './config/chronos';
// Importing the job modules registers their tasks on the shared instance.
import './modules/reports/report.jobs';
import './modules/users/user.jobs';

async function bootstrap(): Promise<void> {
  await chronos.start();

  // Graceful shutdown: finish running handlers before exiting.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      chronos
        .stop({ timeoutMs: 30_000 })
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start Chronos agent:', error);
  process.exit(1);
});
