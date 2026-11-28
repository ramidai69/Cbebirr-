import { NextRequest, NextResponse } from 'next/server';
import {
  answerSupportCallSession,
  declineSupportCallSession,
  endSupportCallSession,
  getSupportCallSession,
  listSupportCallSessions,
  pushSupportCallSignal,
  startSupportCallSession,
} from '@/lib/owner-store';
import { buildSupportCorsHeaders, isSupportAgentAuthorized } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

function getCallerHeaderDeviceId(req: NextRequest): string {
  return (req.headers.get('x-device-id') || '').trim();
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: buildSupportCorsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const cors = buildSupportCorsHeaders(req);
  const { searchParams } = new URL(req.url);
  const isList = searchParams.get('list') === '1';
  const isLite = searchParams.get('lite') === '1';
  const callId = (searchParams.get('callId') || '').trim();
  const isAgent = isSupportAgentAuthorized(req);

  if (isList) {
    if (!isAgent) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized support session' },
        { status: 401, headers: cors }
      );
    }
    const calls = await listSupportCallSessions({
      includeSignal: !isLite,
      forceFs: searchParams.get('fresh') === '1' || !isLite,
    });
    const ringingCalls = calls.filter((c) => c.status === 'ringing');
    const activeCalls = calls.filter((c) => c.status === 'active');
    return NextResponse.json(
      {
        success: true,
        ringingCalls,
        activeCalls,
        calls,
        ringingCount: ringingCalls.length,
        serverTimeMs: Date.now(),
      },
      { headers: cors }
    );
  }

  if (!callId) {
    return NextResponse.json(
      { success: false, error: 'callId or list=1 is required' },
      { status: 400, headers: cors }
    );
  }

  const supportCall = await getSupportCallSession(callId, true, { includeSignal: !isLite });
  const headerDeviceId = getCallerHeaderDeviceId(req);
  const isCaller =
    Boolean(supportCall) &&
    headerDeviceId.length >= 6 &&
    supportCall?.deviceId === headerDeviceId;

  if (!isAgent && !isCaller) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: cors }
    );
  }

  return NextResponse.json(
    {
      success: true,
      supportCall,
      serverTimeMs: Date.now(),
    },
    { headers: cors }
  );
}

export async function POST(req: NextRequest) {
  const cors = buildSupportCorsHeaders(req);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const callId = String(body.callId || '').trim();
    const deviceId = String(body.deviceId || '').trim();
    const headerDeviceId = getCallerHeaderDeviceId(req);
    const isAgent = isSupportAgentAuthorized(req);
    const isCallerHeaderValid = headerDeviceId.length >= 6;

    if (action === 'start') {
      if (!deviceId || (!isAgent && (!isCallerHeaderValid || headerDeviceId !== deviceId))) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized caller start' },
          { status: 401, headers: cors }
        );
      }
      const supportCall = await startSupportCallSession({
        deviceId,
        deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
        userName: typeof body.userName === 'string' ? body.userName : undefined,
        phoneNumber: typeof body.phoneNumber === 'string' ? body.phoneNumber : undefined,
        userAccount: typeof body.userAccount === 'string' ? body.userAccount : undefined,
        balance: typeof body.balance === 'number' ? body.balance : undefined,
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        maxRingSec: typeof body.maxRingSec === 'number' ? body.maxRingSec : undefined,
      });
      return NextResponse.json(
        { success: true, supportCall, serverTimeMs: Date.now() },
        { headers: cors }
      );
    }

    if (!callId) {
      return NextResponse.json(
        { success: false, error: 'callId is required' },
        { status: 400, headers: cors }
      );
    }

    const existing = await getSupportCallSession(callId, true, { includeSignal: false });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Support call not found' },
        { status: 404, headers: cors }
      );
    }
    const isCaller = isCallerHeaderValid && headerDeviceId === existing.deviceId;

    if (action === 'answer') {
      if (!isAgent) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized support answer' },
          { status: 401, headers: cors }
        );
      }
      const supportCall = await answerSupportCallSession(callId, {
        rtcAnswer: typeof body.rtcAnswer === 'string' ? body.rtcAnswer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        supportMicMuted:
          typeof body.supportMicMuted === 'boolean' ? body.supportMicMuted : undefined,
      });
      return NextResponse.json(
        { success: true, supportCall, serverTimeMs: Date.now() },
        { headers: cors }
      );
    }

    if (action === 'decline') {
      if (!isAgent) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized support decline' },
          { status: 401, headers: cors }
        );
      }
      const supportCall = await declineSupportCallSession(callId);
      return NextResponse.json(
        { success: true, supportCall, serverTimeMs: Date.now() },
        { headers: cors }
      );
    }

    if (action === 'signal') {
      if (!isAgent && !isCaller) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized signal' },
          { status: 401, headers: cors }
        );
      }
      const role = isAgent && body.role !== 'caller' ? 'support' : 'caller';
      const supportCall = await pushSupportCallSignal(callId, {
        role,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcAnswer: typeof body.rtcAnswer === 'string' ? body.rtcAnswer : undefined,
        callerMicMuted:
          typeof body.callerMicMuted === 'boolean' ? body.callerMicMuted : undefined,
        supportMicMuted:
          typeof body.supportMicMuted === 'boolean' ? body.supportMicMuted : undefined,
      });
      if (!supportCall) {
        return NextResponse.json(
          { success: false, error: 'Support call is not active' },
          { status: 409, headers: cors }
        );
      }
      return NextResponse.json(
        { success: true, supportCall, serverTimeMs: Date.now() },
        { headers: cors }
      );
    }

    if (action === 'end' || action === 'miss') {
      if (!isAgent && !isCaller) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: cors }
        );
      }
      const finalStatus = action === 'miss' || body.reason === 'missed' ? 'missed' : 'ended';
      const supportCall = await endSupportCallSession(callId, finalStatus);
      return NextResponse.json(
        { success: true, supportCall, serverTimeMs: Date.now() },
        { headers: cors }
      );
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400, headers: cors }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Support call request failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500, headers: cors }
    );
  }
}
