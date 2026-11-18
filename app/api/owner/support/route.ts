import { NextRequest, NextResponse } from 'next/server';
import { OWNER_PIN, SupportCommandType } from '@/lib/owner-types';
import {
  endSupportSession,
  getSupportSession,
  pushClientSupportDelta,
  pushOperatorSupportCommand,
  requestSupportSession,
  respondSupportSession,
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

  const supportSession = await getSupportSession(deviceId, true);
  return NextResponse.json(
    {
      success: true,
      supportSession,
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

    if (action === 'request') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const requestedBy = body.requestedBy === 'ram_control' ? 'ram_control' : 'app_0069';
      const supportSession = await requestSupportSession(deviceId, requestedBy);
      return NextResponse.json(
        { success: true, supportSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'command') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const commandType = String(body.commandType || 'none') as SupportCommandType;
      const supportSession = await pushOperatorSupportCommand(deviceId, {
        commandType,
        commandPayload: body.commandPayload !== undefined ? String(body.commandPayload) : undefined,
        pointerX: typeof body.pointerX === 'number' ? body.pointerX : undefined,
        pointerY: typeof body.pointerY === 'number' ? body.pointerY : undefined,
        pointerLabel: body.pointerLabel !== undefined ? String(body.pointerLabel) : undefined,
      });
      if (!supportSession) {
        return NextResponse.json(
          { success: false, error: 'Support session is not active' },
          { status: 409, headers: CORS_HEADERS }
        );
      }
      return NextResponse.json(
        { success: true, supportSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'accept' || action === 'decline') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device consent' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const supportSession = await respondSupportSession(deviceId, action === 'accept');
      return NextResponse.json(
        { success: true, supportSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    if (action === 'state') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device state' },
          { status: 401, headers: CORS_HEADERS }
        );
      }
      const supportSession = await pushClientSupportDelta(deviceId, {
        currentStep: typeof body.currentStep === 'number' ? body.currentStep : undefined,
        activeTab: typeof body.activeTab === 'string' ? body.activeTab : undefined,
        screenTitle: typeof body.screenTitle === 'string' ? body.screenTitle : undefined,
        recipientSummary:
          typeof body.recipientSummary === 'string' ? body.recipientSummary : undefined,
        amountSummary: typeof body.amountSummary === 'string' ? body.amountSummary : undefined,
        balance: typeof body.balance === 'number' ? body.balance : undefined,
        userName: typeof body.userName === 'string' ? body.userName : undefined,
        phoneNumber: typeof body.phoneNumber === 'string' ? body.phoneNumber : undefined,
        stateSeq: typeof body.stateSeq === 'number' ? body.stateSeq : undefined,
      });
      return NextResponse.json(
        { success: true, supportSession, serverTimeMs: Date.now() },
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
      const supportSession = await endSupportSession(deviceId);
      return NextResponse.json(
        { success: true, supportSession, serverTimeMs: Date.now() },
        { headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { success: false, error: `Unknown support action: ${action}` },
      { status: 400, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Support request failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
