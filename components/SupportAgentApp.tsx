'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowRight,
  Delete,
  Eye,
  EyeOff,
  Headphones,
  Loader2,
  Lock,
  LogOut,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  Radio,
  ShieldCheck,
  Smartphone,
  User,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { SupportCallSession } from '@/lib/owner-types';
import {
  LiveRtcConnectionStatus,
  LiveRtcPeer,
  playStreamInAudioElement,
  requestLiveMedia,
} from '@/lib/live-rtc';
import { startIncomingRingtone, stopIncomingRingtone } from '@/lib/call-ringtone';
import {
  answerSupportCallAsAgent,
  clearSupportNativeSession,
  consumeSupportNativePendingAction,
  declineSupportCallAsAgent,
  endSupportCallAsAgent,
  fetchSupportCallAsAgent,
  getSupportNativeSavedToken,
  listSupportCalls,
  loginSupportAgent,
  pushSupportSignalAsAgent,
  requestSupportNativeBackgroundPermissions,
  saveSupportNativeSession,
  setSupportNativeAudioMode,
  stopSupportNativeRinger,
  verifySupportAgentToken,
} from '@/lib/support-client';

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatClock(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function SupportAgentApp() {
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string>('');
  const [pinInput, setPinInput] = useState<string>('');
  const [showPin, setShowPin] = useState<boolean>(false);
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');
  const [shakeTick, setShakeTick] = useState<number>(0);

  const [ringingCalls, setRingingCalls] = useState<SupportCallSession[]>([]);
  const [recentCalls, setRecentCalls] = useState<SupportCallSession[]>([]);
  const [activeCall, setActiveCall] = useState<SupportCallSession | null>(null);
  const [callBusy, setCallBusy] = useState<boolean>(false);
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [speakerOn, setSpeakerOn] = useState<boolean>(true);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [ringSec, setRingSec] = useState<number>(0);
  const [rtcStatus, setRtcStatus] = useState<LiveRtcConnectionStatus>({
    ice: 'new',
    dataOpen: false,
    voiceConnected: false,
    hasRemoteAudio: false,
  });

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const rtcPeerRef = useRef<LiveRtcPeer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const activeCallRef = useRef<SupportCallSession | null>(null);
  const handledOfferSeqRef = useRef<number>(0);
  const micMutedRef = useRef<boolean>(false);
  const speakerOnRef = useRef<boolean>(true);
  const tokenRef = useRef<string>('');
  const ringingToneCallIdRef = useRef<string>('');
  const lastConsumedActionKeyRef = useRef<string>('');

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  useEffect(() => {
    speakerOnRef.current = speakerOn;
    if (activeCallRef.current?.status === 'active') {
      setSupportNativeAudioMode(true, speakerOn);
    }
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || remoteStreamRef.current,
      false
    );
  }, [speakerOn]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const teardownRtc = useCallback((stopMedia = true) => {
    stopIncomingRingtone();
    stopSupportNativeRinger();
    setSupportNativeAudioMode(false, false);
    if (rtcPeerRef.current) {
      rtcPeerRef.current.destroy(stopMedia);
      rtcPeerRef.current = null;
    }
    if (stopMedia && localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      localStreamRef.current = null;
    }
    remoteStreamRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    handledOfferSeqRef.current = 0;
    setRtcStatus({
      ice: 'closed',
      dataOpen: false,
      voiceConnected: false,
      hasRemoteAudio: false,
    });
  }, []);

  const ensurePeer = useCallback(() => {
    if (rtcPeerRef.current) return rtcPeerRef.current;
    const peer = new LiveRtcPeer({
      onStatus: (st) => setRtcStatus(st),
      onRemoteAudio: (stream) => {
        remoteStreamRef.current = stream;
        setSupportNativeAudioMode(true, speakerOnRef.current);
        playStreamInAudioElement(remoteAudioRef.current, stream, false);
      },
      onMessage: () => {},
    });
    if (localStreamRef.current) {
      peer.attachLocalStream(localStreamRef.current, micMutedRef.current, true);
    }
    rtcPeerRef.current = peer;
    return peer;
  }, []);

  const handleAnswerCall = useCallback(
    async (targetCall: SupportCallSession) => {
      const activeTok = tokenRef.current;
      if (!activeTok || callBusy) return;
      ringingToneCallIdRef.current = '';
      stopIncomingRingtone();
      stopSupportNativeRinger();
      setCallBusy(true);
      setMicMuted(false);
      micMutedRef.current = false;
      setSpeakerOn(true);
      speakerOnRef.current = true;
      setSupportNativeAudioMode(true, true);

      if (remoteAudioRef.current) {
        try {
          remoteAudioRef.current.muted = false;
          remoteAudioRef.current.volume = 1;
          void remoteAudioRef.current.play().catch(() => {});
        } catch {}
      }

      try {
        const fullCall =
          (targetCall.rtcOffer ? targetCall : null) ||
          (await fetchSupportCallAsAgent(activeTok, targetCall.callId).catch(() => null)) ||
          targetCall;

        if (fullCall.status !== 'ringing' && fullCall.status !== 'active') {
          setRingingCalls((prev) => prev.filter((c) => c.callId !== fullCall.callId));
          return;
        }

        setActiveCall({
          ...fullCall,
          status: 'active',
          answeredAtMs: fullCall.answeredAtMs || Date.now(),
        });
        setRingingCalls((prev) => prev.filter((c) => c.callId !== fullCall.callId));

        const mediaRes = await requestLiveMedia({ video: false });
        if (mediaRes.stream) {
          localStreamRef.current = mediaRes.stream;
        }

        let rtcAnswer = '';
        const targetSeq = Math.max(fullCall.rtcSeq || 1, 1);
        if (fullCall.rtcOffer) {
          const peer = ensurePeer();
          if (localStreamRef.current) {
            peer.attachLocalStream(localStreamRef.current, false, true);
          }
          rtcAnswer = (await peer.acceptOfferAndCreateAnswer(fullCall.rtcOffer, { video: false })) || '';
          if (rtcAnswer) {
            handledOfferSeqRef.current = targetSeq;
          }
        }

        const updated = await answerSupportCallAsAgent(activeTok, fullCall.callId, {
          rtcAnswer: rtcAnswer || undefined,
          rtcSeq: targetSeq,
          supportMicMuted: false,
        });
        if (updated) {
          setActiveCall(updated);
          if (updated.rtcOffer && !rtcAnswer) {
            const peer = ensurePeer();
            const created = await peer.acceptOfferAndCreateAnswer(updated.rtcOffer, { video: false });
            if (created) {
              handledOfferSeqRef.current = Math.max(updated.rtcSeq || 1, 1);
              await pushSupportSignalAsAgent(activeTok, updated.callId, {
                rtcSeq: handledOfferSeqRef.current,
                rtcAnswer: created,
                supportMicMuted: false,
              });
            }
          }
        }
      } finally {
        setCallBusy(false);
      }
    },
    [callBusy, ensurePeer]
  );

  const handleDeclineCall = useCallback(async (callId: string) => {
    const activeTok = tokenRef.current;
    if (!activeTok) return;
    ringingToneCallIdRef.current = '';
    stopIncomingRingtone();
    stopSupportNativeRinger();
    setRingingCalls((prev) => prev.filter((c) => c.callId !== callId));
    await declineSupportCallAsAgent(activeTok, callId).catch(() => {});
  }, []);

  const handleEndActiveCall = useCallback(async () => {
    const current = activeCallRef.current;
    const activeTok = tokenRef.current;
    teardownRtc(true);
    setActiveCall(null);
    if (current && activeTok) {
      await endSupportCallAsAgent(activeTok, current.callId).catch(() => {});
    }
  }, [teardownRtc]);

  const handleToggleMic = useCallback(async () => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    if (rtcPeerRef.current) {
      rtcPeerRef.current.setMicMuted(next);
    } else if (localStreamRef.current) {
      for (const track of localStreamRef.current.getAudioTracks()) {
        track.enabled = !next;
      }
    }
    const current = activeCallRef.current;
    const activeTok = tokenRef.current;
    if (current && activeTok) {
      await pushSupportSignalAsAgent(activeTok, current.callId, {
        supportMicMuted: next,
      }).catch(() => {});
    }
  }, []);

  // Restore native APK saved session on mount if valid
  useEffect(() => {
    let mounted = true;
    (async () => {
      const saved = getSupportNativeSavedToken();
      if (saved) {
        const valid = await verifySupportAgentToken(saved).catch(() => false);
        if (mounted && valid) {
          setToken(saved);
          saveSupportNativeSession(saved);
        } else if (mounted && !valid) {
          clearSupportNativeSession();
        }
      }
      if (mounted) setHydrated(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Poll queue + handle active call state & native lock-screen Answer intent
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const checkPendingNativeAction = async () => {
      const pending = consumeSupportNativePendingAction();
      if (!pending) return;
      const actionKey = `${pending.action}:${pending.callId}`;
      if (lastConsumedActionKeyRef.current === actionKey) return;
      lastConsumedActionKeyRef.current = actionKey;
      if (pending.action === 'answer_support_call') {
        const sess = await fetchSupportCallAsAgent(token, pending.callId).catch(() => null);
        if (sess && !cancelled && (sess.status === 'ringing' || sess.status === 'active')) {
          await handleAnswerCall(sess);
        }
      } else if (pending.action === 'decline_support_call') {
        await handleDeclineCall(pending.callId);
      }
    };

    const poll = async () => {
      if (cancelled) return;
      await checkPendingNativeAction();

      const currentActive = activeCallRef.current;
      if (currentActive && currentActive.status === 'active') {
        const latest = await fetchSupportCallAsAgent(token, currentActive.callId).catch(() => null);
        if (cancelled) return;
        if (!latest || latest.status === 'ended' || latest.status === 'declined' || latest.status === 'missed') {
          teardownRtc(true);
          setActiveCall(null);
          return;
        }
        setActiveCall(latest);
        if (latest.rtcOffer && latest.rtcSeq > handledOfferSeqRef.current) {
          handledOfferSeqRef.current = latest.rtcSeq;
          const peer = ensurePeer();
          const ans = await peer.acceptOfferAndCreateAnswer(latest.rtcOffer, { video: false }).catch(() => null);
          if (ans) {
            await pushSupportSignalAsAgent(token, latest.callId, {
              rtcSeq: latest.rtcSeq,
              rtcAnswer: ans,
              supportMicMuted: micMutedRef.current,
            }).catch(() => {});
          }
        }
        return;
      }

      const listRes = await listSupportCalls(token, true);
      if (cancelled) return;
      if (listRes.unauthorized) {
        clearSupportNativeSession();
        teardownRtc(true);
        setActiveCall(null);
        setToken('');
        return;
      }
      setRingingCalls(listRes.ringingCalls);
      setRecentCalls(listRes.calls.filter((c) => c.status !== 'ringing').slice(0, 12));

      const topRinging = listRes.ringingCalls[0] || null;
      if (topRinging) {
        if (ringingToneCallIdRef.current !== topRinging.callId) {
          ringingToneCallIdRef.current = topRinging.callId;
          // Play subtle in-app ringtone if web/foreground (native service handles lockscreen ringing inside APK)
          const isApk = typeof window !== 'undefined' && window.location.origin.includes('appassets.androidplatform.net');
          if (!isApk) {
            startIncomingRingtone({ playAudio: true, vibrate: true });
          }
        }
      } else if (ringingToneCallIdRef.current) {
        ringingToneCallIdRef.current = '';
        stopIncomingRingtone();
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ensurePeer, handleAnswerCall, handleDeclineCall, teardownRtc, token]);

  // Timers for active call and ringing call
  useEffect(() => {
    let mounted = true;
    if (activeCall?.status === 'active') {
      const startMs = activeCall.answeredAtMs || Date.now();
      const update = () => {
        if (mounted) setElapsedSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
      };
      Promise.resolve().then(update);
      const iv = window.setInterval(update, 1000);
      return () => {
        mounted = false;
        window.clearInterval(iv);
      };
    }
    Promise.resolve().then(() => {
      if (mounted) setElapsedSec(0);
    });
    return () => {
      mounted = false;
    };
  }, [activeCall?.answeredAtMs, activeCall?.status]);

  useEffect(() => {
    let mounted = true;
    const firstRinging = ringingCalls[0];
    if (firstRinging && !activeCall) {
      const startMs = firstRinging.startedAtMs || Date.now();
      const update = () => {
        if (mounted) setRingSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
      };
      Promise.resolve().then(update);
      const iv = window.setInterval(update, 1000);
      return () => {
        mounted = false;
        window.clearInterval(iv);
      };
    }
    Promise.resolve().then(() => {
      if (mounted) setRingSec(0);
    });
    return () => {
      mounted = false;
    };
  }, [activeCall, ringingCalls]);

  useEffect(() => {
    return () => {
      teardownRtc(true);
    };
  }, [teardownRtc]);

  const submitPinLogin = async (candidatePin: string) => {
    const clean = candidatePin.trim();
    if (!clean || authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await loginSupportAgent(clean);
      if (res.ok && res.token) {
        setToken(res.token);
        setPinInput('');
        saveSupportNativeSession(res.token);
        requestSupportNativeBackgroundPermissions();
      } else {
        setAuthError(res.error || 'የተሳሳተ PIN ነው');
        setPinInput('');
        setShakeTick((n) => n + 1);
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = () => {
    teardownRtc(true);
    clearSupportNativeSession();
    setActiveCall(null);
    setRingingCalls([]);
    setToken('');
    setPinInput('');
    setAuthError('');
  };

  const handleKeypadDigit = (digit: string) => {
    if (authBusy || pinInput.length >= 6) return;
    const next = pinInput + digit;
    setPinInput(next);
    if (authError) setAuthError('');
    if (next.length === 4) {
      void submitPinLogin(next);
    }
  };

  if (!hydrated) {
    return <div className="w-full h-[100dvh] bg-[#0d111a]" />;
  }

  // ---------------- 1. LOGIN SCREEN (PIN: 0069) ----------------
  if (!token) {
    return (
      <div className="relative w-full h-[100dvh] bg-gradient-to-b from-[#170922] via-[#120d1f] to-[#090d16] text-white flex flex-col items-center justify-center p-4 overflow-y-auto select-none">
        <motion.div
          key={shakeTick}
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={
            shakeTick > 0
              ? { opacity: 1, y: 0, scale: 1, x: [0, -8, 8, -5, 5, 0] }
              : { opacity: 1, y: 0, scale: 1, x: 0 }
          }
          transition={{ duration: shakeTick > 0 ? 0.32 : 0.24 }}
          className="w-full max-w-[350px] rounded-3xl bg-white/[0.06] border border-white/15 backdrop-blur-xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="bg-gradient-to-r from-[#7a1c7d] to-[#561459] px-5 py-4 flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center shrink-0">
              <Headphones className="w-6 h-6 text-amber-300" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold tracking-tight text-white leading-tight">
                CBE 951 Support APK
              </h1>
              <p className="text-[11px] text-purple-100/85 truncate">
                የደንበኞች አገልግሎት መቀበያ • Support Login
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitPinLogin(pinInput);
            }}
            className="p-5 space-y-4"
          >
            <div className="text-center space-y-1">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-purple-500/20 border border-purple-400/30 text-[11px] font-semibold text-purple-200">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Support Agent Access</span>
              </div>
              <p className="text-xs text-slate-300 pt-1">
                ለመግባት የSupport PIN ቁጥር ያስገቡ
              </p>
            </div>

            {/* PIN Input */}
            <div className="space-y-1.5">
              <div
                className={`flex items-center rounded-2xl bg-black/35 border transition-colors ${
                  authError
                    ? 'border-rose-500/80 focus-within:border-rose-400'
                    : 'border-white/20 focus-within:border-purple-400'
                }`}
              >
                <div className="pl-3.5 pr-2 text-purple-300">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setPinInput(digits);
                    if (authError) setAuthError('');
                  }}
                  placeholder="PIN ያስገቡ (••••)"
                  aria-label="Support PIN"
                  className="w-full py-3 bg-transparent text-center font-mono text-lg tracking-[0.35em] text-white placeholder:text-slate-500 placeholder:text-xs placeholder:tracking-normal outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPin((v) => !v)}
                  className="w-11 h-11 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer shrink-0"
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {authError && (
                <p className="text-center text-xs font-semibold text-rose-400">{authError}</p>
              )}
            </div>

            {/* Quick Numeric Keypad */}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => handleKeypadDigit(d)}
                  disabled={authBusy}
                  className="h-12 rounded-2xl bg-white/[0.08] hover:bg-white/[0.15] active:scale-95 border border-white/10 font-semibold text-lg text-white transition-all cursor-pointer"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPinInput('');
                  setAuthError('');
                }}
                disabled={authBusy}
                className="h-12 rounded-2xl bg-white/[0.04] hover:bg-white/[0.1] text-xs font-semibold text-slate-300 border border-white/10 cursor-pointer"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => handleKeypadDigit('0')}
                disabled={authBusy}
                className="h-12 rounded-2xl bg-white/[0.08] hover:bg-white/[0.15] active:scale-95 border border-white/10 font-semibold text-lg text-white transition-all cursor-pointer"
              >
                0
              </button>
              <button
                type="button"
                onClick={() => setPinInput((p) => p.slice(0, -1))}
                disabled={authBusy}
                className="h-12 rounded-2xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/10 flex items-center justify-center text-slate-300 cursor-pointer"
                aria-label="Backspace"
              >
                <Delete className="w-5 h-5" />
              </button>
            </div>

            <button
              type="submit"
              disabled={authBusy || !pinInput.trim()}
              className="w-full h-12 rounded-2xl bg-gradient-to-r from-[#7a1c7d] to-[#9b289e] hover:brightness-110 active:scale-[0.99] disabled:opacity-50 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-purple-900/40 transition-all cursor-pointer"
            >
              {authBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>በመክፈት ላይ...</span>
                </>
              ) : (
                <>
                  <span>ግባ (Login)</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  // ---------------- 2. MAIN SUPPORT DESK UI ----------------
  const topRinging = ringingCalls[0] || null;

  return (
    <div className="relative w-full h-[100dvh] bg-[#0b0f17] text-white flex flex-col overflow-hidden select-none">
      {/* Hidden WebRTC Remote Audio Player */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Top Header */}
      <header className="shrink-0 bg-[#151b28] border-b border-white/10 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#7a1c7d] to-[#9b289e] flex items-center justify-center shadow shrink-0">
            <Headphones className="w-5 h-5 text-amber-300" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white truncate">CBE 951 Support Desk</h1>
            <div className="flex items-center gap-1.5 text-[10.5px] text-emerald-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Online • 951 ጥሪዎችን በመጠበቅ ላይ</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer shrink-0"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>ዝጋ (Lock)</span>
        </button>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Incoming 951 Ringing Card */}
        <AnimatePresence>
          {topRinging && !activeCall && (
            <motion.div
              key={topRinging.callId}
              initial={{ opacity: 0, y: -12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="rounded-3xl bg-gradient-to-br from-[#193b2d] via-[#132924] to-[#0f1722] border-2 border-emerald-400/70 p-5 shadow-2xl shadow-emerald-950/50 space-y-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 text-[11px] font-bold">
                  <PhoneIncoming className="w-3.5 h-3.5 animate-bounce" />
                  <span>951 SUPPORT ጥሪ እየመጣ ነው</span>
                </span>
                <span className="font-mono text-xs font-bold text-emerald-300">
                  {formatDuration(ringSec)}
                </span>
              </div>

              <div className="flex items-center gap-3.5">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-400/35 flex items-center justify-center shrink-0">
                  <User className="w-7 h-7 text-emerald-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold text-white truncate">
                    {topRinging.userName || 'CBEBirr Customer'}
                  </h2>
                  <p className="text-xs text-emerald-200/90 font-mono">
                    {topRinging.phoneNumber || 'Unknown Phone'}
                  </p>
                  <p className="text-[11px] text-slate-300 flex items-center gap-1 mt-0.5 truncate">
                    <Smartphone className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    <span className="truncate">{topRinging.deviceName}</span>
                  </p>
                </div>
              </div>

              {/* Real-time Banking Context */}
              <div className="grid grid-cols-2 gap-2 rounded-2xl bg-black/30 border border-white/10 p-3 text-xs">
                <div>
                  <div className="text-[10px] text-slate-400">CBE Account</div>
                  <div className="font-mono font-semibold text-white truncate">
                    {topRinging.userAccount || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400">Synced Balance</div>
                  <div className="font-mono font-bold text-amber-300">
                    {Number(topRinging.balance || 0).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    ETB
                  </div>
                </div>
              </div>

              {/* Answer / Decline Buttons */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleDeclineCall(topRinging.callId)}
                  disabled={callBusy}
                  className="h-13 rounded-2xl bg-rose-600 hover:bg-rose-500 active:scale-[0.98] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg cursor-pointer"
                >
                  <PhoneOff className="w-4 h-4" />
                  <span>ዝጋ (Decline)</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleAnswerCall(topRinging)}
                  disabled={callBusy}
                  className="h-13 rounded-2xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] text-slate-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/30 cursor-pointer"
                >
                  {callBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <PhoneCall className="w-4 h-4" />
                  )}
                  <span>አንሳ (Answer)</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Standby Empty State */}
        {!topRinging && !activeCall && (
          <div className="rounded-3xl bg-white/[0.04] border border-white/10 p-6 text-center space-y-3">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-purple-500/15 border border-purple-400/25 flex items-center justify-center">
              <Radio className="w-7 h-7 text-purple-300 animate-pulse" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-bold text-white">951 ጥሪ በመጠበቅ ላይ...</h2>
              <p className="text-xs text-slate-400 max-w-xs mx-auto leading-relaxed">
                Call APK ላይ <strong className="text-slate-200">*#951# Studio → Support App</strong>{' '}
                ሲበራ እና <strong className="text-slate-200">951</strong> ሲደወል ወዲያውኑ እዚህ ይጠራል።
              </p>
            </div>
          </div>
        )}

        {/* Recent 951 Support Calls */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
              የቅርብ ጊዜ 951 ጥሪዎች ({recentCalls.length})
            </h3>
          </div>

          {recentCalls.length === 0 ? (
            <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4 text-center text-xs text-slate-500">
              እስካሁን የተመዘገበ የ951 Support ጥሪ የለም
            </div>
          ) : (
            <div className="space-y-2">
              {recentCalls.map((c) => (
                <div
                  key={c.callId}
                  className="rounded-2xl bg-white/[0.04] border border-white/10 px-3.5 py-3 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
                      <Phone className="w-4 h-4 text-purple-300" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">
                        {c.userName || 'Customer'} • {c.deviceName}
                      </div>
                      <div className="text-[10.5px] text-slate-400 truncate font-mono">
                        {c.phoneNumber || '—'} • {formatClock(c.startedAtMs)}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase shrink-0 ${
                      c.status === 'ended' && c.answeredAtMs > 0
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : c.status === 'declined'
                          ? 'bg-rose-500/20 text-rose-300'
                          : 'bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {c.status === 'ended' && c.answeredAtMs > 0 ? 'Answered' : c.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen Active Call Overlay */}
      <AnimatePresence>
        {activeCall && activeCall.status === 'active' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-gradient-to-b from-[#170b24] via-[#0e1420] to-[#080c14] flex flex-col justify-between p-6"
          >
            <div className="pt-4 text-center space-y-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/35 text-emerald-300 text-xs font-bold">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>
                  {rtcStatus.voiceConnected || rtcStatus.hasRemoteAudio
                    ? '951 Live Voice Connected'
                    : `Connecting Audio (${rtcStatus.ice})...`}
                </span>
              </div>

              <div className="w-20 h-20 mx-auto mt-4 rounded-3xl bg-gradient-to-br from-[#7a1c7d] to-purple-800 border border-white/20 flex items-center justify-center shadow-xl">
                <User className="w-10 h-10 text-white" />
              </div>

              <h2 className="text-2xl font-bold text-white pt-2">
                {activeCall.userName || 'CBEBirr Customer'}
              </h2>
              <p className="text-sm font-mono text-purple-200">{activeCall.phoneNumber || '—'}</p>
              <p className="text-xs text-slate-300">{activeCall.deviceName}</p>
              <p className="font-mono text-xl font-bold text-emerald-300 pt-1">
                {formatDuration(elapsedSec)}
              </p>
            </div>

            {/* Real-time Account Info While Speaking */}
            <div className="rounded-3xl bg-white/[0.06] border border-white/15 p-4 grid grid-cols-2 gap-3 text-xs max-w-sm w-full mx-auto">
              <div>
                <div className="text-[10.5px] text-slate-400">Account Number</div>
                <div className="font-mono font-bold text-white text-sm mt-0.5 truncate">
                  {activeCall.userAccount || '—'}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] text-slate-400">Current Balance</div>
                <div className="font-mono font-bold text-amber-300 text-sm mt-0.5">
                  {Number(activeCall.balance || 0).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  ETB
                </div>
              </div>
            </div>

            {/* Controls */}
            <div className="pb-6 max-w-xs w-full mx-auto space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => void handleToggleMic()}
                  className={`h-16 rounded-2xl border flex flex-col items-center justify-center gap-1 text-xs font-semibold cursor-pointer transition-all ${
                    micMuted
                      ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                      : 'bg-white/10 border-white/15 text-white'
                  }`}
                >
                  {micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                  <span>{micMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSpeakerOn((s) => !s)}
                  className={`h-16 rounded-2xl border flex flex-col items-center justify-center gap-1 text-xs font-semibold cursor-pointer transition-all ${
                    speakerOn
                      ? 'bg-sky-500/25 border-sky-400 text-sky-200'
                      : 'bg-white/10 border-white/15 text-white'
                  }`}
                >
                  {speakerOn ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
                  <span>{speakerOn ? 'Speaker On' : 'Earpiece'}</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => void handleEndActiveCall()}
                className="w-full h-16 rounded-full bg-rose-600 hover:bg-rose-500 active:scale-[0.98] text-white font-bold text-base flex items-center justify-center gap-2 shadow-xl shadow-rose-950/60 cursor-pointer"
              >
                <PhoneOff className="w-5 h-5" />
                <span>ጥሪ ዝጋ (End Call)</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
