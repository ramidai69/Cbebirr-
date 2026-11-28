'use client';

import { getOwnerApiBaseUrl, SupportCallSession } from './owner-types';

function resolveSupportApiUrls(path: string): string[] {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const urls: string[] = [];
  if (typeof window !== 'undefined') {
    const origin = window.location?.origin || '';
    const protocol = window.location?.protocol || '';
    if (
      protocol.startsWith('http') &&
      !origin.includes('appassets.androidplatform.net') &&
      !origin.includes('offline-api-disabled.local')
    ) {
      urls.push(cleanPath);
    }
  }
  const ownerBase = getOwnerApiBaseUrl();
  const remoteUrl = `${ownerBase}${cleanPath}`;
  if (!urls.includes(remoteUrl)) {
    urls.push(remoteUrl);
  }
  return urls;
}

async function fetchSupportApi(
  path: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const urls = resolveSupportApiUrls(path);
  let lastStatus = 0;
  let lastData: Record<string, unknown> | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        ...init,
        cache: 'no-store',
      });
      lastStatus = res.status;
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      lastData = data;
      if (res.ok || res.status === 401 || res.status === 404 || res.status === 409) {
        return { ok: res.ok, status: res.status, data };
      }
    } catch {
      // try next fallback url
    }
  }
  return { ok: false, status: lastStatus || 500, data: lastData };
}

// -------- Native Android Bridge Helpers (CBESupport.apk) --------

interface AndroidSupportBridge {
  saveAgentSession?: (apiBase: string, token: string) => void;
  clearAgentSession?: () => void;
  getSavedSessionToken?: () => string;
  consumePendingCallAction?: () => string;
  stopRinger?: () => void;
  setAudioCallMode?: (active: boolean, speakerOn: boolean) => void;
  requestOverlayAndBattery?: () => void;
}

function getSupportNativeBridge(): AndroidSupportBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AndroidSupport?: AndroidSupportBridge;
    Android?: AndroidSupportBridge;
  };
  return w.AndroidSupport || w.Android || null;
}

export function saveSupportNativeSession(token: string): void {
  try {
    const bridge = getSupportNativeBridge();
    bridge?.saveAgentSession?.(getOwnerApiBaseUrl(), token);
  } catch {}
}

export function clearSupportNativeSession(): void {
  try {
    const bridge = getSupportNativeBridge();
    bridge?.clearAgentSession?.();
  } catch {}
}

export function getSupportNativeSavedToken(): string {
  try {
    const bridge = getSupportNativeBridge();
    return String(bridge?.getSavedSessionToken?.() || '').trim();
  } catch {
    return '';
  }
}

export function consumeSupportNativePendingAction(): { action: string; callId: string } | null {
  try {
    const bridge = getSupportNativeBridge();
    const raw = bridge?.consumePendingCallAction?.();
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw) as { action?: string; callId?: string };
    if (!parsed?.action || !parsed?.callId) return null;
    return { action: String(parsed.action), callId: String(parsed.callId) };
  } catch {
    return null;
  }
}

export function stopSupportNativeRinger(): void {
  try {
    getSupportNativeBridge()?.stopRinger?.();
  } catch {}
}

export function setSupportNativeAudioMode(active: boolean, speakerOn: boolean): void {
  try {
    getSupportNativeBridge()?.setAudioCallMode?.(active, speakerOn);
  } catch {}
}

export function requestSupportNativeBackgroundPermissions(): void {
  try {
    getSupportNativeBridge()?.requestOverlayAndBattery?.();
  } catch {}
}

// -------- Agent Auth APIs --------

export async function loginSupportAgent(pin: string): Promise<{
  ok: boolean;
  token?: string;
  error?: string;
}> {
  const res = await fetchSupportApi('/api/support/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin.trim() }),
  });
  if (res.ok && typeof res.data?.token === 'string') {
    return { ok: true, token: res.data.token };
  }
  return {
    ok: false,
    error:
      typeof res.data?.error === 'string'
        ? res.data.error
        : res.status === 401
          ? 'የተሳሳተ PIN ነው'
          : 'መግባት አልተቻለም',
  };
}

