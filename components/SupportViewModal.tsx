'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Crosshair,
  Delete,
  Eraser,
  Hand,
  HelpCircle,
  Home,
  Keyboard,
  Mic,
  MicOff,
  Monitor,
  Phone,
  Power,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { DeviceClient, SupportCommandType, SupportSession } from '@/lib/owner-types';
import {
  endSupportView,
  fetchSupportCastState,
  pushSupportSignal,
  requestSupportView,
  sendSupportCommand,
  setNativeAudioMode,
} from '@/lib/owner-telemetry';
import {
  LiveRtcConnectionStatus,
  LiveRtcPeer,
  playStreamInAudioElement,
  requestLiveMicrophone,
} from '@/lib/live-rtc';

interface SupportViewModalProps {
  device: DeviceClient;
  requestedBy: 'app_0069' | 'ram_control';
  onClose: () => void;
}

const SAFE_NAV_STEPS: { label: string; step: number; tab: string }[] = [
  { label: 'Home', step: 4, tab: 'home' },
  { label: 'Send Phone', step: 15, tab: 'transfer' },
  { label: 'CBE Acct', step: 6, tab: 'transfer' },
  { label: 'Banks', step: 16, tab: 'transfer' },
  { label: 'Pay Bill', step: 11, tab: 'pay' },
  { label: 'Others', step: 14, tab: 'others' },
];

