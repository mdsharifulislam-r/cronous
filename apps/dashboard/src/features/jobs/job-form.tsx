'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { toast } from 'sonner';
import { DurationInput } from '@/components/forms/duration-input';
import { Field, fieldAria } from '@/components/forms/field';
import { JsonEditor } from '@/components/forms/json-editor';
import { KeyValueEditor } from '@/components/forms/key-value-editor';
import { TimezoneInput } from '@/components/forms/timezone-input';
import { errorMessage } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api/client';
import { formatDateTime, formatDelay, formatDuration } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { MODE_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';
import { agentsService, jobsService, queuesService, schedulesService } from '@/services';
import type { Job } from '@/types/api';
import { toMs } from '@/components/forms/duration-input';
import { CRON_PRESETS, STEP_FIELDS, defaultValues, expectedRunTime, fieldForApiPath, jobFormSchema, stepOf, toJobInput, toSubmission, valuesFromJob, type JobFormValues } from './job-form-model';

const STEPS = ['Basics', 'Execution', 'Scheduling', 'Retries', 'Review'] as const;

function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function ChoiceCard({ selected, onSelect, title, description, disabled }: { selected: boolean; onSelect: () => void; title: string; description: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn('rounded-lg border p-3 text-left transition-colors disabled:opacity-50', selected ? 'border-primary bg-primary-subtle' : 'border-border hover:border-border-strong')}
    >
      <span className="flex items-center justify-between text-sm font-medium">{title}{selected ? <Check className="size-4 text-primary" /> : null}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
    </button>
  );
}

