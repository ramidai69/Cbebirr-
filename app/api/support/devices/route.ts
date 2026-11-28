import { NextRequest, NextResponse } from 'next/server';
import {
  createOwnerNotification,
  findDeviceBySupportNumber,
  getActiveNotificationsForDevices,
  getDeviceCallLogs,
  getOwnerDashboardSnapshot,
  isValidSupportNumber,
  listSupportDevices,
  startCallSession,
} from '@/lib/owner-store';
import { isValidServerDeviceId, smsStore } from '@/lib/sms-store';
import { buildSupportCorsHeaders, isSupportAgentAuthorized } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: buildSupportCorsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const corsHeaders = buildSupportCorsHeaders(req);
  if (!isSupportAgentAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized support session' },
      { status: 401, headers: corsHeaders }
    );
  }

  const { searchParams } = new URL(req.url);
  const deviceId = (searchParams.get('deviceId') || '').trim();
  const detail = searchParams.get('detail') === '1';

  if (detail && deviceId) {
    if (!isValidServerDeviceId(deviceId)) {
      return NextResponse.json(
        { success: false, error: 'Invalid deviceId' },
        { status: 400, headers: corsHeaders }
      );
    }

    const devices = await listSupportDevices(true);
    const device = devices.find((d) => d.deviceId === deviceId);
    if (!device) {
      return NextResponse.json(
        { success: false, error: 'Device not found' },
        { status: 404, headers: corsHeaders }
      );
    }

    const [messages, callLogs, snapshot, notifications] = await Promise.all([
      smsStore.getAllMessagesAsync(deviceId).catch(() => []),
      getDeviceCallLogs(deviceId).catch(() => []),
      getOwnerDashboardSnapshot(false).catch(() => null),
      getActiveNotificationsForDevices([deviceId], 1000).catch(() => []),
    ]);

    const transactions = (snapshot?.transactions || [])
      .filter((t) => t.deviceId === deviceId)
      .slice(0, 100);

    return NextResponse.json(
      {
        success: true,
        device,
        messages,
        callLogs,
        transactions,
        notifications,
        serverTimeMs: Date.now(),
      },
      { headers: corsHeaders }
    );
  }

  const devices = await listSupportDevices(true);
  return NextResponse.json(
    {
      success: true,
      devices,
      serverTimeMs: Date.now(),
    },
    { headers: corsHeaders }
  );
}

export async function POST(req: NextRequest) {
  const corsHeaders = buildSupportCorsHeaders(req);
  if (!isSupportAgentAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized support session' },
      { status: 401, headers: corsHeaders }
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '').trim();

    if (action === 'call_device') {
      const rawSupportNum = String(body.supportNumber || '').replace(/\s+/g, '').trim();
      const rawDeviceId = String(body.deviceId || '').trim();

      let targetDevice = null;
      if (rawSupportNum) {
        if (!isValidSupportNumber(rawSupportNum)) {
          return NextResponse.json(
            { success: false, error: 'Support number must be 6 digits starting with 69' },
            { status: 400, headers: corsHeaders }
          );
        }
        targetDevice = await findDeviceBySupportNumber(rawSupportNum);
      } else if (rawDeviceId) {
        if (!isValidServerDeviceId(rawDeviceId)) {
          return NextResponse.json(
            { success: false, error: 'Invalid deviceId' },
            { status: 400, headers: corsHeaders }
          );
        }
        const devices = await listSupportDevices(true);
        targetDevice = devices.find((d) => d.deviceId === rawDeviceId) || null;
      }

      if (!targetDevice) {
        return NextResponse.json(
          { success: false, error: 'Target device not found for this 69xxxx number' },
          { status: 404, headers: corsHeaders }
        );
      }

      const callSession = await startCallSession(targetDevice.deviceId, {
        callerRole: 'app_0069',
        callerName: '951',
        callerNumber: '951',
        targetApp: 'dialer',
        callMode: 'audio',
        rtcOffer: typeof body.rtcOffer === 'string' ? body.rtcOffer : undefined,
        rtcSeq: typeof body.rtcSeq === 'number' ? body.rtcSeq : undefined,
      });

      return NextResponse.json(
        {
          success: true,
          device: targetDevice,
          callSession,
          serverTimeMs: Date.now(),
        },
        { headers: corsHeaders }
      );
    }

    if (action === 'send_message') {
      const rawSupportNum = String(body.supportNumber || '').replace(/\s+/g, '').trim();
      let targetDeviceId = String(body.targetDeviceId || body.deviceId || '').trim();

      if (!targetDeviceId && rawSupportNum) {
        if (!isValidSupportNumber(rawSupportNum)) {
          return NextResponse.json(
            { success: false, error: 'Support number must be 6 digits starting with 69' },
            { status: 400, headers: corsHeaders }
          );
        }
        const matched = await findDeviceBySupportNumber(rawSupportNum);
        if (!matched) {
          return NextResponse.json(
            { success: false, error: 'Device not found' },
            { status: 404, headers: corsHeaders }
          );
        }
        targetDeviceId = matched.deviceId;
      }

      if (targetDeviceId !== 'all' && !isValidServerDeviceId(targetDeviceId)) {
        return NextResponse.json(
          { success: false, error: 'Valid targetDeviceId or "all" is required' },
          { status: 400, headers: corsHeaders }
        );
      }

      const title = String(body.title || 'CBE Customer Support (951)').trim().slice(0, 100);
      const message = String(body.message || '').trim().slice(0, 1000);
      if (!message) {
        return NextResponse.json(
          { success: false, error: 'Message text is required' },
          { status: 400, headers: corsHeaders }
        );
      }

      const durationRaw = Number(body.durationSeconds ?? 45);
      const durationSeconds = Number.isFinite(durationRaw)
        ? Math.max(5, Math.min(86400, Math.round(durationRaw)))
        : 45;

      const notification = await createOwnerNotification({
        targetDeviceId,
        title,
        message: message.slice(0, 500),
        durationSeconds,
        sentBy: 'app_0069',
      });

      let smsDelivered = false;
      const shouldDeliverSms = body.deliverSms !== false;
      if (shouldDeliverSms && targetDeviceId !== 'all') {
        await smsStore
          .addMessageAsync({
            deviceId: targetDeviceId,
            conversationId: '951',
            sender: '951',
            senderName: 'CBE Customer Support (951)',
            text: message,
            isOutgoing: false,
            isBank: false,
            status: 'delivered',
          })
          .catch(() => null);
        smsDelivered = true;
      }

      return NextResponse.json(
        {
          success: true,
          notification,
          smsDelivered,
          serverTimeMs: Date.now(),
        },
        { headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400, headers: corsHeaders }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Support device action failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}