export default function SupportViewModal({
  device,
  requestedBy,
  onClose,
}: SupportViewModalProps) {
  const [session, setSession] = useState<SupportSession | null>(null);
  const [latestFrame, setLatestFrame] = useState<string>('');
  const [dcFrameCount, setDcFrameCount] = useState<number>(0);
  const [requesting, setRequesting] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [controlMode, setControlMode] = useState<'touch' | 'guide'>('touch');
  const [remoteText, setRemoteText] = useState<string>('');
  const [tipInput, setTipInput] = useState<string>('');
  const [ussdCodeInput, setUssdCodeInput] = useState<string>('*847#');
  const [ussdRequestState, setUssdRequestState] = useState<{
    requestId: string;
    code: string;
    status: 'waiting' | 'approved' | 'declined' | 'dialed' | 'failed';
    detail?: string;
  } | null>(null);
  const [showTools, setShowTools] = useState<boolean>(false);
  const [sendingCmd, setSendingCmd] = useState<boolean>(false);
  const [reconnecting, setReconnecting] = useState<boolean>(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  // Two-Way Live Audio State
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [speakerMuted, setSpeakerMuted] = useState<boolean>(false);
  const [remoteMicMuted, setRemoteMicMuted] = useState<boolean>(false);
  const [micReady, setMicReady] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>('');
  const [rtcStatus, setRtcStatus] = useState<LiveRtcConnectionStatus>({
    ice: 'new',
    dataOpen: false,
    voiceConnected: false,
    hasRemoteAudio: false,
  });

  const screenRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const rtcPeerRef = useRef<LiveRtcPeer | null>(null);
  const localMicStreamRef = useRef<MediaStream | null>(null);
  const activeOfferSeqRef = useRef<number>(0);
  const appliedAnswerSeqRef = useRef<number>(0);
  const dcCmdSeqRef = useRef<number>(0);
  const rtcStartedForSessionRef = useRef<boolean>(false);
  const rtcConnectingRef = useRef<boolean>(false);

  const micMutedRef = useRef<boolean>(false);
  const speakerMutedRef = useRef<boolean>(false);
  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);
  useEffect(() => {
    speakerMutedRef.current = speakerMuted;
    if (session?.status === 'active') {
      setNativeAudioMode(true, !speakerMuted);
    }
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || null,
      speakerMuted
    );
  }, [speakerMuted, session?.status]);

  useEffect(() => {
    const stream = rtcPeerRef.current?.getRemoteStream() || null;
    if (stream && (rtcStatus.hasRemoteAudio || rtcStatus.voiceConnected)) {
      playStreamInAudioElement(remoteAudioRef.current, stream, speakerMutedRef.current);
    }
  }, [rtcStatus.hasRemoteAudio, rtcStatus.voiceConnected]);

  const pollInFlightRef = useRef<boolean>(false);
  const consecutiveErrRef = useRef<number>(0);
  const latestFrameSeqRef = useRef<number>(0);
  const sessionRtcSeqRef = useRef<number>(0);
  useEffect(() => {
    sessionRtcSeqRef.current = Math.max(sessionRtcSeqRef.current, session?.rtcSeq || 0);
  }, [session?.rtcSeq]);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const lastWheelAtRef = useRef<number>(0);
  const autoRecoverTriedRef = useRef<boolean>(false);

  const teardownRtc = useCallback((stopMic = true) => {
    setNativeAudioMode(false, false);
    if (rtcPeerRef.current) {
      rtcPeerRef.current.destroy(stopMic);
      rtcPeerRef.current = null;
    }
    if (stopMic && localMicStreamRef.current) {
      for (const t of localMicStreamRef.current.getTracks()) {
        try {
          t.stop();
        } catch {}
      }
      localMicStreamRef.current = null;
      setMicReady(false);
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    activeOfferSeqRef.current = 0;
    appliedAnswerSeqRef.current = 0;
    rtcStartedForSessionRef.current = false;
    setRtcStatus({
      ice: 'closed',
      dataOpen: false,
      voiceConnected: false,
      hasRemoteAudio: false,
    });
  }, []);

  useEffect(() => {
    return () => {
      teardownRtc(true);
    };
  }, [teardownRtc]);

  const ensureOperatorRtcPeer = useCallback(() => {
    if (rtcPeerRef.current) return rtcPeerRef.current;
    const peer = new LiveRtcPeer({
      onStatus: (st) => {
        setRtcStatus(st);
      },
      onRemoteAudio: (stream) => {
        setNativeAudioMode(true, !speakerMutedRef.current);
        playStreamInAudioElement(remoteAudioRef.current, stream, speakerMutedRef.current);
      },
      onMessage: (msg) => {
        if (msg.type === 'frame' && msg.frame) {
          setLatestFrame(msg.frame);
          setDcFrameCount((prev) => Math.max(prev + 1, msg.seq || prev + 1));
          setReconnecting(false);
        } else if (msg.type === 'mic_state') {
          setRemoteMicMuted(Boolean(msg.muted));
        } else if (msg.type === 'ui_state') {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  currentStep: msg.currentStep || prev.currentStep,
                  screenTitle: msg.screenTitle || prev.screenTitle,
                  activeTab: msg.activeTab || prev.activeTab,
                }
              : prev
          );
        } else if (msg.type === 'ussd_status') {
          setUssdRequestState({
            requestId: msg.requestId,
            code: msg.code,
            status: msg.status,
            detail: msg.detail,
          });
        }
      },
    });
    if (localMicStreamRef.current) {
      peer.attachLocalStream(localMicStreamRef.current, micMutedRef.current);
    }
    rtcPeerRef.current = peer;
    return peer;
  }, []);

  const startOrRenegotiateRtc = useCallback(
    async (requestMicNow = true) => {
      if (rtcConnectingRef.current) return;
      rtcConnectingRef.current = true;
      try {
        if (requestMicNow && !localMicStreamRef.current) {
          const micRes = await requestLiveMicrophone();
          if (micRes.stream) {
            localMicStreamRef.current = micRes.stream;
            setMicReady(true);
            setMicError('');
          } else {
            setMicReady(false);
            setMicError(micRes.error || 'Mic unavailable');
          }
        }
        const peer = ensureOperatorRtcPeer();
        if (localMicStreamRef.current) {
          peer.attachLocalStream(localMicStreamRef.current, micMutedRef.current);
        }
        const nextSeq = Math.max(activeOfferSeqRef.current + 1, sessionRtcSeqRef.current + 1);
        activeOfferSeqRef.current = nextSeq;
        sessionRtcSeqRef.current = nextSeq;
        appliedAnswerSeqRef.current = 0;
        const offerJson = await peer.createOfferPayload(nextSeq);
        await pushSupportSignal(device.deviceId, true, {
          rtcSeq: nextSeq,
          rtcOffer: offerJson,
          micMuted: micMutedRef.current,
        });
      } catch {
        // Fallback HTTP cast stays active
      } finally {
        rtcConnectingRef.current = false;
      }
    },
    [device.deviceId, ensureOperatorRtcPeer]
  );

  // Start WebRTC live voice + DataChannel as soon as session turns active
  useEffect(() => {
    if (session?.status === 'active') {
      setNativeAudioMode(true, !speakerMutedRef.current);
      if (!rtcStartedForSessionRef.current) {
        rtcStartedForSessionRef.current = true;
        autoRecoverTriedRef.current = false;
        void startOrRenegotiateRtc(true);
      }
    } else if (session?.status === 'ended' || session?.status === 'declined') {
      if (rtcPeerRef.current || rtcStartedForSessionRef.current) {
        teardownRtc(true);
      }
    }
  }, [session?.status, startOrRenegotiateRtc, teardownRtc]);

  useEffect(() => {
    if (session?.status !== 'active') return;
    if (rtcStatus.ice === 'failed' || rtcStatus.ice === 'disconnected') {
      if (autoRecoverTriedRef.current) return;
      const tid = setTimeout(() => {
        autoRecoverTriedRef.current = true;
        void startOrRenegotiateRtc(false);
      }, 1800);
      return () => clearTimeout(tid);
    }
  }, [session?.status, rtcStatus.ice, startOrRenegotiateRtc]);

  const pollOnce = useCallback(async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const res = await fetchSupportCastState(
        device.deviceId,
        latestFrameSeqRef.current > 0 ? latestFrameSeqRef.current : undefined
      );
      if (res.supportSession) {
        const incoming = res.supportSession;
        setSession(incoming);
        setRemoteMicMuted(Boolean(incoming.clientMicMuted));

        if (incoming.ussdStatus) {
          try {
            const parsedUssd = JSON.parse(incoming.ussdStatus);
            if (parsedUssd?.requestId && parsedUssd?.status) {
              setUssdRequestState((prev) => {
                if (prev && prev.requestId === parsedUssd.requestId && prev.status !== 'waiting' && parsedUssd.status === 'waiting') {
                  return prev;
                }
                return {
                  requestId: String(parsedUssd.requestId),
                  code: String(parsedUssd.code || prev?.code || ''),
                  status: parsedUssd.status,
                  detail: parsedUssd.detail ? String(parsedUssd.detail) : undefined,
                };
              });
            }
          } catch {}
        }

        // Only update frame from HTTP when DataChannel isn't delivering live frames directly
        if (
          !rtcPeerRef.current?.isDataOpen() &&
          !res.frameUnchanged &&
          incoming.frameDataUrl
        ) {
          setLatestFrame(incoming.frameDataUrl);
          latestFrameSeqRef.current = incoming.frameSeq || latestFrameSeqRef.current + 1;
        }

        // Complete WebRTC handshake if target sent an SDP Answer for our active Offer
        if (
          incoming.status === 'active' &&
          incoming.rtcAnswer &&
          incoming.rtcSeq >= activeOfferSeqRef.current &&
          incoming.rtcSeq > appliedAnswerSeqRef.current &&
          rtcPeerRef.current
        ) {
          const ok = await rtcPeerRef.current.applyAnswerPayload(incoming.rtcAnswer).catch(() => false);
          if (ok) {
            appliedAnswerSeqRef.current = incoming.rtcSeq;
          }
        }

        consecutiveErrRef.current = 0;
        setReconnecting(false);
      } else {
        consecutiveErrRef.current += 1;
        if (consecutiveErrRef.current >= 3) setReconnecting(true);
      }
    } catch {
      consecutiveErrRef.current += 1;
      if (consecutiveErrRef.current >= 3) setReconnecting(true);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [device.deviceId]);

  const scheduleQuickRefresh = useCallback(() => {
    if (rtcPeerRef.current?.isDataOpen()) return;
    setTimeout(() => {
      void pollOnce();
    }, 80);
    setTimeout(() => {
      void pollOnce();
    }, 220);
  }, [pollOnce]);

  const startNewRequest = useCallback(async () => {
    setRequesting(true);
    setErrorMsg('');
    setLatestFrame('');
    setDcFrameCount(0);
    setUssdRequestState(null);
    latestFrameSeqRef.current = 0;
    teardownRtc(false);
    try {
      const created = await requestSupportView(device.deviceId, requestedBy);
      setSession(created);
      consecutiveErrRef.current = 0;
      setReconnecting(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to reach device right now.');
    } finally {
      setRequesting(false);
    }
  }, [device.deviceId, requestedBy, teardownRtc]);

  useEffect(() => {
    const t = setTimeout(() => {
      void startNewRequest();
    }, 0);
    return () => clearTimeout(t);
  }, [startNewRequest]);

  // Adaptive polling: 130ms fast HTTP live fallback until DataChannel opens, then 1400ms keepalive
  useEffect(() => {
    const status = session?.status;
    if (status !== 'pending' && status !== 'active') return;

    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setNowTick(Date.now());
      void pollOnce();
    };

    const intervalMs =
      status === 'pending'
        ? 850
        : rtcStatus.dataOpen && rtcStatus.voiceConnected
          ? 1400
          : 130;
    const intervalId = setInterval(tick, intervalMs);
    if (status === 'active') {
      void pollOnce();
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [session?.status, rtcStatus.dataOpen, rtcStatus.voiceConnected, pollOnce]);

  const handleToggleMic = async () => {
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || null,
      speakerMuted
    );

    if (!localMicStreamRef.current) {
      const micRes = await requestLiveMicrophone();
      if (!micRes.stream) {
        setMicError(micRes.error || 'Mic permission denied');
        return;
      }
      localMicStreamRef.current = micRes.stream;
      setMicReady(true);
      setMicError('');
      const peer = ensureOperatorRtcPeer();
      peer.attachLocalStream(micRes.stream, false);
      setMicMuted(false);
      // Renegotiate cleanly if peer already negotiated without local track
      void startOrRenegotiateRtc(false);
      return;
    }

    const nextMuted = !micMuted;
    setMicMuted(nextMuted);
    rtcPeerRef.current?.setMicMuted(nextMuted);
    rtcPeerRef.current?.sendMessage({ type: 'mic_state', muted: nextMuted });
    void pushSupportSignal(device.deviceId, true, { micMuted: nextMuted });
  };

  const handleToggleSpeaker = () => {
    const nextMuted = !speakerMuted;
    setSpeakerMuted(nextMuted);
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || null,
      nextMuted
    );
  };

  const handleEndSession = async () => {
    setSendingCmd(true);
    teardownRtc(true);
    try {
      const ended = await endSupportView(device.deviceId, true);
      if (ended) setSession(ended);
    } finally {
      setSendingCmd(false);
    }
  };

  const handleCloseModal = async () => {
    teardownRtc(true);
    if (session?.status === 'pending' || session?.status === 'active') {
      await endSupportView(device.deviceId, true).catch(() => {});
    }
    onClose();
  };

  const getCoordsPct = (clientX: number, clientY: number): { xPct: number; yPct: number } | null => {
    const el = screenRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const xPct = Math.max(1, Math.min(99, Number((((clientX - rect.left) / rect.width) * 100).toFixed(2))));
    const yPct = Math.max(1, Math.min(99, Number((((clientY - rect.top) / rect.height) * 100).toFixed(2))));
    return { xPct, yPct };
  };

  const dispatchLiveCommand = useCallback(
    async (
      cmd: {
        commandType: SupportCommandType;
        commandPayload?: string;
        pointerX?: number;
        pointerY?: number;
        pointerLabel?: string;
      },
      options?: { mirrorHttp?: boolean }
    ) => {
      dcCmdSeqRef.current += 1;
      const sentViaDc = rtcPeerRef.current?.sendMessage({
        type: 'cmd',
        commandType: cmd.commandType,
        commandPayload: cmd.commandPayload,
        pointerX: cmd.pointerX,
        pointerY: cmd.pointerY,
        pointerLabel: cmd.pointerLabel,
        seq: dcCmdSeqRef.current,
      });

      if (sentViaDc) {
        if (cmd.pointerX !== undefined && cmd.pointerY !== undefined) {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  pointerX: cmd.pointerX ?? prev.pointerX,
                  pointerY: cmd.pointerY ?? prev.pointerY,
                  pointerLabel: cmd.pointerLabel ?? prev.pointerLabel,
                }
              : prev
          );
        }
        if (!options?.mirrorHttp) return;
      }

      setSendingCmd(true);
      try {
        const updated = await sendSupportCommand(device.deviceId, cmd);
        if (updated) {
          setSession((prev) => (prev ? { ...prev, ...updated, frameDataUrl: prev.frameDataUrl } : updated));
        }
        scheduleQuickRefresh();
      } finally {
        setSendingCmd(false);
      }
    },
    [device.deviceId, scheduleQuickRefresh]
  );

  const handleRemoteScrollAction = useCallback(
    async (xPct: number, yPct: number, dyFrac: number) => {
      if (session?.status !== 'active') return;
      await dispatchLiveCommand({
        commandType: 'remote_scroll',
        commandPayload: JSON.stringify({
          xPct: Math.round(xPct),
          yPct: Math.round(yPct),
          dy: Number(dyFrac.toFixed(3)),
        }),
      });
    },
    [dispatchLiveCommand, session?.status]
  );

  const handleScreenPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (session?.status !== 'active') return;
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || null,
      speakerMuted
    );
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastY: e.clientY,
      moved: false,
    };
  };

  const handleScreenPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const totalDx = Math.abs(e.clientX - g.startX);
    const totalDy = Math.abs(e.clientY - g.startY);
    if (totalDx > 10 || totalDy > 10) {
      g.moved = true;
    }
    g.lastY = e.clientY;
  };

  const handleScreenPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || g.pointerId !== e.pointerId || session?.status !== 'active') return;

    const coords = getCoordsPct(e.clientX, e.clientY);
    if (!coords) return;

    const el = screenRef.current;
    const dyPx = e.clientY - g.startY;
    const dxPx = e.clientX - g.startX;

    // Vertical swipe gesture -> Remote Scroll
    if (g.moved && el && Math.abs(dyPx) >= 16 && Math.abs(dyPx) >= Math.abs(dxPx)) {
      const swipeFrac = Math.max(-0.75, Math.min(0.75, -(dyPx / el.getBoundingClientRect().height) * 1.35));
      await handleRemoteScrollAction(coords.xPct, coords.yPct, swipeFrac);
      return;
    }

    if (sendingCmd && !rtcPeerRef.current?.isDataOpen()) return;
    if (controlMode === 'touch') {
      await dispatchLiveCommand({
        commandType: 'remote_tap',
        commandPayload: JSON.stringify({ xPct: coords.xPct, yPct: coords.yPct }),
      });
    } else {
      await dispatchLiveCommand(
        {
          commandType: 'highlight_point',
          pointerX: Math.round(coords.xPct),
          pointerY: Math.round(coords.yPct),
          pointerLabel: 'Tap here',
          commandPayload: `${Math.round(coords.xPct)},${Math.round(coords.yPct)}`,
        },
        { mirrorHttp: true }
      );
    }
  };

  const handleScreenWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (session?.status !== 'active') return;
    const now = Date.now();
    if (now - lastWheelAtRef.current < 160) return;
    lastWheelAtRef.current = now;
    const coords = getCoordsPct(e.clientX, e.clientY) || { xPct: 50, yPct: 50 };
    const dyFrac = e.deltaY > 0 ? 0.3 : -0.3;
    void handleRemoteScrollAction(coords.xPct, coords.yPct, dyFrac);
  };

  const handleRemoteInputSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remoteText || session?.status !== 'active') return;
    const textToSend = remoteText;
    setRemoteText('');
    await dispatchLiveCommand({
      commandType: 'remote_input',
      commandPayload: JSON.stringify({ mode: 'append', text: textToSend }),
    });
  };

  const handleRemoteKey = async (key: 'backspace' | 'clear' | 'enter' | 'back' | 'home') => {
    if (session?.status !== 'active') return;
    await dispatchLiveCommand({
      commandType: key === 'home' ? 'navigate_step' : 'remote_key',
      commandPayload: key === 'home' ? '4' : key,
    });
  };

  const handleNavigateStep = async (step: number, label: string) => {
    if (session?.status !== 'active') return;
    await dispatchLiveCommand({
      commandType: 'navigate_step',
      commandPayload: String(step),
      pointerX: -1,
      pointerY: -1,
      pointerLabel: `Opened ${label}`,
    });
  };

  const handleSendTip = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tipInput.trim();
    if (!clean || session?.status !== 'active') return;
    setTipInput('');
    await dispatchLiveCommand({
      commandType: 'show_tip',
      commandPayload: clean,
    });
  };

  const handleClearPointer = async () => {
    if (session?.status !== 'active') return;
    await dispatchLiveCommand(
      {
        commandType: 'highlight_point',
        pointerX: -1,
        pointerY: -1,
        pointerLabel: '',
        commandPayload: '',
      },
      { mirrorHttp: true }
    );
  };

  const handleRequestRemoteUssd = async (overrideCode?: string) => {
    if (session?.status !== 'active') return;
    let code = (overrideCode ?? ussdCodeInput).trim();
    if (!code) return;
    if (!code.startsWith('*') && !code.startsWith('#')) {
      code = `*${code}`;
    }
    if (!code.endsWith('#')) {
      code = `${code}#`;
    }
    setUssdCodeInput(code);
    dcCmdSeqRef.current += 1;
    const randSuffix =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID().slice(0, 8)
        : String(dcCmdSeqRef.current);
    const requestId = `ussd_${dcCmdSeqRef.current}_${randSuffix}`;
    setUssdRequestState({
      requestId,
      code,
      status: 'waiting',
      detail: 'Waiting for user to tap OK...',
    });
    await dispatchLiveCommand(
      {
        commandType: 'request_ussd',
        commandPayload: JSON.stringify({ requestId, code }),
      },
      { mirrorHttp: true }
    );
  };

  const status = session?.status || (requesting ? 'pending' : 'ended');
  const pendingSecondsLeft =
    session?.status === 'pending'
      ? Math.max(0, Math.ceil((session.expiresAtMs - nowTick) / 1000))
      : 0;

  const liveBadgeText = rtcStatus.dataOpen
    ? `LIVE P2P #${Math.max(dcFrameCount, session?.frameSeq || 0)}`
    : reconnecting
      ? 'Reconnecting...'
      : `LIVE #${session?.frameSeq || 0}`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[97] bg-[#0b121b]/95 backdrop-blur-sm flex flex-col overflow-hidden text-slate-100 select-none"
    >
      {/* Hidden audio sink for live two-way voice */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Top Session Bar */}
      <div
        className={`px-3 py-2 border-b flex items-center justify-between gap-2 shrink-0 ${
          status === 'active'
            ? 'bg-emerald-950/90 border-emerald-500/40'
            : status === 'pending'
              ? 'bg-[#17212b] border-amber-400/30'
              : 'bg-[#17212b] border-white/10'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
              status === 'active'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-[#2b5278]/60 text-[#5eb5f7]'
            }`}
          >
            <Monitor className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[12.5px] font-bold text-white truncate">
                {status === 'active' ? 'Live Screen & Voice' : 'Support Connection'}
              </span>
              {status === 'active' && (
                <span
                  className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                    reconnecting
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-emerald-500/25 text-emerald-200'
                  }`}
                >
                  {reconnecting ? <WifiOff className="w-2.5 h-2.5" /> : <Wifi className="w-2.5 h-2.5" />}
                  {liveBadgeText}
                </span>
              )}
            </div>
            <p className="text-[10.5px] text-slate-300/80 truncate">
              {device.deviceName} • {device.userName || device.phoneNumber || device.deviceId}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {status === 'active' && (
            <button
              type="button"
              onClick={handleEndSession}
              disabled={sendingCmd}
              className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
            >
              <Power className="w-3 h-3" />
              <span>End</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCloseModal}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-200 cursor-pointer"
            aria-label="Close Support View"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col items-center justify-start gap-2">
        {errorMsg && (
          <div className="w-full max-w-[360px] bg-rose-500/20 border border-rose-500/40 rounded-xl p-2.5 text-[11.5px] text-rose-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* 1. Waiting for Explicit Consent */}
        {status === 'pending' && (
          <div className="w-full max-w-[330px] mt-6 bg-[#17212b] border border-white/10 rounded-2xl p-5 text-center space-y-3">
            <div className="w-14 h-14 mx-auto rounded-full bg-amber-500/15 border border-amber-400/30 flex items-center justify-center text-amber-300">
              <RefreshCw className="w-6 h-6 animate-spin" />
            </div>
            <h2 className="text-[15px] font-bold text-white">
              Waiting for User Permission
            </h2>
            <p className="text-[11.5px] text-slate-300 leading-relaxed">
              A consent prompt has been sent to <b>{device.deviceName}</b>. Live screen cast and two-way voice start immediately after the user taps <b>Allow</b>.
            </p>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#0e1621] text-[11px] font-mono text-amber-300">
              Expires in {pendingSecondsLeft || 45}s
            </div>
            <div className="pt-2 flex gap-2">
              <button
                type="button"
                onClick={handleCloseModal}
                className="flex-1 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-semibold cursor-pointer"
              >
                Cancel Request
              </button>
            </div>
          </div>
        )}

        {/* 2. Declined or Ended */}
        {(status === 'declined' || status === 'ended') && !requesting && (
          <div className="w-full max-w-[330px] mt-6 bg-[#17212b] border border-white/10 rounded-2xl p-5 text-center space-y-3">
            <div
              className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center ${
                status === 'declined'
                  ? 'bg-rose-500/15 border border-rose-400/30 text-rose-300'
                  : 'bg-slate-500/15 border border-white/15 text-slate-300'
              }`}
            >
              {status === 'declined' ? <X className="w-7 h-7" /> : <CheckCircle2 className="w-7 h-7" />}
            </div>
            <h2 className="text-[15px] font-bold text-white">
              {status === 'declined' ? 'Permission Declined' : 'Support Session Ended'}
            </h2>
            <p className="text-[11.5px] text-slate-300 leading-relaxed">
              {status === 'declined'
                ? 'The user declined the Support View request. No screen data or voice was shared.'
                : 'The live screen cast and voice session has ended.'}
            </p>
            <div className="pt-2 flex gap-2">
              <button
                type="button"
                onClick={handleCloseModal}
                className="flex-1 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-semibold cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={startNewRequest}
                className="flex-1 py-2 rounded-xl bg-[#2b5278] hover:bg-[#356696] text-white text-[12px] font-bold cursor-pointer"
              >
                Request Again
              </button>
            </div>
          </div>
        )}

        {/* 3. Active Live Screen Cast + Two-Way Live Voice + Remote Touch Control */}
        {status === 'active' && session && (
          <div className="w-full max-w-[360px] space-y-2">
            {/* Two-Way Voice & Mute/Unmute Control Bar */}
            <div className="bg-[#17212b] border border-emerald-500/30 rounded-xl px-2.5 py-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    rtcStatus.voiceConnected
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  <Radio
                    className={`w-3.5 h-3.5 ${
                      rtcStatus.voiceConnected ? 'animate-pulse' : ''
                    }`}
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold text-white truncate">
                    {rtcStatus.voiceConnected
                      ? 'Two-Way Voice Live'
                      : rtcStatus.ice === 'checking'
                        ? 'Connecting Voice...'
                        : 'Setting up Voice...'}
                  </p>
                  <p className="text-[9.5px] text-slate-300/80 truncate">
                    {micError
                      ? 'Tap Mic to allow'
                      : remoteMicMuted
                        ? 'Device mic is muted'
                        : 'Device mic active'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleToggleMic}
                  className={`px-2 py-1.5 rounded-lg text-[10.5px] font-bold flex items-center gap-1 cursor-pointer transition-colors ${
                    !micReady || micMuted
                      ? 'bg-rose-600/90 hover:bg-rose-500 text-white'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  }`}
                >
                  {!micReady || micMuted ? (
                    <MicOff className="w-3.5 h-3.5" />
                  ) : (
                    <Mic className="w-3.5 h-3.5" />
                  )}
                  <span>{!micReady ? 'Enable Mic' : micMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleSpeaker}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors border ${
                    speakerMuted
                      ? 'bg-amber-600/90 border-amber-400/50 text-white'
                      : 'bg-[#0e1621] border-white/10 text-slate-200 hover:bg-white/10'
                  }`}
                  aria-label={speakerMuted ? 'Unmute speaker' : 'Mute speaker'}
                  title={speakerMuted ? 'Unmute speaker' : 'Mute speaker'}
                >
                  {speakerMuted ? (
                    <VolumeX className="w-3.5 h-3.5" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void startOrRenegotiateRtc(true)}
                  className="w-8 h-8 rounded-lg bg-[#0e1621] border border-white/10 hover:bg-white/10 flex items-center justify-center text-slate-300 cursor-pointer"
                  aria-label="Reconnect voice"
                  title="Reconnect live voice"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Control Mode Switcher */}
            <div className="bg-[#17212b] border border-white/10 rounded-xl p-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setControlMode('touch')}
                className={`py-1.5 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                  controlMode === 'touch'
                    ? 'bg-emerald-600 text-white shadow'
                    : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <Hand className="w-3.5 h-3.5" />
                <span>Touch Control</span>
              </button>
              <button
                type="button"
                onClick={() => setControlMode('guide')}
                className={`py-1.5 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                  controlMode === 'guide'
                    ? 'bg-[#2b5278] text-white shadow'
                    : 'text-slate-300 hover:bg-white/5'
                }`}
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span>Guide Pointer</span>
              </button>
            </div>

            {/* Proportional Live Screen Cast Frame (720x1527 exact app aspect ratio) */}
            <div
              ref={screenRef}
              onPointerDown={handleScreenPointerDown}
              onPointerMove={handleScreenPointerMove}
              onPointerUp={handleScreenPointerUp}
              onPointerCancel={() => {
                gestureRef.current = null;
              }}
              onWheel={handleScreenWheel}
              style={{ aspectRatio: '720 / 1527', touchAction: 'none' }}
              className={`relative mx-auto w-[276px] sm:w-[300px] rounded-[22px] overflow-hidden border-[3px] border-[#334155] bg-[#111827] shadow-2xl ${
                controlMode === 'touch' ? 'cursor-pointer' : 'cursor-crosshair'
              }`}
            >
              {latestFrame ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={latestFrame}
                    alt="Live device screen cast"
                    draggable={false}
                    className="w-full h-full object-contain bg-[#0f172a] select-none pointer-events-none block"
                  />
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center space-y-2.5 bg-[#0f172a]">
                  <RefreshCw className="w-6 h-6 text-emerald-400 animate-spin" />
                  <p className="text-[11.5px] font-bold text-white">
                    Streaming Live Screen...
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {session.screenTitle || 'CBEBirr'} • Step {session.currentStep}
                  </p>
                </div>
              )}

              {/* Subtle Bottom Status Tag */}
              <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-black/70 text-[9px] font-mono text-emerald-200 pointer-events-none whitespace-nowrap flex items-center gap-1">
                <ShieldCheck className="w-2.5 h-2.5 text-emerald-400" />
                <span>
                  {session.screenTitle || `Step ${session.currentStep}`}
                </span>
              </div>

              {/* Visible Remote Guide Pointer Sync Overlay */}
              {session.pointerX >= 0 && session.pointerY >= 0 && (
                <div
                  style={{
                    left: `${session.pointerX}%`,
                    top: `${session.pointerY}%`,
                  }}
                  className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20 flex flex-col items-center"
                >
                  <div className="w-7 h-7 rounded-full border-2 border-emerald-400 bg-emerald-500/25 shadow-[0_0_12px_rgba(16,185,129,0.7)] flex items-center justify-center">
                    <Crosshair className="w-3.5 h-3.5 text-emerald-300" />
                  </div>
                  {session.pointerLabel && (
                    <span className="mt-0.5 px-1.5 py-0.5 rounded bg-emerald-700 text-white text-[9px] font-bold whitespace-nowrap shadow">
                      {session.pointerLabel}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Quick Navigation & Scroll Controls */}
            <div className="grid grid-cols-4 gap-1.5">
              <button
                type="button"
                onClick={() => void handleRemoteScrollAction(50, 50, -0.38)}
                className="py-1.5 rounded-xl bg-[#17212b] hover:bg-[#1e2c3a] border border-white/10 text-[10.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
              >
                <ArrowUp className="w-3 h-3 text-[#5eb5f7]" />
                <span>Up</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRemoteScrollAction(50, 50, 0.38)}
                className="py-1.5 rounded-xl bg-[#17212b] hover:bg-[#1e2c3a] border border-white/10 text-[10.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
              >
                <ArrowDown className="w-3 h-3 text-[#5eb5f7]" />
                <span>Down</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRemoteKey('back')}
                className="py-1.5 rounded-xl bg-[#17212b] hover:bg-[#1e2c3a] border border-white/10 text-[10.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
              >
                <ArrowLeft className="w-3 h-3 text-amber-300" />
                <span>Back</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRemoteKey('home')}
                className="py-1.5 rounded-xl bg-[#17212b] hover:bg-[#1e2c3a] border border-white/10 text-[10.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
              >
                <Home className="w-3 h-3 text-emerald-300" />
                <span>Home</span>
              </button>
            </div>

            {/* Remote Keyboard Input Bar */}
            <div className="bg-[#17212b] border border-white/10 rounded-xl p-2 space-y-1.5">
              <form onSubmit={handleRemoteInputSubmit} className="flex gap-1.5">
                <div className="relative flex-1">
                  <Keyboard className="w-3.5 h-3.5 text-[#7f91a4] absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={remoteText}
                    onChange={(e) => setRemoteText(e.target.value)}
                    maxLength={140}
                    placeholder="Type text into active field..."
                    className="w-full bg-[#0e1621] border border-white/10 rounded-lg pl-8 pr-2 py-1.5 text-[11px] text-white placeholder:text-slate-500 outline-none focus:border-emerald-400"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!remoteText}
                  className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  <Send className="w-3 h-3" />
                  <span>Type</span>
                </button>
              </form>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleRemoteKey('backspace')}
                  className="py-1 rounded-lg bg-[#0e1621] border border-white/10 text-[10px] font-semibold text-slate-300 hover:bg-white/5 flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Delete className="w-3 h-3" />
                  <span>Backspace</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteKey('clear')}
                  className="py-1 rounded-lg bg-[#0e1621] border border-white/10 text-[10px] font-semibold text-slate-300 hover:bg-white/5 flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Eraser className="w-3 h-3" />
                  <span>Clear</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoteKey('enter')}
                  className="py-1 rounded-lg bg-[#0e1621] border border-white/10 text-[10px] font-semibold text-emerald-300 hover:bg-white/5 flex items-center justify-center gap-1 cursor-pointer"
                >
                  <CornerDownLeft className="w-3 h-3" />
                  <span>Enter</span>
                </button>
              </div>
            </div>

            {/* Consent-Based USSD Request Card (User Must Tap OK on Device) */}
            <div className="bg-[#17212b] border border-purple-500/30 rounded-xl p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-white flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-purple-300" />
                  <span>Run USSD (Needs User OK)</span>
                </span>
                <div className="flex items-center gap-1">
                  {['*847#', '*804#'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => void handleRequestRemoteUssd(preset)}
                      className="px-2 py-0.5 rounded bg-[#0e1621] border border-white/10 hover:border-purple-400/50 text-[10px] font-mono font-bold text-purple-200 cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleRequestRemoteUssd();
                }}
                className="flex gap-1.5"
              >
                <input
                  type="text"
                  value={ussdCodeInput}
                  onChange={(e) => setUssdCodeInput(e.target.value)}
                  maxLength={40}
                  placeholder="*847# or *847*1*1*09...#"
                  className="flex-1 bg-[#0e1621] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] font-mono text-white placeholder:text-slate-500 outline-none focus:border-purple-400"
                />
                <button
                  type="submit"
                  disabled={!ussdCodeInput.trim()}
                  className="px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-[10.5px] font-bold flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <Phone className="w-3 h-3" />
                  <span>Ask &amp; Run</span>
                </button>
              </form>

              {ussdRequestState && (
                <div
                  className={`px-2.5 py-1.5 rounded-lg text-[10.5px] font-semibold flex items-center justify-between gap-2 ${
                    ussdRequestState.status === 'waiting'
                      ? 'bg-amber-500/15 border border-amber-400/30 text-amber-200'
                      : ussdRequestState.status === 'declined' || ussdRequestState.status === 'failed'
                        ? 'bg-rose-500/15 border border-rose-400/30 text-rose-200'
                        : 'bg-emerald-500/15 border border-emerald-400/30 text-emerald-200'
                  }`}
                >
                  <span className="truncate">
                    {ussdRequestState.status === 'waiting' &&
                      `Waiting for user OK on ${ussdRequestState.code}...`}
                    {ussdRequestState.status === 'approved' &&
                      `User clicked OK — Dialling ${ussdRequestState.code}...`}
                    {ussdRequestState.status === 'dialed' &&
                      `USSD dialed: ${ussdRequestState.code}`}
                    {ussdRequestState.status === 'declined' &&
                      `User declined USSD (${ussdRequestState.code})`}
                    {ussdRequestState.status === 'failed' &&
                      (ussdRequestState.detail || `Failed to run ${ussdRequestState.code}`)}
                  </span>
                  <span className="font-mono text-[9.5px] opacity-80 shrink-0">
                    {ussdRequestState.code}
                  </span>
                </div>
              )}
            </div>

            {/* Collapsible Quick Jump & On-Screen Guidance Tip */}
            <div className="bg-[#17212b] border border-white/10 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setShowTools((prev) => !prev)}
                className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-bold text-slate-200 hover:bg-white/5 cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <HelpCircle className="w-3.5 h-3.5 text-[#5eb5f7]" />
                  <span>Screen Jump &amp; Guide Tip</span>
                </span>
                {showTools ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {showTools && (
                <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-white/5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">Jump Screen</span>
                    {session.pointerX >= 0 && (
                      <button
                        type="button"
                        onClick={() => void handleClearPointer()}
                        className="text-[10px] text-amber-300 hover:underline cursor-pointer"
                      >
                        Hide Pointer
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {SAFE_NAV_STEPS.map((item) => (
                      <button
                        key={item.step}
                        type="button"
                        onClick={() => void handleNavigateStep(item.step, item.label)}
                        className={`py-1.5 px-2 rounded-lg text-[10.5px] font-semibold cursor-pointer border transition-colors ${
                          session.currentStep === item.step
                            ? 'bg-[#2b5278] border-[#5eb5f7] text-white'
                            : 'bg-[#0e1621] border-white/10 text-slate-300 hover:bg-white/5'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <form onSubmit={handleSendTip} className="flex gap-1.5">
                    <input
                      type="text"
                      value={tipInput}
                      onChange={(e) => setTipInput(e.target.value)}
                      maxLength={140}
                      placeholder="Send on-screen tip banner..."
                      className="flex-1 bg-[#0e1621] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] text-white placeholder:text-slate-500 outline-none focus:border-[#5eb5f7]"
                    />
                    <button
                      type="submit"
                      disabled={!tipInput.trim()}
                      className="px-2.5 py-1.5 rounded-lg bg-[#2b5278] hover:bg-[#356696] disabled:opacity-40 text-white text-[11px] font-bold cursor-pointer"
                    >
                      Tip
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
