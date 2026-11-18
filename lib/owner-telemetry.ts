'use client';

import {
  DeviceApprovalStatus,
  DevicePlatform,
  DeviceSyncResponse,
  OWNER_PIN,
  OwnerDashboardSnapshot,
  OwnerNotification,
  SupportCommandType,
  SupportSession,
  getOwnerApiBaseUrl,
} from './owner-types';

const DEVICE_ID_STORAGE_KEY = 'cbebirr_owner_device_id';
const LOCK_CACHE_KEY = 'cbebirr_remote_lock_cache';
const SEEN_NOTIFS_KEY = 'cbebirr_seen_owner_notifs';

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
  const deviceName = `${model} (${tag})`.slice(0, 115);

  return {
    deviceName,
    platform,
    appVersion: '1.0.94',
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

export async function syncDeviceTelemetry(profile: {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
  registerRequest?: boolean;
  freshRegistration?: boolean;
  forceApprovalCheck?: boolean;
  clientGateState?: string;
}): Promise<{
  lockState: CachedLockState;
  newNotifications: OwnerNotification[];
  supportSession: SupportSession | null;
  approvalStatus: DeviceApprovalStatus;
  fromServer: boolean;
} | null> {
  if (typeof window === 'undefined') return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    let offlineApproval: DeviceApprovalStatus = 'pending';
    try {
      const saved = localStorage.getItem('cbebirr_device_approval_v1');
      if (saved === 'pending' || saved === 'rejected' || saved === 'approved') {
        offlineApproval = saved;
      }
    } catch {}
    return {
      lockState: getCachedLockState(),
      newNotifications: [],
      supportSession: null,
      approvalStatus: offlineApproval,
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
        registerRequest: Boolean(profile.registerRequest),
        freshRegistration: Boolean(profile.freshRegistration),
        forceApprovalCheck: Boolean(profile.forceApprovalCheck),
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
    const newNotifications = (data.notifications || []).filter((n) => {
      if (!n?.notifId || seen.has(n.notifId)) return false;
      const deliveryDeadlineMs = Math.max(n.expiresAtMs || 0, (n.createdAtMs || 0) + 3_600_000);
      return deliveryDeadlineMs > refNowMs;
    });

    const fallbackStatus: DeviceApprovalStatus =
      profile.registerRequest || profile.forceApprovalCheck || profile.clientGateState === 'pending'
        ? 'pending'
        : 'approved';

    return {
      lockState,
      newNotifications,
      supportSession: data.supportSession || null,
      approvalStatus: data.approvalStatus || fallbackStatus,
      fromServer: true,
    };
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
      { type: 'application/json' }
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
  currentStep: number;
  activeTab: string;
  screenTitle: string;
  recipientSummary: string;
  amountSummary: string;
  balance: number;
  userName: string;
  phoneNumber: string;
  stateSeq: number;
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
        action: 'state',
        deviceId,
        ...delta,
      }),
    },
    3500
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.supportSession || null;
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

