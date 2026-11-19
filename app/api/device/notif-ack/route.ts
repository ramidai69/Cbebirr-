import { NextRequest, NextResponse } from 'next/server';
import { acknowledgeOwnerNotification } from '@/lib/owner-store';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-device-id',
  'Cache-Control': 'no-store',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const notifId = String(body.notifId || '').trim();
    const deviceId = String(body.deviceId || req.headers.get('x-device-id') || '').trim();
    const event = body.event === 'seen' ? 'seen' : 'delivered';

    if (!notifId || !deviceId) {
      return NextResponse.json(
        { success: false, error: 'notifId and deviceId are required' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const updated = await acknowledgeOwnerNotification(notifId, deviceId, event);
    return NextResponse.json(
      { success: Boolean(updated), notification: updated },
      { headers: CORS_HEADERS }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Ack failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
