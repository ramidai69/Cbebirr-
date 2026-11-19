import { NextRequest, NextResponse } from 'next/server';
import { normalizeDeviceIdFilter, smsStore } from '@/lib/sms-store';
import { getActiveNotificationsForDevices } from '@/lib/owner-store';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-device-id',
  'Cache-Control': 'no-store',
};

function extractRequestedDeviceIds(req: NextRequest, body?: Record<string, unknown>): string[] {
  const url = new URL(req.url);
  const candidates: string[] = [];
  const qIds = url.searchParams.get('deviceIds');
  const qId = url.searchParams.get('deviceId');
  const hdr = req.headers.get('x-device-id');
  if (qIds) candidates.push(qIds);
  if (qId) candidates.push(qId);
  if (hdr) candidates.push(hdr);
  if (body?.deviceIds && Array.isArray(body.deviceIds)) {
    for (const v of body.deviceIds) candidates.push(String(v));
  } else if (typeof body?.deviceIds === 'string') {
    candidates.push(body.deviceIds);
  }
  if (typeof body?.deviceId === 'string') {
    candidates.push(body.deviceId);
  }
  return Array.from(normalizeDeviceIdFilter(candidates.join(',')));
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const allowedIds = extractRequestedDeviceIds(req);
  const unsyncedOnly = url.searchParams.get('unsynced') === 'true';
  const conversationId = url.searchParams.get('conversationId');

  // Strict per-device isolation: never expose unscoped or 'all' messages
  if (allowedIds.length === 0) {
    return NextResponse.json(
      {
        success: true,
        count: 0,
        deviceId: '',
        deviceIds: [],
        conversations: [],
        messages: [],
      },
      { headers: CORS_HEADERS }
    );
  }

  let [messages, ownerNotifications] = await Promise.all([
    smsStore.getAllMessagesAsync(allowedIds, unsyncedOnly),
    getActiveNotificationsForDevices(allowedIds).catch(() => []),
  ]);

  if (conversationId) {
    messages = messages.filter(
      (m) => m.conversationId.trim().toLowerCase() === conversationId.trim().toLowerCase()
    );
  }

  const conversations = smsStore.getConversations(allowedIds);

  return NextResponse.json(
    {
      success: true,
      count: messages.length,
      deviceId: allowedIds[0],
      deviceIds: allowedIds,
      conversations,
      messages,
      ownerNotifications,
      serverTimeMs: Date.now(),
    },
    { headers: CORS_HEADERS }
  );
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const allowedIds = extractRequestedDeviceIds(req, body);

    if (allowedIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Valid scoped deviceId is required' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const ids = Array.isArray(body.ids)
      ? body.ids.map(String)
      : url.searchParams.get('id')
      ? [url.searchParams.get('id')!]
      : undefined;

    if (ids && ids.length > 0) {
      const deletedCount = await smsStore.deleteMessagesAsync(ids, allowedIds);
      return NextResponse.json(
        { success: true, message: `Deleted ${deletedCount} message(s)` },
        { headers: CORS_HEADERS }
      );
    }

    if (body.reset || url.searchParams.get('reset') === 'true') {
      await smsStore.clearAllMessagesAsync(allowedIds);
      return NextResponse.json(
        { success: true, message: 'Reset messages queue for this device' },
        { headers: CORS_HEADERS }
      );
    }

    const clearedCount = await smsStore.clearAllMessagesAsync(allowedIds);
    return NextResponse.json(
      { success: true, message: `Cleared ${clearedCount} message(s) for this device` },
      { headers: CORS_HEADERS }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to delete' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
