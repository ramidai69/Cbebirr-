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
  Send,
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

interface TranscriptMsg {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
}

interface BankingContextSnapshot {
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
}

type Call951Phase =
  | 'ringing'
  | 'welcome_menu'
  | 'amharic_menu'
  | 'hold_mp3'
  | 'secret_ringing'
  | 'secret_busy_retry'
  | 'secret_live'
  | 'ai_active'
  | 'survey_closing'
  | 'ended';

export interface EndedCallSummary {
  target: string;
  label: string;
  durationSec: number;
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
  const [aiChatVisible, setAiChatVisible] = useState<boolean>(false);
  const [dtmfEntered, setDtmfEntered] = useState<string>('');
  const [transcripts, setTranscripts] = useState<TranscriptMsg[]>([]);
  const [typedInput, setTypedInput] = useState<string>('');
  const [vadState, setVadState] = useState<'idle' | 'listening' | 'speaking' | 'sending' | 'agent_speaking'>('idle');
  const [aiBusy, setAiBusy] = useState<boolean>(false);
  const [statusLabel, setStatusLabel] = useState<string>('');
  const [activeAgentName, setActiveAgentName] = useState<string>(DEFAULT_951_CONFIG.agentName);

  const phaseRef = useRef<Call951Phase>('ringing');
  const openRef = useRef<boolean>(false);
  const mutedRef = useRef<boolean>(false);
  const elapsedRef = useRef<number>(0);
  const configRef = useRef<Support951Config>(DEFAULT_951_CONFIG);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ringStopRef = useRef<(() => void) | null>(null);
  const holdTimerRef = useRef<number | null>(null);
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
    elapsedRef.current = elapsedSec;
  }, [elapsedSec]);

  const appendTranscript = useCallback((role: TranscriptMsg['role'], text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (role === 'user' || role === 'agent') {
      historyRef.current = [...historyRef.current.slice(-14), { role, text: clean }];
    }
    setTranscripts((prev) => [
      ...prev.slice(-24),
      { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, role, text: clean },
    ]);
  }, []);

  const stopAllAudio = useCallback(() => {
    currentClipIdRef.current = null;
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
  }, []);

  const stopMicVad = useCallback(() => {
    if (vadLoopRef.current) {
      cancelAnimationFrame(vadLoopRef.current);
      vadLoopRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {}
    }
    recorderRef.current = null;
    chunksRef.current = [];
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

  const speakBrowserAmharic = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        resolve();
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
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        u.onend = finish;
        u.onerror = finish;
        window.setTimeout(finish, Math.max(2400, Math.min(9000, text.length * 85)));
        window.speechSynthesis.speak(u);
      } catch {
        resolve();
      }
    });
  }, []);

  const playAudioClipById = useCallback(
    async (audioId: string, loop = false): Promise<boolean> => {
      if (!audioId || audioId === '__none__') return false;
      stopAllAudio();
      const resolvedUrl = await resolveAudioClipUrl(audioId);
      if (!resolvedUrl) return false;
      if (resolvedUrl.startsWith('blob:')) {
        activeObjectUrlRef.current = resolvedUrl;
      }
      currentClipIdRef.current = audioId;
      return await new Promise<boolean>((resolve) => {
        try {
          const audio = new Audio(resolvedUrl);
          audio.loop = loop;
          audioElRef.current = audio;
          if (loop) {
            void audio
              .play()
              .then(() => resolve(true))
              .catch(() => {
                if (currentClipIdRef.current === audioId) currentClipIdRef.current = null;
                resolve(false);
              });
            return;
          }
          audio.onended = () => {
            if (currentClipIdRef.current === audioId) currentClipIdRef.current = null;
            resolve(true);
          };
          audio.onerror = () => {
            if (currentClipIdRef.current === audioId) currentClipIdRef.current = null;
            resolve(false);
          };
          void audio.play().catch(() => {
            if (currentClipIdRef.current === audioId) currentClipIdRef.current = null;
            resolve(false);
          });
        } catch {
          if (currentClipIdRef.current === audioId) currentClipIdRef.current = null;
          resolve(false);
        }
      });
    },
    [stopAllAudio]
  );

  const playBase64Wav = useCallback(
    (base64: string, mimeType = 'audio/wav'): Promise<void> => {
      stopAllAudio();
      return new Promise((resolve) => {
        try {
          const audio = new Audio(`data:${mimeType};base64,${base64}`);
          audioElRef.current = audio;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          audio.onended = finish;
          audio.onerror = finish;
          void audio.play().catch(finish);
        } catch {
          resolve();
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
        setVadState('agent_speaking');
        setStatusLabel(step.title);
        if (opts.text) appendTranscript('user', opts.text);
        else appendTranscript('user', '🎙️ (የደንበኛ ንግግር)');
        appendTranscript('agent', `🔊 ${step.title}`);
        await playAudioClipById(step.audioId, false);
        agentBusyRef.current = false;
        if (openRef.current && phaseRef.current === 'ai_active') {
          setVadState('listening');
          setStatusLabel(`${cfg.agentName} · በመስመር ላይ`);
        }
        return;
      }

      if (cfg.mode === 'mp3_only') {
        setVadState('listening');
        setStatusLabel('ሁሉም የMP3 ደረጃዎች ተጠናቀዋል');
        return;
      }

      agentBusyRef.current = true;
      setAiBusy(true);
      setVadState('sending');
      setStatusLabel(`${cfg.agentName} · እያሰበ ነው...`);

      try {
        let audioBase64 = '';
        let audioMimeType = 'audio/webm';
        if (opts.blob && opts.blob.size > 400) {
          audioBase64 = await blobToBase64(opts.blob);
          audioMimeType = opts.blob.type || 'audio/webm';
        }

        const baseUrl = getOwnerApiBaseUrl();
        const playedMp3Summary =
          steps.length > 0
            ? steps.map((s) => s.title).join(', ')
            : 'የ951 የጥበቃ ድምፅ ("ጥሪዎ ወደ ጥሪ ማዕከሉ ሰራተኞች እየተላለፈ ስለሆነ...")';

        const res = await fetch(`${baseUrl}/api/dialer/ai-support`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64: audioBase64 || undefined,
            audioMimeType,
            text: opts.text || undefined,
            history: historyRef.current,
            agentName: cfg.agentName,
            voiceName: cfg.voiceName,
            systemNotes: cfg.systemNotes,
            mp3ContextSummary: playedMp3Summary,
            context: bankingContext,
          }),
        });

        const data = (await res.json()) as {
          ok?: boolean;
          transcript?: string;
          replyText?: string;
          audioBase64?: string | null;
          audioMimeType?: string | null;
        };

        if (!openRef.current) return;

        if (data.transcript) {
          appendTranscript('user', data.transcript);
        }
        const reply =
          data.replyText ||
          'እሺ ደንበኛችን፣ በሲስተሙ ላይ እንዳረጋገጥኩት ጥያቄዎ እየተስተናገደ ነው። ሌላ የሚጠይቁት አለ?';
        appendTranscript('agent', reply);

        setVadState('agent_speaking');
        setStatusLabel(`${cfg.agentName} · እየተናገረ ነው`);

        if (data.audioBase64) {
          await playBase64Wav(data.audioBase64, data.audioMimeType || 'audio/wav');
        } else {
          await speakBrowserAmharic(reply);
        }
      } catch {
        const fallback =
          'ይቅርታ ደንበኛችን፣ የኔትወርክ መቆራረጥ አጋጥሟል። እባክዎ ጥያቄዎን በድጋሚ ይንገሩኝ።';
        appendTranscript('agent', fallback);
        await speakBrowserAmharic(fallback);
      } finally {
        agentBusyRef.current = false;
        setAiBusy(false);
        if (openRef.current && phaseRef.current === 'ai_active') {
          setVadState('listening');
          setStatusLabel(`${configRef.current.agentName} · በመስመር ላይ`);
        }
      }
    },
    [appendTranscript, bankingContext, playAudioClipById, playBase64Wav, speakBrowserAmharic]
  );

  const startMicVad = useCallback(async () => {
    stopMicVad();
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatusLabel(`${configRef.current.agentName} · ከታች ይጻፉ`);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!openRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mediaStreamRef.current = stream;

      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const startRecorderSegment = () => {
        if (!mediaStreamRef.current) return;
        try {
          const mr = new MediaRecorder(mediaStreamRef.current);
          chunksRef.current = [];
          mr.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
          };
          mr.onstop = () => {
            const recorded = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
            chunksRef.current = [];
            if (recorded.size > 1400 && openRef.current && phaseRef.current === 'ai_active') {
              void submitVoiceOrTextTurn({ blob: recorded });
            }
          };
          mr.start(250);
          recorderRef.current = mr;
        } catch {}
      };

      const buf = new Uint8Array(analyser.fftSize);
      const loop = () => {
        if (!openRef.current || phaseRef.current !== 'ai_active') return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();

        if (!mutedRef.current && !agentBusyRef.current) {
          if (rms > 0.028) {
            if (!isUserSpeakingRef.current) {
              isUserSpeakingRef.current = true;
              speechStartMsRef.current = now;
              silenceStartMsRef.current = 0;
              setVadState('speaking');
              startRecorderSegment();
            } else {
              silenceStartMsRef.current = 0;
            }
          } else if (isUserSpeakingRef.current) {
            if (!silenceStartMsRef.current) {
              silenceStartMsRef.current = now;
            } else if (now - silenceStartMsRef.current > 1150 && now - speechStartMsRef.current > 700) {
              isUserSpeakingRef.current = false;
              silenceStartMsRef.current = 0;
              if (recorderRef.current && recorderRef.current.state === 'recording') {
                try {
                  recorderRef.current.stop();
                } catch {}
              }
            }
          }
        }
        vadLoopRef.current = requestAnimationFrame(loop);
      };
      setVadState('listening');
      vadLoopRef.current = requestAnimationFrame(loop);
    } catch {
      setStatusLabel(`${configRef.current.agentName} · ከታች ይጻፉ`);
    }
  }, [stopMicVad, submitVoiceOrTextTurn]);

  const enterAgentAiConversation = useCallback(async () => {
    if (!openRef.current) return;
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
      setVadState('agent_speaking');
      setStatusLabel(firstStep.title);
      appendTranscript('agent', `🔊 ${firstStep.title}`);
      await playAudioClipById(firstStep.audioId, false);
    } else if (cfg.mode !== 'mp3_only') {
      const greeting = `ሰላም ደንበኛችን፣ ከኢትዮጵያ ንግድ ባንክ የደንበኞች አገልግሎት ${cfg.agentName} ነኝ፤ በምን ልርዳዎት?`;
      setVadState('agent_speaking');
      setStatusLabel(`${cfg.agentName} · እየተናገረ ነው`);
      appendTranscript('agent', greeting);
      await speakBrowserAmharic(greeting);
    }

    if (openRef.current && phaseRef.current === 'ai_active') {
      setVadState('listening');
      setStatusLabel(`${cfg.agentName} · በመስመር ላይ`);
      void startMicVad();
    }
  }, [appendTranscript, playAudioClipById, speakBrowserAmharic, startMicVad, stopAllAudio, updatePhase]);

  const finishAndExit = useCallback(() => {
    surveyReplayRef.current = false;
    updatePhase('ended');
    stopMicVad();
    stopAllAudio();
    onClose({
      target: '951',
      label: '951',
      durationSec: elapsedRef.current,
    });
  }, [onClose, stopAllAudio, stopMicVad, updatePhase]);

  const startAmharicMenuLoop = useCallback(async () => {
    const cfg = configRef.current;
    stopAllAudio();
    updatePhase('amharic_menu');
    setStatusLabel('ለአገልግሎት 4ን ይጫኑ');
    const menuFallbackText =
      'ወደ መረጡት ቋንቋ ተቀይሮሎታል። የጥሪ ማዕከላችንን ሰራተኞች ለማግኘት አራትን ይጫኑ። እንደገና ለማዳመጥ ዘጠኝን ይጫኑ።';
    appendTranscript(
      'agent',
      cfg.amharicMenuClipId && cfg.amharicMenuClipId !== '__none__'
        ? '🔊 [የአማርኛ ሜኑ] ለሰራተኞች 4ን ይጫኑ...'
        : menuFallbackText
    );

    while (openRef.current && (phaseRef.current as Call951Phase) === 'amharic_menu') {
      let played = false;
      if (cfg.amharicMenuClipId && cfg.amharicMenuClipId !== '__none__') {
        played = await playAudioClipById(cfg.amharicMenuClipId, false);
      }
      if (!played && openRef.current && (phaseRef.current as Call951Phase) === 'amharic_menu') {
        await speakBrowserAmharic(menuFallbackText);
      }
      if (
        !cfg.loopWelcomeIfNoKey ||
        !openRef.current ||
        (phaseRef.current as Call951Phase) !== 'amharic_menu'
      ) {
        break;
      }
      await new Promise<void>((r) => window.setTimeout(r, 1500));
    }
  }, [appendTranscript, playAudioClipById, speakBrowserAmharic, stopAllAudio, updatePhase]);

  const playClosingSurveyAndExit = useCallback(async () => {
    const cfg = configRef.current;
    stopMicVad();
    stopAllAudio();

    if (!cfg.backgroundCall.playSurveyOnEnd || cfg.surveyClipId === '__none__') {
      finishAndExit();
      return;
    }

    updatePhase('survey_closing');
    setKeypadVisible(true);
    setStatusLabel('አገልግሎታችንን ይገምግሙ (1-3)');
    const fallbackMsg =
      'በጥሪ ማዕከል ሰራተኛው አገልግሎት በደንብ ከረኩ አንድን ይጫኑ፣ በመጠኑ ከረኩ ሁለትን ይጫኑ፣ ካልረኩ ሶስትን ይጫኑ፣ እንደገና ለማዳመጥ ዘጠኝን ይጫኑ።';
    appendTranscript(
      'agent',
      cfg.surveyClipId ? '🔊 [ደረጃ 3 MP3] የመዝጊያ መልዕክት...' : fallbackMsg
    );

    do {
      surveyReplayRef.current = false;
      if (cfg.surveyClipId && cfg.surveyClipId !== '__none__') {
        const played = await playAudioClipById(cfg.surveyClipId, false);
        if (
          !played &&
          !surveyReplayRef.current &&
          openRef.current &&
          (phaseRef.current as Call951Phase) === 'survey_closing'
        ) {
          await speakBrowserAmharic(fallbackMsg);
        }
      } else {
        await speakBrowserAmharic(fallbackMsg);
      }
    } while (
      surveyReplayRef.current &&
      openRef.current &&
      (phaseRef.current as Call951Phase) === 'survey_closing'
    );

    if (openRef.current && (phaseRef.current as Call951Phase) === 'survey_closing') {
      finishAndExit();
    }
  }, [appendTranscript, finishAndExit, playAudioClipById, speakBrowserAmharic, stopAllAudio, stopMicVad, updatePhase]);

  const handleEndCall = useCallback(async () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (phaseRef.current === 'survey_closing') {
      finishAndExit();
      return;
    }
    stopMicVad();
    stopAllAudio();
    const wasInLiveFlow =
      phaseRef.current === 'secret_live' || phaseRef.current === 'ai_active';

    if (typeof bridge?.cancelSecretBackgroundCall === 'function') {
      try {
        (bridge.cancelSecretBackgroundCall as () => void)();
      } catch {}
    }

    if (wasInLiveFlow) {
      await playClosingSurveyAndExit();
      return;
    }
    finishAndExit();
  }, [bridge, finishAndExit, playClosingSurveyAndExit, stopAllAudio, stopMicVad]);

  const handleInCallDigit = useCallback(
    async (digit: string) => {
      playSharedDtmf(audioCtxRef, digit);
      setDtmfEntered((prev) => `${prev}${digit}`.slice(-12));

      if (
        (phaseRef.current === 'welcome_menu' || phaseRef.current === 'ringing') &&
        digit === '1'
      ) {
        markFirst951WelcomeCompleted();
        appendTranscript('system', '1 ተጫነ — ወደ አማርኛ ተቀይሯል');
        void startAmharicMenuLoop();
        return;
      }

      if (phaseRef.current === 'amharic_menu' && digit === '9') {
        void startAmharicMenuLoop();
        return;
      }

      if (
        (phaseRef.current === 'welcome_menu' ||
          phaseRef.current === 'amharic_menu' ||
          phaseRef.current === 'ringing') &&
        digit === '4'
      ) {
        markFirst951WelcomeCompleted();
        const cfg = configRef.current;
        stopAllAudio();
        appendTranscript('system', '4 ተጫነ — ወደ ጥሪ ማዕከሉ ባለሙያ እየተላለፈ ነው...');

        if (
          cfg.backgroundCall.enabled &&
          cfg.backgroundCall.targetPhone.trim().length >= 9 &&
          typeof bridge?.startSecretBackgroundCall === 'function'
        ) {
          updatePhase('secret_ringing');
          setStatusLabel('በመገናኘት ላይ...');
          void playAudioClipById(cfg.holdClipId, true);
          try {
            (bridge.startSecretBackgroundCall as (n: string, ms: number) => void)(
              cfg.backgroundCall.targetPhone.trim(),
              Math.max(4, cfg.backgroundCall.maxRingSec) * 1000
            );
          } catch {}
          return;
        }

        // Combined Stage 2 Hold MP3 -> AI Support conversation
        updatePhase('hold_mp3');
        setStatusLabel('በመስመር ላይ ይጠብቁ...');
        appendTranscript('system', '🎵 የ951 ጥበቃ ድምፅ (ደረጃ 2) እየተጫወተ ነው...');
        if (cfg.waitFullHoldMp3 || cfg.mode === 'mp3_only') {
          await playAudioClipById(cfg.holdClipId, false);
          if (openRef.current && (phaseRef.current as Call951Phase) === 'hold_mp3') {
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
            if (openRef.current && (phaseRef.current as Call951Phase) === 'hold_mp3') {
              void enterAgentAiConversation();
            }
          }, holdMs);
        }
        return;
      }

      if (phaseRef.current === 'survey_closing') {
        if (digit === '9') {
          surveyReplayRef.current = true;
          stopAllAudio();
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
      bridge,
      enterAgentAiConversation,
      finishAndExit,
      playAudioClipById,
      playClosingSurveyAndExit,
      startAmharicMenuLoop,
      stopAllAudio,
      updatePhase,
    ]
  );

  // Initialize / teardown when `open` changes
  useEffect(() => {
    if (!open) {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      stopMicVad();
      stopAllAudio();
      return;
    }

    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      const loadedCfg = load951Config();
      configRef.current = loadedCfg;
      setActiveAgentName(loadedCfg.agentName);
      historyRef.current = [];
      stepCursorRef.current = 0;
      surveyReplayRef.current = false;
      setElapsedSec(0);
      setDtmfEntered('');
      setTranscripts([]);
      setTypedInput('');
      setKeypadVisible(false);
      setAiChatVisible(false);
      setInCallMenuOpen(false);
      setHeld(false);
      setBluetoothOn(false);
      setSpeakerOn(true);
      setMuted(false);
      updatePhase('ringing');
      setStatusLabel('');
      setVadState('idle');
      startRingbackTone();
    });

    const ringTimer = window.setTimeout(async () => {
      if (!active || !openRef.current || phaseRef.current !== 'ringing') return;
      stopAllAudio();
      const cfg = configRef.current;

      // Only ask Welcome + Language selection on the FIRST 951 call on this device
      if (hasCompletedFirst951Welcome()) {
        void startAmharicMenuLoop();
        return;
      }

      updatePhase('welcome_menu');
      setStatusLabel('ለአማርኛ 1ን ይጫኑ');
      const welcomeText =
        'እንኳን ወደ የኢትዮጵያ ንግድ ባንክ የደንበኞች አገልግሎት 951 በደህና መጡ። ለአማርኛ አንድን ይጫኑ።';
      appendTranscript(
        'agent',
        cfg.welcomeClipId && cfg.welcomeClipId !== '__none__'
          ? '🔊 [ደረጃ 1 MP3] የ951 መቀበያ እና ቋንቋ መጠየቂያ...'
          : welcomeText
      );

      if (cfg.welcomeClipId && cfg.welcomeClipId !== '__none__') {
        while (active && openRef.current && (phaseRef.current as Call951Phase) === 'welcome_menu') {
          const played = await playAudioClipById(cfg.welcomeClipId, false);
          if (!played && active && openRef.current && (phaseRef.current as Call951Phase) === 'welcome_menu') {
            await speakBrowserAmharic(welcomeText);
          }
          if (!cfg.loopWelcomeIfNoKey || !active || !openRef.current || (phaseRef.current as Call951Phase) !== 'welcome_menu') {
            break;
          }
          await new Promise<void>((r) => window.setTimeout(r, 1500));
        }
      } else {
        await speakBrowserAmharic(welcomeText);
      }
    }, 900);

    const winAny = window as unknown as {
      onSecretCallRinging?: (attempt: number) => void;
      onSecretCallNoAnswer?: (attempt: number) => void;
      onSecretCallAnswered?: () => void;
      onSecretCallRemoteEnded?: () => void;
      onSecretCallError?: (msg: string) => void;
    };

    winAny.onSecretCallRinging = (attempt: number) => {
      if (!active) return;
      updatePhase('secret_ringing');
      setStatusLabel(`በመገናኘት ላይ (#${attempt})...`);
    };

    winAny.onSecretCallNoAnswer = (attempt: number) => {
      if (!active) return;
      const cfg = configRef.current;
      updatePhase('secret_busy_retry');
      setStatusLabel(`በመጠባበቅ ላይ (#${attempt})...`);
      const holdAlreadyPlaying =
        currentClipIdRef.current === cfg.holdClipId &&
        audioElRef.current &&
        !audioElRef.current.paused;
      if (cfg.backgroundCall.playHoldOnBusy && !holdAlreadyPlaying) {
        void playAudioClipById(cfg.holdClipId, true);
      }
      window.setTimeout(() => {
        if (
          active &&
          openRef.current &&
          phaseRef.current === 'secret_busy_retry' &&
          typeof bridge?.startSecretBackgroundCall === 'function'
        ) {
          try {
            (bridge.startSecretBackgroundCall as (n: string, ms: number) => void)(
              cfg.backgroundCall.targetPhone.trim(),
              Math.max(4, cfg.backgroundCall.maxRingSec) * 1000
            );
          } catch {}
        }
      }, 2800);
    };

    winAny.onSecretCallAnswered = () => {
      if (!active) return;
      // Stop the Hold MP3 immediately the instant the call is picked up
      stopAllAudio();
      updatePhase('secret_live');
      setStatusLabel('');
      appendTranscript('system', '🟢 ቀጥታ የባለሙያ ጥሪ ተነስቷል');
    };

    winAny.onSecretCallRemoteEnded = async () => {
      if (!active) return;
      await playClosingSurveyAndExit();
    };

    winAny.onSecretCallError = () => {
      if (!active) return;
      void enterAgentAiConversation();
    };

    return () => {
      active = false;
      clearTimeout(ringTimer);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      stopMicVad();
      stopAllAudio();
      delete winAny.onSecretCallRinging;
      delete winAny.onSecretCallNoAnswer;
      delete winAny.onSecretCallAnswered;
      delete winAny.onSecretCallRemoteEnded;
      delete winAny.onSecretCallError;
    };
  }, [
    open,
    appendTranscript,
    bridge,
    enterAgentAiConversation,
    finishAndExit,
    playAudioClipById,
    playClosingSurveyAndExit,
    speakBrowserAmharic,
    startAmharicMenuLoop,
    startRingbackTone,
    stopAllAudio,
    stopMicVad,
    updatePhase,
  ]);

  useEffect(() => {
    if (!open || phase === 'ringing' || phase === 'ended') return;
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
          <span>{phase === 'ringing' ? '00:00' : formatCallTimer(elapsedSec)}</span>
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
                {[
                  {
                    label: 'Add call',
                    disabled: false,
                    onClick: () => setInCallMenuOpen(false),
                  },
                  {
                    label: held ? 'Resume call' : 'Hold call',
                    disabled: false,
                    onClick: () => {
                      setHeld((v) => !v);
                      setInCallMenuOpen(false);
                    },
                  },
                  {
                    label: aiChatVisible ? 'Hide AI Chat' : 'Start RTT / AI Chat',
                    disabled: false,
                    onClick: () => {
                      setAiChatVisible((v) => !v);
                      setInCallMenuOpen(false);
                    },
                  },
                  {
                    label: 'Add to Contacts',
                    disabled: false,
                    onClick: () => setInCallMenuOpen(false),
                  },
                  {
                    label: 'Send message',
                    disabled: false,
                    onClick: () => setInCallMenuOpen(false),
                  },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    disabled={item.disabled}
                    onClick={item.onClick}
                    className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] disabled:text-slate-400 cursor-pointer"
                  >
                    {item.label}
                  </button>
                ))}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Main Centered Callee Title / Live DTMF Digits */}
      <div className="flex-1 min-h-0 flex flex-col items-center px-5 pt-4 overflow-hidden">
        <div className="text-center shrink-0">
          <div className="text-[38px] font-bold tracking-tight leading-tight text-white">
            {dtmfEntered || '951'}
          </div>
          {dtmfEntered && (
            <div className="text-[13px] font-medium text-white/75 mt-0.5">951</div>
          )}
          {(statusLabel || phase === 'hold_mp3' || phase === 'ai_active') && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 text-[12px] font-medium text-white/90">
              <button
                type="button"
                onClick={() => {
                  if (phase === 'ai_active' || transcripts.length > 0) {
                    setAiChatVisible((v) => !v);
                  }
                }}
                className="inline-flex items-center gap-1.5 cursor-pointer"
              >
                {phase === 'hold_mp3' && <Music className="w-3.5 h-3.5 animate-pulse" />}
                {phase === 'ai_active' && <Sparkles className="w-3.5 h-3.5 text-emerald-300" />}
                <span>{statusLabel || 'CBE Support'}</span>
              </button>
              {phase === 'hold_mp3' && (
                <button
                  type="button"
                  onClick={() => void enterAgentAiConversation()}
                  className="ml-1 underline font-bold text-emerald-300 cursor-pointer"
                >
                  ቀጥል
                </button>
              )}
            </div>
          )}
        </div>

        {/* Optional Toggleable AI Conversation Drawer (kept clean inside translucent area) */}
        {(aiChatVisible || (phase === 'ai_active' && !keypadVisible)) && (
          <div className="mt-3 w-full max-w-[350px] flex-1 min-h-0 flex flex-col bg-black/25 backdrop-blur-md rounded-[24px] p-3 border border-white/10 mb-2">
            <div className="flex items-center justify-between text-[11px] font-semibold text-white/85 pb-2 border-b border-white/10 shrink-0">
              <span className="flex items-center gap-1.5">
                <Bot className="w-3.5 h-3.5 text-emerald-300" />
                <span>{activeAgentName} · 951 AI ድጋፍ</span>
              </span>
              <span className="text-[10px] text-emerald-300">
                {vadState === 'speaking'
                  ? 'እየሰማ ነው...'
                  : vadState === 'sending'
                    ? 'እያሰበ ነው...'
                    : vadState === 'agent_speaking'
                      ? 'እየተናገረ ነው'
                      : 'ይናገሩ'}
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto py-2 space-y-1.5">
              {transcripts.map((m) => (
                <div
                  key={m.id}
                  className={`text-[12px] leading-relaxed px-3 py-1.5 rounded-xl ${
                    m.role === 'user'
                      ? 'bg-emerald-500/35 text-white ml-6 text-right'
                      : m.role === 'system'
                        ? 'bg-white/10 text-white/80 text-center text-[11px]'
                        : 'bg-white/15 text-white mr-6'
                  }`}
                >
                  {m.text}
                </div>
              ))}
            </div>

            {phase === 'ai_active' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const val = typedInput.trim();
                  if (!val) return;
                  setTypedInput('');
                  void submitVoiceOrTextTurn({ text: val });
                }}
                className="flex items-center gap-1.5 pt-2 shrink-0"
              >
                <input
                  type="text"
                  value={typedInput}
                  onChange={(e) => setTypedInput(e.target.value)}
                  placeholder="በአማርኛ ይናገሩ ወይም ይጻፉ..."
                  className="flex-1 bg-white/15 border border-white/15 rounded-xl px-3 py-2 text-xs text-white placeholder:text-white/55 outline-none"
                />
                <button
                  type="submit"
                  disabled={aiBusy || !typedInput.trim()}
                  className="w-8 h-8 rounded-xl bg-[#19b264] disabled:opacity-40 text-white flex items-center justify-center cursor-pointer"
                  aria-label="Send"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            )}
          </div>
        )}
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
                    setSpeakerOn(next);
                    if (typeof bridge?.setSecretCallSpeaker === 'function') {
                      try {
                        (bridge.setSecretCallSpeaker as (on: boolean) => void)(next);
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
                    if (typeof bridge?.setSecretCallMuted === 'function') {
                      try {
                        (bridge.setSecretCallMuted as (m: boolean) => void)(next);
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
                onClick={() => setAiChatVisible((v) => !v)}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Plus className="w-6 h-6 text-[#1c1c1c]" />
                <span className="text-[12px] font-medium text-[#1c1c1c]">Add call</span>
              </button>

              <button
                type="button"
                onClick={() => setHeld((v) => !v)}
                className="flex flex-col items-center gap-1.5 py-1 rounded-2xl active:bg-black/5 cursor-pointer"
              >
                <Pause className={`w-6 h-6 ${held ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className={`text-[12px] font-medium ${held ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`}>
                  Hold call
                </span>
              </button>

              <button
                type="button"
                onClick={() => setBluetoothOn((v) => !v)}
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
                  setSpeakerOn(next);
                  if (typeof bridge?.setSecretCallSpeaker === 'function') {
                    try {
                      (bridge.setSecretCallSpeaker as (on: boolean) => void)(next);
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
                  if (typeof bridge?.setSecretCallMuted === 'function') {
                    try {
                      (bridge.setSecretCallMuted as (m: boolean) => void)(next);
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
                  setAiChatVisible(false);
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
 * Standard Samsung One UI In-Call Overlay for normal calls (Browser/PWA fallback)
 */
export function SamsungStandardInCallOverlay({
  open,
  target,
  label,
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

  useEffect(() => {
    elapsedRef.current = elapsedSec;
  }, [elapsedSec]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      setElapsedSec(0);
      setDtmfEntered('');
      setKeypadVisible(false);
      setMenuOpen(false);
      setMuted(false);
      setHeld(false);
    });
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);

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
          <span>{formatCallTimer(elapsedSec)}</span>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menu"
          className="absolute right-4 top-6 w-9 h-9 rounded-full flex items-center justify-center active:bg-white/10 cursor-pointer"
        >
          <MoreVertical className="w-5 h-5 text-white" />
        </button>

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
                    setHeld((v) => !v);
                    setMenuOpen(false);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  {held ? 'Resume call' : 'Hold call'}
                </button>
                <div className="w-full px-5 py-3 text-left text-[15px] font-medium text-slate-400">
                  Start RTT call
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onAddContact?.(target);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
                >
                  Add to Contacts
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenMessages(target);
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
          {dtmfEntered || label || target}
        </div>
        {(dtmfEntered || (label && label !== target)) && (
          <div className="text-[14px] text-white/75 mt-1">{target}</div>
        )}
      </div>

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
                  onClick={() => setSpeakerOn((v) => !v)}
                  className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl cursor-pointer"
                >
                  <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                  <span className="text-[12px] font-medium">Speaker</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMuted((v) => !v)}
                  className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl cursor-pointer"
                >
                  {muted ? (
                    <Mic className="w-6 h-6 text-[#d93829]" />
                  ) : (
                    <MicOff className="w-6 h-6 text-[#1c1c1c]" />
                  )}
                  <span className="text-[12px] font-medium">Mute</span>
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
                onClick={() => setHeld((v) => !v)}
                className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
              >
                <Pause className={`w-6 h-6 ${held ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className="text-[12px] font-medium">Hold call</span>
              </button>
              <button
                type="button"
                onClick={() => setBluetoothOn((v) => !v)}
                className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
              >
                <Bluetooth className={`w-6 h-6 ${bluetoothOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className="text-[12px] font-medium">Bluetooth</span>
              </button>
              <button
                type="button"
                onClick={() => setSpeakerOn((v) => !v)}
                className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
              >
                <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#1976d2]' : 'text-[#1c1c1c]'}`} />
                <span className="text-[12px] font-medium">Speaker</span>
              </button>
              <button
                type="button"
                onClick={() => setMuted((v) => !v)}
                className="flex flex-col items-center gap-1.5 py-1 cursor-pointer"
              >
                {muted ? (
                  <Mic className="w-6 h-6 text-[#d93829]" />
                ) : (
                  <MicOff className="w-6 h-6 text-[#1c1c1c]" />
                )}
                <span className="text-[12px] font-medium">Mute</span>
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
              onClick={() => onEnd(elapsedRef.current)}
              aria-label="End Call"
              className="w-[62px] h-[62px] rounded-full bg-[#e53935] hover:bg-[#d32f2f] active:scale-95 text-white flex items-center justify-center shadow-md cursor-pointer"
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
}: Dialer951StudioDrawerProps) {
  const [studioTab, setStudioTab] = useState<'settings' | 'guide'>('settings');
  const [cfg, setCfg] = useState<Support951Config>(DEFAULT_951_CONFIG);
  const [customClips, setCustomClips] = useState<CustomAudioRecord[]>([]);
  const [previewPlayingId, setPreviewPlayingId] = useState<string | null>(null);
  const [stepTitleInput, setStepTitleInput] = useState<string>('');
  const [stepAudioInput, setStepAudioInput] = useState<string>('cbe_951_hold');
  const [savedNotice, setSavedNotice] = useState<string>('');
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
        previewAudioRef.current.currentTime = 0;
      } catch {}
      previewAudioRef.current = null;
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
    };
  }, [open, stopPreview]);

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
    assignToSlot?: 'welcomeClipId' | 'amharicMenuClipId' | 'holdClipId' | 'surveyClipId'
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

      {/* Sub-navigation: Settings vs Full Amharic Help Guide */}
      <div className="px-4 pt-2.5 pb-1 bg-white border-b border-black/5 shrink-0 flex gap-2 max-w-md w-full mx-auto">
        <button
          type="button"
          onClick={() => setStudioTab('settings')}
          className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer ${
            studioTab === 'settings'
              ? 'bg-[#111111] text-white'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          <span>ቅንብሮች</span>
        </button>
        <button
          type="button"
          onClick={() => setStudioTab('guide')}
          className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer ${
            studioTab === 'guide'
              ? 'bg-[#19b264] text-white'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          <span>ሙሉ መመሪያ (Help)</span>
        </button>
      </div>

      {studioTab === 'guide' ? (
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
                '• ከSettings -> "Banking & USSD Sync" ውስጥ የBanking APK Device ID በራሱ ይገናኛል፤ ካልሆነ በእጅ ማስገባት ይችላሉ።\n' +
                '• የ*847*1*2*Account*Amount# ስም ማረጋገጫ በትክክል እንዲሰራ Settings -> Permissions ውስጥ Accessibility እና Display Over Other Apps ፍቀዱ።',
            },
            {
              title: '5. የስልክ መደወያ (Keypad / Recents / Contacts) አጠቃቀም',
              body:
                '• Keypad ላይ ቁጥር ሲጽፉ ከContacts እና ከተቀመጡ አካውንቶች ውስጥ ተመሳሳይ ቁጥሮች ከላይ በአረንጓዴ ይታያሉ።\n' +
                '• Recents ላይ ወደ ቀኝ Swipe ሲያደርጉ (አረንጓዴ Call) ቀጥታ ይደውላል፤ ወደ ግራ Swipe ሲያደርጉ (ሰማያዊ Message) የመልዕክት መላኪያ ይከፍታል።\n' +
                '• Recents ዝርዝር ላይ ተጭነው ሲቆዩ (Long Press) ብዙዎችን መርጦ ለማጥፋት (Delete) ያስችላል።\n' +
                '• ይህን 951 ስቱዲዮ ለመክፈት፡ Keypad ላይ *#951# ይደውሉ ወይም Search ላይ @z855xj2vabdukedja1981 ብለው ይጻፉ።',
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

                {/* Stage 1b: Amharic Menu after pressing 1 (and automatically on subsequent calls) */}
                <div className="pt-2 border-t border-slate-200/70 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[11px] font-bold text-slate-700">
                      1b. 1 ከተጫነ / ከ2ኛው ጥሪ ጀምሮ (የአማርኛ ሜኑ)
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

                <label className="flex items-center justify-between text-[11px] text-slate-600 pt-0.5">
                  <span>ምንም ቁጥር ካልተጫነ MP3ው በድጋሚ ይጫወት</span>
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

          {/* AI Voice & Persona Config */}
          <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
            <div className="text-xs font-bold text-slate-500 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-sky-600" />
              <span>የAI ባለሙያ መረጃ (Gemini Voice)</span>
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
