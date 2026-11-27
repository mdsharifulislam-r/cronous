'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Field, fieldAria } from '@/components/forms/field';
import { CopyButton } from '@/components/shared/copy-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { browserTimeZone } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { authService } from '@/services';
import type { BootstrapResult } from '@/types/api';
import { type SetupValues, setupSchema, slugify } from './schemas';

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
        <CopyButton value={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}

export function SetupForm() {
  const router = useRouter();
  const status = useQuery({ queryKey: qk.bootstrap, queryFn: authService.bootstrapStatus, retry: false });
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<SetupValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { bootstrapToken: '', adminName: '', adminEmail: '', adminPassword: '', orgName: '', orgSlug: '', projectName: '', projectSlug: '', timezone: 'UTC' },
  });
  const errors = form.formState.errors;

  useEffect(() => form.setValue('timezone', browserTimeZone()), [form]);
  useEffect(() => {
    if (status.data?.bootstrapped && !result) router.replace('/login');
  }, [status.data, result, router]);

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const created = await authService.setup({
        bootstrapToken: values.bootstrapToken,
        admin: { email: values.adminEmail, name: values.adminName, password: values.adminPassword },
        organization: { name: values.orgName, slug: values.orgSlug },
        project: { name: values.projectName, slug: values.projectSlug, timezone: values.timezone },
      });
      setResult(created);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setFormError('The bootstrap token is not valid. Copy it again from the server log.');
      else if (error instanceof ApiError && error.code === 'ALREADY_BOOTSTRAPPED') setFormError('This installation is already set up. Sign in instead.');
      else setFormError(error instanceof ApiError ? `${error.message}${Object.keys(error.fieldErrors).length ? `: ${Object.entries(error.fieldErrors).map(([path, message]) => `${path} ${message}`).join('; ')}` : ''}` : 'Setup failed.');
    }
  });

  if (result) {
    return (
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 pt-6">
          <h1 className="text-lg font-semibold">Chronos is ready</h1>
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>Copy these credentials now and store them in your secret manager. They are shown only once.</p>
          </div>
          <Secret label="Project API key (server-to-server REST)" value={result.credentials.projectKey.token} />
          <Secret label="Agent token (CHRONOS_AGENT_TOKEN for @sharifulislam1/cronous)" value={result.credentials.agentToken.token} />
          <Button className="w-full" onClick={() => { router.replace('/'); router.refresh(); }}>I saved them, open the dashboard</Button>
        </CardContent>
      </Card>
    );
  }

  const name = (key: keyof SetupValues) => ({ ...fieldAria(key, errors[key]?.message), ...form.register(key) });
  return (
    <Card className="w-full max-w-lg">
      <CardContent className="pt-6">
        <h1 className="text-lg font-semibold">First-time setup</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Find the one-time bootstrap token in the Chronos server log (<code className="font-mono text-xs">bootstrap token</code>), or use the value of <code className="font-mono text-xs">CHRONOS_BOOTSTRAP_TOKEN</code>.
        </p>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <Field id="bootstrapToken" label="Bootstrap token" required error={errors.bootstrapToken?.message}>
            <Input type="password" autoComplete="off" {...name('bootstrapToken')} />
          </Field>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Administrator</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="adminName" label="Name" required error={errors.adminName?.message}><Input autoComplete="name" {...name('adminName')} /></Field>
              <Field id="adminEmail" label="Email" required error={errors.adminEmail?.message}><Input type="email" autoComplete="username" {...name('adminEmail')} /></Field>
            </div>
            <Field id="adminPassword" label="Password" required hint="At least 12 characters" error={errors.adminPassword?.message}>
              <Input type="password" autoComplete="new-password" {...name('adminPassword')} />
            </Field>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Organization and first project</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="orgName" label="Organization" required error={errors.orgName?.message}>
                <Input {...name('orgName')} onChange={(event) => { form.setValue('orgName', event.target.value); if (!form.getFieldState('orgSlug').isDirty) form.setValue('orgSlug', slugify(event.target.value)); }} />
              </Field>
              <Field id="orgSlug" label="Organization slug" required error={errors.orgSlug?.message}><Input className="font-mono" {...name('orgSlug')} /></Field>
              <Field id="projectName" label="Project" required error={errors.projectName?.message}>
                <Input {...name('projectName')} onChange={(event) => { form.setValue('projectName', event.target.value); if (!form.getFieldState('projectSlug').isDirty) form.setValue('projectSlug', slugify(event.target.value)); }} />
              </Field>
              <Field id="projectSlug" label="Project slug" required hint="Used by the SDK: new Chronos({ project })" error={errors.projectSlug?.message}><Input className="font-mono" {...name('projectSlug')} /></Field>
            </div>
            <Field id="timezone" label="Default time zone" hint="IANA name, e.g. Asia/Dhaka" error={errors.timezone?.message}><Input className="font-mono" {...name('timezone')} /></Field>
          </fieldset>
          {formError ? <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</p> : null}
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Create installation</Button>
        </form>
      </CardContent>
    </Card>
  );
}