function Note({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warning' }) {
  const Icon = tone === 'warning' ? AlertTriangle : Info;
  return (
    <p className={cn('flex gap-2 rounded-md border p-3 text-xs', tone === 'warning' ? 'border-warning/40 bg-warning/10' : 'border-border bg-muted/60 text-muted-foreground')}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function JobForm({ projectId, projectTimeZone, job }: { projectId: string; projectTimeZone: string; job?: Job }) {
  const editing = Boolean(job);
  const router = useRouter();
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<JobFormValues>({ resolver: zodResolver(jobFormSchema), defaultValues: job ? valuesFromJob(job, projectTimeZone) : defaultValues(projectTimeZone), mode: 'onTouched' });
  const { register, control, setValue, formState } = form;
  const errors = formState.errors;
  const values = useWatch({ control }) as JobFormValues;

  const queues = useQuery({ queryKey: qk.queues(projectId), queryFn: () => queuesService.list(projectId) });
  const agents = useQuery({ queryKey: qk.agents(projectId), queryFn: () => agentsService.list(projectId), enabled: values.mode === 'AGENT' });
  const eligibleAgents = (agents.data ?? []).filter((agent) => agent.status === 'ONLINE' && agent.handlers.includes(values.name.trim()));

  const scheduleInput = values.kind === 'scheduled' ? (values.scheduleType === 'cron' ? { cron: values.cron.trim(), timezone: values.timezone } : null) : null;
  const debouncedSchedule = useDebounced(scheduleInput);
  const preview = useQuery({
    queryKey: ['schedule-preview', projectId, debouncedSchedule],
    queryFn: () => schedulesService.preview(projectId, debouncedSchedule!, 5),
    enabled: Boolean(debouncedSchedule?.cron && debouncedSchedule.cron.split(/\s+/).length === 5),
    retry: false,
  });

  const save = useMutation({
    mutationFn: async (data: JobFormValues) => {
      const input = toJobInput(data, editing ? 'edit' : 'create');
      const saved = editing ? await jobsService.update(projectId, job!.id, input) : await jobsService.create(projectId, input);
      const submission = editing ? null : toSubmission(data);
      if (!submission) return { saved, submitted: null as null | { id: string; delayed: boolean } };
      try {
        const result = await queuesService.submit(projectId, submission);
        return { saved, submitted: { id: result.execution.id, delayed: result.execution.delayed } };
      } catch (error) {
        toast.error('Job created, but submitting it failed', { description: errorMessage(error) });
        return { saved, submitted: null };
      }
    },
    onSuccess: ({ saved, submitted }) => {
      void client.invalidateQueries({ queryKey: ['jobs', projectId] });
      void client.invalidateQueries({ queryKey: ['job', projectId, saved.id] });
      void client.invalidateQueries({ queryKey: ['queues', projectId] });
      if (submitted) {
        toast.success(submitted.delayed ? `${saved.name} created and scheduled to run later` : `${saved.name} created and submitted`);
        router.push(`/executions/${submitted.id}`);
      } else {
        toast.success(editing ? `Saved ${saved.name}` : `Created ${saved.name}`);
        router.push(`/jobs/${saved.id}`);
      }
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = Object.entries(error.fieldErrors);
        let firstStep: number | null = null;
        for (const [path, message] of fields) {
          const field = fieldForApiPath(path);
          if (!field) continue;
          form.setError(field as FieldPath<JobFormValues>, { message });
          firstStep = Math.min(firstStep ?? 99, stepOf(field));
        }
        if (error.status === 409 && /already exists/i.test(error.message)) {
          form.setError('name', { message: error.message });
          firstStep = 0;
        } else if (error.status === 400 && /does not exist/i.test(error.message)) {
          form.setError('queue', { message: error.message });
          firstStep = 0;
        }
        if (firstStep !== null) setStep(firstStep);
        setFormError(fields.length || firstStep !== null ? 'The server rejected some fields; they are highlighted.' : error.message);
      } else {
        setFormError(errorMessage(error));
      }
    },
  });

  const next = async () => {
    const valid = await form.trigger(STEP_FIELDS[step] as FieldPath<JobFormValues>[]);
    if (valid) setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };
  const submit = form.handleSubmit((data) => {
    setFormError(null);
    save.mutate(data);
  }, (invalid) => {
    const first = Object.keys(invalid)[0] as keyof JobFormValues | undefined;
    if (first) setStep(stepOf(first));
  });

  const reg = (name: keyof JobFormValues) => ({ ...fieldAria(name, errors[name]?.message as string | undefined), ...register(name) });
  const expected = expectedRunTime(values);

  return (
    <form onSubmit={submit} noValidate className="grid gap-6 lg:grid-cols-[200px_1fr]">
      <ol className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => (index < step ? setStep(index) : undefined)}
              aria-current={index === step ? 'step' : undefined}
              className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap', index === step ? 'bg-muted font-medium' : index < step ? 'text-foreground hover:bg-muted' : 'cursor-default text-muted-foreground')}
            >
              <span className={cn('flex size-5 items-center justify-center rounded-full border text-[11px]', index < step ? 'border-primary bg-primary text-primary-foreground' : index === step ? 'border-primary text-primary' : 'border-border')}>
                {index < step ? <Check className="size-3" /> : index + 1}
              </span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-5 pt-5">
          {step === 0 ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="name" label="Job name" required hint={editing ? 'Names cannot change (SDK handlers and submissions refer to them).' : 'Also the handler name for agent and worker jobs.'} error={errors.name?.message}>
                  <Input className="font-mono" placeholder="send-welcome-email" disabled={editing} {...reg('name')} />
                </Field>
                <Field id="queue" label="Queue" required hint="Admission lane: concurrency limit, priority, pause." error={errors.queue?.message}>
                  <Controller control={control} name="queue" render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="queue" aria-invalid={Boolean(errors.queue) || undefined}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(queues.data ?? [{ id: 'default', name: 'default', concurrencyLimit: null }]).map((queue) => (
                          <SelectItem key={queue.id} value={queue.name}>{queue.name}{queue.concurrencyLimit ? ` · max ${queue.concurrencyLimit}` : ''}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )} />
                </Field>
              </div>
              <Field id="description" label="Description" error={errors.description?.message}>
                <Textarea className="min-h-16 font-sans text-sm" placeholder="What this job does" {...register('description')} />
              </Field>
              <div>
                <p className="mb-2 text-sm font-medium">How should it run?</p>
                <div role="radiogroup" aria-label="Job type" className="grid gap-2 sm:grid-cols-3">
                  <ChoiceCard selected={values.kind === 'scheduled'} onSelect={() => setValue('kind', 'scheduled')} title="Scheduled" description="Cron expression or a one-time date. Runs by itself." />
                  <ChoiceCard selected={values.kind === 'immediate'} onSelect={() => setValue('kind', 'immediate')} title={editing ? 'On demand' : 'Immediate'} description={editing ? 'No schedule: runs when submitted or triggered.' : 'Submit now; runs as soon as a slot is free.'} />
                  {editing ? null : <ChoiceCard selected={values.kind === 'delayed'} onSelect={() => setValue('kind', 'delayed')} title="Delayed" description="Submit now; runs after a delay or at a set time (not cron)." />}
                </div>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div role="radiogroup" aria-label="Execution mode" className="grid gap-2 sm:grid-cols-3">
                <ChoiceCard selected={values.mode === 'HTTP'} onSelect={() => setValue('mode', 'HTTP')} title="HTTP webhook" description="Chronos calls your endpoint." />
                <ChoiceCard selected={values.mode === 'AGENT'} onSelect={() => setValue('mode', 'AGENT')} title="Agent" description="Runs in your app via @sharifulislam1/cronous." />
                <ChoiceCard selected={values.mode === 'WORKER'} onSelect={() => setValue('mode', 'WORKER')} title="Central worker" description="Runs in a Chronos worker process." />
              </div>

              {values.mode === 'HTTP' ? (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
                    <Field id="httpMethod" label="Method">
                      <Controller control={control} name="httpMethod" render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="httpMethod"><SelectValue /></SelectTrigger>
                          <SelectContent>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectContent>
                        </Select>
                      )} />
                    </Field>
                    <Field id="httpUrl" label="Endpoint URL" required error={errors.httpUrl?.message} hint="Loopback and cloud-metadata addresses are blocked by the server (SSRF protection).">
                      <Input className="font-mono" placeholder="https://app.example.com/jobs/sync" {...reg('httpUrl')} />
                    </Field>
                  </div>
                  <Field id="headers" label="Headers" error={(errors.headers as { message?: string } | undefined)?.message}>
                    <Controller control={control} name="headers" render={({ field }) => <KeyValueEditor rows={field.value} onChange={field.onChange} />} />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field id="authType" label="Authentication">
                      <Controller control={control} name="authType" render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="authType"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="bearer">Bearer token</SelectItem>
                            <SelectItem value="basic">Basic auth</SelectItem>
                          </SelectContent>
                        </Select>
                      )} />
                    </Field>
                    {values.authType === 'bearer' ? (
                      <Field id="authToken" label="Token" error={errors.authToken?.message} className="sm:col-span-2"><Input type="password" autoComplete="off" {...reg('authToken')} /></Field>
                    ) : values.authType === 'basic' ? (
                      <>
                        <Field id="authUsername" label="Username" error={errors.authUsername?.message}><Input autoComplete="off" {...reg('authUsername')} /></Field>
                        <Field id="authPassword" label="Password"><Input type="password" autoComplete="off" {...reg('authPassword')} /></Field>
                      </>
                    ) : null}
                  </div>
                  <Field id="signingSecret" label="Signing secret" hint="Optional (16+ chars). Requests carry X-Chronos-Signature." error={errors.signingSecret?.message}>
                    <Input type="password" autoComplete="off" {...reg('signingSecret')} />
                  </Field>
                  {editing ? <Note>Secrets are shown as ******** and are kept unless you type a new value.</Note> : null}
                </div>
              ) : null}

              {values.mode === 'AGENT' ? (
                <div className="space-y-2">
                  <Note>
                    The handler is <code className="font-mono">chronos.task(&apos;{values.name || 'job-name'}&apos;, …)</code> in your application. Any connected agent of this project with that handler takes the work; pinning a job to one specific agent is not supported.
                  </Note>
                  <p className="text-xs text-muted-foreground">
                    Eligible agents online now:{' '}
                    {agents.isLoading ? '…' : eligibleAgents.length ? eligibleAgents.map((agent) => agent.hostname ?? agent.instanceId).join(', ') : 'none (executions wait in the queue until one connects)'}
                  </p>
                </div>
              ) : null}

              {values.mode === 'WORKER' ? (
                <Note>
                  Central workers run the handler named <code className="font-mono">{values.name || 'job-name'}</code> from the handler module mounted into the worker (<code className="font-mono">CHRONOS_WORKER_HANDLERS</code>). Workers serve all queues; use the queue and job limits below to control concurrency.
                </Note>
              ) : null}

              <Field id="payloadText" label="Default payload (JSON)" hint="Sent when a submission or schedule provides none." error={errors.payloadText?.message}>
                <Controller control={control} name="payloadText" render={({ field }) => <JsonEditor id="payloadText" value={field.value} onChange={field.onChange} rows={6} />} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="timeoutValue" label="Timeout" error={errors.timeoutValue?.message}>
                  <Controller control={control} name="timeoutValue" render={({ field }) => (
                    <DurationInput id="timeoutValue" value={field.value} unit={values.timeoutUnit} onChange={(value, unit) => { field.onChange(value); setValue('timeoutUnit', unit); }} />
                  )} />
                </Field>
                <Field id="priority" label="Priority" hint="0–100, higher first; empty = queue default" error={errors.priority?.message}><Input inputMode="numeric" placeholder="queue default" {...reg('priority')} /></Field>
                <Field id="maxConcurrency" label="Max concurrent" hint="Of this job, across all executors" error={errors.maxConcurrency?.message}><Input inputMode="numeric" placeholder="unlimited" {...reg('maxConcurrency')} /></Field>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Field id="timezone" label="Time zone" error={errors.timezone?.message} hint="Schedules and dates below are in this zone.">
                <Controller control={control} name="timezone" render={({ field }) => <TimezoneInput id="timezone" value={field.value} onChange={field.onChange} />} />
              </Field>
              {values.kind === 'scheduled' ? (
                <>
                  <div role="radiogroup" aria-label="Schedule type" className="grid gap-2 sm:grid-cols-2">
                    <ChoiceCard selected={values.scheduleType === 'cron'} onSelect={() => setValue('scheduleType', 'cron')} title="Recurring (cron)" description="Daily, weekly, monthly or a custom expression." />
                    <ChoiceCard selected={values.scheduleType === 'once'} onSelect={() => setValue('scheduleType', 'once')} title="One time" description="Runs once at a date and time." />
                  </div>
                  {values.scheduleType === 'cron' ? (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-1.5">
                        {CRON_PRESETS.map((preset) => (
                          <Button key={preset.value} type="button" size="sm" variant={values.cron === preset.value ? 'default' : 'secondary'} onClick={() => setValue('cron', preset.value, { shouldValidate: true })}>{preset.label}</Button>
                        ))}
                      </div>
                      <Field id="cron" label="Cron expression" required hint="minute hour day-of-month month day-of-week" error={errors.cron?.message ?? (preview.error instanceof ApiError ? Object.values(preview.error.fieldErrors)[0] ?? preview.error.message : undefined)}>
                        <Input className="font-mono" {...reg('cron')} />
                      </Field>
                      <div className="rounded-md border border-border p-3">
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Next runs ({values.timezone}), calculated by the server</p>
                        {preview.isFetching ? <p className="text-xs text-muted-foreground">Calculating…</p> : preview.data ? (
                          <ul className="space-y-0.5 font-mono text-xs">{preview.data.occurrences.map((at) => <li key={at}>{formatDateTime(at, values.timezone)}</li>)}</ul>
                        ) : <p className="text-xs text-muted-foreground">Enter a valid expression to preview.</p>}
                      </div>
                    </div>
                  ) : (
                    <Field id="runAtLocal" label="Run at" required error={errors.runAtLocal?.message}>
                      <Input type="datetime-local" {...reg('runAtLocal')} />
                    </Field>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="misfirePolicy" label="Missed runs (server was down)">
                      <Controller control={control} name="misfirePolicy" render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="misfirePolicy"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="FIRE_ONCE">Run once to catch up</SelectItem>
                            <SelectItem value="SKIP">Skip missed runs</SelectItem>
                            <SelectItem value="FIRE_ALL">Run every missed occurrence</SelectItem>
                          </SelectContent>
                        </Select>
                      )} />
                    </Field>
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3">
                      <label htmlFor="enabled" className="text-sm">Enabled</label>
                      <Controller control={control} name="enabled" render={({ field }) => <Switch id="enabled" checked={field.value} onCheckedChange={field.onChange} />} />
                    </div>
                  </div>
                </>
              ) : editing ? (
                <Note>On-demand jobs have no schedule. Submit them from the Queues page or with <code className="font-mono">chronos.queue()</code>.</Note>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                    <div>
                      <label htmlFor="submitNow" className="text-sm font-medium">{values.kind === 'immediate' ? 'Submit for immediate execution after creating' : 'Submit with a delay after creating'}</label>
                      <p className="text-xs text-muted-foreground">Off: only the job definition is created; submit it later.</p>
                    </div>
                    <Controller control={control} name="submitNow" render={({ field }) => <Switch id="submitNow" checked={field.value} onCheckedChange={field.onChange} />} />
                  </div>
                  {values.submitNow ? (
                    <div className="space-y-4">
                      {values.kind === 'delayed' ? (
                        <>
                          <div role="radiogroup" aria-label="Delay" className="grid gap-2 sm:grid-cols-2">
                            <ChoiceCard selected={values.delayMode === 'duration'} onSelect={() => setValue('delayMode', 'duration')} title="After a delay" description="e.g. in 5 minutes" />
                            <ChoiceCard selected={values.delayMode === 'datetime'} onSelect={() => setValue('delayMode', 'datetime')} title="At a date and time" description="In the time zone above" />
                          </div>
                          {values.delayMode === 'duration' ? (
                            <Field id="delayValue" label="Delay" error={errors.delayValue?.message}>
                              <Controller control={control} name="delayValue" render={({ field }) => (
                                <DurationInput id="delayValue" value={field.value} unit={values.delayUnit} units={['s', 'm', 'h', 'd']} onChange={(value, unit) => { field.onChange(value); setValue('delayUnit', unit); }} />
                              )} />
                            </Field>
                          ) : (
                            <Field id="delayRunAtLocal" label="Run at" error={errors.delayRunAtLocal?.message}><Input type="datetime-local" {...reg('delayRunAtLocal')} /></Field>
                          )}
                          {expected ? <p className="text-xs text-muted-foreground">Expected to run at <span className="font-mono text-foreground">{formatDateTime(expected, values.timezone)}</span> ({values.timezone}){values.delayMode === 'duration' ? ` · in ${formatDelay(toMs(values.delayValue, values.delayUnit))}` : ''}</p> : null}
                        </>
                      ) : null}
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field id="submitPriority" label="Priority for this run" hint="0–100; empty = job/queue default" error={errors.submitPriority?.message}><Input inputMode="numeric" {...reg('submitPriority')} /></Field>
                        <Field id="idempotencyKey" label="Idempotency key" hint="Repeating the key returns the same execution" error={errors.idempotencyKey?.message}><Input className="font-mono" placeholder="optional" {...reg('idempotencyKey')} /></Field>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="maxAttempts" label="Max attempts" error={errors.maxAttempts?.message}><Input type="number" min={1} max={100} {...fieldAria('maxAttempts', errors.maxAttempts?.message)} {...register('maxAttempts', { valueAsNumber: true })} /></Field>
                <Field id="backoffValue" label="Retry delay (base)" error={errors.backoffValue?.message}>
                  <Controller control={control} name="backoffValue" render={({ field }) => <DurationInput id="backoffValue" value={field.value} unit={values.backoffUnit} units={['s', 'm', 'h']} onChange={(value, unit) => { field.onChange(value); setValue('backoffUnit', unit); }} />} />
                </Field>
                <Field id="backoffMaxValue" label="Retry delay (max)" error={errors.backoffMaxValue?.message}>
                  <Controller control={control} name="backoffMaxValue" render={({ field }) => <DurationInput id="backoffMaxValue" value={field.value} unit={values.backoffMaxUnit} units={['s', 'm', 'h', 'd']} onChange={(value, unit) => { field.onChange(value); setValue('backoffMaxUnit', unit); }} />} />
                </Field>
              </div>
              <Note>Backoff strategy: exponential with jitter (fixed by the server). Attempt n waits a random time between half and all of min(base × 2ⁿ⁻¹, max). After the last attempt the execution is dead-lettered and can be retried manually.</Note>
              <Field id="concurrencyPolicy" label="Overlapping runs">
                <Controller control={control} name="concurrencyPolicy" render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="concurrencyPolicy"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALLOW">Allow overlapping executions</SelectItem>
                      <SelectItem value="FORBID">Forbid: skip schedules / reject manual runs while one is active; queue submissions wait</SelectItem>
                    </SelectContent>
                  </Select>
                )} />
              </Field>
              <Field id="payloadSchemaText" label="Payload schema (JSON Schema, optional)" hint="Every submitted payload must satisfy it; violations are rejected with 400." error={errors.payloadSchemaText?.message}>
                <Controller control={control} name="payloadSchemaText" render={({ field }) => <JsonEditor id="payloadSchemaText" value={field.value} onChange={field.onChange} rows={6} placeholder={'{\n  "type": "object",\n  "required": ["to"]\n}'} />} />
              </Field>
            </>
          ) : null}

          {step === 4 ? (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {[
                ['Name', <span key="n" className="font-mono">{values.name}</span>],
                ['Queue', <span key="q" className="font-mono">{values.queue}</span>],
                ['Type', values.kind === 'scheduled' ? (values.scheduleType === 'cron' ? `Cron ${values.cron}` : `One time at ${values.runAtLocal}`) : values.kind === 'immediate' ? (editing ? 'On demand' : 'Immediate') : 'Delayed'],
                ['Time zone', values.timezone],
                ['Mode', MODE_LABEL[values.mode]],
                ...(values.mode === 'HTTP' ? [['Endpoint', <span key="u" className="font-mono break-all">{values.httpMethod} {values.httpUrl}</span>] as const] : []),
                ['Timeout', formatDuration(toMs(values.timeoutValue, values.timeoutUnit))],
                ['Retries', `${values.maxAttempts} attempts, ${formatDuration(toMs(values.backoffValue, values.backoffUnit))} → ${formatDuration(toMs(values.backoffMaxValue, values.backoffMaxUnit))}`],
                ['Priority', values.priority || 'queue default'],
                ['Max concurrent', values.maxConcurrency || 'unlimited'],
                ['Enabled', values.enabled ? 'Yes' : 'No'],
                ...(!editing && values.kind !== 'scheduled' ? [['Submission', values.submitNow ? (values.kind === 'delayed' && expected ? `Runs at ${formatDateTime(expected, values.timezone)}` : 'Runs as soon as possible') : 'Not submitted yet'] as const] : []),
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5">{value}</dd>
                </div>
              ))}
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Default payload</dt>
                <dd className="mt-1"><pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{values.payloadText.trim() || 'none'}</pre></dd>
              </div>
              {values.payloadSchemaText.trim() ? <div className="sm:col-span-2"><Badge tone="info">Payload schema validation on</Badge></div> : null}
            </dl>
          ) : null}

          {formError ? <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</p> : null}

          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={() => (step === 0 ? router.back() : setStep(step - 1))}>
              <ChevronLeft /> {step === 0 ? 'Cancel' : 'Back'}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" onClick={() => void next()}>Next <ChevronRight /></Button>
            ) : (
              <Button type="submit" loading={save.isPending}>{editing ? 'Save changes' : values.kind !== 'scheduled' && values.submitNow ? 'Create and submit' : 'Create job'}</Button>
            )}
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
