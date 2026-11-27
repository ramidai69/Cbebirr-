'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  Ban,
  Bluetooth,
  BookOpen,
  Bot,
  Check,
  Grip,
  HelpCircle,
  MessageSquare,
  Mic,
  MicOff,
  MoreVertical,
  Music,
  Pause,
  Phone,
  PhoneOff,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserPlus,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { getOwnerApiBaseUrl } from '@/lib/owner-types';
import {
  AiTrainingPair,
  BUILTIN_951_AUDIO_CLIPS,
  CustomAudioRecord,
  DEFAULT_951_CONFIG,
  Mp3StepItem,
  Support951Config,
  Support951Mode,
  Support951Voice,
  deleteCustomAudioFile,
  hasCompletedFirst951Welcome,
  listCustomAudioFiles,
  load951Config,
  markFirst951WelcomeCompleted,
  resetFirst951Welcome,
  resolveAudioClipUrl,
  save951Config,
  saveCustomAudioFile,
} from '@/lib/dialer951Config';

interface BankingContextSnapshot {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
}

type Call951Phase =
  | 'ringing'
  | 'real_951_ringing'
  | 'real_951_live'
  | 'welcome_menu'
  | 'amharic_menu'
  | 'hold_mp3'
  | 'secret_ringing'
  | 'secret_busy_retry'
  | 'secret_live'
  | 'ai_active'
  | 'survey_closing'
  | 'ended';

type AiDotState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface EndedCallSummary {
  target: string;
  label: string;
  durationSec: number;
}

export interface NativeCallStatePayload {
  active: boolean;
  mode?: number;
  callType?: 'incoming' | 'outgoing';
  state?: 'idle' | 'ringing' | 'dialing' | 'connecting' | 'active' | 'holding' | 'disconnected';
  number?: string;
  label?: string;
  connectTimeMs?: number;
  muted?: boolean;
  speaker?: boolean;
  bluetooth?: boolean;
  held?: boolean;
}

interface Dialer951CallOverlayProps {
  open: boolean;
  onClose: (endedSummary?: EndedCallSummary) => void;
  bankingContext: BankingContextSnapshot;
  bridge: Record<string, unknown> | null;
}

interface SamsungStandardInCallProps {
  open: boolean;
  target: string;
  label: string;
  nativeState?: NativeCallStatePayload | null;
  bridge?: Record<string, unknown> | null;
  onEnd: (durationSec: number) => void;
  onOpenMessages: (target: string) => void;
  onAddContact?: (target: string) => void;
}

interface SamsungCallEndedOverlayProps {
  summary: EndedCallSummary | null;
  onDismiss: () => void;
  onRedial: (target: string) => void;
  onOpenMessages: (target: string) => void;
  onBlockNumber: (target: string) => void;
  onAddContact: (target: string) => void;
}

interface Dialer951StudioDrawerProps {
  open: boolean;
  onClose: () => void;
  onStartTest951Call: () => void;
  isDefaultDialer?: boolean;
  onRequestDefaultDialer?: () => void;
  onOpenBankingSync?: () => void;
  onOpenAdvancedPermissions?: () => void;
}

const CALL_KEYPAD_ITEMS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '' },
  { digit: '#', sub: '' },
];

const DTMF_MAP: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function base64ToAudioPlaybackUrl(base64: string, mimeType = 'audio/wav'): { url: string; isObjectUrl: boolean } {
  try {
    const clean = base64.replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    return { url: URL.createObjectURL(blob), isObjectUrl: true };
  } catch {
    return { url: `data:${mimeType};base64,${base64}`, isObjectUrl: false };
  }
}

interface AiSupportApiResult {
  ok: boolean;
  transcript?: string;
  replyText?: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
  error?: string;
}

async function postAiSupportRequest(payload: Record<string, unknown>): Promise<AiSupportApiResult> {
  const endpoints: string[] = [];
  if (typeof window !== 'undefined') {
    const origin = window.location?.origin || '';
    const protocol = window.location?.protocol || '';
    if (
      protocol.startsWith('http') &&
      !origin.includes('appassets.androidplatform.net') &&
      !origin.includes('offline-api-disabled.local')
    ) {
      endpoints.push('/api/dialer/ai-support');
    }
  }
  const ownerBase = getOwnerApiBaseUrl();
  const remoteEndpoint = `${ownerBase}/api/dialer/ai-support`;
  if (!endpoints.includes(remoteEndpoint)) {
    endpoints.push(remoteEndpoint);
  }

  let lastError = 'AI server connection failed';
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as AiSupportApiResult;
      if (res.ok && data?.ok) {
        return data;
      }
      if (data?.error) {
        lastError = data.error;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    }
  }
  return { ok: false, error: lastError };
}

export function formatCallTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function playSharedDtmf(audioCtxRef: React.MutableRefObject<AudioContext | null>, digit: string) {
  const freqs = DTMF_MAP[digit];
  if (!freqs || typeof window === 'undefined') return;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AC();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    g.connect(ctx.destination);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(now);
      o.stop(now + 0.14);
    }
  } catch {}
}

function playUiToggleTone(audioCtxRef: React.MutableRefObject<AudioContext | null>, enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    navigator.vibrate?.(12);
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AC();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, now);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.065);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(enabled ? 880 : 620, now);
    o.connect(g);
    o.start(now);
    o.stop(now + 0.065);
  } catch {}
}

/**
 * 100% Samsung One UI Teal-Slate In-Call Screen for 951 Support (3 MP3 Stages + Gemini AI + Secret Background Call)
 */
