'use client';
import Link from 'next/link';
import { CopyButton } from '@/components/shared/copy-button';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useWorkspace } from '@/hooks/use-workspace';
import { EXECUTION_STATUS } from '@/lib/status';
import { usePublicUrl } from '@/hooks/use-public-url';

function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-10 font-mono text-xs leading-relaxed">{children}</pre>
      <CopyButton value={children} label="Copy snippet" className="absolute top-1.5 right-1.5" />
    </div>
  );
}

/** In-app quick reference. The full documentation lives in the repository's docs/ folder. */
export function DocsPage() {
  const { project } = useWorkspace();
  const slug = project?.slug ?? 'my-project';
  const server = usePublicUrl();
  return (
    <div className="max-w-4xl">
      <PageHeader title="Documentation" description="Quick reference for this project. Full guides: docs/QUEUE_JOBS.md, docs/API_REFERENCE.md and docs/DEPLOYMENT_GUIDE.md in the Chronos repository." />
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Concepts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><strong>Job</strong>: what runs (a name, an execution mode, retries, timeout). <strong>Queue</strong>: how many run at once, in which order, and whether anything runs (pause).</p>
            <p><strong>Scheduled</strong> jobs carry a cron or one-time schedule and run by themselves. <strong>Immediate</strong> and <strong>delayed</strong> runs are submissions of a job (<code className="font-mono">chronos.queue()</code> or <code className="font-mono">POST /queue</code>); delays are not cron.</p>
            <p>Execution modes: <strong>HTTP webhook</strong> (Chronos calls your endpoint), <strong>Agent</strong> (your app runs the handler via @sharifulislam1/cronous), <strong>Central worker</strong> (a Chronos worker runs it).</p>
            <p>Delivery is at-least-once: make handlers idempotent with <code className="font-mono">ctx.idempotencyKey</code>.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Agent (SDK) in your application</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>Create an agent token in <Link href="/settings/credentials" className="text-primary hover:underline">Settings → Credentials</Link>, then:</p>
            <Code>{`npm install @sharifulislam1/cronous\n\nCHRONOS_SERVER=${server}\nCHRONOS_AGENT_TOKEN=chr_a_…`}</Code>
            <Code>{`import { Chronos } from '@sharifulislam1/cronous';\n\nconst chronos = new Chronos({ server: process.env.CHRONOS_SERVER!, project: '${slug}' });\n\nchronos.task('daily-report', { schedule: '0 2 * * *', timezone: '${project?.timezone ?? 'UTC'}' }, async (ctx) => {\n  ctx.log.info('Generating report');\n});\n\nchronos.task('send-email', { queue: 'emails', maxAttempts: 5 }, async (ctx) => {\n  await mailer.send(ctx.payload, { idempotencyKey: ctx.idempotencyKey });\n});\n\nawait chronos.start();`}</Code>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Submit immediate and delayed jobs</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Code>{`await chronos.queue('send-email', { to: 'a@example.com' });                      // immediate\nawait chronos.queue('send-reminder', { userId: 7 }, { delay: 300_000 });         // in 5 minutes\nawait chronos.queue('rebuild-index', {}, { priority: 90, idempotencyKey: 'idx-7' });\nawait chronos.cancel(executionId);                                               // if not started`}</Code>
            <p>Over REST with a project API key (chr_p_…):</p>
            <Code>{`curl -X POST ${server}/v1/projects/${project?.id ?? '<project-id>'}/queue \\\n  -H "Authorization: Bearer $CHRONOS_PROJECT_KEY" -H 'Content-Type: application/json' \\\n  -d '{"job":"send-reminder","payload":{"userId":7},"delayMs":300000}'`}</Code>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Execution statuses</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {Object.entries(EXECUTION_STATUS).map(([key, view]) => (
                <div key={key}><dt className="font-medium">{view.label} <span className="font-mono text-xs text-muted-foreground">{key}</span></dt><dd className="text-muted-foreground">{view.description}</dd></div>
              ))}
              <div><dt className="font-medium">Delayed</dt><dd className="text-muted-foreground">Waiting status shown for submissions with a future run time</dd></div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
