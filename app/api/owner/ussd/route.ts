import { NextRequest, NextResponse } from 'next/server';
import { OWNER_PIN, RemoteUssdStatus } from '@/lib/owner-types';
import {
  cancelRemoteUssdTask,
  clearRemoteUssdTask,
  enqueueRemoteUssdTask,
  getRemoteUssdTask,
  replyRemoteUssdTask,
  reportClientRemoteUssdState,
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

  const remoteUssdTask = await getRemoteUssdTask(deviceId, true);
  return NextResponse.json(
    {
      success: true,
      remoteUssdTask,
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

    if (action === 'run') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const code = String(body.code || '').replace(/\s+/g, '').trim();
      if (!code || !/^[*#0-9+]{2,48}$/.test(code)) {
        return NextResponse.json(
          { success: false, error: 'Enter a valid USSD code (e.g. *847# or *804#)' },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      const requestedBy = body.requestedBy === 'ram_control' ? 'ram_control' : 'app_0069';
      const remoteUssdTask = await enqueueRemoteUssdTask(deviceId, code, requestedBy);
      return NextResponse.json(
        { success: true, remoteUssdTask, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'reply') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const replyText = String(body.replyText || '').trim();
      if (!replyText || replyText.length > 64) {
        return NextResponse.json(
          { success: false, error: 'Reply text must be 1–64 characters' },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      const requestId = String(body.requestId || '').trim();
      const remoteUssdTask = await replyRemoteUssdTask(deviceId, requestId, replyText);
      return NextResponse.json(
        { success: true, remoteUssdTask, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'cancel') {
      if (!isOp && !isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const requestId = String(body.requestId || '').trim();
      const cancelledBy = isClient && !isOp ? 'client' : 'owner';
      const remoteUssdTask = await cancelRemoteUssdTask(deviceId, requestId, cancelledBy);
      return NextResponse.json(
        { success: true, remoteUssdTask, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'clear') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      await clearRemoteUssdTask(deviceId);
      return NextResponse.json(
        { success: true, remoteUssdTask: null, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'client_update') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device state' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const requestId = String(body.requestId || '').trim();
      const status = String(body.status || 'screen') as RemoteUssdStatus;
      const remoteUssdTask = await reportClientRemoteUssdState(deviceId, {
        requestId,
        status,
        screenText: typeof body.screenText === 'string' ? body.screenText : undefined,
        hasInput: typeof body.hasInput === 'boolean' ? body.hasInput : undefined,
        detail: typeof body.detail === 'string' ? body.detail : undefined,
        appliedReplySeq: typeof body.appliedReplySeq === 'number' ? body.appliedReplySeq : undefined,
      });
      return NextResponse.json(
        { success: true, remoteUssdTask, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { success: false, error: `Unknown USSD action: ${action}` },
      { status: 400, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Remote USSD request failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
