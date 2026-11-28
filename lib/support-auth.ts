import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { OWNER_PIN } from './owner-types';

const globalForSupportAuth = globalThis as unknown as {
  __supportSessionSecret?: string;
};

function getSessionSecret(): string {
  const fromEnv = (process.env.SUPPORT_SESSION_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  if (fromEnv) {
    return crypto.createHash('sha256').update(`cbe_support_secret_${fromEnv}`).digest('hex');
  }
  if (!globalForSupportAuth.__supportSessionSecret) {
    // Stable deterministic fallback across serverless cold starts derived from project config + pin
    const seed = `${process.env.SUPPORT_PIN || OWNER_PIN}_gen-lang-client-0770056331_support_desk_v1`;
    globalForSupportAuth.__supportSessionSecret = crypto.createHash('sha256').update(seed).digest('hex');
  }
  return globalForSupportAuth.__supportSessionSecret;
}

function getExpectedSupportPin(): string {
  return (process.env.SUPPORT_PIN || process.env.OWNER_PIN || OWNER_PIN).trim();
}

export function verifySupportPin(candidatePin: string): boolean {
  const expected = getExpectedSupportPin();
  const submitted = String(candidatePin || '').trim();
  if (!expected || !submitted) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(submitted).digest();
  return crypto.timingSafeEqual(a, b);
}

export function issueSupportSessionToken(ttlMs = 30 * 24 * 60 * 60_000): {
  token: string;
  expiresAtMs: number;
} {
  const nowMs = Date.now();
  const expiresAtMs = nowMs + ttlMs;
  const payloadObj = {
    role: 'cbe_support_agent',
    iat: nowMs,
    exp: expiresAtMs,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');
  return {
    token: `cb_sup_${payloadB64}.${sig}`,
    expiresAtMs,
  };
}

export function verifySupportSessionToken(token: string): boolean {
  const clean = String(token || '').trim();
  if (!clean.startsWith('cb_sup_')) return false;
  const body = clean.slice(7);
  const dotIdx = body.indexOf('.');
  if (dotIdx <= 0) return false;
  const payloadB64 = body.slice(0, dotIdx);
  const sig = body.slice(dotIdx + 1);
  if (!payloadB64 || !sig) return false;

  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payloadB64)
    .digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      role?: string;
      exp?: number;
    };
    if (parsed.role !== 'cbe_support_agent') return false;
    if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return false;
    return true;
  } catch {
    return false;
  }
}

export function extractBearerToken(req: NextRequest): string {
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export function isSupportAgentAuthorized(req: NextRequest): boolean {
  const bearer = extractBearerToken(req);
  if (bearer && verifySupportSessionToken(bearer)) {
    return true;
  }
  const headerPin = req.headers.get('x-owner-pin') || '';
  if (headerPin && verifySupportPin(headerPin)) {
    return true;
  }
  return false;
}

export function buildSupportCorsHeaders(req: NextRequest): Record<string, string> {
  const origin = (req.headers.get('origin') || '').trim();
  let allowedOrigin = '';
  if (origin) {
    try {
      const parsed = new URL(origin);
      const host = parsed.hostname.toLowerCase();
      const appUrlHost = (() => {
        try {
          const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').trim();
          return appUrl ? new URL(appUrl).hostname.toLowerCase() : '';
        } catch {
          return '';
        }
      })();
      if (
        host === 'appassets.androidplatform.net' ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.endsWith('.run.app') ||
        host.endsWith('.vercel.app') ||
        (appUrlHost && host === appUrlHost)
      ) {
        allowedOrigin = origin;
      }
    } catch {
      allowedOrigin = '';
    }
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-owner-pin, x-device-id',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
  }
  return headers;
}