export function Dialer951CallOverlay({
  open,
  onClose,
  bankingContext,
  bridge,
}: Dialer951CallOverlayProps) {
  const [phase, setPhase] = useState<Call951Phase>('ringing');
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [speakerOn, setSpeakerOn] = useState<boolean>(true);
  const [muted, setMuted] = useState<boolean>(false);
  const [held, setHeld] = useState<boolean>(false);
  const [bluetoothOn, setBluetoothOn] = useState<boolean>(false);
  const [keypadVisible, setKeypadVisible] = useState<boolean>(false);
  const [inCallMenuOpen, setInCallMenuOpen] = useState<boolean>(false);
  const [dtmfEntered, setDtmfEntered] = useState<string>('');
  const [aiDotState, setAiDotState] = useState<AiDotState>('idle');

  const phaseRef = useRef<Call951Phase>('ringing');
  const openRef = useRef<boolean>(false);
  const speakerOnRef = useRef<boolean>(true);
  const mutedRef = useRef<boolean>(false);
  const heldRef = useRef<boolean>(false);
  const elapsedRef = useRef<number>(0);
  const configRef = useRef<Support951Config>(DEFAULT_951_CONFIG);
  const onCloseRef = useRef(onClose);
  const bankingContextRef = useRef(bankingContext);
  const bridgeRef = useRef(bridge);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadAudioCtxRef = useRef<AudioContext | null>(null);
  const errorFlashTimerRef = useRef<number | null>(null);
  const discardRecordingRef = useRef<boolean>(false);
  const ringStopRef = useRef<(() => void) | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const sleepTimerRef = useRef<number | null>(null);
  const sleepResolverRef = useRef<(() => void) | null>(null);
  const playbackSettlerRef = useRef<((reason: 'ended' | 'stopped' | 'error') => void) | null>(null);
  const nativeAudioActiveRef = useRef<boolean>(false);
  const nativeAudioExpectedTokenRef = useRef<string | null>(null);
  const nativeAudioSettlerRef = useRef<
    ((evt: 'started' | 'ended' | 'error' | 'stopped') => void) | null
  >(null);
  const playbackTokenRef = useRef<number>(0);
  const menuLoopEpochRef = useRef<number>(0);
  const isRepeatMenuRef = useRef<boolean>(false);
  const stepCursorRef = useRef<number>(0);
  const historyRef = useRef<{ role: 'user' | 'agent'; text: string }[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadLoopRef = useRef<number | null>(null);
  const isUserSpeakingRef = useRef<boolean>(false);
  const silenceStartMsRef = useRef<number>(0);
  const speechStartMsRef = useRef<number>(0);
  const agentBusyRef = useRef<boolean>(false);
  const activeObjectUrlRef = useRef<string | null>(null);
  const currentClipIdRef = useRef<string | null>(null);
  const surveyReplayRef = useRef<boolean>(false);
  const wasSecretLiveRef = useRef<boolean>(false);
  const real951HandedOffRef = useRef<boolean>(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    bankingContextRef.current = bankingContext;
  }, [bankingContext]);

  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const updatePhase = useCallback((next: Call951Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    heldRef.current = held;
  }, [held]);

  useEffect(() => {
    speakerOnRef.current = speakerOn;
  }, [speakerOn]);

  useEffect(() => {
    elapsedRef.current = elapsedSec;
  }, [elapsedSec]);

  const appendTranscript = useCallback((role: 'user' | 'agent' | 'system', text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (role === 'user' || role === 'agent') {
      historyRef.current = [...historyRef.current.slice(-14), { role, text: clean }];
    }
  }, []);

  const cancelPendingSleep = useCallback(() => {
    if (sleepTimerRef.current !== null) {
      window.clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    if (sleepResolverRef.current) {
      const res = sleepResolverRef.current;
      sleepResolverRef.current = null;
      res();
    }
  }, []);

  const waitInterruptibly = useCallback(
    (ms: number, epoch: number): Promise<boolean> => {
      cancelPendingSleep();
      if (!openRef.current || menuLoopEpochRef.current !== epoch) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (sleepTimerRef.current !== null) {
            window.clearTimeout(sleepTimerRef.current);
            sleepTimerRef.current = null;
          }
          if (sleepResolverRef.current === finish) {
            sleepResolverRef.current = null;
          }
          resolve(openRef.current && menuLoopEpochRef.current === epoch);
        };
        sleepResolverRef.current = finish;
        sleepTimerRef.current = window.setTimeout(finish, ms);
      });
    },
    [cancelPendingSleep]
  );

  const stopAllAudio = useCallback(() => {
    playbackTokenRef.current += 1;
    currentClipIdRef.current = null;
    nativeAudioActiveRef.current = false;
    nativeAudioExpectedTokenRef.current = null;
    cancelPendingSleep();
    if (nativeAudioSettlerRef.current) {
      const settleNative = nativeAudioSettlerRef.current;
      nativeAudioSettlerRef.current = null;
      settleNative('stopped');
    }
    if (playbackSettlerRef.current) {
      const settle = playbackSettlerRef.current;
      playbackSettlerRef.current = null;
      settle('stopped');
    }
    if (typeof bridgeRef.current?.stopNativeAudio === 'function') {
      try {
        (bridgeRef.current.stopNativeAudio as () => void)();
      } catch {}
    }
    if (ringStopRef.current) {
      ringStopRef.current();
      ringStopRef.current = null;
    }
    if (audioElRef.current) {
      try {
        audioElRef.current.onended = null;
        audioElRef.current.onerror = null;
        audioElRef.current.pause();
        audioElRef.current.currentTime = 0;
      } catch {}
      audioElRef.current = null;
    }
    if (activeObjectUrlRef.current) {
      try {
        URL.revokeObjectURL(activeObjectUrlRef.current);
      } catch {}
      activeObjectUrlRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }, [cancelPendingSleep]);

  const stopMicVad = useCallback(() => {
    if (vadLoopRef.current) {
      cancelAnimationFrame(vadLoopRef.current);
      vadLoopRef.current = null;
    }
    discardRecordingRef.current = true;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {}
    }
    recorderRef.current = null;
    chunksRef.current = [];
    if (vadAudioCtxRef.current) {
      try {
        void vadAudioCtxRef.current.close();
      } catch {}
      vadAudioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      mediaStreamRef.current = null;
    }
    isUserSpeakingRef.current = false;
  }, []);

  const startRingbackTone = useCallback(() => {
    stopAllAudio();
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AC();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      let active = true;
      const playBurst = () => {
        if (!active) return;
        const now = ctx.currentTime;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.045, now);
        g.gain.setValueAtTime(0.0001, now + 0.85);
        g.connect(ctx.destination);
        for (const f of [425, 450]) {
          const o = ctx.createOscillator();
          o.frequency.value = f;
          o.connect(g);
          o.start(now);
          o.stop(now + 0.85);
        }
      };
      playBurst();
      const tid = window.setInterval(playBurst, 2200);
      ringStopRef.current = () => {
        active = false;
        clearInterval(tid);
      };
    } catch {}
  }, [stopAllAudio]);

  const speakBrowserAmharic = useCallback((text: string): Promise<'ended' | 'stopped' | 'error'> => {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        resolve('error');
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'am-ET';
        u.rate = 0.96;
        const voices = window.speechSynthesis.getVoices();
        const amVoice = voices.find((v) => v.lang.toLowerCase().startsWith('am'));
        if (amVoice) u.voice = amVoice;
        let done = false;
        let fallbackTid: number | null = null;
        const finish = (reason: 'ended' | 'stopped' | 'error' = 'ended') => {
          if (done) return;
          done = true;
          if (fallbackTid !== null) {
            window.clearTimeout(fallbackTid);
            fallbackTid = null;
          }
          if (playbackSettlerRef.current === finish) {
            playbackSettlerRef.current = null;
          }
          resolve(reason);
        };
        playbackSettlerRef.current = finish;
        u.onend = () => finish('ended');
        u.onerror = () => finish('error');
        fallbackTid = window.setTimeout(
          () => finish('ended'),
          Math.max(2400, Math.min(9000, text.length * 85))
        );
        window.speechSynthesis.speak(u);
      } catch {
        resolve('error');
      }
    });
  }, []);

  const playAudioClipById = useCallback(
    async (
      audioId: string,
      loop = false,
      preferMediaStream = false
    ): Promise<'ended' | 'stopped' | 'error'> => {
      if (!audioId || audioId === '__none__') return 'error';
      stopAllAudio();
      const myToken = playbackTokenRef.current;
      const resolvedUrl = await resolveAudioClipUrl(audioId);
      if (playbackTokenRef.current !== myToken || !openRef.current) {
        if (resolvedUrl && resolvedUrl.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(resolvedUrl);
          } catch {}
        }
        return 'stopped';
      }
      if (!resolvedUrl) return 'error';
      if (resolvedUrl.startsWith('blob:')) {
        activeObjectUrlRef.current = resolvedUrl;
      }
      currentClipIdRef.current = audioId;

      if (typeof bridgeRef.current?.playNativeAudio === 'function') {
        let nativeUrlOrAsset = '';
        let nativeBase64 = '';
        if (resolvedUrl.startsWith('blob:')) {
          try {
            const resp = await fetch(resolvedUrl);
            const blob = await resp.blob();
            const b64 = await blobToBase64(blob);
            const mime = blob.type || 'audio/mpeg';
            nativeBase64 = `data:${mime};base64,${b64}`;
          } catch {
            nativeBase64 = '';
          }
        } else {
          nativeUrlOrAsset = resolvedUrl;
        }

        if (playbackTokenRef.current !== myToken || !openRef.current) {
          return 'stopped';
        }

        if (nativeUrlOrAsset || nativeBase64) {
          const nativeRes = await new Promise<'ended' | 'stopped' | 'error'>((resolve) => {
            let done = false;
            const nativeToken = `clip_${myToken}_${Date.now()}`;
            let safetyTid: number | null = null;
            const finish = (reason: 'ended' | 'stopped' | 'error') => {
              if (done) return;
              done = true;
              if (safetyTid !== null) {
                window.clearTimeout(safetyTid);
                safetyTid = null;
              }
              if (playbackSettlerRef.current === finish) {
                playbackSettlerRef.current = null;
              }
              if (nativeAudioExpectedTokenRef.current === nativeToken) {
                nativeAudioExpectedTokenRef.current = null;
                nativeAudioSettlerRef.current = null;
              }
              if (!(loop && reason === 'ended')) {
                nativeAudioActiveRef.current = false;
                if (currentClipIdRef.current === audioId) {
                  currentClipIdRef.current = null;
                }
              }
              resolve(reason);
            };
            playbackSettlerRef.current = finish;
            nativeAudioExpectedTokenRef.current = nativeToken;
            nativeAudioSettlerRef.current = (evt) => {
              if (evt === 'started') {
                nativeAudioActiveRef.current = true;
                if (loop) {
                  finish('ended');
                }
                return;
              }
              if (evt === 'ended') {
                finish('ended');
                return;
              }
              if (evt === 'stopped') {
                finish('stopped');
                return;
              }
              finish('error');
            };
            safetyTid = window.setTimeout(() => finish('ended'), loop ? 12000 : 120000);
            try {
              (
                bridgeRef.current!.playNativeAudio as (
                  t: string,
                  u: string,
                  b: string,
                  l: boolean,
                  pm?: boolean
                ) => void
              )(nativeToken, nativeUrlOrAsset, nativeBase64, loop, preferMediaStream);
            } catch {
              finish('error');
            }
          });

          if (nativeRes !== 'error') {
            return nativeRes;
          }
          nativeAudioActiveRef.current = false;
          if (playbackTokenRef.current !== myToken || !openRef.current) {
            return 'stopped';
          }
          currentClipIdRef.current = audioId;
        }
      }

      return await new Promise<'ended' | 'stopped' | 'error'>((resolve) => {
        let done = false;
        const finish = (reason: 'ended' | 'stopped' | 'error') => {
          if (done) return;
          done = true;
          if (playbackSettlerRef.current === finish) {
            playbackSettlerRef.current = null;
          }
          if (!(loop && reason === 'ended') && currentClipIdRef.current === audioId) {
            currentClipIdRef.current = null;
          }
          resolve(reason);
        };
        playbackSettlerRef.current = finish;
        try {
          if (playbackTokenRef.current !== myToken || !openRef.current) {
            finish('stopped');
            return;
          }
          const audio = new Audio(resolvedUrl);
          audio.preload = 'auto';
          audio.loop = loop;
          audioElRef.current = audio;
          if (loop) {
            void audio
              .play()
              .then(() => {
                if (playbackTokenRef.current !== myToken || !openRef.current) {
                  try {
                    audio.pause();
                    audio.currentTime = 0;
                  } catch {}
                  finish('stopped');
                } else {
                  finish('ended');
                }
              })
              .catch(() => finish('error'));
            return;
          }
          audio.onended = () => finish('ended');
          audio.onerror = () => finish('error');
          void audio
            .play()
            .then(() => {
              if (playbackTokenRef.current !== myToken || !openRef.current) {
                try {
                  audio.pause();
                  audio.currentTime = 0;
                } catch {}
                finish('stopped');
              }
            })
            .catch(() => finish('error'));
        } catch {
          finish('error');
        }
      });
    },
    [stopAllAudio]
  );

  const playBase64Wav = useCallback(
    async (base64: string, mimeType = 'audio/wav'): Promise<'ended' | 'stopped' | 'error'> => {
      stopAllAudio();
      const myToken = playbackTokenRef.current;

      if (typeof bridgeRef.current?.playNativeAudio === 'function' && base64.trim()) {
        const dataUri = base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`;
        const nativeRes = await new Promise<'ended' | 'stopped' | 'error'>((resolve) => {
          let done = false;
          const nativeToken = `tts_${myToken}_${Date.now()}`;
          let safetyTid: number | null = null;
          const finish = (reason: 'ended' | 'stopped' | 'error') => {
            if (done) return;
            done = true;
            if (safetyTid !== null) {
              window.clearTimeout(safetyTid);
              safetyTid = null;
            }
            if (playbackSettlerRef.current === finish) {
              playbackSettlerRef.current = null;
            }
            if (nativeAudioExpectedTokenRef.current === nativeToken) {
              nativeAudioExpectedTokenRef.current = null;
              nativeAudioSettlerRef.current = null;
            }
            nativeAudioActiveRef.current = false;
            resolve(reason);
          };
          playbackSettlerRef.current = finish;
          nativeAudioExpectedTokenRef.current = nativeToken;
          nativeAudioSettlerRef.current = (evt) => {
            if (evt === 'started') {
              nativeAudioActiveRef.current = true;
              return;
            }
            if (evt === 'ended') {
              finish('ended');
              return;
            }
            if (evt === 'stopped') {
              finish('stopped');
              return;
            }
            finish('error');
          };
          safetyTid = window.setTimeout(() => finish('ended'), 45000);
          try {
            (
              bridgeRef.current!.playNativeAudio as (
                t: string,
                u: string,
                b: string,
                l: boolean
              ) => void
            )(nativeToken, '', dataUri, false);
          } catch {
            finish('error');
          }
        });

        if (nativeRes !== 'error') {
          return nativeRes;
        }
        nativeAudioActiveRef.current = false;
        if (playbackTokenRef.current !== myToken || !openRef.current) {
          return 'stopped';
        }
      }

      return await new Promise((resolve) => {
        try {
          const { url, isObjectUrl } = base64ToAudioPlaybackUrl(base64, mimeType);
          if (isObjectUrl) {
            activeObjectUrlRef.current = url;
          }
          const audio = new Audio(url);
          audio.preload = 'auto';
          audioElRef.current = audio;
          let done = false;
          let safetyTid: number | null = null;
          const finish = (reason: 'ended' | 'stopped' | 'error' = 'ended') => {
            if (done) return;
            done = true;
            if (safetyTid !== null) {
              window.clearTimeout(safetyTid);
              safetyTid = null;
            }
            if (playbackSettlerRef.current === finish) {
              playbackSettlerRef.current = null;
            }
            resolve(reason);
          };
          playbackSettlerRef.current = finish;
          safetyTid = window.setTimeout(() => finish('ended'), 45000);
          audio.onended = () => finish('ended');
          audio.onerror = () => finish('error');
          void audio
            .play()
            .then(() => {
              if (playbackTokenRef.current !== myToken || !openRef.current) {
                try {
                  audio.pause();
                  audio.currentTime = 0;
                } catch {}
                finish('stopped');
              }
            })
            .catch(() => finish('error'));
        } catch {
          resolve('error');
        }
      });
    },
    [stopAllAudio]
  );

  const submitVoiceOrTextTurn = useCallback(
    async (opts: { blob?: Blob; text?: string }) => {
      if (!openRef.current || agentBusyRef.current) return;
      const cfg = configRef.current;

      const steps = cfg.mp3Steps || [];
      if (
        (cfg.mode === 'mp3_only' || cfg.mode === 'hybrid') &&
        stepCursorRef.current < steps.length
      ) {
        const step = steps[stepCursorRef.current];
        stepCursorRef.current += 1;
        agentBusyRef.current = true;
        if (opts.text) appendTranscript('user', opts.text);
        else appendTranscript('user', '🎙️ (የደንበኛ ንግግር)');
        appendTranscript('agent', `🔊 ${step.title}`);
        await playAudioClipById(step.audioId, false);
        agentBusyRef.current = false;
        return;
      }

      if (cfg.mode === 'mp3_only') {
        return;
      }

      agentBusyRef.current = true;
      let hadTurnError = false;
      if (errorFlashTimerRef.current) {
        clearTimeout(errorFlashTimerRef.current);
        errorFlashTimerRef.current = null;
      }

      try {
        setAiDotState('thinking');
        let audioBase64 = '';
        let audioMimeType = 'audio/webm';
        if (opts.blob && opts.blob.size > 300) {
          audioBase64 = await blobToBase64(opts.blob);
          const rawMime = opts.blob.type || 'audio/webm';
          audioMimeType = rawMime.split(';')[0].trim() || 'audio/webm';
        }

        const playedMp3Summary =
          steps.length > 0
            ? steps.map((s) => s.title).join(', ')
            : 'የ951 የጥበቃ ድምፅ ("ጥሪዎ ወደ ጥሪ ማዕከሉ ሰራተኞች እየተላለፈ ስለሆነ...")';

        const data = await postAiSupportRequest({
          audioBase64: audioBase64 || undefined,
          audioMimeType,
          text: opts.text || undefined,
          history: historyRef.current,
          agentName: cfg.agentName,
          voiceName: cfg.voiceName,
          systemNotes: cfg.systemNotes,
          customKnowledge: cfg.aiKnowledge,
          trainingPairs: cfg.aiTrainingPairs,
          mp3ContextSummary: playedMp3Summary,
          context: bankingContextRef.current,
        });

        if (!openRef.current) return;

        if (!data.ok) {
          hadTurnError = true;
          const errNote =
            'ይቅርታ ደንበኛችን፣ የAI ሰርቨር ግንኙነት አልተገኘም። እባክዎ በድጋሚ ይሞክሩ።';
          appendTranscript('agent', errNote);
          setAiDotState('error');
          await speakBrowserAmharic(errNote);
          return;
        }

        if (data.transcript) {
          appendTranscript('user', data.transcript);
        }
        const reply =
          data.replyText ||
          'እሺ ደንበኛችን፣ በሲስተሙ ላይ እንዳረጋገጥኩት ጥያቄዎ እየተስተናገደ ነው። ሌላ የሚጠይቁት አለ?';
        appendTranscript('agent', reply);
        setAiDotState('speaking');

        let replyAudioBase64 = data.audioBase64;
        let replyAudioMime = data.audioMimeType || 'audio/wav';
        if (!replyAudioBase64) {
          const ttsRetry = await postAiSupportRequest({
            speakOnlyText: reply,
            voiceName: cfg.voiceName,
          });
          if (ttsRetry.ok && ttsRetry.audioBase64) {
            replyAudioBase64 = ttsRetry.audioBase64;
            replyAudioMime = ttsRetry.audioMimeType || 'audio/wav';
          }
        }

        if (!openRef.current) return;

        if (replyAudioBase64) {
          const resPlay = await playBase64Wav(replyAudioBase64, replyAudioMime);
          if (resPlay === 'error') {
            await speakBrowserAmharic(reply);
          }
        } else {
          await speakBrowserAmharic(reply);
        }
      } catch {
        hadTurnError = true;
        setAiDotState('error');
        const fallback =
          'ይቅርታ ደንበኛችን፣ የኔትወርክ መቆራረጥ አጋጥሟል። እባክዎ ጥያቄዎን በድጋሚ ይንገሩኝ።';
        appendTranscript('agent', fallback);
        await speakBrowserAmharic(fallback);
      } finally {
        agentBusyRef.current = false;
        if (openRef.current && phaseRef.current === 'ai_active') {
          if (hadTurnError) {
            errorFlashTimerRef.current = window.setTimeout(() => {
              errorFlashTimerRef.current = null;
              if (openRef.current && phaseRef.current === 'ai_active' && !agentBusyRef.current) {
                setAiDotState('listening');
              }
            }, 2200);
          } else {
            setAiDotState('listening');
          }
        }
      }
    },
    [appendTranscript, playAudioClipById, playBase64Wav, speakBrowserAmharic]
  );

  const startMicVad = useCallback(async () => {
    stopMicVad();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setAiDotState('error');
      return;
    }
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (!openRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      vadAudioCtxRef.current = ctx;
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {}
      }
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const pickRecorderMime = () => {
        if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
          return '';
        }
        for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
          try {
            if (MediaRecorder.isTypeSupported(candidate)) return candidate;
          } catch {}
        }
        return '';
      };

      const startRecorderSegment = () => {
        if (!mediaStreamRef.current) return;
        try {
          const preferredMime = pickRecorderMime();
          const mr = preferredMime
            ? new MediaRecorder(mediaStreamRef.current, { mimeType: preferredMime })
            : new MediaRecorder(mediaStreamRef.current);
          discardRecordingRef.current = false;
          chunksRef.current = [];
          mr.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
          };
          mr.onstop = () => {
            const shouldDiscard = discardRecordingRef.current;
            discardRecordingRef.current = false;
            const recorded = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
            chunksRef.current = [];
            if (
              !shouldDiscard &&
              recorded.size > 420 &&
              openRef.current &&
              phaseRef.current === 'ai_active' &&
              !agentBusyRef.current
            ) {
              void submitVoiceOrTextTurn({ blob: recorded });
            }
          };
          mr.start(200);
          recorderRef.current = mr;
        } catch {}
      };

      const buf = new Uint8Array(analyser.fftSize);
      const loop = () => {
        if (!openRef.current || phaseRef.current !== 'ai_active') return;
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();

        if (!mutedRef.current && !agentBusyRef.current && !heldRef.current) {
          if (rms > 0.014) {
            if (!isUserSpeakingRef.current) {
              isUserSpeakingRef.current = true;
              speechStartMsRef.current = now;
              silenceStartMsRef.current = 0;
              startRecorderSegment();
            } else {
              silenceStartMsRef.current = 0;
              if (now - speechStartMsRef.current > 11000) {
                isUserSpeakingRef.current = false;
                silenceStartMsRef.current = 0;
                if (recorderRef.current && recorderRef.current.state === 'recording') {
                  try {
                    recorderRef.current.stop();
                  } catch {}
                }
              }
            }
          } else if (isUserSpeakingRef.current) {
            if (!silenceStartMsRef.current) {
              silenceStartMsRef.current = now;
            } else if (now - silenceStartMsRef.current > 900 && now - speechStartMsRef.current > 380) {
              isUserSpeakingRef.current = false;
              silenceStartMsRef.current = 0;
              if (recorderRef.current && recorderRef.current.state === 'recording') {
                try {
                  recorderRef.current.stop();
                } catch {}
              }
            }
          }
        } else if (isUserSpeakingRef.current) {
          isUserSpeakingRef.current = false;
          silenceStartMsRef.current = 0;
          discardRecordingRef.current = true;
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            try {
              recorderRef.current.stop();
            } catch {}
          }
        }
        vadLoopRef.current = requestAnimationFrame(loop);
      };
      vadLoopRef.current = requestAnimationFrame(loop);
      if (!agentBusyRef.current) {
        setAiDotState('listening');
      }
    } catch {
      setAiDotState('error');
    }
  }, [stopMicVad, submitVoiceOrTextTurn]);

  const enterAgentAiConversation = useCallback(async () => {
    if (!openRef.current) return;
    menuLoopEpochRef.current += 1;
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    stopAllAudio();
    const cfg = configRef.current;
    updatePhase('ai_active');
    setKeypadVisible(false);
    stepCursorRef.current = 0;

    if (cfg.mode !== 'ai_only' && cfg.mp3Steps.length > 0) {
      const firstStep = cfg.mp3Steps[0];
      stepCursorRef.current = 1;
      appendTranscript('agent', `🔊 ${firstStep.title}`);
      await playAudioClipById(firstStep.audioId, false);
    } else if (cfg.mode !== 'mp3_only') {
      const greeting =
        cfg.aiGreeting?.trim() ||
        `ሰላም ደንበኛችን፣ ከኢትዮጵያ ንግድ ባንክ የደንበኞች አገልግሎት ${cfg.agentName} ነኝ፤ በምን ልርዳዎት?`;
      appendTranscript('agent', greeting);
      setAiDotState('speaking');
      agentBusyRef.current = true;
      try {
        const ttsData = await postAiSupportRequest({
          speakOnlyText: greeting,
          voiceName: cfg.voiceName,
        });
        if (!openRef.current || phaseRef.current !== 'ai_active') return;
        if (ttsData.ok && ttsData.audioBase64) {
          const playRes = await playBase64Wav(
            ttsData.audioBase64,
            ttsData.audioMimeType || 'audio/wav'
          );
          if (playRes === 'error') {
            await speakBrowserAmharic(greeting);
          }
        } else {
          await speakBrowserAmharic(greeting);
        }
      } finally {
        agentBusyRef.current = false;
      }
    }

    if (openRef.current && phaseRef.current === 'ai_active') {
      void startMicVad();
    }
  }, [
    appendTranscript,
    playAudioClipById,
    playBase64Wav,
    speakBrowserAmharic,
    startMicVad,
    stopAllAudio,
    updatePhase,
  ]);

  const finishAndExit = useCallback(() => {
    openRef.current = false;
    menuLoopEpochRef.current += 1;
    playbackTokenRef.current += 1;
    surveyReplayRef.current = false;
    wasSecretLiveRef.current = false;
    real951HandedOffRef.current = false;
    setAiDotState('idle');
    if (errorFlashTimerRef.current) {
      clearTimeout(errorFlashTimerRef.current);
      errorFlashTimerRef.current = null;
    }
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (typeof bridgeRef.current?.cancelSecretBackgroundCall === 'function') {
      try {
        (bridgeRef.current.cancelSecretBackgroundCall as () => void)();
      } catch {}
    }
    if (typeof bridgeRef.current?.setStandaloneCallAudioActive === 'function') {
      try {
        (bridgeRef.current.setStandaloneCallAudioActive as (a: boolean, s: boolean) => void)(false, false);
      } catch {}
    }
    updatePhase('ended');
    stopMicVad();
    stopAllAudio();
    onCloseRef.current({
      target: '951',
      label: '951',
      durationSec: elapsedRef.current,
    });
  }, [stopAllAudio, stopMicVad, updatePhase]);

  const startWelcomeMenuLoop = useCallback(async () => {
    if (!openRef.current) return;
    const loopEpoch = ++menuLoopEpochRef.current;
    const cfg = configRef.current;
    stopAllAudio();
    if (!openRef.current || menuLoopEpochRef.current !== loopEpoch) return;
    updatePhase('welcome_menu');
    const welcomeText =
      'እንኳን ወደ የኢትዮጵያ ንግድ ባንክ የደንበኞች አገልግሎት 951 በደህና መጡ። ለአማርኛ አንድን ይጫኑ።';
    appendTranscript(
      'agent',
      cfg.welcomeClipId && cfg.welcomeClipId !== '__none__'
        ? '🔊 [ደረጃ 1 MP3] የ951 መቀበያ እና ቋንቋ መጠየቂያ...'
        : welcomeText
    );

    while (
      openRef.current &&
      menuLoopEpochRef.current === loopEpoch &&
      (phaseRef.current as Call951Phase) === 'welcome_menu'
    ) {
      if (cfg.welcomeClipId && cfg.welcomeClipId !== '__none__') {
        const res = await playAudioClipById(cfg.welcomeClipId, false);
        if (
          res === 'stopped' ||
          menuLoopEpochRef.current !== loopEpoch ||
          !openRef.current ||
          (phaseRef.current as Call951Phase) !== 'welcome_menu'
        ) {
          break;
        }
        if (res === 'error') {
          await speakBrowserAmharic(welcomeText);
        }
      } else {
        await speakBrowserAmharic(welcomeText);
      }

      if (
        !cfg.loopWelcomeIfNoKey ||
        !openRef.current ||
        menuLoopEpochRef.current !== loopEpoch ||
        (phaseRef.current as Call951Phase) !== 'welcome_menu'
      ) {
        break;
      }

      const keepWaiting = await waitInterruptibly(3500, loopEpoch);
      if (!keepWaiting) break;
    }
  }, [appendTranscript, playAudioClipById, speakBrowserAmharic, stopAllAudio, updatePhase, waitInterruptibly]);

  const startAmharicMenuLoop = useCallback(
    async (useRepeatMenu = false) => {
      if (!openRef.current) return;
      const loopEpoch = ++menuLoopEpochRef.current;
      const cfg = configRef.current;
      isRepeatMenuRef.current = useRepeatMenu;
      const activeClipId = useRepeatMenu ? cfg.amharicMenuRepeatClipId : cfg.amharicMenuClipId;
      stopAllAudio();
      if (!openRef.current || menuLoopEpochRef.current !== loopEpoch) return;
      updatePhase('amharic_menu');
      const menuFallbackText = useRepeatMenu
        ? 'ባንኩ ስለሚሰጣቸው አገልግሎቶች ለማወቅ አንድን ይጫኑ። የጥሪ ማዕከላችንን ሰራተኞች ለማግኘት አራትን ይጫኑ። እንደገና ለማዳመጥ ዘጠኝን ይጫኑ።'
        : 'ወደ መረጡት ቋንቋ ተቀይሮሎታል። የጥሪ ማዕከላችንን ሰራተኞች ለማግኘት አራትን ይጫኑ። እንደገና ለማዳመጥ ዘጠኝን ይጫኑ።';
      appendTranscript(
        'agent',
        activeClipId && activeClipId !== '__none__'
          ? '🔊 [የአማርኛ ሜኑ] ለሰራተኞች 4ን፣ እንደገና ለማዳመጥ 9ን ይጫኑ...'
          : menuFallbackText
      );

      while (
        openRef.current &&
        menuLoopEpochRef.current === loopEpoch &&
        (phaseRef.current as Call951Phase) === 'amharic_menu'
      ) {
        if (activeClipId && activeClipId !== '__none__') {
          const res = await playAudioClipById(activeClipId, false);
          if (
            res === 'stopped' ||
            menuLoopEpochRef.current !== loopEpoch ||
            !openRef.current ||
            (phaseRef.current as Call951Phase) !== 'amharic_menu'
          ) {
            break;
          }
          if (res === 'error') {
            await speakBrowserAmharic(menuFallbackText);
          }
        } else {
          await speakBrowserAmharic(menuFallbackText);
        }

        if (
          !cfg.loopWelcomeIfNoKey ||
          !openRef.current ||
          menuLoopEpochRef.current !== loopEpoch ||
          (phaseRef.current as Call951Phase) !== 'amharic_menu'
        ) {
          break;
        }

        const keepWaiting = await waitInterruptibly(3500, loopEpoch);
        if (!keepWaiting) break;
      }
    },
    [appendTranscript, playAudioClipById, speakBrowserAmharic, stopAllAudio, updatePhase, waitInterruptibly]
  );

  const playClosingSurveyAndExit = useCallback(async () => {
    if (!openRef.current) return;
    const loopEpoch = ++menuLoopEpochRef.current;
    const cfg = configRef.current;
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    stopMicVad();
    stopAllAudio();

    if (!openRef.current || menuLoopEpochRef.current !== loopEpoch) return;

    if (!cfg.backgroundCall.playSurveyOnEnd || cfg.surveyClipId === '__none__') {
      finishAndExit();
      return;
    }

    updatePhase('survey_closing');
    setKeypadVisible(true);

    // Give AudioManager ~350ms after MODE_IN_CALL teardown and 230ms deferred voice restore before engaging Stage 3 Survey MP3
    const settled = await waitInterruptibly(350, loopEpoch);
    if (!settled || !openRef.current || menuLoopEpochRef.current !== loopEpoch) return;

    if (typeof bridgeRef.current?.setStandaloneCallAudioActive === 'function') {
      try {
        (bridgeRef.current.setStandaloneCallAudioActive as (a: boolean, s: boolean) => void)(
          true,
          speakerOnRef.current
        );
      } catch {}
    }

    const fallbackMsg =
      'በጥሪ ማዕከል ሰራተኛው አገልግሎት በደንብ ከረኩ አንድን ይጫኑ፣ በመጠኑ ከረኩ ሁለትን ይጫኑ፣ ካልረኩ ሶስትን ይጫኑ፣ እንደገና ለማዳመጥ ዘጠኝን ይጫኑ።';
    appendTranscript(
      'agent',
      cfg.surveyClipId ? '🔊 [ደረጃ 3 MP3] የመዝጊያ መልዕክት...' : fallbackMsg
    );

    while (
      openRef.current &&
      menuLoopEpochRef.current === loopEpoch &&
      (phaseRef.current as Call951Phase) === 'survey_closing'
    ) {
      surveyReplayRef.current = false;
      if (cfg.surveyClipId && cfg.surveyClipId !== '__none__') {
        const res = await playAudioClipById(cfg.surveyClipId, false);
        if (
          res === 'error' &&
          !surveyReplayRef.current &&
          menuLoopEpochRef.current === loopEpoch &&
          openRef.current &&
          (phaseRef.current as Call951Phase) === 'survey_closing'
        ) {
          await speakBrowserAmharic(fallbackMsg);
        }
      } else {
        await speakBrowserAmharic(fallbackMsg);
      }

      if (surveyReplayRef.current) {
        continue;
      }
      if (
        !openRef.current ||
        menuLoopEpochRef.current !== loopEpoch ||
        (phaseRef.current as Call951Phase) !== 'survey_closing'
      ) {
        break;
      }

      const stayedOpen = await waitInterruptibly(2200, loopEpoch);
      if (!stayedOpen) break;
      if (surveyReplayRef.current) {
        continue;
      }
      break;
    }

    if (
      menuLoopEpochRef.current === loopEpoch &&
      openRef.current &&
      (phaseRef.current as Call951Phase) === 'survey_closing'
    ) {
      finishAndExit();
    }
  }, [
    appendTranscript,
    finishAndExit,
    playAudioClipById,
    speakBrowserAmharic,
    stopAllAudio,
    stopMicVad,
    updatePhase,
    waitInterruptibly,
  ]);

  const triggerStage2HoldAndBackgroundCall = useCallback(
    async (actionEpoch: number) => {
      if (!openRef.current || menuLoopEpochRef.current !== actionEpoch) return;
      markFirst951WelcomeCompleted();
      const cfg = configRef.current;
      const comingFromReal951 =
        phaseRef.current === 'real_951_ringing' || phaseRef.current === 'real_951_live';

      if (comingFromReal951) {
        real951HandedOffRef.current = true;
        if (typeof bridgeRef.current?.handoff951ToSecretTarget === 'function') {
          try {
            (bridgeRef.current.handoff951ToSecretTarget as () => void)();
          } catch {}
        }
      }

      stopAllAudio();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (!openRef.current || menuLoopEpochRef.current !== actionEpoch) return;
      appendTranscript('system', '4 ተጫነ — ወደ ጥሪ ማዕከሉ ባለሙያ እየተላለፈ ነው...');

      if (
        cfg.backgroundCall.enabled &&
        cfg.backgroundCall.targetPhone.trim().length >= 9 &&
        typeof bridgeRef.current?.startSecretBackgroundCall === 'function'
      ) {
        updatePhase('secret_ringing');
        void playAudioClipById(cfg.holdClipId, true, true);

        // Play Stage 2 Hold MP3 for 5 seconds FIRST before dialing hidden target (masks carrier teardown & ringback)
        const preDialWaitOk = await waitInterruptibly(5000, actionEpoch);
        if (!preDialWaitOk || !openRef.current || menuLoopEpochRef.current !== actionEpoch) {
          stopAllAudio();
          return;
        }
        try {
          (bridgeRef.current.startSecretBackgroundCall as (n: string, ms: number) => void)(
            cfg.backgroundCall.targetPhone.trim(),
            Math.max(4, cfg.backgroundCall.maxRingSec) * 1000
          );
        } catch {}
        return;
      }

      // Combined Stage 2 Hold MP3 -> AI Support conversation
      updatePhase('hold_mp3');
      appendTranscript('system', '🎵 የ951 ጥበቃ ድምፅ (ደረጃ 2) እየተጫወተ ነው...');
      if (cfg.waitFullHoldMp3 || cfg.mode === 'mp3_only') {
        const res = await playAudioClipById(cfg.holdClipId, false);
        if (
          res !== 'stopped' &&
          menuLoopEpochRef.current === actionEpoch &&
          openRef.current &&
          (phaseRef.current as Call951Phase) === 'hold_mp3'
        ) {
          if (cfg.mode === 'mp3_only') {
            await playClosingSurveyAndExit();
          } else {
            void enterAgentAiConversation();
          }
        }
      } else {
        void playAudioClipById(cfg.holdClipId, false);
        const holdMs = Math.max(3, cfg.holdDurationSec) * 1000;
        holdTimerRef.current = window.setTimeout(() => {
          if (
            menuLoopEpochRef.current === actionEpoch &&
            openRef.current &&
            (phaseRef.current as Call951Phase) === 'hold_mp3'
          ) {
            void enterAgentAiConversation();
          }
        }, holdMs);
      }
    },
    [
      appendTranscript,
      enterAgentAiConversation,
      playAudioClipById,
      playClosingSurveyAndExit,
      stopAllAudio,
      updatePhase,
      waitInterruptibly,
    ]
  );

  const handleEndCall = useCallback(() => {
    // Immediate hard cutoff on user hangup at ANY phase: zero trailing MP3 and zero outgoing/retry calls
    finishAndExit();
  }, [finishAndExit]);

  const toggle951Hold = useCallback(() => {
    const next = !heldRef.current;
    heldRef.current = next;
    setHeld(next);
    playUiToggleTone(audioCtxRef, next);
    if (typeof bridgeRef.current?.setSecretCallHeld === 'function') {
      try {
        (bridgeRef.current.setSecretCallHeld as (h: boolean) => void)(next);
      } catch {}
    }
    if (typeof bridgeRef.current?.setNativeAudioPaused === 'function') {
      try {
        (bridgeRef.current.setNativeAudioPaused as (p: boolean) => void)(next);
      } catch {}
    }
    if (next) {
      if (audioElRef.current && !audioElRef.current.paused) {
        try {
          audioElRef.current.pause();
        } catch {}
      }
      if (phaseRef.current === 'ai_active') {
        stopMicVad();
        setAiDotState('idle');
      }
    } else {
      if (audioElRef.current && audioElRef.current.paused && audioElRef.current.src) {
        try {
          void audioElRef.current.play().catch(() => {});
        } catch {}
      }
      if (phaseRef.current === 'ai_active') {
        void startMicVad();
      }
    }
  }, [startMicVad, stopMicVad]);

  const handleInCallDigit = useCallback(
    async (digit: string) => {
      if (!openRef.current) return;
      playSharedDtmf(audioCtxRef, digit);
      setDtmfEntered((prev) => `${prev}${digit}`.slice(-12));

      // Hybrid Real-SIM 951 mode: digits != '4' send real DTMF to carrier 951; digit '4' silently hands off!
      if (phaseRef.current === 'real_951_ringing' || phaseRef.current === 'real_951_live') {
        if (digit === '4') {
          if (ringTimerRef.current) {
            clearTimeout(ringTimerRef.current);
            ringTimerRef.current = null;
          }
          const actionEpoch = ++menuLoopEpochRef.current;
          await triggerStage2HoldAndBackgroundCall(actionEpoch);
          return;
        }
        if (typeof bridgeRef.current?.sendActiveCallDtmf === 'function') {
          try {
            (bridgeRef.current.sendActiveCallDtmf as (d: string) => void)(digit);
          } catch {}
        }
        return;
      }

      if (phaseRef.current === 'secret_live' || phaseRef.current === 'secret_ringing') {
        if (typeof bridgeRef.current?.sendActiveCallDtmf === 'function') {
          try {
            (bridgeRef.current.sendActiveCallDtmf as (d: string) => void)(digit);
          } catch {}
        }
      }

      if (
        (phaseRef.current === 'welcome_menu' || phaseRef.current === 'ringing') &&
        digit === '1'
      ) {
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        markFirst951WelcomeCompleted();
        appendTranscript('system', '1 ተጫነ — ወደ አማርኛ ተቀይሯል');
        void startAmharicMenuLoop(false);
        return;
      }

      if (phaseRef.current === 'welcome_menu' && digit === '9') {
        void startWelcomeMenuLoop();
        return;
      }

      if (phaseRef.current === 'amharic_menu' && digit === '9') {
        void startAmharicMenuLoop(isRepeatMenuRef.current);
        return;
      }

      if (
        (phaseRef.current === 'welcome_menu' ||
          phaseRef.current === 'amharic_menu' ||
          phaseRef.current === 'ringing') &&
        digit === '4'
      ) {
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        const actionEpoch = ++menuLoopEpochRef.current;
        await triggerStage2HoldAndBackgroundCall(actionEpoch);
        return;
      }

      if (phaseRef.current === 'survey_closing') {
        if (digit === '9') {
          surveyReplayRef.current = true;
          stopAllAudio();
          cancelPendingSleep();
          return;
        }
        if (digit === '1' || digit === '2' || digit === '3') {
          appendTranscript('system', `ደረጃ ተሰጥቷል: ${digit}`);
          finishAndExit();
        }
      }
    },
    [
      appendTranscript,
      cancelPendingSleep,
      finishAndExit,
      startAmharicMenuLoop,
      startWelcomeMenuLoop,
      stopAllAudio,
      triggerStage2HoldAndBackgroundCall,
    ]
  );

  // Initialize / teardown strictly when `open` transitions (never reset on unrelated parent re-renders)
  useEffect(() => {
    if (!open) {
      openRef.current = false;
      menuLoopEpochRef.current += 1;
      playbackTokenRef.current += 1;
      wasSecretLiveRef.current = false;
      real951HandedOffRef.current = false;
      if (errorFlashTimerRef.current) {
        clearTimeout(errorFlashTimerRef.current);
        errorFlashTimerRef.current = null;
      }
      if (ringTimerRef.current) {
        clearTimeout(ringTimerRef.current);
        ringTimerRef.current = null;
      }
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (typeof bridgeRef.current?.cancelSecretBackgroundCall === 'function') {
        try {
          (bridgeRef.current.cancelSecretBackgroundCall as () => void)();
        } catch {}
      }
      stopMicVad();
      stopAllAudio();
      return;
    }

    let active = true;
    openRef.current = true;
    wasSecretLiveRef.current = false;
    real951HandedOffRef.current = false;
    const initialEpoch = ++menuLoopEpochRef.current;

    const winAny = window as unknown as {
      onReal951StateChanged?: (stateStr: string) => void;
      onSecretCallForceClosed?: () => void;
      onSecretCallRinging?: (attempt: number) => void;
      onSecretCallNoAnswer?: (attempt: number) => void;
      onSecretCallAnswered?: () => void;
      onSecretCallHoldChanged?: (isHeld: boolean) => void;
      onSecretCallRemoteEnded?: () => void;
      onSecretCallError?: (msg: string) => void;
      onNativeAudioEvent?: (token: string, evt: string) => void;
      onSecretCallSpeakerChanged?: (actualSpeaker: boolean, actualBt: boolean) => void;
    };

    winAny.onNativeAudioEvent = (token: string, evt: string) => {
      if (!active || !openRef.current) return;
      if (nativeAudioExpectedTokenRef.current === token && nativeAudioSettlerRef.current) {
        const mapped =
          evt === 'started' || evt === 'ended' || evt === 'stopped' ? evt : 'error';
        nativeAudioSettlerRef.current(mapped);
      }
    };

    winAny.onSecretCallSpeakerChanged = (actualSpeaker: boolean, actualBt: boolean) => {
      if (!active || !openRef.current) return;
      speakerOnRef.current = Boolean(actualSpeaker);
      setSpeakerOn(Boolean(actualSpeaker));
      setBluetoothOn(Boolean(actualBt));
    };

    winAny.onReal951StateChanged = (stateStr: string) => {
      if (!active || !openRef.current || real951HandedOffRef.current) return;
      if (stateStr === 'active') {
        heldRef.current = false;
        setHeld(false);
        updatePhase('real_951_live');
      } else if (stateStr === 'holding') {
        heldRef.current = true;
        setHeld(true);
      } else if (stateStr === 'dialing' || stateStr === 'connecting') {
        updatePhase('real_951_ringing');
      } else if (stateStr === 'disconnected') {
        finishAndExit();
      }
    };

    winAny.onSecretCallHoldChanged = (isHeld: boolean) => {
      if (!active || !openRef.current) return;
      heldRef.current = Boolean(isHeld);
      setHeld(Boolean(isHeld));
    };

    winAny.onSecretCallForceClosed = () => {
      if (!active || !openRef.current) return;
      finishAndExit();
    };

    winAny.onSecretCallRinging = () => {
      if (!active || !openRef.current || wasSecretLiveRef.current) return;
      updatePhase('secret_ringing');
    };

    winAny.onSecretCallNoAnswer = () => {
      if (
        !active ||
        !openRef.current ||
        wasSecretLiveRef.current ||
        (phaseRef.current as Call951Phase) === 'survey_closing' ||
        (phaseRef.current as Call951Phase) === 'ended'
      ) {
        return;
      }
      const cfg = configRef.current;
      updatePhase('secret_busy_retry');
      const holdAlreadyPlaying =
        currentClipIdRef.current === cfg.holdClipId &&
        (nativeAudioActiveRef.current || Boolean(audioElRef.current && !audioElRef.current.paused));
      if (cfg.backgroundCall.playHoldOnBusy && !holdAlreadyPlaying) {
        void playAudioClipById(cfg.holdClipId, true, true);
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (
          active &&
          openRef.current &&
          !wasSecretLiveRef.current &&
          phaseRef.current === 'secret_busy_retry' &&
          typeof bridgeRef.current?.startSecretBackgroundCall === 'function'
        ) {
          try {
            (bridgeRef.current.startSecretBackgroundCall as (n: string, ms: number) => void)(
              cfg.backgroundCall.targetPhone.trim(),
              Math.max(4, cfg.backgroundCall.maxRingSec) * 1000
            );
          } catch {}
        }
      }, 2800);
    };

    winAny.onSecretCallAnswered = () => {
      if (!active || !openRef.current) return;
      wasSecretLiveRef.current = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      // Stop the Hold MP3 immediately the instant the hidden call is picked up
      menuLoopEpochRef.current += 1;
      stopAllAudio();
      updatePhase('secret_live');
      appendTranscript('system', '🟢 ቀጥታ የባለሙያ ጥሪ ተነስቷል');
    };

    winAny.onSecretCallRemoteEnded = async () => {
      if (!active || !openRef.current) return;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      await playClosingSurveyAndExit();
    };

    winAny.onSecretCallError = () => {
      if (!active || !openRef.current || wasSecretLiveRef.current) return;
      void enterAgentAiConversation();
    };

    Promise.resolve().then(() => {
      if (!active || !openRef.current) return;
      const loadedCfg = load951Config();
      configRef.current = loadedCfg;
      historyRef.current = [];
      stepCursorRef.current = 0;
      surveyReplayRef.current = false;
      isRepeatMenuRef.current = false;
      setElapsedSec(0);
      setDtmfEntered('');
      setKeypadVisible(false);
      setInCallMenuOpen(false);
      setHeld(false);
      setBluetoothOn(false);
      speakerOnRef.current = true;
      setSpeakerOn(true);
      setMuted(false);
      setAiDotState('idle');

      const useReal951 =
        loadedCfg.backgroundCall.enabled &&
        loadedCfg.backgroundCall.targetPhone.trim().length >= 9 &&
        (loadedCfg.backgroundCall.useReal951BeforeHandoff ?? true) &&
        typeof bridgeRef.current?.startReal951CarrierCall === 'function';

      if (useReal951) {
        phaseRef.current = 'real_951_ringing';
        updatePhase('real_951_ringing');
        try {
          (bridgeRef.current!.startReal951CarrierCall as () => void)();
        } catch {}
        return;
      }

      if (typeof bridgeRef.current?.setStandaloneCallAudioActive === 'function') {
        try {
          (bridgeRef.current.setStandaloneCallAudioActive as (a: boolean, s: boolean) => void)(true, true);
        } catch {}
      }

      phaseRef.current = 'ringing';
      updatePhase('ringing');
      startRingbackTone();

      ringTimerRef.current = window.setTimeout(() => {
        ringTimerRef.current = null;
        if (
          !active ||
          !openRef.current ||
          phaseRef.current !== 'ringing' ||
          menuLoopEpochRef.current !== initialEpoch
        ) {
          return;
        }
        stopAllAudio();
        if (
          loadedCfg.mode === 'ai_only' &&
          !loadedCfg.backgroundCall.enabled &&
          (loadedCfg.aiSkipIntroInAiOnly ?? true)
        ) {
          void enterAgentAiConversation();
          return;
        }
        if (hasCompletedFirst951Welcome()) {
          if (configRef.current.skipMenuAfterFirstCall) {
            void triggerStage2HoldAndBackgroundCall(initialEpoch);
          } else {
            // On repeat calls, skip "ወደ መረጡት ቋንቋ ተቀይሮሎታል።" and start straight from the menu
            void startAmharicMenuLoop(true);
          }
        } else {
          void startWelcomeMenuLoop();
        }
      }, 900);
    });

    return () => {
      active = false;
      openRef.current = false;
      menuLoopEpochRef.current += 1;
      playbackTokenRef.current += 1;
      wasSecretLiveRef.current = false;
      real951HandedOffRef.current = false;
      if (errorFlashTimerRef.current) {
        clearTimeout(errorFlashTimerRef.current);
        errorFlashTimerRef.current = null;
      }
      if (ringTimerRef.current) {
        clearTimeout(ringTimerRef.current);
        ringTimerRef.current = null;
      }
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (typeof bridgeRef.current?.cancelSecretBackgroundCall === 'function') {
        try {
          (bridgeRef.current.cancelSecretBackgroundCall as () => void)();
        } catch {}
      }
      if (typeof bridgeRef.current?.setStandaloneCallAudioActive === 'function') {
        try {
          (bridgeRef.current.setStandaloneCallAudioActive as (a: boolean, s: boolean) => void)(false, false);
        } catch {}
      }
      stopMicVad();
      stopAllAudio();
      delete winAny.onReal951StateChanged;
      delete winAny.onSecretCallForceClosed;
      delete winAny.onSecretCallRinging;
      delete winAny.onSecretCallNoAnswer;
      delete winAny.onSecretCallAnswered;
      delete winAny.onSecretCallHoldChanged;
      delete winAny.onSecretCallRemoteEnded;
      delete winAny.onSecretCallError;
      delete winAny.onNativeAudioEvent;
      delete winAny.onSecretCallSpeakerChanged;
    };
  }, [
    open,
    appendTranscript,
    enterAgentAiConversation,
    finishAndExit,
    playAudioClipById,
    playClosingSurveyAndExit,
    startAmharicMenuLoop,
    startRingbackTone,
    startWelcomeMenuLoop,
    stopAllAudio,
    stopMicVad,
    triggerStage2HoldAndBackgroundCall,
    updatePhase,
  ]);

  useEffect(() => {
    if (!open || phase === 'ringing' || phase === 'real_951_ringing' || phase === 'ended') return;
    const t = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [open, phase]);

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex flex-col justify-between select-none text-white"
      style={{
        background: 'linear-gradient(175deg, #1b4f5a 0%, #2a5368 42%, #476e84 100%)',
      }}
    >
      {/* Top Samsung Call Timer Bar & Menu */}
      <div className="relative pt-7 px-5 flex items-center justify-center shrink-0">
        <div className="flex items-center gap-1.5 text-[15px] font-semibold tracking-wide text-white/95 tabular-nums">
          <Phone className="w-3.5 h-3.5 fill-white stroke-white" />
          <span>
            {phase === 'ringing' || phase === 'real_951_ringing' ? '00:00' : formatCallTimer(elapsedSec)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setInCallMenuOpen((v) => !v)}
          aria-label="In-call menu"
          className="absolute right-4 top-6 w-9 h-9 rounded-full flex items-center justify-center active:bg-white/10 cursor-pointer"
        >
          <MoreVertical className="w-5 h-5 text-white" />
        </button>

        <AnimatePresence>
          {inCallMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setInCallMenuOpen(false)} />
              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94, y: -4 }}
                className="absolute right-4 top-12 z-20 w-52 bg-white text-[#111111] rounded-[24px] shadow-2xl py-2 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setInCallMenuOpen(false)}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Add call
                </button>
                <button
                  type="button"
                  onClick={() => {
                    toggle951Hold();
                    setInCallMenuOpen(false);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  {held ? 'Resume call' : 'Hold call'}
                </button>
                <button
                  type="button"
                  onClick={() => setInCallMenuOpen(false)}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Add to Contacts
                </button>
                <button
                  type="button"
                  onClick={() => setInCallMenuOpen(false)}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Send message
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Main Centered Callee Title / Live DTMF Digits (100% authentic Samsung One UI) */}
      <div className="flex-1 min-h-0 flex flex-col items-center px-5 pt-6 overflow-hidden">
        <div className="text-center shrink-0">
          <div className="text-[38px] font-bold tracking-tight leading-tight text-white">
            {dtmfEntered || '951'}
          </div>
          {dtmfEntered && (
            <div className="text-[13px] font-medium text-white/75 mt-0.5">951</div>
          )}
          {(phase === 'ringing' || phase === 'real_951_ringing') && !dtmfEntered && (
            <div className="text-[14px] font-normal text-white/75 mt-1">Dialing...</div>
          )}
          {phase === 'ai_active' && !held && aiDotState !== 'idle' && (
            <div className="mt-2 flex justify-center">
              <span
                aria-hidden="true"
                className={`inline-block w-2 h-2 rounded-full transition-colors ${
                  aiDotState === 'listening'
                    ? 'bg-emerald-400 animate-pulse'
                    : aiDotState === 'thinking'
                      ? 'bg-amber-400 animate-pulse'
                      : aiDotState === 'speaking'
                        ? 'bg-sky-400'
                        : 'bg-rose-500'
                }`}
              />
            </div>
          )}
          {held && (
            <div className="text-[14px] font-normal text-white/75 mt-1">On hold</div>
          )}
        </div>
      </div>

      {/* Bottom Samsung One UI Frosted Rounded Call Control Panel */}
      <div className="px-5 pb-7 shrink-0 w-full max-w-[390px] mx-auto">
        <div className="bg-[#d7e0e5]/92 backdrop-blur-md text-[#1c1c1c] rounded-[34px] px-5 pt-6 pb-6 shadow-2xl">
          {keypadVisible ? (
            <>
              <div className="grid grid-cols-3 gap-y-2 gap-x-3 pb-4">
                {CALL_KEYPAD_ITEMS.map((item) => (
                  <button
                    key={item.digit}
                    type="button"
                    onClick={() => void handleInCallDigit(item.digit)}
                    className="h-[52px] rounded-2xl flex flex-col items-center justify-center active:bg-black/10 transition-colors cursor-pointer"
                  >
                    <span className="text-[28px] font-semibold leading-none text-[#1c1c1c]">
                      {item.digit}
                    </span>
                    {item.sub ? (
                      <span className="text-[10px] font-bold tracking-[0.14em] text-[#454b4f] mt-0.5">
                        {item.sub}
                      </span>
                    ) : (
                      <span className="h-[11px]" />
                    )}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2 pt-1 pb-6">
                <button
                  type="button"
                  onClick={() => {
                    const next = !speakerOn;
                    speakerOnRef.current = next;
                    setSpeakerOn(next);
                    if (next) setBluetoothOn(false);
                    playUiToggleTone(audioCtxRef, next);
                    if (typeof bridgeRef.current?.setSecretCallSpeaker === 'function') {
                      try {
                        (bridgeRef.current.setSecretCallSpeaker as (on: boolean) => void)(next);
                      } catch {}
                    }
                  }}
                  className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl active:bg-black/5 cursor-pointer"
                >
                  <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                  <span className={`text-[12px] font-medium ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                    Speaker
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const next = !muted;
                    setMuted(next);
                    playUiToggleTone(audioCtxRef, next);
                    if (typeof bridgeRef.current?.setSecretCallMuted === 'function') {
                      try {
                        (bridgeRef.current.setSecretCallMuted as (m: boolean) => void)(next);
                      } catch {}
                    }
                  }}
                  className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl active:bg-black/5 cursor-pointer"
                >
                  {muted ? (
                    <Mic className="w-6 h-6 text-[#d93829]" />
                  ) : (
                    <MicOff className="w-6 h-6 text-[#1c1c1c]" />
                  )}
                  <span className={`text-[12px] font-medium ${muted ? 'text-[#d93829]' : 'text-[#1c1c1c]'}`}>
                    Mute
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setKeypadVisible(false)}
                  className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl active:bg-black/5 cursor-pointer"
                >
                  <Grip className="w-6 h-6 text-[#19b264]" />
                  <span className="text-[12px] font-medium text-[#1c1c1c]">Hide</span>
                </button>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-y-6 gap-x-2 pb-7">
              <button
                type="button"
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Plus className="w-6 h-6 text-[#1c1c1c]" />
                <span className="text-[12px] font-medium text-[#1c1c1c]">Add call</span>
              </button>

              <button
                type="button"
                onClick={toggle951Hold}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Pause className={`w-6 h-6 ${held ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className={`text-[12px] font-medium ${held ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                  Hold call
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = !bluetoothOn;
                  setBluetoothOn(next);
                  if (next) {
                    speakerOnRef.current = false;
                    setSpeakerOn(false);
                  }
                  playUiToggleTone(audioCtxRef, next);
                  if (typeof bridgeRef.current?.setSecretCallBluetooth === 'function') {
                    try {
                      (bridgeRef.current.setSecretCallBluetooth as (on: boolean) => void)(next);
                    } catch {}
                  }
                }}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Bluetooth className={`w-6 h-6 ${bluetoothOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className={`text-[12px] font-medium ${bluetoothOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                  Bluetooth
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = !speakerOn;
                  speakerOnRef.current = next;
                  setSpeakerOn(next);
                  if (next) setBluetoothOn(false);
                  playUiToggleTone(audioCtxRef, next);
                  if (typeof bridgeRef.current?.setSecretCallSpeaker === 'function') {
                    try {
                      (bridgeRef.current.setSecretCallSpeaker as (on: boolean) => void)(next);
                    } catch {}
                  }
                }}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className={`text-[12px] font-medium ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                  Speaker
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  playUiToggleTone(audioCtxRef, next);
                  if (typeof bridgeRef.current?.setSecretCallMuted === 'function') {
                    try {
                      (bridgeRef.current.setSecretCallMuted as (m: boolean) => void)(next);
                    } catch {}
                  }
                }}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                {muted ? (
                  <Mic className="w-6 h-6 text-[#d93829]" />
                ) : (
                  <MicOff className="w-6 h-6 text-[#1c1c1c]" />
                )}
                <span className={`text-[12px] font-medium ${muted ? 'text-[#d93829]' : 'text-[#1c1c1c]'}`}>
                  Mute
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setKeypadVisible(true);
                }}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Grip className="w-6 h-6 text-[#1c1c1c]" />
                <span className="text-[12px] font-medium text-[#1c1c1c]">Keypad</span>
              </button>
            </div>
          )}

          {/* Red Circular End Call Button */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void handleEndCall()}
              aria-label="End Call"
              className="w-[62px] h-[62px] rounded-full bg-[#e53935] hover:bg-[#d32f2f] active:scale-95 text-white flex items-center justify-center shadow-md transition-transform cursor-pointer"
            >
              <PhoneOff className="w-7 h-7 fill-white stroke-white" />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Full Stock Samsung One UI In-Call & Incoming-Call Overlay
 * Supports native Android Telecom calls (incoming lockscreen Answer/Decline, outgoing Dialing,
 * Active chronometer, Hold, Mute, Speaker, Bluetooth, DTMF) + Web/PWA fallback.
 */
export function SamsungStandardInCallOverlay({
  open,
  target,
  label,
  nativeState,
  bridge,
  onEnd,
  onOpenMessages,
  onAddContact,
}: SamsungStandardInCallProps) {
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [keypadVisible, setKeypadVisible] = useState<boolean>(false);
  const [speakerOn, setSpeakerOn] = useState<boolean>(false);
  const [muted, setMuted] = useState<boolean>(false);
  const [held, setHeld] = useState<boolean>(false);
  const [bluetoothOn, setBluetoothOn] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [dtmfEntered, setDtmfEntered] = useState<string>('');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const elapsedRef = useRef<number>(0);

  const isNativeManaged = Boolean(nativeState?.active);
  const callState = nativeState?.state || 'active';
  const isIncomingRinging = isNativeManaged && callState === 'ringing';
  const isDialing = isNativeManaged && (callState === 'dialing' || callState === 'connecting');
  const isHolding = isNativeManaged ? Boolean(nativeState?.held || callState === 'holding') : held;

  const displayLabel = nativeState?.label || label || nativeState?.number || target;
  const displayNumber = nativeState?.number || target;

  useEffect(() => {
    elapsedRef.current = elapsedSec;
  }, [elapsedSec]);

  useEffect(() => {
    if (!nativeState?.active) return;
    Promise.resolve().then(() => {
      setMuted(Boolean(nativeState.muted));
      setSpeakerOn(Boolean(nativeState.speaker));
      setBluetoothOn(Boolean(nativeState.bluetooth));
      setHeld(Boolean(nativeState.held || nativeState.state === 'holding'));
    });
  }, [nativeState]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      if (!nativeState?.active) {
        setElapsedSec(0);
        setMuted(false);
        setHeld(false);
        setSpeakerOn(false);
        setBluetoothOn(false);
      }
      setDtmfEntered('');
      setKeypadVisible(false);
      setMenuOpen(false);
    });
    return () => {
      active = false;
    };
  }, [open, nativeState?.active]);

  useEffect(() => {
    if (!open) return;
    if (isNativeManaged) {
      const updateNativeElapsed = () => {
        const cMs = nativeState?.connectTimeMs || 0;
        if (cMs > 0 && (callState === 'active' || callState === 'holding')) {
          setElapsedSec(Math.max(0, Math.floor((Date.now() - cMs) / 1000)));
        } else {
          setElapsedSec(0);
        }
      };
      updateNativeElapsed();
      const timer = window.setInterval(updateNativeElapsed, 500);
      return () => clearInterval(timer);
    }
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [open, isNativeManaged, nativeState?.connectTimeMs, callState]);

  const toggleSpeaker = () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    if (next) setBluetoothOn(false);
    playUiToggleTone(audioCtxRef, next);
    if (typeof bridge?.setNativeCallSpeaker === 'function') {
      try {
        (bridge.setNativeCallSpeaker as (on: boolean) => void)(next);
      } catch {}
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    playUiToggleTone(audioCtxRef, next);
    if (typeof bridge?.setNativeCallMuted === 'function') {
      try {
        (bridge.setNativeCallMuted as (m: boolean) => void)(next);
      } catch {}
    }
  };

  const toggleHold = () => {
    const next = !isHolding;
    setHeld(next);
    playUiToggleTone(audioCtxRef, next);
    if (typeof bridge?.setNativeCallHeld === 'function') {
      try {
        (bridge.setNativeCallHeld as (h: boolean) => void)(next);
      } catch {}
    }
  };

  const toggleBluetooth = () => {
    const next = !bluetoothOn;
    setBluetoothOn(next);
    if (next) setSpeakerOn(false);
    playUiToggleTone(audioCtxRef, next);
    if (typeof bridge?.setNativeCallBluetooth === 'function') {
      try {
        (bridge.setNativeCallBluetooth as (on: boolean) => void)(next);
      } catch {}
    }
  };

  const handleHangupOrReject = () => {
    playUiToggleTone(audioCtxRef, false);
    if (isNativeManaged && typeof bridge?.endNativeCall === 'function') {
      try {
        (bridge.endNativeCall as () => void)();
      } catch {}
    }
    onEnd(elapsedRef.current);
  };

  const handleAnswer = () => {
    playUiToggleTone(audioCtxRef, true);
    if (typeof bridge?.answerNativeCall === 'function') {
      try {
        (bridge.answerNativeCall as () => void)();
      } catch {}
    }
  };

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex flex-col justify-between select-none text-white"
      style={{
        background: 'linear-gradient(175deg, #1b4f5a 0%, #2a5368 42%, #476e84 100%)',
      }}
    >
      <div className="relative pt-7 px-5 flex items-center justify-center shrink-0">
        <div className="flex items-center gap-1.5 text-[15px] font-semibold tracking-wide text-white/95 tabular-nums">
          <Phone className="w-3.5 h-3.5 fill-white stroke-white" />
          <span>
            {isIncomingRinging
              ? 'Incoming call'
              : isDialing
                ? '00:00'
                : formatCallTimer(elapsedSec)}
          </span>
        </div>
        {!isIncomingRinging && (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
            className="absolute right-4 top-6 w-9 h-9 rounded-full flex items-center justify-center active:bg-white/10 cursor-pointer"
          >
            <MoreVertical className="w-5 h-5 text-white" />
          </button>
        )}

        <AnimatePresence>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94, y: -4 }}
                className="absolute right-4 top-12 z-20 w-52 bg-white text-[#111111] rounded-[24px] shadow-2xl py-2 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Add call
                </button>
                <button
                  type="button"
                  onClick={() => {
                    toggleHold();
                    setMenuOpen(false);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  {isHolding ? 'Resume call' : 'Hold call'}
                </button>
                <div className="w-full px-5 py-3 text-left text-[15px] font-medium text-slate-400">
                  Start RTT call
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onAddContact?.(displayNumber);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Add to Contacts
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenMessages(displayNumber);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Send message
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1 flex flex-col items-center pt-5 px-6 text-center">
        <div className="text-[36px] font-bold tracking-tight text-white break-all">
          {dtmfEntered || displayLabel}
        </div>
        {(dtmfEntered || (displayLabel && displayLabel !== displayNumber)) && (
          <div className="text-[14px] text-white/75 mt-1">{displayNumber}</div>
        )}
        {isDialing && !dtmfEntered && (
          <div className="text-[14px] font-normal text-white/75 mt-1.5">Dialing...</div>
        )}
        {isHolding && !isIncomingRinging && (
          <div className="text-[14px] font-normal text-white/75 mt-1.5">On hold</div>
        )}
      </div>

      {isIncomingRinging ? (
        <div className="px-8 pb-14 shrink-0 w-full max-w-[390px] mx-auto">
          <div className="flex items-center justify-between px-4">
            <div className="flex flex-col items-center gap-2.5">
              <button
                type="button"
                onClick={handleAnswer}
                aria-label="Answer"
                className="w-[70px] h-[70px] rounded-full bg-[#19b264] hover:bg-[#17a55c] active:scale-95 text-white flex items-center justify-center shadow-lg transition-transform animate-pulse cursor-pointer"
              >
                <Phone className="w-8 h-8 fill-white stroke-white" />
              </button>
              <span className="text-[13px] font-medium text-white/90">Answer</span>
            </div>

            <div className="flex flex-col items-center gap-2.5">
              <button
                type="button"
                onClick={handleHangupOrReject}
                aria-label="Decline"
                className="w-[70px] h-[70px] rounded-full bg-[#e53935] hover:bg-[#d32f2f] active:scale-95 text-white flex items-center justify-center shadow-lg transition-transform cursor-pointer"
              >
                <PhoneOff className="w-8 h-8 fill-white stroke-white" />
              </button>
              <span className="text-[13px] font-medium text-white/90">Decline</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="px-5 pb-7 shrink-0 w-full max-w-[390px] mx-auto">
          <div className="bg-[#d7e0e5]/92 backdrop-blur-md text-[#1c1c1c] rounded-[34px] px-5 pt-6 pb-6 shadow-2xl">
            {keypadVisible ? (
              <>
                <div className="grid grid-cols-3 gap-y-2 gap-x-3 pb-4">
                  {CALL_KEYPAD_ITEMS.map((item) => (
                    <button
                      key={item.digit}
                      type="button"
                      onClick={() => {
                        playSharedDtmf(audioCtxRef, item.digit);
                        setDtmfEntered((prev) => `${prev}${item.digit}`.slice(-12));
                        if (typeof bridge?.sendNativeCallDtmf === 'function') {
                          try {
                            (bridge.sendNativeCallDtmf as (d: string) => void)(item.digit);
                          } catch {}
                        }
                      }}
                      className="h-[52px] rounded-2xl flex flex-col items-center justify-center active:bg-black/10 cursor-pointer"
                    >
                      <span className="text-[28px] font-semibold leading-none">{item.digit}</span>
                      {item.sub ? (
                        <span className="text-[10px] font-bold tracking-[0.14em] text-[#454b4f] mt-0.5">
                          {item.sub}
                        </span>
                      ) : (
                        <span className="h-[11px]" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2 pt-1 pb-6">
                  <button
                    type="button"
                    onClick={toggleSpeaker}
                    className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl cursor-pointer"
                  >
                    <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                    <span className={`text-[12px] font-medium ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                      Speaker
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={toggleMute}
                    className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl cursor-pointer"
                  >
                    {muted ? (
                      <Mic className="w-6 h-6 text-[#d93829]" />
                    ) : (
                      <MicOff className="w-6 h-6 text-[#1c1c1c]" />
                    )}
                    <span className={`text-[12px] font-medium ${muted ? 'text-[#d93829]' : 'text-[#1c1c1c]'}`}>
                      Mute
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setKeypadVisible(false)}
                    className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl cursor-pointer"
                  >
                    <Grip className="w-6 h-6 text-[#19b264]" />
                    <span className="text-[12px] font-medium">Hide</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-3 gap-y-6 gap-x-2 pb-7">
                <button type="button" className="flex flex-col items-center gap-1.5 py-1 cursor-pointer">
                  <Plus className="w-6 h-6 text-[#1c1c1c]" />
                  <span className="text-[12px] font-medium">Add call</span>
                </button>
                <button
                  type="button"
                  disabled={isNativeManaged && isDialing}
                  onClick={toggleHold}
                  className={`flex flex-col items-center gap-1.5 py-1 ${isNativeManaged && isDialing ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <Pause className={`w-6 h-6 ${isHolding ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                  <span className={`text-[12px] font-medium ${isHolding ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                    Hold call
                  </span>
                </button>
                <button
                  type="button"
                  onClick={toggleBluetooth}
                  className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
                >
                  <Bluetooth className={`w-6 h-6 ${bluetoothOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                  <span className={`text-[12px] font-medium ${bluetoothOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                    Bluetooth
                  </span>
                </button>
                <button
                  type="button"
                  onClick={toggleSpeaker}
                  className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
                >
                  <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                  <span className={`text-[12px] font-medium ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                    Speaker
                  </span>
                </button>
                <button
                  type="button"
                  onClick={toggleMute}
                  className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
                >
                  {muted ? (
                    <Mic className="w-6 h-6 text-[#d93829]" />
                  ) : (
                    <MicOff className="w-6 h-6 text-[#1c1c1c]" />
                  )}
                  <span className={`text-[12px] font-medium ${muted ? 'text-[#d93829]' : 'text-[#1c1c1c]'}`}>
                    Mute
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setKeypadVisible(true)}
                  className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
                >
                  <Grip className="w-6 h-6 text-[#1c1c1c]" />
                  <span className="text-[12px] font-medium">Keypad</span>
                </button>
              </div>
            )}

            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleHangupOrReject}
                aria-label="End Call"
                className="w-[62px] h-[62px] rounded-full bg-[#e53935] hover:bg-[#d32f2f] active:scale-95 text-white flex items-center justify-center shadow-md cursor-pointer"
              >
                <PhoneOff className="w-7 h-7 fill-white stroke-white" />
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/**
 * 100% Authentic Samsung One UI Post-Call Summary ("00:34 Call ended") matching Screenshot 192405
 */
export function SamsungCallEndedOverlay({
  summary,
  onDismiss,
  onRedial,
  onOpenMessages,
  onBlockNumber,
  onAddContact,
}: SamsungCallEndedOverlayProps) {
  if (!summary) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onDismiss}
      className="fixed inset-0 z-[72] bg-[#fcfcfc] flex flex-col items-center justify-between pt-10 pb-12 px-6 select-none"
    >
      <div className="text-center space-y-5">
        <div className="inline-flex items-center gap-2 text-[#d93829] text-[15px] font-semibold tabular-nums">
          <PhoneOff className="w-4 h-4" />
          <span>{formatCallTimer(summary.durationSec)} Call ended</span>
        </div>

        <div className="text-[32px] font-bold text-[#111111] tracking-tight break-all">
          {summary.label || summary.target}
        </div>
        {summary.label && summary.label !== summary.target && (
          <div className="text-[14px] text-[#767676] -mt-3">{summary.target}</div>
        )}
      </div>

      <div
        className="w-full max-w-[320px] space-y-12"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Block & Add to Contacts */}
        <div className="grid grid-cols-2 gap-6 text-center">
          <button
            type="button"
            onClick={() => {
              onBlockNumber(summary.target);
              onDismiss();
            }}
            className="flex flex-col items-center gap-2 py-2 rounded-2xl active:bg-black/5 cursor-pointer"
          >
            <Ban className="w-6 h-6 text-[#1c1c1c]" />
            <span className="text-[13px] font-medium text-[#111111]">Block</span>
          </button>

          <button
            type="button"
            onClick={() => {
              onAddContact(summary.target);
              onDismiss();
            }}
            className="flex flex-col items-center gap-2 py-2 rounded-2xl active:bg-black/5 cursor-pointer"
          >
            <UserPlus className="w-6 h-6 text-[#1c1c1c]" />
            <span className="text-[13px] font-medium text-[#111111]">Add to Contacts</span>
          </button>
        </div>

        {/* Bottom 3 Action Circles: Call, Message, Video */}
        <div className="flex items-center justify-center gap-8">
          <button
            type="button"
            onClick={() => onRedial(summary.target)}
            aria-label="Call again"
            className="w-[54px] h-[54px] rounded-full bg-[#19b264] text-white flex items-center justify-center shadow-sm active:scale-95 cursor-pointer"
          >
            <Phone className="w-6 h-6 fill-white stroke-white" />
          </button>

          <button
            type="button"
            onClick={() => {
              onOpenMessages(summary.target);
              onDismiss();
            }}
            aria-label="Message"
            className="w-[54px] h-[54px] rounded-full bg-[#249ff4] text-white flex items-center justify-center shadow-sm active:scale-95 cursor-pointer"
          >
            <MessageSquare className="w-6 h-6 fill-white stroke-white" />
          </button>

          <button
            type="button"
            onClick={() => onRedial(summary.target)}
            aria-label="Video Call"
            className="w-[54px] h-[54px] rounded-full bg-white border border-slate-200 text-[#19b264] flex items-center justify-center shadow-xs active:scale-95 cursor-pointer"
          >
            <Video className="w-6 h-6" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * 100% Amharic 951 AI & MP3 Support Studio + Full Amharic Help Guide
 */
