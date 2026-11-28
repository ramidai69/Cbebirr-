import { NextRequest, NextResponse } from 'next/server';
import {
  buildSupportCorsHeaders,
  extractBearerToken,
  issueSupportSessionToken,
  verifySupportPin,
  verifySupportSessionToken,
} from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: buildSupportCorsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const cors = buildSupportCorsHeaders(req);
  const token = extractBearerToken(req);
  const valid = Boolean(token && verifySupportSessionToken(token));
  if (!valid) {
    return NextResponse.json({ ok: false, authenticated: false }, { status: 401, headers: cors });
  }
  return NextResponse.json({ ok: true, authenticated: true }, { headers: cors });
}

export async function POST(req: NextRequest) {
  const cors = buildSupportCorsHeaders(req);
  try {
    const body = await req.json().catch(() => ({}));
    const pin = typeof body?.pin === 'string' ? body.pin : String(body?.pin || '');
    if (!verifySupportPin(pin)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid Support PIN' },
        { status: 401, headers: cors }
      );
    }
    const issued = issueSupportSessionToken();
    return NextResponse.json(
      {
        ok: true,
        token: issued.token,
        expiresAtMs: issued.expiresAtMs,
      },
      { headers: cors }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Authentication request failed' },
      { status: 500, headers: cors }
    );
  }
}
