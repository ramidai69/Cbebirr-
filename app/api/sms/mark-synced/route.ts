import { NextRequest, NextResponse } from 'next/server';
import { normalizeDeviceIdFilter, smsStore } from '@/lib/sms-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
    const rawFilter = [
      body.deviceIds,
      body.deviceId,
      req.headers.get('x-device-id'),
    ]
      .filter(Boolean)
      .join(',');
    const allowedIds = Array.from(normalizeDeviceIdFilter(rawFilter));

    if (allowedIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Valid scoped deviceId is required' },
        { status: 400 }
      );
    }

    smsStore.markMessagesSynced(ids, allowedIds);

    return NextResponse.json({
      success: true,
      message: 'Messages marked as synced',
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Failed to mark synced' }, { status: 500 });
  }
}
