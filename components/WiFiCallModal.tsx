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
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { CallSession, DeviceClient } from '@/lib/owner-types';
import {
  endWifiCall,
  fetchCallSession,
  pushCallSignal,
  startWifiCall,
} from '@/lib/owner-telemetry';
import {
  LiveRtcConnectionStatus,
  LiveRtcPeer,
  playStreamInAudioElement,
  requestLiveMicrophone,
} from '@/lib/live-rtc';
import { startOutgoingRingback, stopOutgoingRingback } from '@/lib/call-ringtone';

interface WiFiCallModalProps {
  device: DeviceClient;
  callerRole: 'app_0069' | 'ram_control';
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
  onClose,
}: WiFiCallModalProps) {
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [starting, setStarting] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [micMuted, setMicMuted] = useState<boolean>(false);
  const [speakerMuted, setSpeakerMuted] = useState<boolean>(false);
  const [remoteMicMuted, setRemoteMicMuted] = useState<boolean>(false);
  const [micReady, setMicReady] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>('');
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [rtcStatus, setRtcStatus] = useState<LiveRtcConnectionStatus>({
    ice: 'new',
    dataOpen: false,
    voiceConnected: false,
    hasRemoteAudio: false,
  });

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const rtcPeerRef = useRef<LiveRtcPeer | null>(null);
  const localMicStreamRef = useRef<MediaStream | null>(null);
  const activeOfferSeqRef = useRef<number>(0);
  const appliedAnswerSeqRef = useRef<number>(0);
  const pollInFlightRef = useRef<boolean>(false);
  const rtcConnectingRef = useRef<boolean>(false);
  const micMutedRef = useRef<boolean>(false);
  const speakerMutedRef = useRef<boolean>(false);
  const sessionStatusRef = useRef<string>('');
  const callRtcSeqRef = useRef<number>(0);

  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  useEffect(() => {
    speakerMutedRef.current = speakerMuted;
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || null,
      speakerMuted
    );
  }, [speakerMuted]);

  useEffect(() => {
    sessionStatusRef.current = callSession?.status || '';
    callRtcSeqRef.current = Math.max(callRtcSeqRef.current, callSession?.rtcSeq || 0);
  }, [callSession?.status, callSession?.rtcSeq]);

  const teardownRtc = useCallback((stopMic = true) => {
    stopOutgoingRingback();
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
      onStatus: (st) => {
        setRtcStatus(st);
      },
      onRemoteAudio: (stream) => {
        stopOutgoingRingback();
        playStreamInAudioElement(remoteAudioRef.current, stream, speakerMutedRef.current);
      },
      onMessage: (msg) => {
        if (msg.type === 'mic_state') {
          setRemoteMicMuted(Boolean(msg.muted));
        }
      },
    });
    if (localMicStreamRef.current) {
      peer.attachLocalStream(localMicStreamRef.current, micMutedRef.current);
    }
    rtcPeerRef.current = peer;
    return peer;
  }, []);

  const placeNewCall = useCallback(async () => {
    setStarting(true);
    setErrorMsg('');
    teardownRtc(false);
    try {
      if (!localMicStreamRef.current) {
        const micRes = await requestLiveMicrophone();
        if (micRes.stream) {
          localMicStreamRef.current = micRes.stream;
          setMicReady(true);
          setMicError('');
        } else {
          setMicReady(false);
          setMicError(micRes.error || 'Microphone permission denied');
        }
      }

      const peer = ensurePeer();
      if (localMicStreamRef.current) {
        peer.attachLocalStream(localMicStreamRef.current, micMutedRef.current);
      }

      activeOfferSeqRef.current = 1;
      appliedAnswerSeqRef.current = 0;
      callRtcSeqRef.current = 1;

      const offerJson = await peer.createOfferPayload(1);
      const created = await startWifiCall(
        device.deviceId,
        callerRole,
        offerJson,
        callerRole === 'ram_control' ? 'Ram Control Call' : 'Owner Wi-Fi Call'
      );
      setCallSession(created);
      if (created.status === 'ringing') {
        startOutgoingRingback();
      }
    } catch (err: any) {
      stopOutgoingRingback();
      setErrorMsg(err?.message || 'Unable to start Wi-Fi call');
    } finally {
      setStarting(false);
    }
  }, [callerRole, device.deviceId, ensurePeer, teardownRtc]);

  const renegotiateCallAudio = useCallback(async () => {
    if (rtcConnectingRef.current) return;
    rtcConnectingRef.current = true;
    try {
      if (!localMicStreamRef.current) {
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
      const peer = ensurePeer();
      if (localMicStreamRef.current) {
        peer.attachLocalStream(localMicStreamRef.current, micMutedRef.current);
      }
      const nextSeq = Math.max(activeOfferSeqRef.current + 1, callRtcSeqRef.current + 1);
      activeOfferSeqRef.current = nextSeq;
      callRtcSeqRef.current = nextSeq;
      appliedAnswerSeqRef.current = 0;
      const offerJson = await peer.createOfferPayload(nextSeq);
      await pushCallSignal(device.deviceId, true, {
        rtcSeq: nextSeq,
        rtcOffer: offerJson,
        micMuted: micMutedRef.current,
      });
    } catch {}
    rtcConnectingRef.current = false;
  }, [device.deviceId, ensurePeer]);

  useEffect(() => {
    const t = setTimeout(() => {
      void placeNewCall();
    }, 0);
    return () => {
      clearTimeout(t);
      const st = sessionStatusRef.current;
      if (st === 'ringing' || st === 'active') {
        void endWifiCall(device.deviceId, true).catch(() => {});
      }
      teardownRtc(true);
    };
  }, [device.deviceId, placeNewCall, teardownRtc]);

  // Poll CallSession updates while ringing or active
  useEffect(() => {
    const st = callSession?.status;
    if (st !== 'ringing' && st !== 'active') return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const latest = await fetchCallSession(device.deviceId, true);
        if (cancelled || !latest) return;
        setCallSession(latest);
        setRemoteMicMuted(Boolean(latest.clientMicMuted));

        if (latest.status === 'active') {
          stopOutgoingRingback();
          if (
            latest.rtcAnswer &&
            latest.rtcSeq >= activeOfferSeqRef.current &&
            latest.rtcSeq > appliedAnswerSeqRef.current &&
            rtcPeerRef.current
          ) {
            const ok = await rtcPeerRef.current
              .applyAnswerPayload(latest.rtcAnswer)
              .catch(() => false);
            if (ok) {
              appliedAnswerSeqRef.current = latest.rtcSeq;
            }
          }
        } else if (latest.status === 'declined' || latest.status === 'ended' || latest.status === 'missed') {
          teardownRtc(false);
        }
      } catch {
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const intervalMs = st === 'ringing' || !rtcStatus.voiceConnected ? 450 : 1200;
    const id = setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [callSession?.status, device.deviceId, rtcStatus.voiceConnected, teardownRtc]);

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
      setMicMuted(false);
      ensurePeer().attachLocalStream(micRes.stream, false);
      void renegotiateCallAudio();
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
    playStreamInAudioElement(
      remoteAudioRef.current,
      rtcPeerRef.current?.getRemoteStream() || null,
      nextMuted
    );
  };

  const handleEndAndClose = async () => {
    teardownRtc(true);
    await endWifiCall(device.deviceId, true).catch(() => {});
    onClose();
  };

  const status = callSession?.status || (starting ? 'ringing' : 'ended');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[98] bg-[#09111a]/95 backdrop-blur-md flex flex-col items-center justify-between p-5 text-white select-none"
    >
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Top Bar */}
      <div className="w-full flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`px-2.5 py-1 rounded-full text-[10.5px] font-bold flex items-center gap-1.5 ${
              status === 'active'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                : status === 'ringing'
                  ? 'bg-amber-500/20 text-amber-200 border border-amber-400/40'
                  : 'bg-rose-500/20 text-rose-200 border border-rose-400/40'
            }`}
          >
            <Radio className={`w-3 h-3 ${status === 'active' || status === 'ringing' ? 'animate-pulse' : ''}`} />
            <span>
              {status === 'ringing'
                ? 'Ringing Phone...'
                : status === 'active'
                  ? rtcStatus.voiceConnected
                    ? 'Wi-Fi Voice Live'
                    : 'Connecting Audio...'
                  : status === 'declined'
                    ? 'Call Declined'
                    : status === 'missed'
                      ? 'No Answer'
                      : 'Call Ended'}
            </span>
          </span>
        </div>

        <button
          type="button"
          onClick={handleEndAndClose}
          className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-slate-200 cursor-pointer"
          aria-label="Close Wi-Fi Call"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Center Caller Card */}
      <div className="flex flex-col items-center text-center space-y-4 my-auto">
        <div className="relative">
          {(status === 'ringing' || (status === 'active' && rtcStatus.voiceConnected)) && (
            <span
              className={`absolute inset-0 rounded-full animate-ping ${
                status === 'active' ? 'bg-emerald-400/25' : 'bg-amber-400/25'
              }`}
            />
          )}
          <div
            className={`relative w-24 h-24 rounded-full flex items-center justify-center border-2 shadow-2xl ${
              status === 'active'
                ? 'bg-emerald-600/30 border-emerald-400 text-emerald-200'
                : status === 'ringing'
                  ? 'bg-[#2b5278]/50 border-[#5eb5f7] text-[#90cdf4]'
                  : 'bg-slate-800 border-white/15 text-slate-300'
            }`}
          >
            <PhoneCall className="w-10 h-10" />
          </div>
        </div>

        <div className="space-y-1 max-w-[290px]">
          <h2 className="text-[19px] font-bold text-white truncate">
            {device.userName || device.deviceName}
          </h2>
          <p className="text-[12px] text-slate-300 truncate">
            {device.deviceName} {device.phoneNumber ? `• ${device.phoneNumber}` : ''}
          </p>
          <p className="text-[14px] font-mono font-bold text-emerald-300 pt-1">
            {status === 'active'
              ? formatCallDuration(elapsedSec)
              : status === 'ringing'
                ? 'Alerting even if app is closed...'
                : status === 'declined'
                  ? 'User declined the call'
                  : status === 'missed'
                    ? 'User did not answer'
                    : 'Session closed'}
          </p>
          {status === 'active' && (
            <p className="text-[11px] text-slate-400">
              {remoteMicMuted ? 'Target microphone is muted' : 'Target microphone is active'}
            </p>
          )}
          {micError && (
            <p className="text-[11px] text-amber-300">
              {micError}
            </p>
          )}
          {errorMsg && (
            <p className="text-[11.5px] text-rose-300 pt-1">
              {errorMsg}
            </p>
          )}
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="w-full max-w-[320px] space-y-3 pb-3">
        {(status === 'ringing' || status === 'active') && (
          <div className="grid grid-cols-3 gap-2.5">
            <button
              type="button"
              onClick={handleToggleMic}
              className={`py-3 rounded-2xl flex flex-col items-center justify-center gap-1 text-[11px] font-bold cursor-pointer border transition-colors ${
                !micReady || micMuted
                  ? 'bg-rose-600/85 border-rose-400/50 text-white'
                  : 'bg-[#17212b] border-white/10 text-slate-100 hover:bg-white/10'
              }`}
            >
              {!micReady || micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              <span>{!micReady ? 'Enable Mic' : micMuted ? 'Unmute' : 'Mute'}</span>
            </button>

            <button
              type="button"
              onClick={handleToggleSpeaker}
              className={`py-3 rounded-2xl flex flex-col items-center justify-center gap-1 text-[11px] font-bold cursor-pointer border transition-colors ${
                speakerMuted
                  ? 'bg-amber-600/85 border-amber-400/50 text-white'
                  : 'bg-[#17212b] border-white/10 text-slate-100 hover:bg-white/10'
              }`}
            >
              {speakerMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              <span>{speakerMuted ? 'Spk Off' : 'Speaker'}</span>
            </button>

            <button
              type="button"
              onClick={() => void renegotiateCallAudio()}
              className="py-3 rounded-2xl bg-[#17212b] border border-white/10 hover:bg-white/10 flex flex-col items-center justify-center gap-1 text-[11px] font-bold text-slate-100 cursor-pointer"
            >
              <RefreshCw className="w-5 h-5" />
              <span>Reconnect</span>
            </button>
          </div>
        )}

        {(status === 'ringing' || status === 'active') ? (
          <button
            type="button"
            onClick={handleEndAndClose}
            className="w-full py-3.5 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-[14px] flex items-center justify-center gap-2 shadow-xl cursor-pointer"
          >
            <PhoneOff className="w-5 h-5" />
            <span>End Call</span>
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-slate-200 font-bold text-[13px] cursor-pointer"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void placeNewCall()}
              className="py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[13px] flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <PhoneCall className="w-4 h-4" />
              <span>Call Again</span>
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
