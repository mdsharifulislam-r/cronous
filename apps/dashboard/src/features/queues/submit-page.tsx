'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, ExternalLink, Send, Zap } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { DurationInput } from '@/components/forms/duration-input';
import { Field, fieldAria } from '@/components/forms/field';
import { JsonEditor } from '@/components/forms/json-editor';
import { TimezoneInput } from '@/components/forms/timezone-input';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, errorMessage } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/hooks/use-workspace';
import { ApiError } from '@/lib/api/client';
import { formatDateTime, formatDelay } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { MODE_LABEL, executionStatusView } from '@/lib/status';
import { cn } from '@/lib/utils';
import { executionsService, jobsService, queuesService } from '@/services';
import type { SubmittedExecution } from '@/types/api';
import { expectedAt, submitSchema, toQueueSubmission, type SubmitValues } from './submit-model';

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Result panel: live status of the submitted execution and the remaining delay. */
function Submitted({ projectId, submitted, created, onAnother }: { projectId: string; submitted: SubmittedExecution; created: boolean; onAnother: () => void }) {
  const now = useNow();
  const live = useQuery({ queryKey: qk.execution(projectId, submitted.id), queryFn: () => executionsService.get(projectId, submitted.id), refetchInterval: 3000 });
  const current = live.data ?? { ...submitted };
  const runAt = current.nextAttemptAt ? new Date(current.nextAttemptAt).getTime() : null;
  const waiting = current.status === 'PENDING' && runAt !== null && runAt > now;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-4 text-success" />{created ? 'Submitted' : 'Already submitted (same idempotency key)'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Execution ID</dt><dd className="font-mono text-xs break-all">{submitted.id}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Status</dt><dd><StatusBadge view={executionStatusView({ status: current.status, delayed: waiting })} /></dd></div>
          <div><dt className="text-xs text-muted-foreground">Job</dt><dd>{submitted.jobName}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Queue</dt><dd className="font-mono">{submitted.queue}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Priority</dt><dd className="tabular">{submitted.priority}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{waiting ? 'Runs at' : 'Due'}</dt><dd>{formatDateTime(current.nextAttemptAt ?? submitted.scheduledFor)}</dd></div>
        </dl>
        {waiting && runAt ? (
          <p className="flex items-center gap-2 rounded-md border border-delayed/30 bg-delayed/10 px-3 py-2 text-sm"><Clock className="size-4 text-delayed" />Starts in <span className="font-mono tabular">{formatDelay(runAt - now)}</span> · cancel it from the execution page until then.</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild><Link href={`/executions/${submitted.id}`}><ExternalLink /> Execution details</Link></Button>
          <Button variant="secondary" onClick={onAnother}>Submit another</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SubmitPage() {
  const { project, can } = useWorkspace();
  const projectId = project!.id;
  const params = useSearchParams();
  const client = useQueryClient();
  const jobs = useQuery({ queryKey: qk.jobs(projectId, {}), queryFn: () => jobsService.list(projectId) });
  const queues = useQuery({ queryKey: qk.queues(projectId), queryFn: () => queuesService.list(projectId) });
  const [result, setResult] = useState<{ execution: SubmittedExecution; created: boolean } | null>(null);
  const form = useForm<SubmitValues>({
    resolver: zodResolver(submitSchema),
    defaultValues: {
      job: params.get('job') ?? '', queue: params.get('queue') ?? '', payloadText: '', delivery: params.get('delay') ? 'delayed' : 'immediate', delayMode: 'duration', delayValue: 5, delayUnit: 'm',
      runAtLocal: '', timezone: project!.timezone, priority: '', idempotencyKey: '', maxAttempts: '', backoffValue: '', backoffMaxValue: '', backoffUnit: 's', timeoutValue: '', timeoutUnit: 's',
    },
  });
  const { control, register, setValue } = form;
  const errors = form.formState.errors;
  const values = useWatch({ control }) as SubmitValues;
  const now = useNow();
  const selected = jobs.data?.find((job) => job.name === values.job);
  const expected = expectedAt(values, now);

  // Prefill the payload with the job's default the first time a job is picked.
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  useEffect(() => {
    if (selected && prefilledFor !== selected.name) {
      setPrefilledFor(selected.name);
      if (!form.getValues('payloadText').trim() && selected.payload !== null && selected.payload !== undefined) setValue('payloadText', JSON.stringify(selected.payload, null, 2));
    }
  }, [selected, prefilledFor, form, setValue]);

  const submit = useMutation({
    mutationFn: (data: SubmitValues) => queuesService.submit(projectId, toQueueSubmission(data)),
    onSuccess: (data) => {
      setResult(data);
      void client.invalidateQueries({ queryKey: ['queues', projectId] });
      void client.invalidateQueries({ queryKey: ['executions', projectId] });
      toast.success(data.created ? (data.execution.delayed ? 'Delayed job submitted' : 'Job submitted') : 'Idempotency key matched an earlier submission');
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const [path, message] of Object.entries(error.fieldErrors)) {
          if (path.startsWith('payload')) form.setError('payloadText', { message: `${path}: ${message}` });
          else if (path === 'delayMs') form.setError('delayValue', { message });
          else if (path === 'runAt') form.setError('runAtLocal', { message });
        }
        if (error.status === 404 && /Queue/.test(error.message)) form.setError('queue', { message: error.message });
        else if (error.status === 404 || error.status === 409) form.setError('job', { message: error.message });
      }
      toast.error('Submission failed', { description: errorMessage(error) });
    },
  });

  if (!can('MEMBER')) return <EmptyState title="You cannot submit jobs" description="Submitting jobs requires the Member role or higher." />;

  return (
    <div>
      <PageHeader title="Submit job" description="Run an existing job asynchronously, now or later. Delayed submissions wait in PostgreSQL until their time; they are not cron schedules." />
      {result ? (
        <div className="max-w-2xl"><Submitted projectId={projectId} submitted={result.execution} created={result.created} onAnother={() => { setResult(null); form.setValue('idempotencyKey', ''); }} /></div>
      ) : (
        <form noValidate onSubmit={form.handleSubmit((data) => submit.mutate(data))} className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <Card>
            <CardContent className="space-y-5 pt-5">
              <div role="radiogroup" aria-label="Delivery" className="grid gap-2 sm:grid-cols-2">
                {([['immediate', Zap, 'Immediate', 'Runs as soon as its queue admits it'], ['delayed', Clock, 'Delayed', 'Runs after a delay or at a date and time']] as const).map(([key, Icon, title, text]) => (
                  <button key={key} type="button" role="radio" aria-checked={values.delivery === key} onClick={() => setValue('delivery', key)} className={cn('flex gap-3 rounded-lg border p-3 text-left', values.delivery === key ? 'border-primary bg-primary-subtle' : 'border-border hover:border-border-strong')}>
                    <Icon className={cn('mt-0.5 size-4', key === 'delayed' ? 'text-delayed' : 'text-primary')} />
                    <span><span className="block text-sm font-medium">{title}</span><span className="text-xs text-muted-foreground">{text}</span></span>
                  </button>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="job" label="Job" required error={errors.job?.message} hint={selected ? `${MODE_LABEL[selected.mode]} · queue ${selected.queue}${selected.enabled ? '' : ' · disabled'}` : 'The job definition to run'}>
                  <Controller control={control} name="job" render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="job" aria-invalid={Boolean(errors.job) || undefined}><SelectValue placeholder={jobs.isLoading ? 'Loading…' : 'Choose a job'} /></SelectTrigger>
                      <SelectContent>{(jobs.data ?? []).map((job) => <SelectItem key={job.id} value={job.name} disabled={!job.enabled}>{job.name}{job.enabled ? '' : ' (disabled)'}</SelectItem>)}</SelectContent>
                    </Select>
                  )} />
                </Field>
                <Field id="queue" label="Queue" error={errors.queue?.message} hint="Overrides the job's queue for this run">
                  <Controller control={control} name="queue" render={({ field }) => (
                    <Select value={field.value || '__job__'} onValueChange={(next) => field.onChange(next === '__job__' ? '' : next)}>
                      <SelectTrigger id="queue"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__job__">Job&apos;s queue{selected ? ` (${selected.queue})` : ''}</SelectItem>
                        {(queues.data ?? []).map((queue) => <SelectItem key={queue.id} value={queue.name}>{queue.name}{queue.paused ? ' (paused)' : ''}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )} />
                </Field>
              </div>

              {values.delivery === 'delayed' ? (
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant={values.delayMode === 'duration' ? 'default' : 'secondary'} onClick={() => setValue('delayMode', 'duration')}>After a delay</Button>
                    <Button type="button" size="sm" variant={values.delayMode === 'datetime' ? 'default' : 'secondary'} onClick={() => setValue('delayMode', 'datetime')}>At a date and time</Button>
                  </div>
                  {values.delayMode === 'duration' ? (
                    <Field id="delayValue" label="Delay" error={errors.delayValue?.message}>
                      <Controller control={control} name="delayValue" render={({ field }) => <DurationInput id="delayValue" value={field.value} unit={values.delayUnit} units={['s', 'm', 'h', 'd']} onChange={(value, unit) => { field.onChange(value); setValue('delayUnit', unit); }} />} />
                    </Field>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field id="runAtLocal" label="Date and time" error={errors.runAtLocal?.message}><Input type="datetime-local" {...fieldAria('runAtLocal', errors.runAtLocal?.message)} {...register('runAtLocal')} /></Field>
                      <Field id="timezone" label="Time zone" error={errors.timezone?.message}>
                        <Controller control={control} name="timezone" render={({ field }) => <TimezoneInput id="timezone" value={field.value} onChange={field.onChange} />} />
                      </Field>
                    </div>
                  )}
                </div>
              ) : null}

              <Field id="payloadText" label="Payload (JSON)" hint={selected?.payloadSchema ? 'This job validates payloads against a JSON Schema.' : 'Empty = the job\'s default payload'} error={errors.payloadText?.message}>
                <Controller control={control} name="payloadText" render={({ field }) => <JsonEditor id="payloadText" value={field.value} onChange={field.onChange} rows={8} invalid={Boolean(errors.payloadText)} />} />
              </Field>
              {selected?.payloadSchema ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Payload schema</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono">{JSON.stringify(selected.payloadSchema, null, 2)}</pre>
                </details>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="priority" label="Priority" hint="0–100, higher first; empty = default" error={errors.priority?.message}><Input inputMode="numeric" {...fieldAria('priority', errors.priority?.message)} {...register('priority')} /></Field>
                <Field id="idempotencyKey" label="Idempotency key" hint="Same key → same execution (no duplicate)" error={errors.idempotencyKey?.message}><Input className="font-mono" placeholder="optional" {...fieldAria('idempotencyKey', errors.idempotencyKey?.message)} {...register('idempotencyKey')} /></Field>
              </div>

              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">Retry and timeout overrides</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field id="maxAttempts" label="Max attempts" hint={selected ? `Job default: ${selected.maxAttempts}` : undefined} error={errors.maxAttempts?.message}><Input inputMode="numeric" {...register('maxAttempts')} /></Field>
                  <Field id="timeoutValue" label="Timeout" error={errors.timeoutValue?.message}>
                    <div className="flex gap-2">
                      <Input inputMode="numeric" {...register('timeoutValue')} placeholder={selected ? String(selected.timeoutMs / 1000) : ''} />
                      <Controller control={control} name="timeoutUnit" render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}><SelectTrigger className="w-28" aria-label="Timeout unit"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="s">seconds</SelectItem><SelectItem value="m">minutes</SelectItem></SelectContent></Select>
                      )} />
                    </div>
                  </Field>
                  <Field id="backoffValue" label="Retry delay base" error={errors.backoffValue?.message}><Input inputMode="numeric" {...register('backoffValue')} /></Field>
                  <Field id="backoffMaxValue" label="Retry delay max" error={errors.backoffMaxValue?.message}>
                    <div className="flex gap-2">
                      <Input inputMode="numeric" {...register('backoffMaxValue')} />
                      <Controller control={control} name="backoffUnit" render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}><SelectTrigger className="w-28" aria-label="Backoff unit"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="s">seconds</SelectItem><SelectItem value="m">minutes</SelectItem><SelectItem value="h">hours</SelectItem></SelectContent></Select>
                      )} />
                    </div>
                  </Field>
                </div>
              </details>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="flex justify-between gap-2"><span className="text-muted-foreground">Job</span><span className="truncate font-mono">{values.job || '—'}</span></p>
                <p className="flex justify-between gap-2"><span className="text-muted-foreground">Queue</span><span className="font-mono">{values.queue || selected?.queue || '—'}</span></p>
                <p className="flex justify-between gap-2"><span className="text-muted-foreground">Runs</span>{values.delivery === 'immediate' ? <Badge tone="primary">As soon as possible</Badge> : <Badge tone="delayed">Delayed</Badge>}</p>
                {expected ? (
                  <>
                    <p className="flex justify-between gap-2"><span className="text-muted-foreground">Expected at</span><span className="text-right font-mono text-xs">{formatDateTime(expected, values.timezone)}<br />{values.timezone}</span></p>
                    <p className="flex justify-between gap-2"><span className="text-muted-foreground">Remaining</span><span className="font-mono tabular">{expected.getTime() > now ? formatDelay(expected.getTime() - now) : 'in the past'}</span></p>
                  </>
                ) : null}
                <p className="pt-2 text-xs text-muted-foreground">Delayed jobs start within about a second of their time (one scheduler tick).</p>
              </CardContent>
            </Card>
            <Button type="submit" className="w-full" loading={submit.isPending}><Send /> {values.delivery === 'immediate' ? 'Submit now' : 'Submit delayed job'}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
