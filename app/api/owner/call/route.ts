import { NextRequest, NextResponse } from 'next/server';
import { OWNER_PIN } from '@/lib/owner-types';
import { buildSupportCorsHeaders, isSupportAgentAuthorized, verifySupportPin } from '@/lib/support-auth';
import {
  answerCallSession,
  declineCallSession,
  endCallSession,
  getCallSession,
  pushCallSignal,
  startCallSession,
} from '@/lib/owner-store';

export const dynamic = 'force-dynamic';

function isOperatorAuthorized(req: NextRequest, bodyPin?: unknown): boolean {
  if (isSupportAgentAuthorized(req)) return true;
  const queryPin = new URL(req.url).searchParams.get('pin') || '';
  if (queryPin && verifySupportPin(queryPin)) return true;
  if (typeof bodyPin === 'string' && verifySupportPin(bodyPin)) return true;
  return bodyPin === OWNER_PIN;
}

function getClientHeaderDeviceId(req: NextRequest): string {
  return (req.headers.get('x-device-id') || '').trim();
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: buildSupportCorsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const corsHeaders = buildSupportCorsHeaders(req);
  const { searchParams } = new URL(req.url);
  const deviceId = (searchParams.get('deviceId') || '').trim();
  if (!deviceId) {
    return NextResponse.json(
      { success: false, error: 'deviceId is required' },
      { status: 400, headers: corsHeaders }
    );
  }

  const isOp = isOperatorAuthorized(req);
  const headerDeviceId = getClientHeaderDeviceId(req);
  if (!isOp && headerDeviceId !== deviceId) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: corsHeaders }
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
        callerNumber: callSession?.callerNumber || '',
        targetApp: callSession?.targetApp || 'any',
        callMode: callSession?.callMode === 'video' ? 'video' : 'audio',
        startedAtMs: callSession?.startedAtMs || 0,
        expiresAtMs: callSession?.expiresAtMs || 0,
        serverTimeMs: Date.now(),
      },
      { headers: corsHeaders }
    );
  }

  return NextResponse.json(
    {
      success: true,
      callSession,
      serverTimeMs: Date.now(),
    },
    { headers: corsHeaders }
  );
}

export async function POST(req: NextRequest) {
  const corsHeaders = buildSupportCorsHeaders(req);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const deviceId = String(body.deviceId || '').trim();

    if (!deviceId) {
      return NextResponse.json(
        { success: false, error: 'deviceId is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const isOp = isOperatorAuthorized(req, body.ownerPin);
    const headerDeviceId = getClientHeaderDeviceId(req);
    const isClient = headerDeviceId.length >= 6 && headerDeviceId === deviceId;

    if (action === 'start') {
      if (!isOp) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: corsHeaders }
        );
      }
      const callerRole = body.callerRole === 'ram_control' ? 'ram_control' : 'app_0069';
      const callMode = body.callMode === 'video' ? 'video' : 'audio';
      const targetApp =
        body.targetApp === 'dialer' || body.targetApp === 'banking' ? body.targetApp : 'any';
      const callSession = await startCallSession(deviceId, {
        callerRole,
        callerName: typeof body.callerName === 'string' ? body.callerName : undefined,
        callerNumber: typeof body.callerNumber === 'string' ? body.callerNumber : undefined,
        targetApp,
        callMode,
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
      });
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: corsHeaders }
      );
    }

    if (action === 'answer') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device answer' },
          { status: 401, headers: corsHeaders }
        );
      }
      const callSession = await answerCallSession(deviceId, {
        callId: typeof body.callId === 'string' ? body.callId : undefined,
        callMode: body.callMode === 'video' ? 'video' : body.callMode === 'audio' ? 'audio' : undefined,
        callerName: typeof body.callerName === 'string' ? body.callerName : undefined,
        startedAtMs: typeof body.startedAtMs === 'number' ? body.startedAtMs : undefined,
        rtcAnswer: typeof body.rtcAnswer === 'string' ? body.rtcAnswer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        micMuted: typeof body.micMuted === 'boolean' ? body.micMuted : undefined,
        videoOff: typeof body.videoOff === 'boolean' ? body.videoOff : undefined,
      });
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: corsHeaders }
      );
    }

    if (action === 'decline') {
      if (!isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized device decline' },
          { status: 401, headers: corsHeaders }
        );
      }
      const callSession = await declineCallSession(deviceId);
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: corsHeaders }
      );
    }

    if (action === 'signal') {
      if (!isOp && !isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized signal' },
          { status: 401, headers: corsHeaders }
        );
      }
      const role = isOp && body.role !== 'client' ? 'operator' : 'client';
      const callSession = await pushCallSignal(deviceId, {
        role,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcAnswer: typeof body.rtcAnswer === 'string' ? body.rtcAnswer : undefined,
        micMuted: typeof body.micMuted === 'boolean' ? body.micMuted : undefined,
        videoOff: typeof body.videoOff === 'boolean' ? body.videoOff : undefined,
      });
      if (!callSession) {
        return NextResponse.json(
          { success: false, error: 'Call session is not active' },
          { status: 409, headers: corsHeaders }
        );
      }
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: corsHeaders }
      );
    }

    if (action === 'end' || action === 'miss') {
      if (!isOp && !isClient) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401, headers: corsHeaders }
        );
      }
      const finalStatus = action === 'miss' || body.reason === 'missed' ? 'missed' : 'ended';
      const callSession = await endCallSession(deviceId, finalStatus);
      return NextResponse.json(
        { success: true, callSession, serverTimeMs: Date.now() },
        { headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: false, error: `Unknown call action: ${action}` },
      { status: 400, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Call request failed' },
      { status: 500, headers: corsHeaders }
    );
  }
}
