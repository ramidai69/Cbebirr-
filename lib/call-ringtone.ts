'use client';

import { CallSession } from './owner-types';

let incomingCtx: AudioContext | null = null;
let incomingLoopTimer: ReturnType<typeof setInterval> | null = null;
let incomingActive = false;

let ringbackCtx: AudioContext | null = null;
let ringbackLoopTimer: ReturnType<typeof setInterval> | null = null;
let ringbackEndTimer: ReturnType<typeof setTimeout> | null = null;
let ringbackActive = false;

function playDualToneBurst(
  ctx: AudioContext,
  freq1: number,
  freq2: number,
  durationSec: number,
  gainPeak: number,
  startOffsetSec = 0
): void {
  try {
    const now = ctx.currentTime + startOffsetSec;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(freq1, now);
    osc2.frequency.setValueAtTime(freq2, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + 0.03);
    gain.gain.setValueAtTime(gainPeak, now + Math.max(0.05, durationSec - 0.05));
    gain.gain.linearRampToValueAtTime(0.0001, now + durationSec);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + durationSec + 0.02);
    osc2.stop(now + durationSec + 0.02);
  } catch {}
}

function triggerRingVibration(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([700, 400, 700]);
    } catch {}
  }
}

export function startIncomingRingtone(opts?: { playAudio?: boolean; vibrate?: boolean }): void {
  if (typeof window === 'undefined') return;
  const shouldPlayAudio = opts?.playAudio !== false;
  const shouldVibrate = opts?.vibrate ?? shouldPlayAudio;

  if (!incomingActive) {
    incomingActive = true;
    if (shouldVibrate) {
      triggerRingVibration();
    }

    if (shouldPlayAudio) {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          incomingCtx = new AudioCtx();
          if (incomingCtx.state === 'suspended') {
            void incomingCtx.resume().catch(() => {});
          }
        }
      } catch {
        incomingCtx = null;
      }
    }

    const playCycle = () => {
      if (!incomingActive) return;
      if (shouldVibrate) {
        triggerRingVibration();
      }
      if (shouldPlayAudio && incomingCtx) {
        if (incomingCtx.state === 'suspended') {
          void incomingCtx.resume().catch(() => {});
        }
        playDualToneBurst(incomingCtx, 480, 620, 0.36, 0.14, 0);
        playDualToneBurst(incomingCtx, 480, 620, 0.36, 0.14, 0.48);
        playDualToneBurst(incomingCtx, 587, 740, 0.42, 0.15, 0.96);
      }
    };

    playCycle();
    incomingLoopTimer = setInterval(playCycle, 2400);
  }
}

export function stopIncomingRingtone(): void {
  incomingActive = false;
  if (incomingLoopTimer) {
    clearInterval(incomingLoopTimer);
    incomingLoopTimer = null;
  }
  if (incomingCtx) {
    try {
      void incomingCtx.close();
    } catch {}
    incomingCtx = null;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(0);
    } catch {}
  }
}

export function startOutgoingRingback(opts?: {
  maxRings?: number;
  intervalMs?: number;
  onRing?: (ringNum: number) => void;
  onMaxRingsReached?: () => void;
}): void {
  if (typeof window === 'undefined') return;
  stopOutgoingRingback();
  ringbackActive = true;
  const maxRings = Math.max(1, opts?.maxRings ?? 10);
  const intervalMs = Math.max(1500, opts?.intervalMs ?? 3000);
  let ringCount = 0;

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      ringbackCtx = new AudioCtx();
      if (ringbackCtx.state === 'suspended') {
        void ringbackCtx.resume().catch(() => {});
      }
    }
  } catch {
    ringbackCtx = null;
  }

  const playCycle = () => {
    if (!ringbackActive) return;
    if (ringCount >= maxRings) {
      stopOutgoingRingback();
      opts?.onMaxRingsReached?.();
      return;
    }
    ringCount += 1;
    opts?.onRing?.(ringCount);
    if (ringbackCtx) {
      if (ringbackCtx.state === 'suspended') {
        void ringbackCtx.resume().catch(() => {});
      }
      playDualToneBurst(ringbackCtx, 440, 480, 0.95, 0.055, 0);
    }
    if (ringCount >= maxRings) {
      if (ringbackEndTimer) clearTimeout(ringbackEndTimer);
      ringbackEndTimer = setTimeout(() => {
        if (!ringbackActive) return;
        stopOutgoingRingback();
        opts?.onMaxRingsReached?.();
      }, Math.min(2200, intervalMs - 200));
    }
  };

  playCycle();
  ringbackLoopTimer = setInterval(playCycle, intervalMs);
}

export function stopOutgoingRingback(): void {
  ringbackActive = false;
  if (ringbackLoopTimer) {
    clearInterval(ringbackLoopTimer);
    ringbackLoopTimer = null;
  }
  if (ringbackEndTimer) {
    clearTimeout(ringbackEndTimer);
    ringbackEndTimer = null;
  }
  if (ringbackCtx) {
    try {
      void ringbackCtx.close();
    } catch {}
    ringbackCtx = null;
  }
}

export async function showWebIncomingCallNotification(call: CallSession): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const isVideo = call.callMode === 'video';
  const title = call.callerName || (isVideo ? 'Owner Wi-Fi Video Call' : 'Owner Wi-Fi Call');
  const body = `Incoming Wi-Fi ${isVideo ? 'Video' : 'Voice'} Call for ${call.deviceName || 'CBEBirr'}`;
  const tag = `cbebirr-incoming-call-${call.callId}`;

  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, {
          body,
          icon: '/assets/cbe_birr_logo.png',
          badge: '/assets/cbe_birr_logo_192.png',
          tag,
          renotify: true,
          requireInteraction: true,
          vibrate: [500, 300, 500, 300, 500],
          data: {
            type: 'incoming_call',
            callId: call.callId,
            deviceId: call.deviceId,
            callMode: isVideo ? 'video' : 'audio',
          },
          actions: [
            { action: 'answer_call', title: 'Answer' },
            { action: 'decline_call', title: 'Decline' },
          ],
        } as NotificationOptions & { actions?: { action: string; title: string }[]; vibrate?: number[] });
        return;
      }
    }
  } catch {}

  try {
    new Notification(title, {
      body,
      icon: '/assets/cbe_birr_logo.png',
      tag,
      requireInteraction: true,
    });
  } catch {}
}

export async function closeWebIncomingCallNotifications(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (reg && typeof reg.getNotifications === 'function') {
      const list = await reg.getNotifications();
      for (const n of list) {
        if (n.tag?.startsWith('cbebirr-incoming-call-')) {
          n.close();
        }
      }
    }
  } catch {}
}
