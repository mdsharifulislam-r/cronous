'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Field, fieldAria } from '@/components/forms/field';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { qk } from '@/lib/query-keys';
import { authService } from '@/services';
import { type LoginValues, loginSchema } from './schemas';

/** Only same-site relative paths are honoured as post-login destinations (no open redirect). */
export function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const client = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const status = useQuery({ queryKey: qk.bootstrap, queryFn: authService.bootstrapStatus, retry: false });
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authService.login(values.email, values.password);
      client.clear();
      router.replace(safeNext(params.get('next')));
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        setFormError(`Too many failed attempts. Try again in ${Math.ceil((error.retryAfterSeconds ?? 900) / 60)} minutes.`);
      } else if (error instanceof ApiError && error.status === 401) {
        setFormError('Invalid email or password.');
      } else {
        setFormError(error instanceof ApiError ? error.message : 'Sign-in failed.');
      }
    }
  });

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="pt-6">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">Use your Chronos account.</p>
        {status.data && !status.data.bootstrapped ? (
          <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            This installation is not set up yet.{' '}
            <Link href="/setup" className="font-medium text-primary underline-offset-4 hover:underline">Run first-time setup</Link>
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field id="email" label="Email" error={errors.email?.message}>
            <Input type="email" autoComplete="username" autoFocus {...fieldAria('email', errors.email?.message)} {...form.register('email')} />
          </Field>
          <Field id="password" label="Password" error={errors.password?.message}>
            <Input type="password" autoComplete="current-password" {...fieldAria('password', errors.password?.message)} {...form.register('password')} />
          </Field>
          {formError ? <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</p> : null}
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Sign in</Button>
        </form>
      </CardContent>
    </Card>
  );
}
