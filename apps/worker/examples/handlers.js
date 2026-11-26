// Example Mode C handlers. Mount your own module and point CHRONOS_WORKER_HANDLERS at it.
// Each key is a job name (create the job with mode "WORKER"); each value receives a context:
//   { executionId, attempt, job, scheduledFor, idempotencyKey, payload, signal, log }
// Throw an error with `retryable = false` to mark a permanent failure.

module.exports = {
  'cleanup-temp-files': async (ctx) => {
    await ctx.log('INFO', 'Cleaning up temporary files', { scheduledFor: ctx.scheduledFor });
    return { removed: 0 };
  },

  'call-internal-report': async (ctx) => {
    const response = await fetch('http://reports.internal/run', { method: 'POST', signal: ctx.signal });
    if (response.status === 400) {
      const error = new Error('report service rejected the request');
      error.retryable = false;
      throw error;
    }
    if (!response.ok) throw new Error(`report service returned ${response.status}`);
    return { status: response.status };
  },
};
