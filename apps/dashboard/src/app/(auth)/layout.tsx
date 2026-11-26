import { Logo } from '@/components/shared/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-2.5">
        <Logo className="size-8" />
        <span className="text-lg font-semibold tracking-tight">Chronos</span>
      </div>
      {children}
    </main>
  );
}
