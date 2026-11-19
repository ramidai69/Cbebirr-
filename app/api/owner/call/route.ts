import { NextRequest, NextResponse } from 'next/server';
import { OWNER_PIN } from '@/lib/owner-types';
import {
  answerCallSession,
  declineCallSession,
  endCallSession,
  getCallSession,
  pushCallSignal,
  startCallSession,
} from '@/lib/owner-store';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-owner-pin, x-device-id',
  'Cache-Control': 'no-store',
};

function isOperatorAuthorized(req: NextRequest, bodyPin?: unknown): boolean {
  const headerPin = req.headers.get('x-owner-pin') || '';
  const queryPin = new URL(req.url).searchParams.get('pin') || '';
  return headerPin === OWNER_PIN || queryPin === OWNER_PIN || bodyPin === OWNER_PIN;
}

function getClientHeaderDeviceId(req: NextRequest): string {
  return (req.headers.get('x-device-id') || '').trim();
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const deviceId = (searchParams.get('deviceId') || '').trim();
  if (!deviceId) {
    return NextResponse.json(
      { success: false, error: 'deviceId is required' },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const isOp = isOperatorAuthorized(req);
  const headerDeviceId = getClientHeaderDeviceId(req);
  if (!isOp && headerDeviceId !== deviceId) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const isLite = searchParams.get('lite') === '1';
  const callSession = await getCallSession(deviceId, true, { includeSignal: !isLite });

  if (isLite) {
    return NextResponse.json(
      {
        success: true,
        status: callSession?.status || 'idle',
        callId: callSession?.callId || '',
        callerName: callSession?.callerName || 'Owner Wi-Fi Call',
        startedAtMs: callSession?.startedAtMs || 0,
        expiresAtMs: callSession?.expiresAtMs || 0,
        serverTimeMs: Date.now(),
      },
      { headers: CORS_HEADERS }
    );
  }

  return NextResponse.json(
    {
      success: true,
      callSession,
      serverTimeMs: Date.now(),
    },
    { headers: CORS_HEADERS }
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const deviceId = String(body.deviceId || '').trim();

    if (!deviceId) {
      return NextResponse.json(
        { success: false, error: 'deviceId is required' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const isOp = isOperatorAuthorized(req, body.ownerPin);
    const headerDeviceId = getClientHeaderDeviceId(req);
    const isClient = headerDeviceId.length >= 6 && headerDeviceId === deviceId;

    if (action === 'start') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const callerRole = body.callerRole === 'ram_control' ? 'ram_control' : 'app_0069';
      const callSession = await startCallSession(deviceId, {
        callerRole,
        callerName: typeof body.callerName === 'string' ? body.callerName : undefined,
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
      });
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'answer') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device answer' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const callSession = await answerCallSession(deviceId, {
        rtcAnswer: typeof body.rtcAnswer === 'string' ? body.rtcAnswer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        micMuted: typeof body.micMuted === 'boolean' ? body.micMuted : undefined,
      });
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'decline') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device decline' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const callSession = await declineCallSession(deviceId);
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'signal') {
      if (!isOp && !isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized signal' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const role = isOp && body.role !== 'client' ? 'operator' : 'client';
      const callSession = await pushCallSignal(deviceId, {
        role,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcAnswer: typeof body.rtcAnswer === 'string' ? body.rtcAnswer : undefined,
        micMuted: typeof body.micMuted === 'boolean' ? body.micMuted : undefined,
      });
      if (!callSession) {
        return NextResponse.json(
          { success: false, error: 'Call session is not active' },
          { status: 409, headers: CORS_HEADERS }
        );
      }
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'end') {
      if (!isOp && !isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const callSession = await endCallSession(deviceId);
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { success: false, error: `Unknown call action: ${action}` },
      { status: 400, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Call request failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
