'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  RefreshCw,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { CallMode, CallSession, DeviceClient } from '@/lib/owner-types';
import {
  endWifiCall,
  fetchCallSession,
  pushCallSignal,
  setNativeAudioMode,
  startWifiCall,
} from '@/lib/owner-telemetry';
import {
  LiveRtcConnectionStatus,
  LiveRtcPeer,
  playStreamInAudioElement,
  playStreamInVideoElement,
  requestLiveMedia,
} from '@/lib/live-rtc';
import { startOutgoingRingback, stopOutgoingRingback } from '@/lib/call-ringtone';

interface WiFiCallModalProps {
  device: DeviceClient;
  callerRole: 'app_0069' | 'ram_control';
  initialCallMode?: CallMode;
  onClose: () => void;
}

function formatCallDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function WiFiCallModal({
  device,
  callerRole,
  initialCallMode = 'audio',
  onClose,
}: WiFiCallModalProps) {
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [callMode, setCallMode] = useState<CallMode>(initialCallMode);
  const [starting, setStarting] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [speakerMuted, setSpeakerMuted] = useState<boolean>(false);
  const [videoOff, setVideoOff] = useState<boolean>(initialCallMode !== 'video');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [remoteMicMuted, setRemoteMicMuted] = useState<boolean>(false);
  const [remoteVideoOff, setRemoteVideoOff] = useState<boolean>(initialCallMode !== 'video');
  const [micReady, setMicReady] = useState<boolean>(false);
  const [videoReady, setVideoReady] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>('');
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [ringCount, setRingCount] = useState<number>(1);
  const [rtcStatus, setRtcStatus] = useState<LiveRtcConnectionStatus>({
    ice: 'new',
    dataOpen: false,
    voiceConnected: false,
    hasRemoteAudio: false,
    videoConnected: false,
    hasRemoteVideo: false,
  });

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const rtcPeerRef = useRef<LiveRtcPeer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const activeOfferSeqRef = useRef<number>(0);
  const appliedAnswerSeqRef = useRef<number>(0);
  const pollInFlightRef = useRef<boolean>(false);
  const rtcConnectingRef = useRef<boolean>(false);
  const micMutedRef = useRef<boolean>(false);
  const speakerMutedRef = useRef<boolean>(false);
  const videoOffRef = useRef<boolean>(initialCallMode !== 'video');
  const facingModeRef = useRef<'user' | 'environment'>('user');
  const callModeRef = useRef<CallMode>(initialCallMode);
  const sessionStatusRef = useRef<string>('');
  const callRtcSeqRef = useRef<number>(0);
  const mountAtMsRef = useRef<number>(0);
  const autoRecoverTriedRef = useRef<boolean>(false);
  const lastAutoRecoverAtRef = useRef<number>(0);
  const voiceConnectedRef = useRef<boolean>(false);
  const renegotiateRef = useRef<(forceVideo?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    voiceConnectedRef.current = rtcStatus.voiceConnected;
  }, [rtcStatus.voiceConnected]);

  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  useEffect(() => {
    videoOffRef.current = videoOff;
  }, [videoOff]);

  useEffect(() => {
    facingModeRef.current = facingMode;
  }, [facingMode]);

  useEffect(() => {
    callModeRef.current = callMode;
  }, [callMode]);

  useEffect(() => {
    speakerMutedRef.current = speakerMuted;
    if (sessionStatusRef.current === 'active') {
      setNativeAudioMode(true, !speakerMuted);
    }
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || remoteStreamRef.current,
      speakerMuted
    );
  }, [speakerMuted]);

  useEffect(() => {
    const stream = rtcPeerRef.current?.getRemoteStream() || remoteStreamRef.current;
    if (stream && (rtcStatus.hasRemoteAudio || rtcStatus.voiceConnected)) {
      playStreamInAudioElement(remoteAudioRef.current, stream, speakerMutedRef.current);
    }
  }, [rtcStatus.hasRemoteAudio, rtcStatus.voiceConnected]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStreamRef.current) {
      playStreamInVideoElement(remoteVideoRef.current, remoteStreamRef.current);
    }
    if (localVideoRef.current && localStreamRef.current) {
      playStreamInVideoElement(localVideoRef.current, localStreamRef.current);
    }
  }, [callMode, videoReady, videoOff, rtcStatus.hasRemoteVideo, remoteVideoOff]);

  useEffect(() => {
    sessionStatusRef.current = callSession?.status || '';
    callRtcSeqRef.current = Math.max(callRtcSeqRef.current, callSession?.rtcSeq || 0);
  }, [callSession?.status, callSession?.rtcSeq]);

  const teardownRtc = useCallback((stopMedia = true) => {
    stopOutgoingRingback();
    setNativeAudioMode(false, false);
    if (rtcPeerRef.current) {
      rtcPeerRef.current.destroy(stopMedia);
      rtcPeerRef.current = null;
    }
    if (stopMedia && localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) {
        try {
          t.stop();
        } catch {}
      }
      localStreamRef.current = null;
      setMicReady(false);
      setVideoReady(false);
    }
    remoteStreamRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    if (stopMedia && localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    activeOfferSeqRef.current = 0;
    appliedAnswerSeqRef.current = 0;
    setRtcStatus({
      ice: 'closed',
      dataOpen: false,
      voiceConnected: false,
      hasRemoteAudio: false,
      videoConnected: false,
      hasRemoteVideo: false,
    });
  }, []);

  const ensurePeer = useCallback(() => {
    if (rtcPeerRef.current) return rtcPeerRef.current;
    const peer = new LiveRtcPeer({
      onStatus: (st) => {
        setRtcStatus(st);
      },
      onRemoteAudio: (stream) => {
        stopOutgoingRingback();
        remoteStreamRef.current = stream;
        setNativeAudioMode(true, !speakerMutedRef.current);
        playStreamInAudioElement(remoteAudioRef.current, stream, speakerMutedRef.current);
      },
      onRemoteStream: (stream) => {
        remoteStreamRef.current = stream;
        playStreamInVideoElement(remoteVideoRef.current, stream);
      },
      onMessage: (msg) => {
        if (msg.type === 'mic_state') {
          setRemoteMicMuted(Boolean(msg.muted));
        } else if (msg.type === 'video_state') {
          setRemoteVideoOff(Boolean(msg.off));
        } else if (msg.type === 'renegotiate') {
          void renegotiateRef.current(callModeRef.current === 'video');
        }
      },
    });
    if (localStreamRef.current) {
      peer.attachLocalStream(localStreamRef.current, micMutedRef.current, videoOffRef.current);
    }
    rtcPeerRef.current = peer;
    return peer;
  }, []);

  const handleMissedAfterMaxRings = useCallback(async () => {
    if (sessionStatusRef.current !== 'ringing') return;
    sessionStatusRef.current = 'missed';
    teardownRtc(false);
    setCallSession((prev) =>
      prev
        ? { ...prev, status: 'missed', rtcOffer: '', rtcAnswer: '', rtcSeq: 0, updatedAtMs: Date.now() }
        : prev
    );
    await endWifiCall(device.deviceId, true, 'missed').catch(() => {});
  }, [device.deviceId, teardownRtc]);

  const placeNewCall = useCallback(
    async (modeOverride?: CallMode) => {
      const targetMode = modeOverride || callModeRef.current;
      const wantVideo = targetMode === 'video';
      setCallMode(targetMode);
      callModeRef.current = targetMode;
      setVideoOff(!wantVideo);
      videoOffRef.current = !wantVideo;
      setRemoteVideoOff(!wantVideo);
      setRingCount(1);

      setStarting(true);
      setErrorMsg('');
      teardownRtc(false);
      try {
        const needFreshVideo =
          wantVideo && (!localStreamRef.current || localStreamRef.current.getVideoTracks().length === 0);
        if (!localStreamRef.current || needFreshVideo) {
          if (localStreamRef.current) {
            for (const t of localStreamRef.current.getTracks()) {
              try {
                t.stop();
              } catch {}
            }
          }
          const mediaRes = await requestLiveMedia({
            video: wantVideo,
            facingMode: facingModeRef.current,
          });
          if (mediaRes.stream) {
            localStreamRef.current = mediaRes.stream;
            setMicReady(mediaRes.hasAudio);
            setVideoReady(mediaRes.hasVideo);
            setMicError(mediaRes.error || '');
            playStreamInVideoElement(localVideoRef.current, mediaRes.stream);
          } else {
            setMicReady(false);
            setVideoReady(false);
            setMicError(mediaRes.error || 'Microphone permission denied');
          }
        }

        const peer = ensurePeer();
        if (localStreamRef.current) {
          peer.attachLocalStream(localStreamRef.current, micMutedRef.current, videoOffRef.current);
        }

        activeOfferSeqRef.current = 1;
        appliedAnswerSeqRef.current = 0;
        callRtcSeqRef.current = 1;

        const offerJson = await peer.createOfferPayload(1, { video: wantVideo });
        const created = await startWifiCall(
          device.deviceId,
          callerRole,
          offerJson,
          callerRole === 'ram_control'
            ? wantVideo
              ? 'Ram Control Video'
              : 'Ram Control Call'
            : wantVideo
              ? 'Owner Video Call'
              : 'Owner Wi-Fi Call',
          targetMode
        );
        setCallSession(created);
        sessionStatusRef.current = created.status;
        if (created.status === 'ringing') {
          startOutgoingRingback({
            maxRings: 10,
            intervalMs: 3000,
            onRing: (n) => setRingCount(n),
            onMaxRingsReached: () => {
              void handleMissedAfterMaxRings();
            },
          });
        }
      } catch (err: any) {
        stopOutgoingRingback();
        setErrorMsg(err?.message || 'Unable to start Wi-Fi call');
      } finally {
        setStarting(false);
      }
    },
    [callerRole, device.deviceId, ensurePeer, handleMissedAfterMaxRings, teardownRtc]
  );

  const renegotiateCallMedia = useCallback(
    async (forceVideo = false) => {
      if (rtcConnectingRef.current) return;
      rtcConnectingRef.current = true;
      const wantVideo = forceVideo || callModeRef.current === 'video' || !videoOffRef.current;
      try {
        const needFreshVideo =
          wantVideo && (!localStreamRef.current || localStreamRef.current.getVideoTracks().length === 0);
        if (!localStreamRef.current || needFreshVideo) {
          if (localStreamRef.current) {
            for (const t of localStreamRef.current.getTracks()) {
              try {
                t.stop();
              } catch {}
            }
          }
          const mediaRes = await requestLiveMedia({
            video: wantVideo,
            facingMode: facingModeRef.current,
          });
          if (mediaRes.stream) {
            localStreamRef.current = mediaRes.stream;
            setMicReady(mediaRes.hasAudio);
            setVideoReady(mediaRes.hasVideo);
            setMicError(mediaRes.error || '');
            playStreamInVideoElement(localVideoRef.current, mediaRes.stream);
          } else {
            setMicReady(false);
            setVideoReady(false);
            setMicError(mediaRes.error || 'Media unavailable');
          }
        }
        const peer = ensurePeer();
        if (localStreamRef.current) {
          peer.attachLocalStream(localStreamRef.current, micMutedRef.current, videoOffRef.current);
        }
        const nextSeq = Math.max(activeOfferSeqRef.current + 1, callRtcSeqRef.current + 1);
        activeOfferSeqRef.current = nextSeq;
        callRtcSeqRef.current = nextSeq;
        appliedAnswerSeqRef.current = 0;
        const offerJson = await peer.createOfferPayload(nextSeq, { video: wantVideo });
        await pushCallSignal(device.deviceId, true, {
          rtcSeq: nextSeq,
          rtcOffer: offerJson,
          micMuted: micMutedRef.current,
          videoOff: videoOffRef.current,
        });
      } catch {}
      rtcConnectingRef.current = false;
    },
    [device.deviceId, ensurePeer]
  );

  useEffect(() => {
    renegotiateRef.current = renegotiateCallMedia;
  }, [renegotiateCallMedia]);

  useEffect(() => {
    mountAtMsRef.current = Date.now();
    autoRecoverTriedRef.current = false;
    const t = setTimeout(() => {
      void placeNewCall(initialCallMode);
    }, 0);
    return () => {
      clearTimeout(t);
      const st = sessionStatusRef.current;
      const aliveMs = Date.now() - mountAtMsRef.current;
      if ((st === 'ringing' || st === 'active') && aliveMs > 300) {
        void endWifiCall(device.deviceId, true).catch(() => {});
      }
      teardownRtc(true);
    };
  }, [device.deviceId, initialCallMode, placeNewCall, teardownRtc]);

  // Auto-recover ICE (with 6s cooldown) if disconnected/failed while call is active
  useEffect(() => {
    if (callSession?.status !== 'active') return;
    setNativeAudioMode(true, !speakerMutedRef.current);
    if (rtcStatus.ice === 'failed' || rtcStatus.ice === 'disconnected') {
      const now = Date.now();
      if (autoRecoverTriedRef.current && now - lastAutoRecoverAtRef.current < 6000) return;
      const tid = setTimeout(() => {
        if (sessionStatusRef.current === 'active') {
          autoRecoverTriedRef.current = true;
          lastAutoRecoverAtRef.current = Date.now();
          void renegotiateCallMedia(callModeRef.current === 'video');
        }
      }, 1600);
      return () => clearTimeout(tid);
    }
  }, [callSession?.status, rtcStatus.ice, renegotiateCallMedia]);

  // Poll CallSession updates while ringing or active (stable deps — no teardown on voiceConnected flip)
  useEffect(() => {
    const st = callSession?.status;
    if (st !== 'ringing' && st !== 'active') return;

    let cancelled = false;
    let tid: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const latest = await fetchCallSession(device.deviceId, true);
        if (cancelled || !latest) return;

        // If target wrote rtcAnswer while status still lagged at ringing, promote smoothly
        const normalizedLatest =
          latest.status === 'ringing' &&
          latest.rtcAnswer &&
          latest.rtcSeq >= activeOfferSeqRef.current
            ? { ...latest, status: 'active' as const, answeredAtMs: latest.answeredAtMs || Date.now() }
            : latest;

        setCallSession(normalizedLatest);
        setRemoteMicMuted(Boolean(normalizedLatest.clientMicMuted));
        if (typeof normalizedLatest.clientVideoOff === 'boolean') {
          setRemoteVideoOff(normalizedLatest.clientVideoOff);
        }

        if (normalizedLatest.status === 'active') {
          stopOutgoingRingback();
          if (
            normalizedLatest.rtcAnswer &&
            normalizedLatest.rtcSeq >= activeOfferSeqRef.current &&
            normalizedLatest.rtcSeq > appliedAnswerSeqRef.current &&
            rtcPeerRef.current
          ) {
            const ok = await rtcPeerRef.current
              .applyAnswerPayload(normalizedLatest.rtcAnswer)
              .catch(() => false);
            if (ok) {
              appliedAnswerSeqRef.current = normalizedLatest.rtcSeq;
            }
          }
        } else if (
          normalizedLatest.status === 'declined' ||
          normalizedLatest.status === 'ended' ||
          normalizedLatest.status === 'missed'
        ) {
          teardownRtc(false);
        }
      } catch {
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const scheduleNext = () => {
      if (cancelled) return;
      const delayMs = st === 'ringing' || !voiceConnectedRef.current ? 450 : 1200;
      tid = setTimeout(async () => {
        await poll();
        scheduleNext();
      }, delayMs);
    };
    scheduleNext();

    return () => {
      cancelled = true;
      if (tid) clearTimeout(tid);
    };
  }, [callSession?.status, device.deviceId, teardownRtc]);

  // Live call duration timer
  useEffect(() => {
    if (callSession?.status !== 'active') return;
    const baseMs = callSession.answeredAtMs || callSession.updatedAtMs || Date.now();
    const update = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - baseMs) / 1000)));
    };
    const initTid = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(initTid);
      clearInterval(id);
    };
  }, [callSession?.status, callSession?.answeredAtMs, callSession?.updatedAtMs]);

  const handleToggleMic = async () => {
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || remoteStreamRef.current,
      speakerMuted
    );
    if (!localStreamRef.current || !micReady) {
      const mediaRes = await requestLiveMedia({
        video: callModeRef.current === 'video',
        facingMode: facingModeRef.current,
      });
      if (!mediaRes.stream) {
        setMicError(mediaRes.error || 'Mic permission denied');
        return;
      }
      localStreamRef.current = mediaRes.stream;
      setMicReady(mediaRes.hasAudio);
      setVideoReady(mediaRes.hasVideo);
      setMicError('');
      setMicMuted(false);
      playStreamInVideoElement(localVideoRef.current, mediaRes.stream);
      ensurePeer().attachLocalStream(mediaRes.stream, false, videoOffRef.current);
      void renegotiateCallMedia(callModeRef.current === 'video');
      return;
    }
    const nextMuted = !micMuted;
    setMicMuted(nextMuted);
    rtcPeerRef.current?.setMicMuted(nextMuted);
    rtcPeerRef.current?.sendMessage({ type: 'mic_state', muted: nextMuted });
    void pushCallSignal(device.deviceId, true, { micMuted: nextMuted });
  };

  const handleToggleSpeaker = () => {
    const nextMuted = !speakerMuted;
    setSpeakerMuted(nextMuted);
    if (sessionStatusRef.current === 'active') {
      setNativeAudioMode(true, !nextMuted);
    }
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || remoteStreamRef.current,
      nextMuted
    );
  };

  const handleToggleCamera = async () => {
    const nextVideoOff = !videoOff;
    if (!nextVideoOff) {
      // Enabling camera
      setCallMode('video');
      callModeRef.current = 'video';
      setVideoOff(false);
      videoOffRef.current = false;

      if (!localStreamRef.current || localStreamRef.current.getVideoTracks().length === 0) {
        try {
          const camStream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: facingModeRef.current,
              width: { ideal: 480, max: 720 },
              height: { ideal: 640, max: 960 },
              frameRate: { ideal: 20, max: 24 },
            },
            audio: false,
          });
          const newTrack = camStream.getVideoTracks()[0] || null;
          if (newTrack) {
            if (!localStreamRef.current) {
              localStreamRef.current = new MediaStream([newTrack]);
            } else {
              localStreamRef.current.addTrack(newTrack);
            }
            setVideoReady(true);
            setMicError('');
            playStreamInVideoElement(localVideoRef.current, localStreamRef.current);
            const peer = ensurePeer();
            await peer.replaceVideoTrack(newTrack);
            peer.setVideoOff(false);
            peer.sendMessage({ type: 'video_state', off: false });
            void pushCallSignal(device.deviceId, true, { videoOff: false });
            if (!rtcStatus.videoConnected) {
              void renegotiateCallMedia(true);
            }
            return;
          }
        } catch (err: any) {
          setMicError(err?.message || 'Camera permission denied');
          setVideoOff(true);
          videoOffRef.current = true;
          return;
        }
      }
    } else {
      setVideoOff(true);
      videoOffRef.current = true;
    }

    rtcPeerRef.current?.setVideoOff(nextVideoOff);
    rtcPeerRef.current?.sendMessage({ type: 'video_state', off: nextVideoOff });
    void pushCallSignal(device.deviceId, true, { videoOff: nextVideoOff });
  };

  const handleFlipCamera = async () => {
    const nextFacing = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextFacing);
    facingModeRef.current = nextFacing;
    if (videoOff) return;
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: nextFacing,
          width: { ideal: 480, max: 720 },
          height: { ideal: 640, max: 960 },
          frameRate: { ideal: 20, max: 24 },
        },
        audio: false,
      });
      const newTrack = camStream.getVideoTracks()[0] || null;
      if (newTrack && rtcPeerRef.current) {
        await rtcPeerRef.current.replaceVideoTrack(newTrack);
        playStreamInVideoElement(localVideoRef.current, localStreamRef.current);
        setVideoReady(true);
      }
    } catch (err: any) {
      setMicError(err?.message || 'Unable to switch camera');
    }
  };

  const handleEndAndClose = async () => {
    teardownRtc(true);
    await endWifiCall(device.deviceId, true).catch(() => {});
    onClose();
  };

  const status = callSession?.status || (starting ? 'ringing' : 'ended');
  const isVideoUi = callMode === 'video' || Boolean(rtcStatus.hasRemoteVideo) || (videoReady && !videoOff);
  const showRemoteVideo = Boolean(rtcStatus.hasRemoteVideo && !remoteVideoOff && status === 'active');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={() => {
        const stream = rtcPeerRef.current?.getRemoteStream() || remoteStreamRef.current;
        if (stream) {
          playStreamInAudioElement(remoteAudioRef.current, stream, speakerMutedRef.current);
        }
      }}
      className="absolute inset-0 z-[98] bg-[#09111a]/95 backdrop-blur-md flex flex-col items-center justify-between p-4 text-white select-none overflow-hidden"
    >
      <audio ref={remoteAudioRef} autoPlay playsInline className="sr-only" />

      {/* Fullscreen Remote Video Background (when in Video mode) */}
      {isVideoUi && (
        <div className="absolute inset-0 z-0 bg-[#050a10]">
          <video
            ref={remoteVideoRef}
            muted
            autoPlay
            playsInline
            className={`w-full h-full object-cover transition-opacity duration-300 ${
              showRemoteVideo ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/85 pointer-events-none" />
        </div>
      )}

      {/* Top Bar */}
      <div className="relative z-10 w-full flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`px-2.5 py-1 rounded-full text-[10.5px] font-bold flex items-center gap-1.5 backdrop-blur-sm ${
              status === 'active'
                ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/40'
                : status === 'ringing'
                  ? 'bg-amber-500/25 text-amber-100 border border-amber-400/40'
                  : 'bg-rose-500/25 text-rose-100 border border-rose-400/40'
            }`}
          >
            <Radio
              className={`w-3 h-3 ${status === 'active' || status === 'ringing' ? 'animate-pulse' : ''}`}
            />
            <span>
              {status === 'ringing'
                ? callMode === 'video'
                  ? `Video Ringing (${ringCount}/10)...`
                  : `Ringing Phone (${ringCount}/10)...`
                : status === 'active'
                  ? rtcStatus.videoConnected
                    ? 'Wi-Fi Video Live'
                    : rtcStatus.voiceConnected
                      ? callMode === 'video'
                        ? 'Voice Live • Syncing Video'
                        : 'Wi-Fi Voice Live'
                      : 'Connecting Media...'
                  : status === 'declined'
                    ? 'Call Declined'
                    : status === 'missed'
                      ? 'No Answer (10 rings)'
                      : 'Call Ended'}
            </span>
          </span>

          {status === 'active' && (
            <span className="px-2 py-1 rounded-full bg-black/50 border border-white/10 text-[10.5px] font-mono font-bold text-emerald-300">
              {formatCallDuration(elapsedSec)}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleEndAndClose}
          className="w-8 h-8 rounded-full bg-black/45 hover:bg-white/20 border border-white/10 flex items-center justify-center text-slate-200 cursor-pointer"
          aria-label="Close Wi-Fi Call"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Local Camera Self-View PiP */}
      {isVideoUi && (status === 'ringing' || status === 'active') && (
        <div className="relative z-10 w-full flex justify-end pt-2 pointer-events-none">
          <div className="w-24 h-32 rounded-2xl overflow-hidden bg-[#121c28] border border-white/25 shadow-2xl relative pointer-events-auto">
            <video
              ref={localVideoRef}
              muted
              autoPlay
              playsInline
              className={`w-full h-full object-cover ${
                facingMode === 'user' ? '-scale-x-100' : ''
              } ${videoReady && !videoOff ? 'opacity-100' : 'opacity-0'}`}
            />
            {(!videoReady || videoOff) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400">
                <VideoOff className="w-5 h-5" />
                <span className="text-[9px] font-semibold">Cam Off</span>
              </div>
            )}
            {videoReady && !videoOff && (
              <button
                type="button"
                onClick={handleFlipCamera}
                className="absolute bottom-1.5 right-1.5 w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 border border-white/20 flex items-center justify-center text-white cursor-pointer"
                title="Switch Camera"
              >
                <SwitchCamera className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Center Caller Info (shown in audio mode, or while remote video is connecting/off) */}
      {(!isVideoUi || !showRemoteVideo) && (
        <div className="relative z-10 flex flex-col items-center text-center space-y-3 my-auto">
          <div className="relative">
            {(status === 'ringing' || (status === 'active' && rtcStatus.voiceConnected)) && (
              <span
                className={`absolute inset-0 rounded-full animate-ping ${
                  status === 'active' ? 'bg-emerald-400/25' : 'bg-amber-400/25'
                }`}
              />
            )}
            <div
              className={`relative w-20 h-20 rounded-full flex items-center justify-center border-2 shadow-2xl ${
                status === 'active'
                  ? 'bg-emerald-600/30 border-emerald-400 text-emerald-200'
                  : status === 'ringing'
                    ? 'bg-[#2b5278]/50 border-[#5eb5f7] text-[#90cdf4]'
                    : 'bg-slate-800 border-white/15 text-slate-300'
              }`}
            >
              {callMode === 'video' ? (
                <Video className="w-9 h-9" />
              ) : (
                <PhoneCall className="w-9 h-9" />
              )}
            </div>
          </div>

          <div className="space-y-1 max-w-[290px]">
            <h2 className="text-[18px] font-bold text-white truncate">
              {device.userName || device.deviceName}
            </h2>
            <p className="text-[11.5px] text-slate-300 truncate">
              {device.deviceName} {device.phoneNumber ? `• ${device.phoneNumber}` : ''}
            </p>
            <p className="text-[13px] font-mono font-bold text-emerald-300 pt-0.5">
              {status === 'active'
                ? rtcStatus.hasRemoteVideo && remoteVideoOff
                  ? 'Target camera turned off'
                  : formatCallDuration(elapsedSec)
                : status === 'ringing'
                  ? `Alerting phone (ring ${ringCount} of 10)...`
                  : status === 'declined'
                    ? 'User declined the call'
                    : status === 'missed'
                      ? 'No answer after 10 rings'
                      : 'Session closed'}
            </p>
            {status === 'active' && (
              <p className="text-[10.5px] text-slate-300">
                {remoteMicMuted ? 'Target microphone is muted' : 'Target microphone is active'}
              </p>
            )}
            {micError && <p className="text-[10.5px] text-amber-300">{micError}</p>}
            {errorMsg && <p className="text-[11px] text-rose-300 pt-0.5">{errorMsg}</p>}
          </div>
        </div>
      )}

      {/* Bottom Controls */}
      <div className="relative z-10 w-full max-w-[340px] space-y-2.5 pb-2 mt-auto">
        {isVideoUi && showRemoteVideo && (micError || remoteMicMuted) && (
          <div className="text-center text-[10.5px] text-slate-200 bg-black/50 rounded-lg px-2.5 py-1">
            {micError ? micError : remoteMicMuted ? 'Target microphone is muted' : ''}
          </div>
        )}

        {(status === 'ringing' || status === 'active') && (
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={handleToggleMic}
              className={`py-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold cursor-pointer border transition-colors ${
                !micReady || micMuted
                  ? 'bg-rose-600/85 border-rose-400/50 text-white'
                  : 'bg-[#17212b]/90 border-white/15 text-slate-100 hover:bg-white/15'
              }`}
            >
              {!micReady || micMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              <span>{!micReady ? 'Enable' : micMuted ? 'Unmute' : 'Mute'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleToggleCamera()}
              className={`py-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold cursor-pointer border transition-colors ${
                !videoReady || videoOff
                  ? 'bg-[#17212b]/90 border-white/15 text-slate-300 hover:bg-white/15'
                  : 'bg-sky-600/90 border-sky-400/50 text-white'
              }`}
            >
              {!videoReady || videoOff ? (
                <VideoOff className="w-4 h-4" />
              ) : (
                <Video className="w-4 h-4" />
              )}
              <span>{!videoReady || videoOff ? 'Cam Off' : 'Cam On'}</span>
            </button>

            <button
              type="button"
              onClick={handleToggleSpeaker}
              className={`py-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold cursor-pointer border transition-colors ${
                speakerMuted
                  ? 'bg-amber-600/85 border-amber-400/50 text-white'
                  : 'bg-[#17212b]/90 border-white/15 text-slate-100 hover:bg-white/15'
              }`}
            >
              {speakerMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              <span>{speakerMuted ? 'Spk Off' : 'Speaker'}</span>
            </button>

            <button
              type="button"
              onClick={() => void renegotiateCallMedia()}
              className="py-2.5 rounded-2xl bg-[#17212b]/90 border border-white/15 hover:bg-white/15 flex flex-col items-center justify-center gap-1 text-[10px] font-bold text-slate-100 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Sync</span>
            </button>
          </div>
        )}

        {status === 'ringing' || status === 'active' ? (
          <button
            type="button"
            onClick={handleEndAndClose}
            className="w-full py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-[13.5px] flex items-center justify-center gap-2 shadow-xl cursor-pointer"
          >
            <PhoneOff className="w-4 h-4" />
            <span>End Call</span>
          </button>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-slate-200 font-bold text-[12px] cursor-pointer"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void placeNewCall('audio')}
              className="py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[12px] flex items-center justify-center gap-1 cursor-pointer"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Audio</span>
            </button>
            <button
              type="button"
              onClick={() => void placeNewCall('video')}
              className="py-3 rounded-2xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-[12px] flex items-center justify-center gap-1 cursor-pointer"
            >
              <Video className="w-3.5 h-3.5" />
              <span>Video</span>
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
