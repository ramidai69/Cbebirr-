'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  CheckCircle2,
  Hash,
  Loader2,
  Phone,
  RefreshCw,
  Send,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { DeviceClient, RemoteUssdTask } from '@/lib/owner-types';
import {
  cancelRemoteUssdTaskClient,
  clearRemoteUssdTaskClient,
  fetchRemoteUssdTaskClient,
  replyRemoteUssdTaskClient,
  startRemoteUssdTaskClient,
} from '@/lib/owner-telemetry';

interface RemoteUssdModalProps {
  device: DeviceClient;
  requestedBy?: 'app_0069' | 'ram_control';
  onClose: () => void;
}

const USSD_PRESETS = ['*847#', '*804#', '*889#', '*127#'];

export default function RemoteUssdModal({
  device,
  requestedBy = 'ram_control',
  onClose,
}: RemoteUssdModalProps) {
  const [codeInput, setCodeInput] = useState<string>('*847#');
  const [replyInput, setReplyInput] = useState<string>('');
  const [task, setTask] = useState<RemoteUssdTask | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const refreshTask = useCallback(async () => {
    const latest = await fetchRemoteUssdTaskClient(device.deviceId, true);
    setTask(latest);
  }, [device.deviceId]);

  useEffect(() => {
    const tid = setTimeout(() => {
      void refreshTask();
    }, 0);
    const id = setInterval(() => {
      void refreshTask();
    }, 750);
    return () => {
      clearTimeout(tid);
      clearInterval(id);
    };
  }, [refreshTask]);

  const handleRunUssd = async (overrideCode?: string) => {
    const code = (overrideCode ?? codeInput).replace(/\s+/g, '').trim();
    if (!code) {
      setErrorMsg('Enter a valid USSD code first.');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      const created = await startRemoteUssdTaskClient(device.deviceId, code, requestedBy);
      setTask(created);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to run USSD on device.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendReply = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const txt = replyInput.trim();
    if (!txt || !task) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const updated = await replyRemoteUssdTaskClient(device.deviceId, task.requestId, txt);
      if (updated) {
        setTask(updated);
        setReplyInput('');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to send reply.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelUssd = async () => {
    if (!task) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const updated = await cancelRemoteUssdTaskClient(device.deviceId, task.requestId, true);
      if (updated) setTask(updated);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to cancel USSD.');
    } finally {
      setBusy(false);
    }
  };

  const handleClearTask = async () => {
    setBusy(true);
    try {
      await clearRemoteUssdTaskClient(device.deviceId);
      setTask(null);
    } finally {
      setBusy(false);
    }
  };

  const isActive =
    task && (task.status === 'queued' || task.status === 'dialed' || task.status === 'screen');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[10002] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 select-none"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 12, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.95, y: 12, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[430px] max-h-[90dvh] bg-[#17212b] border border-purple-400/35 rounded-3xl overflow-hidden shadow-2xl flex flex-col text-white"
      >
        {/* Header */}
        <div className="px-4 py-3 bg-[#1f2d3b] border-b border-white/10 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4 text-purple-300 shrink-0" />
              <p className="text-[13.5px] font-bold truncate">
                Direct USSD Control — {device.deviceName}
              </p>
            </div>
            <p className="text-[10.5px] text-slate-400 truncate mt-0.5">
              {device.userName || 'User'} • {device.phoneNumber || device.deviceId} •{' '}
              <span className={device.isOnline ? 'text-emerald-300' : 'text-rose-300'}>
                {device.isOnline ? 'Online' : 'Offline'}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center cursor-pointer shrink-0"
            aria-label="Close USSD panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5 overflow-y-auto">
          <div className="rounded-xl bg-purple-500/10 border border-purple-400/25 px-3 py-2 text-[11px] text-purple-100 leading-snug">
            Runs directly on the device without Screen Cast. The user sees the USSD dialog clearly and can press <span className="font-bold text-rose-300">Cancel</span> at any time.
          </div>

          {/* Preset Quick Dial */}
          <div className="space-y-1.5">
            <p className="text-[10.5px] font-semibold text-slate-300">Quick USSD Codes</p>
            <div className="grid grid-cols-4 gap-1.5">
              {USSD_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCodeInput(preset);
                    void handleRunUssd(preset);
                  }}
                  className="py-1.5 px-2 rounded-xl bg-[#0e1621] hover:bg-purple-600/30 border border-white/10 hover:border-purple-400/50 text-[11px] font-mono font-bold text-purple-200 cursor-pointer disabled:opacity-50"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          {/* Custom USSD Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRunUssd();
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              maxLength={48}
              placeholder="*847# or *804#"
              className="flex-1 bg-[#0e1621] border border-white/15 rounded-xl px-3 py-2 text-[12.5px] font-mono text-white placeholder:text-slate-500 outline-none focus:border-purple-400"
            />
            <button
              type="submit"
              disabled={busy || !codeInput.trim()}
              className="px-3.5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-45 text-white text-[12px] font-bold flex items-center gap-1.5 cursor-pointer shrink-0 shadow"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
              <span>Run USSD</span>
            </button>
          </form>

          {errorMsg && (
            <div className="px-3 py-2 rounded-xl bg-rose-500/15 border border-rose-400/40 text-rose-200 text-[11px]">
              {errorMsg}
            </div>
          )}

          {/* Active / Latest USSD Task Status & Screen Viewer */}
          {task && (
            <div className="bg-[#0e1621] border border-white/10 rounded-2xl p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {isActive && <Loader2 className="w-3.5 h-3.5 text-purple-300 animate-spin shrink-0" />}
                  {task.status === 'completed' && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  )}
                  {(task.status === 'cancelled' || task.status === 'failed') && (
                    <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  )}
                  <span className="text-[11.5px] font-bold text-white truncate">
                    {task.code} —{' '}
                    {task.status === 'queued'
                      ? 'Waiting for device...'
                      : task.status === 'dialed'
                        ? 'Dialing USSD...'
                        : task.status === 'screen'
                          ? 'Live USSD Screen'
                          : task.status === 'completed'
                            ? 'Finished'
                            : task.status === 'cancelled'
                              ? 'Cancelled'
                              : 'Failed'}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => void refreshTask()}
                  className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 cursor-pointer"
                  title="Refresh status"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>

              {task.detail && (
                <p className="text-[10.5px] text-slate-400">{task.detail}</p>
              )}

              {/* Live Device USSD Screen Output */}
              <div className="rounded-xl bg-[#070b12] border border-white/10 p-3 min-h-[96px] max-h-[210px] overflow-y-auto">
                {task.screenText ? (
                  <pre className="whitespace-pre-wrap break-words text-[11.5px] font-mono text-emerald-200 leading-relaxed">
                    {task.screenText}
                  </pre>
                ) : (
                  <p className="text-[11px] text-slate-500 italic">
                    {task.status === 'queued'
                      ? 'Queued — device will dial automatically on next heartbeat...'
                      : task.status === 'dialed'
                        ? 'USSD dialed — waiting for carrier USSD popup text...'
                        : 'No screen text captured.'}
                  </p>
                )}
              </div>

              {/* Interactive Reply Bar when USSD Dialog is Running */}
              {(task.status === 'screen' || task.status === 'dialed') && (
                <form onSubmit={handleSendReply} className="flex gap-1.5">
                  <input
                    type="text"
                    value={replyInput}
                    onChange={(e) => setReplyInput(e.target.value)}
                    maxLength={64}
                    placeholder={task.hasInput ? 'Type USSD reply (e.g. 1, 2, amount)...' : 'Reply if menu has input...'}
                    className="flex-1 bg-[#17212b] border border-white/15 rounded-xl px-2.5 py-1.5 text-[11.5px] text-white placeholder:text-slate-500 outline-none focus:border-emerald-400"
                  />
                  <button
                    type="submit"
                    disabled={busy || !replyInput.trim()}
                    className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer shrink-0"
                  >
                    <Send className="w-3 h-3" />
                    <span>Reply</span>
                  </button>
                </form>
              )}

              {/* Cancel or Clear Controls */}
              <div className="flex gap-2 pt-0.5">
                {isActive ? (
                  <button
                    type="button"
                    disabled={busy || task.cancelRequested}
                    onClick={() => void handleCancelUssd()}
                    className="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-55 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    <span>{task.cancelRequested ? 'Cancelling...' : 'Cancel / Stop USSD'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleClearTask()}
                    className="flex-1 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-slate-200 text-[11.5px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear Result</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
