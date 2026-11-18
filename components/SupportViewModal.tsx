'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle2,
  Crosshair,
  Eye,
  HelpCircle,
  Home,
  Lock,
  Monitor,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { DeviceClient, SupportSession } from '@/lib/owner-types';
import {
  endSupportView,
  fetchSupportSession,
  requestSupportView,
  sendSupportCommand,
} from '@/lib/owner-telemetry';

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
  const [requesting, setRequesting] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [tipInput, setTipInput] = useState<string>('');
  const [sendingCmd, setSendingCmd] = useState<boolean>(false);
  const [reconnecting, setReconnecting] = useState<boolean>(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const pollInFlightRef = useRef<boolean>(false);
  const consecutiveErrRef = useRef<number>(0);

  const startNewRequest = useCallback(async () => {
    setRequesting(true);
    setErrorMsg('');
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
  }, [device.deviceId, requestedBy]);

  useEffect(() => {
    const t = setTimeout(() => {
      void startNewRequest();
    }, 0);
    return () => clearTimeout(t);
  }, [startNewRequest]);

  // Lightweight 1.2s delta polling while session is pending or active
  useEffect(() => {
    const status = session?.status;
    if (status !== 'pending' && status !== 'active') return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const latest = await fetchSupportSession(device.deviceId, true);
        if (cancelled) return;
        if (latest) {
          setSession(latest);
          consecutiveErrRef.current = 0;
          setReconnecting(false);
        } else {
          consecutiveErrRef.current += 1;
          if (consecutiveErrRef.current >= 2) setReconnecting(true);
        }
      } catch {
        if (!cancelled) {
          consecutiveErrRef.current += 1;
          if (consecutiveErrRef.current >= 2) setReconnecting(true);
        }
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const intervalId = setInterval(() => {
      setNowTick(Date.now());
      void poll();
    }, 1200);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [device.deviceId, session?.status]);

  const handleEndSession = async () => {
    setSendingCmd(true);
    try {
      const ended = await endSupportView(device.deviceId, true);
      if (ended) setSession(ended);
    } finally {
      setSendingCmd(false);
    }
  };

  const handleCloseModal = async () => {
    if (session?.status === 'pending' || session?.status === 'active') {
      await endSupportView(device.deviceId, true).catch(() => {});
    }
    onClose();
  };

  const handleMirrorTap = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (session?.status !== 'active' || !mirrorRef.current || sendingCmd) return;
    const rect = mirrorRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const xPct = Math.max(4, Math.min(96, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    const yPct = Math.max(4, Math.min(96, Math.round(((e.clientY - rect.top) / rect.height) * 100)));

    setSendingCmd(true);
    try {
      const updated = await sendSupportCommand(device.deviceId, {
        commandType: 'highlight_point',
        pointerX: xPct,
        pointerY: yPct,
        pointerLabel: 'Tap here',
        commandPayload: `${xPct},${yPct}`,
      });
      if (updated) setSession(updated);
    } finally {
      setSendingCmd(false);
    }
  };

  const handleNavigateStep = async (step: number, label: string) => {
    if (session?.status !== 'active' || sendingCmd) return;
    setSendingCmd(true);
    try {
      const updated = await sendSupportCommand(device.deviceId, {
        commandType: 'navigate_step',
        commandPayload: String(step),
        pointerX: -1,
        pointerY: -1,
        pointerLabel: `Opened ${label}`,
      });
      if (updated) setSession(updated);
    } finally {
      setSendingCmd(false);
    }
  };

  const handleSendTip = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tipInput.trim();
    if (!clean || session?.status !== 'active' || sendingCmd) return;
    setSendingCmd(true);
    try {
      const updated = await sendSupportCommand(device.deviceId, {
        commandType: 'show_tip',
        commandPayload: clean,
      });
      if (updated) setSession(updated);
      setTipInput('');
    } finally {
      setSendingCmd(false);
    }
  };

  const handleClearPointer = async () => {
    if (session?.status !== 'active' || sendingCmd) return;
    setSendingCmd(true);
    try {
      const updated = await sendSupportCommand(device.deviceId, {
        commandType: 'highlight_point',
        pointerX: -1,
        pointerY: -1,
        pointerLabel: '',
        commandPayload: '',
      });
      if (updated) setSession(updated);
    } finally {
      setSendingCmd(false);
    }
  };

  const status = session?.status || (requesting ? 'pending' : 'ended');
  const pendingSecondsLeft =
    session?.status === 'pending'
      ? Math.max(0, Math.ceil((session.expiresAtMs - nowTick) / 1000))
      : 0;

  const isPinScreen = session?.currentStep === 3;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[95] bg-[#0b121b]/95 backdrop-blur-sm flex flex-col overflow-hidden text-slate-100 select-none"
    >
      {/* Top Session Bar (Always Visible) */}
      <div
        className={`px-3 py-2.5 border-b flex items-center justify-between gap-2 shrink-0 ${
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
                {status === 'active' ? 'Remote Session Active' : 'Live Support View'}
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
                  {reconnecting ? 'Reconnecting...' : 'Low-Data Live'}
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
              <span>End Session</span>
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
      <div className="flex-1 overflow-y-auto p-3 flex flex-col items-center justify-start gap-3">
        {errorMsg && (
          <div className="w-full bg-rose-500/20 border border-rose-500/40 rounded-xl p-2.5 text-[11.5px] text-rose-200 flex items-center gap-2">
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
              A clear consent prompt has been sent to <b>{device.deviceName}</b>. Live Support View starts only after the user taps <b>Allow</b>.
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
                ? 'The user declined the Support View request. No screen data was shared.'
                : 'The live support session has ended. Neither side is sharing state.'}
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

        {/* 3. Active Transparent Live Mirror */}
        {status === 'active' && session && (
          <div className="w-full max-w-[350px] space-y-2.5">
            <div className="bg-[#17212b] border border-white/10 rounded-xl px-2.5 py-1.5 flex items-center justify-between text-[10.5px] text-slate-300">
              <span className="flex items-center gap-1.5 font-semibold text-emerald-300">
                <Eye className="w-3.5 h-3.5" />
                Tap screen to place visible guide pointer
              </span>
              <span className="font-mono text-[10px] text-[#7f91a4]">
                Δ#{session.stateSeq}
              </span>
            </div>

            {/* Mirrored CBEBirr Phone Viewport (Compact Vector Sync — ~300 bytes/update) */}
            <div
              ref={mirrorRef}
              onClick={handleMirrorTap}
              className="relative mx-auto w-[250px] rounded-[24px] overflow-hidden border-[3px] border-[#334155] bg-[#f6f1f8] text-slate-900 shadow-2xl cursor-crosshair"
            >
              {/* Simulated Persistent Active Banner on Mirrored Device */}
              <div className="bg-emerald-600 text-white text-[9.5px] font-bold px-2.5 py-1 flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  Remote Session Active
                </span>
                <span>End</span>
              </div>

              {/* App Header */}
              <div className="bg-gradient-to-r from-[#68176b] to-[#8a238e] text-white px-3 py-2.5">
                <div className="flex items-center justify-between text-[10px] opacity-85">
                  <span>Step {session.currentStep}</span>
                  <span className="uppercase font-bold">{session.activeTab}</span>
                </div>
                <p className="text-[13.5px] font-bold mt-0.5 truncate">
                  {session.screenTitle || 'CBEBirr Home'}
                </p>
              </div>

              {/* Screen Body */}
              <div className="p-3 min-h-[250px] flex flex-col justify-between space-y-2.5 bg-[#f8f5fa]">
                {isPinScreen ? (
                  <div className="my-auto bg-white border border-purple-200 rounded-2xl p-4 text-center space-y-2 shadow-xs">
                    <div className="w-10 h-10 mx-auto rounded-full bg-purple-100 text-[#7a1c7d] flex items-center justify-center">
                      <Lock className="w-5 h-5" />
                    </div>
                    <p className="text-[12px] font-bold text-slate-800">
                      PIN Entry Protected
                    </p>
                    <p className="text-[16px] tracking-[6px] font-mono text-[#7a1c7d] font-bold">
                      ••••
                    </p>
                    <p className="text-[10px] text-slate-500 leading-snug">
                      PIN & USSD confirmation stay strictly private on the user&apos;s phone.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Profile & Balance Card */}
                    <div className="bg-white rounded-2xl p-2.5 border border-purple-100 shadow-xs space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Smartphone className="w-3.5 h-3.5 text-[#7a1c7d] shrink-0" />
                          <span className="text-[11.5px] font-bold text-slate-800 truncate">
                            {session.userName || 'CBEBirr User'}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-slate-500 shrink-0">
                          {session.phoneNumber ? `+251${session.phoneNumber}` : ''}
                        </span>
                      </div>
                      <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                        <span className="text-[10px] text-slate-500 flex items-center gap-1">
                          <Wallet className="w-3 h-3 text-emerald-600" />
                          Balance
                        </span>
                        <span className="text-[13px] font-bold font-mono text-[#68176b]">
                          {Number(session.balance || 0).toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                          })}{' '}
                          ETB
                        </span>
                      </div>
                    </div>

                    {/* Live Form / Transfer Activity State */}
                    <div className="bg-white rounded-2xl p-2.5 border border-purple-100 shadow-xs space-y-2 flex-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-[#7a1c7d]">
                        Current Screen Activity
                      </p>
                      <div className="space-y-1.5 text-[11px]">
                        <div className="bg-slate-50 rounded-lg px-2 py-1.5">
                          <span className="block text-[9.5px] text-slate-400">Target / Details</span>
                          <span className="font-semibold text-slate-800 break-words">
                            {session.recipientSummary || 'Browsing screen'}
                          </span>
                        </div>
                        {session.amountSummary && (
                          <div className="bg-emerald-50 rounded-lg px-2 py-1.5 flex items-center justify-between">
                            <span className="text-[10px] text-emerald-700 font-semibold">Amount</span>
                            <span className="font-mono font-bold text-emerald-800">
                              {session.amountSummary} ETB
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}

                {/* Bottom Quick Visual Reference Bar */}
                <div className="grid grid-cols-4 gap-1 pt-1 border-t border-slate-200 text-center text-[9px] font-semibold text-slate-500">
                  <div className={session.activeTab === 'home' ? 'text-[#7a1c7d] font-bold' : ''}>Home</div>
                  <div className={session.activeTab === 'transfer' ? 'text-[#7a1c7d] font-bold' : ''}>Transfer</div>
                  <div className={session.activeTab === 'pay' ? 'text-[#7a1c7d] font-bold' : ''}>Pay Bill</div>
                  <div className={session.activeTab === 'others' ? 'text-[#7a1c7d] font-bold' : ''}>Others</div>
                </div>
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
                    <Crosshair className="w-3.5 h-3.5 text-emerald-700" />
                  </div>
                  {session.pointerLabel && (
                    <span className="mt-0.5 px-1.5 py-0.5 rounded bg-emerald-700 text-white text-[9px] font-bold whitespace-nowrap shadow">
                      {session.pointerLabel}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Quick Visible Guidance Navigation */}
            <div className="bg-[#17212b] border border-white/10 rounded-2xl p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-bold text-slate-200 flex items-center gap-1">
                  <Home className="w-3 h-3 text-[#5eb5f7]" />
                  Guide to Screen (Visible on device)
                </span>
                {session.pointerX >= 0 && (
                  <button
                    type="button"
                    onClick={handleClearPointer}
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
                    disabled={sendingCmd}
                    onClick={() => handleNavigateStep(item.step, item.label)}
                    className={`py-1.5 px-2 rounded-xl text-[10.5px] font-semibold cursor-pointer border transition-colors ${
                      session.currentStep === item.step
                        ? 'bg-[#2b5278] border-[#5eb5f7] text-white'
                        : 'bg-[#0e1621] border-white/10 text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Short Guidance Tip */}
              <form onSubmit={handleSendTip} className="flex gap-1.5 pt-1">
                <div className="relative flex-1">
                  <HelpCircle className="w-3.5 h-3.5 text-[#7f91a4] absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={tipInput}
                    onChange={(e) => setTipInput(e.target.value)}
                    maxLength={140}
                    placeholder="Send short on-screen help tip..."
                    className="w-full bg-[#0e1621] border border-white/10 rounded-xl pl-8 pr-2.5 py-1.5 text-[11px] text-white placeholder:text-slate-500 outline-none focus:border-[#5eb5f7]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!tipInput.trim() || sendingCmd}
                  className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  <Send className="w-3 h-3" />
                  <span>Tip</span>
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