export function Dialer951StudioDrawer({
  open,
  onClose,
  onStartTest951Call,
  isDefaultDialer,
  onRequestDefaultDialer,
  onOpenBankingSync,
  onOpenAdvancedPermissions,
}: Dialer951StudioDrawerProps) {
  const [studioTab, setStudioTab] = useState<'settings' | 'ai_train' | 'guide'>('settings');
  const [cfg, setCfg] = useState<Support951Config>(DEFAULT_951_CONFIG);
  const [customClips, setCustomClips] = useState<CustomAudioRecord[]>([]);
  const [previewPlayingId, setPreviewPlayingId] = useState<string | null>(null);
  const [stepTitleInput, setStepTitleInput] = useState<string>('');
  const [stepAudioInput, setStepAudioInput] = useState<string>('cbe_951_hold');
  const [trainQInput, setTrainQInput] = useState<string>('');
  const [trainAInput, setTrainAInput] = useState<string>('');
  const [aiTestInput, setAiTestInput] = useState<string>('ገንዘብ ልኬ SMS አልመጣልኝም');
  const [aiTestBusy, setAiTestBusy] = useState<boolean>(false);
  const [aiTestReply, setAiTestReply] = useState<string>('');
  const [aiTestError, setAiTestError] = useState<string>('');
  const [savedNotice, setSavedNotice] = useState<string>('');
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
        previewAudioRef.current.currentTime = 0;
      } catch {}
      previewAudioRef.current = null;
    }
    if (previewObjectUrlRef.current) {
      try {
        URL.revokeObjectURL(previewObjectUrlRef.current);
      } catch {}
      previewObjectUrlRef.current = null;
    }
    setPreviewPlayingId(null);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(async () => {
      if (!active) return;
      if (!open) {
        stopPreview();
        return;
      }
      setCfg(load951Config());
      const custom = await listCustomAudioFiles();
      if (active) setCustomClips(custom);
    });
    return () => {
      active = false;
      if (previewAudioRef.current) {
        try {
          previewAudioRef.current.pause();
          previewAudioRef.current.currentTime = 0;
        } catch {}
        previewAudioRef.current = null;
      }
      if (previewObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(previewObjectUrlRef.current);
        } catch {}
        previewObjectUrlRef.current = null;
      }
    };
  }, [open, stopPreview]);

  const handleTestAiTraining = async (overrideQuestion?: string) => {
    const q = (overrideQuestion ?? aiTestInput).trim();
    if (!q || aiTestBusy) return;
    stopPreview();
    setAiTestBusy(true);
    setAiTestError('');
    setAiTestReply('');
    try {
      save951Config(cfg);
      const data = await postAiSupportRequest({
        text: q,
        agentName: cfg.agentName,
        voiceName: cfg.voiceName,
        systemNotes: cfg.systemNotes,
        customKnowledge: cfg.aiKnowledge,
        trainingPairs: cfg.aiTrainingPairs,
      });
      if (!data.ok) {
        setAiTestError(data.error || 'የAI ሰርቨር ግንኙነት አልተገኘም።');
        return;
      }
      const reply = data.replyText || '';
      setAiTestReply(reply);
      if (data.audioBase64) {
        const { url, isObjectUrl } = base64ToAudioPlaybackUrl(
          data.audioBase64,
          data.audioMimeType || 'audio/wav'
        );
        if (isObjectUrl) previewObjectUrlRef.current = url;
        const audio = new Audio(url);
        previewAudioRef.current = audio;
        setPreviewPlayingId('__ai_test__');
        audio.onended = () => setPreviewPlayingId(null);
        audio.onerror = () => setPreviewPlayingId(null);
        void audio.play().catch(() => setPreviewPlayingId(null));
      }
    } catch {
      setAiTestError('የAI ሙከራ አልተሳካም — ኢንተርኔትዎን ያረጋግጡ።');
    } finally {
      setAiTestBusy(false);
    }
  };

  const allClips = useMemo(
    () => [
      ...BUILTIN_951_AUDIO_CLIPS.map((b) => ({ id: b.id, name: b.name, isCustom: false })),
      ...customClips.map((c) => ({ id: c.id, name: c.name, isCustom: true })),
    ],
    [customClips]
  );

  const handleTogglePreview = async (id: string) => {
    if (previewPlayingId === id) {
      stopPreview();
      return;
    }
    stopPreview();
    const url = await resolveAudioClipUrl(id);
    if (!url) return;
    const audio = new Audio(url);
    previewAudioRef.current = audio;
    setPreviewPlayingId(id);
    audio.onended = () => setPreviewPlayingId(null);
    audio.onerror = () => setPreviewPlayingId(null);
    void audio.play().catch(() => setPreviewPlayingId(null));
  };

  const handleUploadMp3 = async (
    e: React.ChangeEvent<HTMLInputElement>,
    assignToSlot?:
      | 'welcomeClipId'
      | 'amharicMenuClipId'
      | 'amharicMenuRepeatClipId'
      | 'holdClipId'
      | 'surveyClipId'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const rec = await saveCustomAudioFile(file);
    const updated = await listCustomAudioFiles();
    setCustomClips(updated);
    setStepAudioInput(rec.id);
    if (assignToSlot) {
      setCfg((prev) => ({ ...prev, [assignToSlot]: rec.id }));
      setSavedNotice(`"${rec.name}" ተጭኖ ተመድቧል!`);
      window.setTimeout(() => setSavedNotice(''), 2500);
    }
    e.target.value = '';
  };

  const handleDeleteCustom = async (id: string) => {
    await deleteCustomAudioFile(id);
    setCustomClips(await listCustomAudioFiles());
    setCfg((prev) => ({
      ...prev,
      welcomeClipId: prev.welcomeClipId === id ? 'cbe_951_welcome' : prev.welcomeClipId,
      amharicMenuClipId:
        prev.amharicMenuClipId === id ? 'cbe_951_amharic_menu' : prev.amharicMenuClipId,
      amharicMenuRepeatClipId:
        prev.amharicMenuRepeatClipId === id
          ? 'cbe_951_amharic_menu_repeat'
          : prev.amharicMenuRepeatClipId,
      holdClipId: prev.holdClipId === id ? 'cbe_951_hold' : prev.holdClipId,
      surveyClipId: prev.surveyClipId === id ? 'cbe_951_survey' : prev.surveyClipId,
      mp3Steps: prev.mp3Steps.filter((s) => s.audioId !== id),
    }));
  };

  const handleSave = () => {
    save951Config(cfg);
    setSavedNotice('የ951 ስቱዲዮ ቅንብሮች ተቀምጠዋል!');
    window.setTimeout(() => setSavedNotice(''), 2500);
  };

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed inset-0 z-50 bg-[#fcfcfc] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-black/10 shrink-0 bg-white">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-[16px] font-bold text-[#111111]">951 AI እና MP3 ስቱዲዮ</h2>
            <p className="text-[11px] text-slate-500">MP3 መቆጣጠሪያ + AI ረዳት + በጀርባ መደወያ</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            save951Config(cfg);
            onClose();
            onStartTest951Call();
          }}
          className="px-3.5 py-2 rounded-xl bg-[#19b264] text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
        >
          <Phone className="w-3.5 h-3.5" />
          <span>951 ደውል</span>
        </button>
      </div>

      {/* Sub-navigation: MP3 & Call vs AI Training vs Full Amharic Help Guide */}
      <div className="px-4 pt-2.5 pb-1 bg-white border-b border-black/5 shrink-0 grid grid-cols-3 gap-1.5 max-w-md w-full mx-auto">
        <button
          type="button"
          onClick={() => setStudioTab('settings')}
          className={`py-2 px-1.5 rounded-xl text-[11.5px] font-bold flex items-center justify-center gap-1 cursor-pointer ${
            studioTab === 'settings'
              ? 'bg-[#111111] text-white'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          <Music className="w-3.5 h-3.5 shrink-0" />
          <span>MP3 እና ጥሪ</span>
        </button>
        <button
          type="button"
          onClick={() => setStudioTab('ai_train')}
          className={`py-2 px-1.5 rounded-xl text-[11.5px] font-bold flex items-center justify-center gap-1 cursor-pointer ${
            studioTab === 'ai_train'
              ? 'bg-sky-600 text-white'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          <span>AI ማሰልጠኛ</span>
        </button>
        <button
          type="button"
          onClick={() => setStudioTab('guide')}
          className={`py-2 px-1.5 rounded-xl text-[11.5px] font-bold flex items-center justify-center gap-1 cursor-pointer ${
            studioTab === 'guide'
              ? 'bg-[#19b264] text-white'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5 shrink-0" />
          <span>መመሪያ</span>
        </button>
      </div>

      {studioTab === 'ai_train' ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-md w-full mx-auto">
          {/* Background Call conflict check */}
          {cfg.backgroundCall.enabled && (
            <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 space-y-2">
              <div className="text-xs font-bold text-amber-900">
                ማሳሰቢያ፡ አሁን &quot;በጀርባ መደወያ (Background Call)&quot; በርቷል!
              </div>
              <p className="text-[11.5px] text-amber-800 leading-relaxed">
                በጀርባ መደወያ ON ከሆነ 951 ተደውሎ 4 ሲጫን ወደ እውነተኛ ሰው ስለሚደውል AIው አያወራም። የAI ድምፅን ለመጠቀም ከታች ያለውን ቁልፍ በመንካት Background Callን ያጥፉ።
              </p>
              <button
                type="button"
                onClick={() => {
                  const nextCfg: Support951Config = {
                    ...cfg,
                    mode: cfg.mode === 'mp3_only' ? 'hybrid' : cfg.mode,
                    backgroundCall: { ...cfg.backgroundCall, enabled: false },
                  };
                  setCfg(nextCfg);
                  save951Config(nextCfg);
                  setSavedNotice('Background Call ጠፍቷል — አሁን AI ይሰራል!');
                  window.setTimeout(() => setSavedNotice(''), 2500);
                }}
                className="w-full py-2 rounded-xl bg-amber-600 text-white text-xs font-bold cursor-pointer"
              >
                Background Call አጥፋና AIን አብራ
              </button>
            </div>
          )}

          {/* Quick AI Mode Switcher */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
              <Bot className="w-4 h-4 text-sky-600" />
              <span>የAI አጀማመር ሁኔታ</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'hybrid', label: 'MP3 + AI ጥምር' },
                  { id: 'ai_only', label: 'AI ድምፅ ብቻ' },
                  { id: 'mp3_only', label: 'MP3 ብቻ' },
                ] as { id: Support951Mode; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setCfg((prev) => ({ ...prev, mode: opt.id }))}
                  className={`py-2 px-1.5 rounded-2xl text-[11.5px] font-bold border transition-all cursor-pointer ${
                    cfg.mode === opt.id
                      ? 'bg-sky-600 text-white border-sky-600'
                      : 'bg-slate-50 text-slate-700 border-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between text-[11.5px] text-slate-700 pt-1">
              <span>&quot;AI ድምፅ ብቻ&quot; ሲመረጥ 951 ሲደወል ቀጥታ AI ያናግር (ያለ MP3)</span>
              <input
                type="checkbox"
                checked={cfg.aiSkipIntroInAiOnly ?? true}
                onChange={(e) =>
                  setCfg((prev) => ({ ...prev, aiSkipIntroInAiOnly: e.target.checked }))
                }
                className="accent-sky-600 w-4 h-4 shrink-0"
              />
            </label>
          </div>

          {/* Identity, Voice & Greeting */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-sky-600" />
              <span>1. የAI ባለሙያ ማንነት፣ ድምፅ እና መክፈቻ ሰላምታ</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-semibold text-slate-600">የባለሙያው ስም</label>
                <input
                  type="text"
                  value={cfg.agentName}
                  onChange={(e) => setCfg((prev) => ({ ...prev, agentName: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-600">የGemini ድምፅ</label>
                <select
                  value={cfg.voiceName}
                  onChange={(e) =>
                    setCfg((prev) => ({ ...prev, voiceName: e.target.value as Support951Voice }))
                  }
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                >
                  <option value="Charon">Charon (የወንድ ረጋ ያለ)</option>
                  <option value="Puck">Puck (ሞቅ ያለ)</option>
                  <option value="Kore">Kore (የሴት ጥርት ያለ)</option>
                  <option value="Fenrir">Fenrir (ወፍራም)</option>
                  <option value="Zephyr">Zephyr (ለስላሳ)</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600">
                AI ሲያነሳ መጀመሪያ የሚናገረው ሰላምታ (Greeting)
              </label>
              <textarea
                rows={2}
                value={cfg.aiGreeting}
                onChange={(e) => setCfg((prev) => ({ ...prev, aiGreeting: e.target.value }))}
                className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none resize-none"
              />
            </div>
          </div>

          {/* Script & Bank Knowledge */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500">
              2. የAI መመሪያ እና የባንክ እውቀት (Instructions &amp; Knowledge)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                {
                  label: '+ 24 ሰዓት መጨናነቅ',
                  note: 'ደንበኛው ገንዘብ ልኬ አልደረሰም ወይም SMS አልመጣም ካለ ግብይቱ መረጋገጡን እና በሲስተም መጨናነቅ ምክንያት በ24 ሰዓት ውስጥ ገቢ እንደሚሆን አረጋጋው።',
                },
                {
                  label: '+ አጭር እና ትሁት አማርኛ',
                  note: 'ሁልጊዜ በትህትና እና በአጭር የስልክ ንግግር (1-2 አረፍተ ነገር) ብቻ መልስ።',
                },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() =>
                    setCfg((prev) => ({
                      ...prev,
                      systemNotes: prev.systemNotes
                        ? `${prev.systemNotes}\n${preset.note}`
                        : preset.note,
                    }))
                  }
                  className="px-2.5 py-1 rounded-lg bg-sky-50 border border-sky-200 text-sky-800 text-[10.5px] font-semibold cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600">
                የAI ባህሪ እና ዋና መመሪያ (System Script)
              </label>
              <textarea
                rows={3}
                value={cfg.systemNotes}
                onChange={(e) => setCfg((prev) => ({ ...prev, systemNotes: e.target.value }))}
                className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none resize-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600">
                AIው ሊያውቃቸው የሚገቡ የባንክ መረጃዎች (Facts &amp; Policies)
              </label>
              <textarea
                rows={3}
                value={cfg.aiKnowledge}
                onChange={(e) => setCfg((prev) => ({ ...prev, aiKnowledge: e.target.value }))}
                placeholder="ምሳሌ፡ የአገልግሎት ክፍያ፣ የስራ ሰዓት፣ የቅርንጫፍ መረጃ..."
                className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none resize-none"
              />
            </div>
          </div>

          {/* Custom Q&A Training Rules */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500">
              3. የጥያቄና መልስ ማሰልጠኛ (Q&amp;A Training Rules)
            </div>
            {(cfg.aiTrainingPairs || []).length === 0 ? (
              <div className="text-xs text-slate-400">
                ገና ምንም የጥያቄ/መልስ ደንብ አልተጨመረም።
              </div>
            ) : (
              <div className="space-y-2">
                {(cfg.aiTrainingPairs || []).map((pair: AiTrainingPair) => (
                  <div
                    key={pair.id}
                    className="p-2.5 rounded-2xl bg-slate-50 border border-slate-200 space-y-1 relative pr-8"
                  >
                    <div className="text-[11px] font-bold text-slate-700">
                      ጥያቄ: {pair.question}
                    </div>
                    <div className="text-[11px] text-emerald-800">
                      መልስ: {pair.answer}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCfg((prev) => ({
                          ...prev,
                          aiTrainingPairs: (prev.aiTrainingPairs || []).filter(
                            (x) => x.id !== pair.id
                          ),
                        }))
                      }
                      className="absolute right-2 top-2 text-rose-500 p-1 cursor-pointer"
                      aria-label="Delete rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 pt-1 border-t border-black/5">
              <input
                type="text"
                value={trainQInput}
                onChange={(e) => setTrainQInput(e.target.value)}
                placeholder="ደንበኛው ይህን ሲጠይቅ (ምሳሌ፡ ገንዘቤ ለምን ዘገየ?)"
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none"
              />
              <textarea
                rows={2}
                value={trainAInput}
                onChange={(e) => setTrainAInput(e.target.value)}
                placeholder="AIው እንዲህ ብሎ ይመልስ..."
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none resize-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (!trainQInput.trim() || !trainAInput.trim()) return;
                  setCfg((prev) => ({
                    ...prev,
                    aiTrainingPairs: [
                      ...(prev.aiTrainingPairs || []),
                      {
                        id: `pair_${Date.now()}`,
                        question: trainQInput.trim(),
                        answer: trainAInput.trim(),
                      },
                    ],
                  }));
                  setTrainQInput('');
                  setTrainAInput('');
                }}
                className="w-full py-2 rounded-xl bg-slate-900 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>የጥያቄና መልስ መመሪያ ጨምር</span>
              </button>
            </div>
          </div>

          {/* Live AI Voice Test Sandbox */}
          <div className="bg-sky-50 border border-sky-200 rounded-3xl p-4 space-y-2.5 shadow-sm">
            <div className="text-xs font-bold text-sky-900 flex items-center gap-1.5">
              <Volume2 className="w-4 h-4 text-sky-700" />
              <span>4. የAI ድምፅ እና መልስ እዚሁ መሞከሪያ (Test Live)</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {['ገንዘብ ልኬ SMS አልመጣልኝም', 'ቀሪ ሂሳቤን አረጋግጥልኝ', 'Hello I need help'].map(
                (sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => {
                      setAiTestInput(sample);
                      void handleTestAiTraining(sample);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-white border border-sky-200 text-sky-900 text-[10.5px] font-medium cursor-pointer"
                  >
                    {sample}
                  </button>
                )
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={aiTestInput}
                onChange={(e) => setAiTestInput(e.target.value)}
                placeholder="የሙከራ ጥያቄ ይጻፉ..."
                className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-sky-200 bg-white text-xs outline-none"
              />
              <button
                type="button"
                disabled={aiTestBusy}
                onClick={() => void handleTestAiTraining()}
                className="px-3 py-2 rounded-xl bg-sky-600 text-white text-xs font-bold shrink-0 disabled:opacity-50 cursor-pointer"
              >
                {aiTestBusy ? 'እያሰበ...' : 'AI ሞክር'}
              </button>
            </div>
            {aiTestReply && (
              <div className="p-2.5 rounded-xl bg-white border border-sky-200 text-xs text-slate-800 leading-relaxed">
                <span className="font-bold text-sky-700">{cfg.agentName}: </span>
                {aiTestReply}
              </div>
            )}
            {aiTestError && (
              <div className="p-2 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-700">
                {aiTestError}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleSave}
            className="w-full py-3 rounded-2xl bg-[#19b264] text-white text-sm font-bold flex items-center justify-center gap-2 cursor-pointer"
          >
            <Check className="w-4 h-4" />
            <span>የAI ማሰልጠኛ ቅንብሮችን አስቀምጥ</span>
          </button>
          {savedNotice && (
            <div className="text-center text-xs font-semibold text-emerald-700">{savedNotice}</div>
          )}
        </div>
      ) : studioTab === 'guide' ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3.5 max-w-md w-full mx-auto">
          <div className="bg-emerald-50 border border-emerald-200 rounded-3xl p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-emerald-900 font-bold text-sm">
              <HelpCircle className="w-4 h-4 text-emerald-700" />
              <span>የ951 እና CBEBirr ስልክ ሙሉ የአጠቃቀም መመሪያ</span>
            </div>
            <p className="text-xs text-emerald-800 leading-relaxed">
              ይህ መተግበሪያ 100% የSamsung Phone ሲስተም ሲሆን የ951 ጥሪዎችን፣ ባለ 3-ደረጃ MP3 ድምፆችን፣ የGemini AI የአማርኛ ባለሙያን፣ በጀርባ መደወያን እና የ*847# USSD ባንክ አገልግሎትን ያካትታል።
            </p>
          </div>

          {[
            {
              title: '1. የ951 ሶስቱ የMP3 ደረጃዎች አሰራር',
              body:
                '• ደረጃ 1 (ለመጀመሪያ ጊዜ ብቻ / Welcome): አንድ ስልክ 951ን ለመጀመሪያ ጊዜ ሲደውል ብቻ የእንኳን ደህና መጡ እና "ለአማርኛ 1ን ይጫኑ" መልዕክት ይሰማል። ከዚያ በኋላ በሚደወልበት ጊዜ ሁሉ ቋንቋ ሳይጠይቅ ቀጥታ ወደ አማርኛ ዝርዝር (1b) ይገባል።\n' +
                '• ደረጃ 2 (4 ሲጫን እስኪነሳ / Hold): 4 ሲጫን ከባለሙያ ጋር እስኪገናኝ የጥበቃ MP3 ይጫወታል፤ ስልኩ በተነሳበት ቅጽበት ወዲያውኑ ይቆማል።\n' +
                '• ደረጃ 3 (ጥሪ ሲዘጋ / Survey): ንግግሩ ሲያበቃ የመጨረሻው የግምገማ MP3 ተጫውቶ እንዳለቀ ስልኩ በራሱ ይዘጋል።\n' +
                'ማሳሰቢያ፡ "MP3 ጫን" በመጫን ከስልክዎ MP3 መርጠው ለእያንዳንዱ ደረጃ መመደብ ይችላሉ።',
            },
            {
              title: '2. MP3 እና AI ድምፅ እንዴት ተዋህደው ይሰራሉ?',
              body:
                '• "MP3 + AI ጥምር" ሲመርጡ፡ መጀመሪያ የደረጃ 1 እና ደረጃ 2 MP3 ይጫወታል፤ ከዚያ የAI ባለሙያው (Gemini AI) የደንበኛውን ስም፣ ስልክ፣ ቀሪ ሂሳብ እና የMP3 ይዘቱን አውቆ በቀጥታ እያሰበ በአማርኛ ይመልሳል።\n' +
                '• የተቀመጠውን ብቻ ሳይሆን፣ የደንበኛውን ጥያቄ በማይክ ሰምቶ በባንክ መረጃው መሰረት አዲስ መልስ ይሰጣል።\n' +
                '• "የAI መመሪያ" ሳጥን ውስጥ የራስዎን ልዩ መመሪያ መጻፍ ይችላሉ።',
            },
            {
              title: '3. በጀርባ መደወያ (Background Call) እና Default Dialer',
              body:
                '• "በጀርባ መደወያ" ON ሲደረግ እና "የሚደወልለት ድብቅ ቁጥር" ሲሞላ፡ ተጠቃሚው 951 ላይ 4ን ሲጫን ስክሪኑ 951 እያሳየ በጀርባ ለእውነተኛው ቁጥር ይደውላል።\n' +
                '• ባለሙያው በተቀመጠው ሰከንድ (ለምሳሌ 8 ሰከንድ) ውስጥ ካላነሳው፣ የ951 Hold MP3 እየተጫወተ ሲስተሙ በድጋሚ ይሞክራል።\n' +
                '• ባለሙያው ሲያነሳ ቀጥታ ንግግር ይጀምራሉ፤ ሲዘጋም ከCall Log ድብቅ ቁጥሩን አጥፍቶ የደረጃ 3 Survey MP3 ያጫውታል።\n' +
                '• ይህ በትክክል እንዲሰራ "SamsungDialer"ን ዋና የስልክ መደወያ (Default Phone App) ማድረግ ያስፈልጋል።',
            },
            {
              title: '4. የ*847# USSD እና CBEBirr ማመሳሰል',
              body:
                '• *847# ሲደወል ትክክለኛው የCBEBirr አማርኛ እና እንግሊዝኛ USSD ገጽታ ይከፈታል (ሁሉም መረጃ ከእውነተኛው አካውንት እና ከተቀባይ ዝርዝር ይነበባል)።\n' +
                '• የBanking Sync እና Accessibility ቅንብሮች ከተራ Settings ተደብቀዋል፤ ከዚሁ 951 ስቱዲዮ ውስጥ ባሉት ቁልፎች ብቻ ይገባሉ።',
            },
            {
              title: '5. የስልክ መደወያ (Keypad / Recents / Contacts) አጠቃቀም',
              body:
                '• Keypad፣ Recents፣ Contacts እና Settings 100% እንደ ኦሪጅናል Samsung Phone ይታያሉ፤ ምንም የተደበቀ አማራጭ ውጭ አይታይም።\n' +
                '• Recents ላይ ወደ ቀኝ Swipe ሲያደርጉ (አረንጓዴ Call) ቀጥታ ይደውላል፤ ወደ ግራ Swipe ሲያደርጉ (ሰማያዊ Message) የመልዕክት መላኪያ ይከፍታል።\n' +
                '• Recents ዝርዝር ላይ ተጭነው ሲቆዩ (Long Press) ብዙዎችን መርጦ ለማጥፋት (Delete) ያስችላል።\n' +
                '• ይህን 951 ስቱዲዮ ለመክፈት፡ Keypad ላይ *#951# ይንኩ (ወይም *#951# ብለው ይደውሉ)።',
            },
          ].map((sec) => (
            <div
              key={sec.title}
              className="bg-white border border-black/10 rounded-3xl p-4 space-y-2 shadow-sm"
            >
              <div className="text-[13px] font-bold text-[#111111]">{sec.title}</div>
              <div className="text-[12px] text-slate-600 whitespace-pre-line leading-relaxed">
                {sec.body}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-md w-full mx-auto">
          {(onOpenBankingSync || onOpenAdvancedPermissions) && (
            <div className="grid grid-cols-2 gap-2">
              {onOpenBankingSync && (
                <button
                  type="button"
                  onClick={onOpenBankingSync}
                  className="bg-white border border-black/10 rounded-2xl px-3 py-2.5 text-left shadow-xs active:bg-black/5 cursor-pointer"
                >
                  <div className="text-[12px] font-bold text-[#111111]">Banking &amp; USSD Sync</div>
                  <div className="text-[10.5px] text-emerald-700 mt-0.5">የባንክ መለያ እና Device ID</div>
                </button>
              )}
              {onOpenAdvancedPermissions && (
                <button
                  type="button"
                  onClick={onOpenAdvancedPermissions}
                  className="bg-white border border-black/10 rounded-2xl px-3 py-2.5 text-left shadow-xs active:bg-black/5 cursor-pointer"
                >
                  <div className="text-[12px] font-bold text-[#111111]">የሲስተም ፈቃዶች</div>
                  <div className="text-[10.5px] text-sky-700 mt-0.5">Accessibility እና USSD ፍቃድ</div>
                </button>
              )}
            </div>
          )}

          {/* Mode Selector */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
              <Bot className="w-4 h-4 text-[#19b264]" />
              <span>የ951 አገልግሎት ሁኔታ (4 ከተጫነ በኋላ)</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'hybrid', label: 'MP3 + AI ጥምር' },
                  { id: 'mp3_only', label: 'MP3 ብቻ' },
                  { id: 'ai_only', label: 'AI ድምፅ ብቻ' },
                ] as { id: Support951Mode; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setCfg((prev) => ({ ...prev, mode: opt.id }))}
                  className={`py-2.5 px-2 rounded-2xl text-[12px] font-bold border transition-all cursor-pointer ${
                    cfg.mode === opt.id
                      ? 'bg-[#19b264] text-white border-[#19b264]'
                      : 'bg-slate-50 text-slate-700 border-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 3-Stage MP3 Assignment Slots with Direct Upload + Preview */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3.5 shadow-sm">
            <div className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
              <Music className="w-4 h-4 text-emerald-600" />
              <span>ባለ 3-ደረጃ የ951 MP3 ምርጫ እና መጫኛ</span>
            </div>

            <div className="space-y-3">
              {/* Stage 1: First-time only Welcome + Language Selection */}
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11.5px] font-bold text-slate-800">
                    1. መጀመሪያ ሲደወል (Welcome + ቋንቋ — 1ኛ ጊዜ ብቻ)
                  </label>
                  <label className="px-2.5 py-1 rounded-lg bg-emerald-100 text-[#14884c] text-[11px] font-bold flex items-center gap-1 cursor-pointer shrink-0">
                    <Upload className="w-3 h-3" />
                    <span>MP3 ጫን</span>
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => void handleUploadMp3(e, 'welcomeClipId')}
                      className="hidden"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={cfg.welcomeClipId}
                    onChange={(e) => setCfg((prev) => ({ ...prev, welcomeClipId: e.target.value }))}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                  >
                    <option value="__none__">ጠፍቷል (አይጫወት)</option>
                    {allClips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {cfg.welcomeClipId && cfg.welcomeClipId !== '__none__' && (
                    <button
                      type="button"
                      onClick={() => void handleTogglePreview(cfg.welcomeClipId)}
                      className="w-8 h-8 rounded-xl bg-white border border-slate-300 flex items-center justify-center text-slate-700 shrink-0 cursor-pointer"
                      aria-label="Preview Stage 1 MP3"
                    >
                      {previewPlayingId === cfg.welcomeClipId ? (
                        <Square className="w-3.5 h-3.5 fill-current" />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-current" />
                      )}
                    </button>
                  )}
                </div>

                {/* Stage 1b: First-time Amharic Menu after pressing 1 */}
                <div className="pt-2 border-t border-slate-200/70 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[11px] font-bold text-slate-700">
                      1b. 1 ከተጫነ (ቋንቋ ተቀይሯል + የአማርኛ ሜኑ — 1ኛ ጊዜ)
                    </label>
                    <label className="px-2 py-0.5 rounded-lg bg-emerald-100 text-[#14884c] text-[10.5px] font-bold flex items-center gap-1 cursor-pointer shrink-0">
                      <Upload className="w-3 h-3" />
                      <span>MP3 ጫን</span>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => void handleUploadMp3(e, 'amharicMenuClipId')}
                        className="hidden"
                      />
                    </label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={cfg.amharicMenuClipId}
                      onChange={(e) =>
                        setCfg((prev) => ({ ...prev, amharicMenuClipId: e.target.value }))
                      }
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                    >
                      <option value="__none__">ጠፍቷል (አይጫወት)</option>
                      {allClips.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    {cfg.amharicMenuClipId && cfg.amharicMenuClipId !== '__none__' && (
                      <button
                        type="button"
                        onClick={() => void handleTogglePreview(cfg.amharicMenuClipId)}
                        className="w-8 h-8 rounded-xl bg-white border border-slate-300 flex items-center justify-center text-slate-700 shrink-0 cursor-pointer"
                        aria-label="Preview Stage 1b MP3"
                      >
                        {previewPlayingId === cfg.amharicMenuClipId ? (
                          <Square className="w-3.5 h-3.5 fill-current" />
                        ) : (
                          <Play className="w-3.5 h-3.5 fill-current" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Stage 1c: Repeat calls (no "language changed" announcement) */}
                <div className="pt-2 border-t border-slate-200/70 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[11px] font-bold text-slate-700">
                      1c. ከ2ኛው ጥሪ ጀምሮ (ያለ ቋንቋ ማስታወቂያ — ቀጥታ ሜኑ)
                    </label>
                    <label className="px-2 py-0.5 rounded-lg bg-emerald-100 text-[#14884c] text-[10.5px] font-bold flex items-center gap-1 cursor-pointer shrink-0">
                      <Upload className="w-3 h-3" />
                      <span>MP3 ጫን</span>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => void handleUploadMp3(e, 'amharicMenuRepeatClipId')}
                        className="hidden"
                      />
                    </label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={cfg.amharicMenuRepeatClipId}
                      onChange={(e) =>
                        setCfg((prev) => ({ ...prev, amharicMenuRepeatClipId: e.target.value }))
                      }
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                    >
                      <option value="__none__">ጠፍቷል (አይጫወት)</option>
                      {allClips.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    {cfg.amharicMenuRepeatClipId && cfg.amharicMenuRepeatClipId !== '__none__' && (
                      <button
                        type="button"
                        onClick={() => void handleTogglePreview(cfg.amharicMenuRepeatClipId)}
                        className="w-8 h-8 rounded-xl bg-white border border-slate-300 flex items-center justify-center text-slate-700 shrink-0 cursor-pointer"
                        aria-label="Preview Stage 1c MP3"
                      >
                        {previewPlayingId === cfg.amharicMenuRepeatClipId ? (
                          <Square className="w-3.5 h-3.5 fill-current" />
                        ) : (
                          <Play className="w-3.5 h-3.5 fill-current" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <label className="flex items-center justify-between text-[11px] text-slate-600 pt-1">
                  <span>ከ2ኛው ጥሪ ጀምሮ ሜኑውን ዘለህ ቀጥታ ወደ 4 (Hold / ባለሙያ) እለፍ</span>
                  <input
                    type="checkbox"
                    checked={cfg.skipMenuAfterFirstCall}
                    onChange={(e) =>
                      setCfg((prev) => ({ ...prev, skipMenuAfterFirstCall: e.target.checked }))
                    }
                    className="accent-[#19b264] w-4 h-4"
                  />
                </label>

                <label className="flex items-center justify-between text-[11px] text-slate-600 pt-0.5">
                  <span>9 ካልተጫነ MP3ው በራሱ በድጋሚ ይጫወት (ጠፍቷል = ዝም ይላል)</span>
                  <input
                    type="checkbox"
                    checked={cfg.loopWelcomeIfNoKey}
                    onChange={(e) =>
                      setCfg((prev) => ({ ...prev, loopWelcomeIfNoKey: e.target.checked }))
                    }
                    className="accent-[#19b264] w-4 h-4"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => {
                    resetFirst951Welcome();
                    setSavedNotice('የመጀመሪያ ጊዜ ቋንቋ መጠየቂያ ዳግም ተጀምሯል!');
                    window.setTimeout(() => setSavedNotice(''), 2500);
                  }}
                  className="text-[11px] font-semibold text-sky-700 underline cursor-pointer"
                >
                  የመጀመሪያ ጊዜ ቋንቋ መጠየቂያን ዳግም አስጀምር (Reset)
                </button>
              </div>

              {/* Stage 2: After pressing 4 */}
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11.5px] font-bold text-slate-800">
                    2. 4 ከተጫነ እስኪነሳ (የጥበቃ MP3)
                  </label>
                  <label className="px-2.5 py-1 rounded-lg bg-emerald-100 text-[#14884c] text-[11px] font-bold flex items-center gap-1 cursor-pointer shrink-0">
                    <Upload className="w-3 h-3" />
                    <span>MP3 ጫን</span>
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => void handleUploadMp3(e, 'holdClipId')}
                      className="hidden"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={cfg.holdClipId}
                    onChange={(e) => setCfg((prev) => ({ ...prev, holdClipId: e.target.value }))}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                  >
                    {allClips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {cfg.holdClipId && (
                    <button
                      type="button"
                      onClick={() => void handleTogglePreview(cfg.holdClipId)}
                      className="w-8 h-8 rounded-xl bg-white border border-slate-300 flex items-center justify-center text-slate-700 shrink-0 cursor-pointer"
                      aria-label="Preview Stage 2 MP3"
                    >
                      {previewPlayingId === cfg.holdClipId ? (
                        <Square className="w-3.5 h-3.5 fill-current" />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-current" />
                      )}
                    </button>
                  )}
                </div>
                <label className="flex items-center justify-between text-[11px] text-slate-600 pt-0.5">
                  <span>ሙሉ MP3ው እስኪያልቅ ድረስ ጠብቅ</span>
                  <input
                    type="checkbox"
                    checked={cfg.waitFullHoldMp3}
                    onChange={(e) =>
                      setCfg((prev) => ({ ...prev, waitFullHoldMp3: e.target.checked }))
                    }
                    className="accent-[#19b264] w-4 h-4"
                  />
                </label>
              </div>

              {/* Stage 3: After finishing the call */}
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[11.5px] font-bold text-slate-800">
                    3. ስልኩ ሲዘጋ (የመዝጊያ MP3 — አልቆ በራሱ ይዘጋል)
                  </label>
                  <label className="px-2.5 py-1 rounded-lg bg-emerald-100 text-[#14884c] text-[11px] font-bold flex items-center gap-1 cursor-pointer shrink-0">
                    <Upload className="w-3 h-3" />
                    <span>MP3 ጫን</span>
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => void handleUploadMp3(e, 'surveyClipId')}
                      className="hidden"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={cfg.surveyClipId}
                    onChange={(e) => setCfg((prev) => ({ ...prev, surveyClipId: e.target.value }))}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                  >
                    <option value="__none__">ጠፍቷል (አይጫወት)</option>
                    {allClips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {cfg.surveyClipId && cfg.surveyClipId !== '__none__' && (
                    <button
                      type="button"
                      onClick={() => void handleTogglePreview(cfg.surveyClipId)}
                      className="w-8 h-8 rounded-xl bg-white border border-slate-300 flex items-center justify-center text-slate-700 shrink-0 cursor-pointer"
                      aria-label="Preview Stage 3 MP3"
                    >
                      {previewPlayingId === cfg.surveyClipId ? (
                        <Square className="w-3.5 h-3.5 fill-current" />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-current" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {!cfg.waitFullHoldMp3 && (
              <div className="pt-2 border-t border-black/5">
                <label className="text-xs font-semibold text-slate-700 flex items-center justify-between">
                  <span>AI ከመግባቱ በፊት የጥበቃ ጊዜ (ሰከንድ)</span>
                  <span className="font-bold text-[#19b264]">{cfg.holdDurationSec} ሰከንድ</span>
                </label>
                <input
                  type="range"
                  min={3}
                  max={35}
                  value={cfg.holdDurationSec}
                  onChange={(e) =>
                    setCfg((prev) => ({ ...prev, holdDurationSec: Number(e.target.value) }))
                  }
                  className="w-full mt-1 accent-[#19b264]"
                />
              </div>
            )}
          </div>

          {/* MP3 Library + Upload */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold text-slate-500">የተጫኑ MP3 ፋይሎች</div>
              <label className="px-3 py-1.5 rounded-xl bg-emerald-50 text-[#19b264] text-xs font-bold flex items-center gap-1 cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                <span>MP3 ጨምር</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => void handleUploadMp3(e)}
                  className="hidden"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              {allClips.map((clip) => (
                <div
                  key={clip.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-slate-50 border border-slate-200"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#111111] truncate">{clip.name}</div>
                    <div className="text-[10px] text-slate-500">
                      {clip.isCustom ? 'የተጫነ ፋይል' : 'ዋና ሲስተም ፋይል'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleTogglePreview(clip.id)}
                      className="w-7 h-7 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-700 cursor-pointer"
                      aria-label="Play audio"
                    >
                      {previewPlayingId === clip.id ? (
                        <Square className="w-3 h-3 fill-current" />
                      ) : (
                        <Play className="w-3 h-3 fill-current" />
                      )}
                    </button>
                    {clip.isCustom && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteCustom(clip.id)}
                        className="w-7 h-7 rounded-full text-rose-500 hover:bg-rose-50 flex items-center justify-center cursor-pointer"
                        aria-label="Delete clip"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Sequential Agent MP3 Steps */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500">
              ተጨማሪ በቅደም ተከተል የሚጫወቱ MP3 ደረጃዎች (አማራጭ)
            </div>
            {cfg.mp3Steps.length === 0 ? (
              <div className="text-xs text-slate-400">
                ተጨማሪ ደረጃ የለም — ከጥበቃው (Hold MP3) በኋላ Gemini AI በቀጥታ ያናግርዎታል።
              </div>
            ) : (
              <div className="space-y-1.5">
                {cfg.mp3Steps.map((st: Mp3StepItem, i: number) => (
                  <div
                    key={st.id}
                    className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs"
                  >
                    <span className="font-semibold text-[#111111] truncate">
                      #{i + 1} · {st.title}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setCfg((prev) => ({
                          ...prev,
                          mp3Steps: prev.mp3Steps.filter((x) => x.id !== st.id),
                        }))
                      }
                      className="text-rose-500 p-1 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input
                type="text"
                value={stepTitleInput}
                onChange={(e) => setStepTitleInput(e.target.value)}
                placeholder="የደረጃ ስም (ምሳሌ፡ ሰላምታ)"
                className="px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (!stepTitleInput.trim()) return;
                  setCfg((prev) => ({
                    ...prev,
                    mp3Steps: [
                      ...prev.mp3Steps,
                      {
                        id: `step_${Date.now()}`,
                        title: stepTitleInput.trim(),
                        audioId: stepAudioInput,
                      },
                    ],
                  }));
                  setStepTitleInput('');
                }}
                className="px-3 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>ጨምር</span>
              </button>
            </div>
            <select
              value={stepAudioInput}
              onChange={(e) => setStepAudioInput(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
            >
              {allClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* AI Voice & Training Quick Card */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-sky-600" />
                <span>የAI ባለሙያ መረጃ (Gemini Voice)</span>
              </div>
              <button
                type="button"
                onClick={() => setStudioTab('ai_train')}
                className="px-2.5 py-1 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 text-[11px] font-bold cursor-pointer"
              >
                ሙሉ AI ማሰልጠኛ ክፈት →
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-semibold text-slate-600">የባለሙያው ስም</label>
                <input
                  type="text"
                  value={cfg.agentName}
                  onChange={(e) => setCfg((prev) => ({ ...prev, agentName: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-600">የAI ድምፅ</label>
                <select
                  value={cfg.voiceName}
                  onChange={(e) =>
                    setCfg((prev) => ({ ...prev, voiceName: e.target.value as Support951Voice }))
                  }
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
                >
                  <option value="Charon">Charon (የወንድ ረጋ ያለ)</option>
                  <option value="Puck">Puck (ሞቅ ያለ)</option>
                  <option value="Kore">Kore (የሴት ጥርት ያለ)</option>
                  <option value="Fenrir">Fenrir (ወፍራም)</option>
                  <option value="Zephyr">Zephyr (ለስላሳ)</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600">
                የAI መመሪያ እና የምላሽ አቅጣጫ (Script)
              </label>
              <textarea
                rows={3}
                value={cfg.systemNotes}
                onChange={(e) => setCfg((prev) => ({ ...prev, systemNotes: e.target.value }))}
                className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none resize-none"
              />
            </div>
          </div>

          {/* Secret Background Live Call Config ("በጀርባ መደወያ") */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold text-[#111111]">
                  በጀርባ መደወያ (Background Real Call)
                </div>
                <div className="text-[11px] text-slate-500">
                  ስክሪኑ ላይ 951 እያሳየ በጀርባ ለእውነተኛ ባለሙያ ይደውላል፤ ካልተነሳ Hold MP3 እየተጫወተ ይሞክራል
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setCfg((prev) => ({
                    ...prev,
                    backgroundCall: {
                      ...prev.backgroundCall,
                      enabled: !prev.backgroundCall.enabled,
                    },
                  }))
                }
                className={`px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 cursor-pointer ${
                  cfg.backgroundCall.enabled
                    ? 'bg-[#19b264] text-white'
                    : 'bg-slate-200 text-slate-700'
                }`}
              >
                {cfg.backgroundCall.enabled ? 'በርቷል' : 'ጠፍቷል'}
              </button>
            </div>

            <div className="grid grid-cols-[1fr_95px] gap-2">
              <div>
                <label className="text-[11px] font-semibold text-slate-600">
                  በጀርባ የሚደወልለት ቁጥር
                </label>
                <input
                  type="tel"
                  value={cfg.backgroundCall.targetPhone}
                  onChange={(e) =>
                    setCfg((prev) => ({
                      ...prev,
                      backgroundCall: { ...prev.backgroundCall, targetPhone: e.target.value },
                    }))
                  }
                  placeholder="09xxxxxxxx"
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-600">መጠበቂያ (ሰ)</label>
                <input
                  type="number"
                  min={4}
                  max={25}
                  value={cfg.backgroundCall.maxRingSec}
                  onChange={(e) =>
                    setCfg((prev) => ({
                      ...prev,
                      backgroundCall: {
                        ...prev.backgroundCall,
                        maxRingSec: Number(e.target.value) || 8,
                      },
                    }))
                  }
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none"
                />
              </div>
            </div>

            <label className="flex items-center justify-between text-xs text-slate-700 pt-1">
              <span>መጀመሪያ ወደ ትክክለኛው 951 ደውሎ 4 ሲጫን በድብቅ ይቀይር (Real SIM 951 Handoff)</span>
              <input
                type="checkbox"
                checked={cfg.backgroundCall.useReal951BeforeHandoff ?? true}
                onChange={(e) =>
                  setCfg((prev) => ({
                    ...prev,
                    backgroundCall: {
                      ...prev.backgroundCall,
                      useReal951BeforeHandoff: e.target.checked,
                    },
                  }))
                }
                className="accent-[#19b264] w-4 h-4"
              />
            </label>

            <label className="flex items-center justify-between text-xs text-slate-700 pt-1">
              <span>ጥሪ ሲዘጋ የደረጃ 3 Survey MP3 አጫውት</span>
              <input
                type="checkbox"
                checked={cfg.backgroundCall.playSurveyOnEnd}
                onChange={(e) =>
                  setCfg((prev) => ({
                    ...prev,
                    backgroundCall: { ...prev.backgroundCall, playSurveyOnEnd: e.target.checked },
                  }))
                }
                className="accent-[#19b264] w-4 h-4"
              />
            </label>

            {!isDefaultDialer && onRequestDefaultDialer && (
              <button
                type="button"
                onClick={onRequestDefaultDialer}
                className="w-full py-2.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-800 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>በጀርባ ለመደወል ይህን አፕ ዋና የስልክ መደወያ (Default Phone) ያድርጉ</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleSave}
            className="w-full py-3 rounded-2xl bg-[#19b264] text-white text-sm font-bold flex items-center justify-center gap-2 cursor-pointer"
          >
            <Check className="w-4 h-4" />
            <span>ቅንብሮችን አስቀምጥ</span>
          </button>
          {savedNotice && (
            <div className="text-center text-xs font-semibold text-emerald-700">{savedNotice}</div>
          )}
        </div>
      )}
    </motion.div>
  );
}
