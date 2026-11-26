import { NextResponse } from 'next/server';

/**
 * Runtime settings for the browser. Read from the environment on every request, so a
 * pre-built image can be configured with `docker run -e CHRONOS_PUBLIC_URL=…`.
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const publicUrl = process.env.CHRONOS_PUBLIC_URL || process.env.NEXT_PUBLIC_CHRONOS_PUBLIC_URL || null;
  return NextResponse.json({ publicUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