export async function verifySupportAgentToken(token: string): Promise<boolean> {
  if (!token) return false;
  const res = await fetchSupportApi('/api/support/auth', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return Boolean(res.ok && res.data?.authenticated === true);
}

// -------- Support Agent Queue & WebRTC APIs --------

export async function listSupportCalls(
  token: string,
  lite = false
): Promise<{
  ok: boolean;
  unauthorized?: boolean;
  ringingCalls: SupportCallSession[];
  activeCalls: SupportCallSession[];
  calls: SupportCallSession[];
}> {
  const qs = lite ? '?list=1&lite=1' : '?list=1&fresh=1';
  const res = await fetchSupportApi(`/api/support/call${qs}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    return { ok: false, unauthorized: true, ringingCalls: [], activeCalls: [], calls: [] };
  }
  return {
    ok: res.ok,
    ringingCalls: Array.isArray(res.data?.ringingCalls)
      ? (res.data.ringingCalls as SupportCallSession[])
      : [],
    activeCalls: Array.isArray(res.data?.activeCalls)
      ? (res.data.activeCalls as SupportCallSession[])
      : [],
    calls: Array.isArray(res.data?.calls) ? (res.data.calls as SupportCallSession[]) : [],
  };
}

export async function fetchSupportCallAsAgent(
  token: string,
  callId: string
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi(`/api/support/call?callId=${encodeURIComponent(callId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function answerSupportCallAsAgent(
  token: string,
  callId: string,
  opts?: { rtcAnswer?: string; rtcSeq?: number; supportMicMuted?: boolean }
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'answer',
      callId,
      rtcAnswer: opts?.rtcAnswer,
      rtcSeq: opts?.rtcSeq,
      supportMicMuted: opts?.supportMicMuted,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function declineSupportCallAsAgent(
  token: string,
  callId: string
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'decline',
      callId,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function pushSupportSignalAsAgent(
  token: string,
  callId: string,
  signal: { rtcSeq?: number; rtcAnswer?: string; supportMicMuted?: boolean }
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'signal',
      role: 'support',
      callId,
      ...signal,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function endSupportCallAsAgent(
  token: string,
  callId: string
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'end',
      callId,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

// -------- Caller Side APIs (Call APK -> Support Queue) --------

export async function startSupportQueueCall(input: {
  deviceId: string;
  deviceName?: string;
  userName?: string;
  phoneNumber?: string;
  userAccount?: string;
  balance?: number;
  rtcOffer: string;
  rtcSeq?: number;
  maxRingSec?: number;
}): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-device-id': input.deviceId,
    },
    body: JSON.stringify({
      action: 'start',
      ...input,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function fetchSupportQueueCallAsCaller(
  deviceId: string,
  callId: string
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi(`/api/support/call?callId=${encodeURIComponent(callId)}`, {
    method: 'GET',
    headers: {
      'x-device-id': deviceId,
    },
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function pushSupportSignalAsCaller(
  deviceId: string,
  callId: string,
  signal: { rtcSeq?: number; rtcOffer?: string; callerMicMuted?: boolean }
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-device-id': deviceId,
    },
    body: JSON.stringify({
      action: 'signal',
      role: 'caller',
      callId,
      ...signal,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}

export async function endSupportQueueCallAsCaller(
  deviceId: string,
  callId: string,
  reason: 'ended' | 'missed' = 'ended'
): Promise<SupportCallSession | null> {
  const res = await fetchSupportApi('/api/support/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-device-id': deviceId,
    },
    body: JSON.stringify({
      action: reason === 'missed' ? 'miss' : 'end',
      reason,
      callId,
    }),
  });
  return (res.data?.supportCall as SupportCallSession) || null;
}
