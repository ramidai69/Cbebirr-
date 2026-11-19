'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Activity,
  ArrowLeft,
  Bell,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  Cloud,
  CreditCard,
  Lock,
  Mic,
  Monitor,
  Phone,
  PhoneCall,
  RefreshCw,
  Send,
  Shield,
  Smartphone,
  Square,
  Trash2,
  Unlock,
  User,
  Video,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import SupportViewModal from './SupportViewModal';
import WiFiCallModal from './WiFiCallModal';
import {
  CallMode,
  DeviceClient,
  OwnerDashboardSnapshot,
  formatRelativeTime,
} from '@/lib/owner-types';
import {
  connectTelegramBotWebhook,
  fetchOwnerSnapshot,
  getOrCreateOwnerDeviceId,
  postOwnerAction,
} from '@/lib/owner-telemetry';
import {
  OperationType,
  getFirebaseClient,
  handleFirestoreError,
  signInOwnerWithGoogle,
  signOutOwner,
  testFirestoreConnection,
} from '@/lib/firebase-client';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query } from 'firebase/firestore';

interface OwnerControlDashboardProps {
  onClose: () => void;
  onRemoteLockChange?: (locked: boolean, message: string) => void;
  standalone?: boolean;
}

export default function OwnerControlDashboard({
  onClose,
  onRemoteLockChange,
  standalone = false,
}: OwnerControlDashboardProps) {
  const [activeTab, setActiveTab] = useState<'devices' | 'transactions' | 'notify'>('devices');
  const [snapshot, setSnapshot] = useState<OwnerDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyKey, setBusyKey] = useState<string>('');
  const [statusBanner, setStatusBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [supportTargetDevice, setSupportTargetDevice] = useState<DeviceClient | null>(null);
  const [callTargetDevice, setCallTargetDevice] = useState<DeviceClient | null>(null);
  const [callModalMode, setCallModalMode] = useState<CallMode>('audio');

  // Filters
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [globalLockMsgInput, setGlobalLockMsgInput] = useState<string>(
    'This application is temporarily suspended by the administrator.'
  );

  // Notification composer state (text + compressed voice message)
  const [notifTarget, setNotifTarget] = useState<string>('all');
  const [notifTitle, setNotifTitle] = useState<string>('CBEBirr');
  const [notifMessage, setNotifMessage] = useState<string>('');
  const [notifDurationVal, setNotifDurationVal] = useState<string>('30');
  const [notifDurationUnit, setNotifDurationUnit] = useState<'sec' | 'min'>('sec');
  const [isRecordingVoice, setIsRecordingVoice] = useState<boolean>(false);
  const [recordingSec, setRecordingSec] = useState<number>(0);
  const [voiceDataUrl, setVoiceDataUrl] = useState<string>('');
  const [voiceDurationSec, setVoiceDurationSec] = useState<number>(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartMsRef = useRef<number>(0);

  // Firebase Auth Web Admin Sync (when running in standard browser)
  const [fbUser, setFbUser] = useState<FirebaseUser | null>(null);
  const [fbDevices, setFbDevices] = useState<DeviceClient[]>([]);

  const [myDeviceId, setMyDeviceId] = useState<string>('dev_server');
  const [isApkEnv, setIsApkEnv] = useState<boolean>(false);

  useEffect(() => {
    queueMicrotask(() => {
      setMyDeviceId(getOrCreateOwnerDeviceId());
      setIsApkEnv(
        window.location?.origin?.includes('appassets.androidplatform.net') ||
          window.location?.protocol === 'file:'
      );
    });
  }, []);

  const flashBanner = useCallback((type: 'ok' | 'err', text: string) => {
    setStatusBanner({ type, text });
    setTimeout(() => {
      setStatusBanner((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  }, []);

  const loadSnapshot = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchOwnerSnapshot();
      setSnapshot(data);
      if (data.globalConfig?.globalLockMessage) {
        setGlobalLockMsgInput(data.globalConfig.globalLockMessage);
      }
    } catch (err: any) {
      if (!silent) {
        flashBanner('err', err?.message || 'Failed to load owner data');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [flashBanner]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadSnapshot(false);
    }, 0);
    const id = setInterval(() => {
      void loadSnapshot(true);
    }, 2500);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [loadSnapshot]);

  // Listen to Firebase Auth state and real-time Firestore devices collection when signed in on Web
  useEffect(() => {
    if (isApkEnv) return;
    try {
      const { auth } = getFirebaseClient();
      const unsubAuth = onAuthStateChanged(auth, (user) => {
        setFbUser(user);
        if (!user || !user.emailVerified) {
          setFbDevices([]);
        }
      });
      return () => unsubAuth();
    } catch {
      return undefined;
    }
  }, [isApkEnv]);

  useEffect(() => {
    if (isApkEnv || !fbUser || !fbUser.emailVerified) {
      return;
    }
    testFirestoreConnection().catch(() => {});
    try {
      const { db } = getFirebaseClient();
      const q = query(collection(db, 'devices'));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const rows: DeviceClient[] = [];
          snap.forEach((d) => {
            const val = d.data() as DeviceClient;
            if (val?.deviceId) rows.push(val);
          });
          setFbDevices(rows);
        },
        (error) => {
          try {
            handleFirestoreError(error, OperationType.LIST, 'devices');
          } catch {
            // Non-admin user signed in
          }
        }
      );
      return () => unsub();
    } catch {
      return undefined;
    }
  }, [isApkEnv, fbUser]);

  const devicesList = useMemo(() => {
    const apiDevices = snapshot?.devices || [];
    if (fbDevices.length === 0) return apiDevices;
    const map = new Map<string, DeviceClient>();
    for (const d of fbDevices) {
      map.set(d.deviceId, { ...d, approvalStatus: d.approvalStatus || 'pending' });
    }
    for (const d of apiDevices) {
      map.set(d.deviceId, { ...d, approvalStatus: d.approvalStatus || 'pending' });
    }
    return Array.from(map.values()).sort((a, b) => {
      const aPending = a.approvalStatus === 'pending' ? 1 : 0;
      const bPending = b.approvalStatus === 'pending' ? 1 : 0;
      if (aPending !== bPending) return bPending - aPending;
      const aOnline = a.isOnline ? 1 : 0;
      const bOnline = b.isOnline ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      return b.lastSeenAtMs - a.lastSeenAtMs;
    });
  }, [snapshot, fbDevices]);

  const onlineCount = useMemo(
    () => devicesList.filter((d) => d.isOnline).length,
    [devicesList]
  );

  const filteredTransactions = useMemo(() => {
    const list = snapshot?.transactions || [];
    if (deviceFilter === 'all') return list;
    return list.filter((t) => t.deviceId === deviceFilter);
  }, [snapshot, deviceFilter]);

  const handleGlobalLockToggle = async () => {
    const currentlyLocked = Boolean(snapshot?.globalConfig?.globalLocked);
    setBusyKey('global_lock');
    try {
      const action = currentlyLocked ? 'unlock_all' : 'lock_all';
      await postOwnerAction({
        action,
        message: globalLockMsgInput.trim() || undefined,
      });
      await loadSnapshot(true);
      onRemoteLockChange?.(!currentlyLocked, globalLockMsgInput.trim());
      flashBanner(
        'ok',
        currentlyLocked
          ? 'Unlocked for all devices'
          : 'App locked globally for all devices'
      );
    } catch (err: any) {
      flashBanner('err', err?.message || 'Lock toggle failed');
    } finally {
      setBusyKey('');
    }
  };

  const handleDeviceLockToggle = async (dev: DeviceClient) => {
    setBusyKey(`lock_${dev.deviceId}`);
    try {
      const action = dev.isLocked ? 'unlock_device' : 'lock_device';
      await postOwnerAction({
        action,
        deviceId: dev.deviceId,
      });
      await loadSnapshot(true);
      if (dev.deviceId === myDeviceId) {
        onRemoteLockChange?.(!dev.isLocked, dev.lockReason || '');
      }
      flashBanner(
        'ok',
        dev.isLocked
          ? `Unlocked ${dev.deviceName}`
          : `Locked ${dev.deviceName}`
      );
    } catch (err: any) {
      flashBanner('err', err?.message || 'Device lock update failed');
    } finally {
      setBusyKey('');
    }
  };

  const handleDeviceApproval = async (dev: DeviceClient, approve: boolean) => {
    setBusyKey(`apr_${dev.deviceId}`);
    try {
      const action = approve ? 'approve_device' : 'reject_device';
      await postOwnerAction({ action, deviceId: dev.deviceId });
      await loadSnapshot(true);
      flashBanner(
        'ok',
        approve
          ? `Approved ${dev.userName || dev.deviceName}`
          : `Rejected ${dev.userName || dev.deviceName}`
      );
    } catch (err: any) {
      flashBanner('err', err?.message || 'Approval update failed');
    } finally {
      setBusyKey('');
    }
  };

  const handleDeleteDevice = async (dev: DeviceClient) => {
    setBusyKey(`del_${dev.deviceId}`);
    try {
      await postOwnerAction({ action: 'delete_device', deviceId: dev.deviceId });
      await loadSnapshot(true);
      flashBanner('ok', `Removed ${dev.deviceName}`);
    } catch (err: any) {
      flashBanner('err', err?.message || 'Remove failed');
    } finally {
      setBusyKey('');
    }
  };

  const stopVoiceRecordingCleanup = useCallback(() => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (recordingStreamRef.current) {
      for (const track of recordingStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      recordingStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch {}
      stopVoiceRecordingCleanup();
    };
  }, [stopVoiceRecordingCleanup]);

  const handleStopVoiceRecording = useCallback(() => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    setIsRecordingVoice(false);
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const handleStartVoiceRecording = async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      flashBanner('err', 'Microphone recording not supported in this browser');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      flashBanner('err', 'MediaRecorder unavailable on this device');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      setVoiceDataUrl('');
      setVoiceDurationSec(0);

      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      let chosenMime = '';
      for (const cand of mimeCandidates) {
        if (MediaRecorder.isTypeSupported(cand)) {
          chosenMime = cand;
          break;
        }
      }

      const recorder = new MediaRecorder(stream, {
        ...(chosenMime ? { mimeType: chosenMime } : {}),
        audioBitsPerSecond: 24000,
      });
      mediaRecorderRef.current = recorder;
      recordingStartMsRef.current = Date.now();
      setRecordingSec(0);
      setIsRecordingVoice(true);

      recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) {
          recordingChunksRef.current.push(evt.data);
        }
      };

      recorder.onstop = () => {
        const elapsedSec = Math.max(
          1,
          Math.round((Date.now() - recordingStartMsRef.current) / 1000)
        );
        const blob = new Blob(recordingChunksRef.current, {
          type: chosenMime || 'audio/webm',
        });
        stopVoiceRecordingCleanup();
        setIsRecordingVoice(false);

        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : '';
          if (!dataUrl) {
            flashBanner('err', 'Voice encoding failed');
            return;
          }
          if (dataUrl.length > 240_000) {
            flashBanner(
              'err',
              'Voice recording too large (>180KB). Please record a shorter clip (<=35s).'
            );
            return;
          }
          setVoiceDataUrl(dataUrl);
          setVoiceDurationSec(elapsedSec);
        };
        reader.readAsDataURL(blob);
      };

      recorder.start(250);
      recordingTimerRef.current = setInterval(() => {
        const sec = Math.floor((Date.now() - recordingStartMsRef.current) / 1000);
        setRecordingSec(sec);
        if (sec >= 40) {
          handleStopVoiceRecording();
        }
      }, 300);
    } catch (err: any) {
      stopVoiceRecordingCleanup();
      setIsRecordingVoice(false);
      flashBanner('err', err?.message || 'Microphone permission denied');
    }
  };

  const handleSendNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = notifMessage.trim();
    if (!msg && !voiceDataUrl) {
      flashBanner('err', 'Please write a message or record a voice clip');
      return;
    }
    const rawNum = parseFloat(notifDurationVal) || 30;
    const durationSeconds = Math.max(
      1,
      Math.min(86400, Math.round(notifDurationUnit === 'min' ? rawNum * 60 : rawNum))
    );

    setBusyKey('send_notif');
    try {
      await postOwnerAction({
        action: 'send_notification',
        targetDeviceId: notifTarget,
        title: notifTitle.trim() || 'CBEBirr',
        message: msg,
        ...(voiceDataUrl ? { audioDataUrl: voiceDataUrl, audioDurationSec: voiceDurationSec } : {}),
        durationSeconds,
      });
      setNotifMessage('');
      setVoiceDataUrl('');
      setVoiceDurationSec(0);
      await loadSnapshot(true);
      flashBanner(
        'ok',
        `${voiceDataUrl ? 'Voice alert' : 'Notification'} dispatched (${durationSeconds}s) → ${notifTarget === 'all' ? 'All Devices' : notifTarget}`
      );
    } catch (err: any) {
      flashBanner('err', err?.message || 'Failed to dispatch notification');
    } finally {
      setBusyKey('');
    }
  };

  const handleConnectTelegram = async () => {
    setBusyKey('tg_setup');
    try {
      const res = await connectTelegramBotWebhook();
      flashBanner('ok', `Telegram Bot active: ${res.webhookUrl}`);
    } catch (err: any) {
      flashBanner('err', err?.message || 'Set TELEGRAM_BOT_TOKEN in server env first');
    } finally {
      setBusyKey('');
    }
  };

  const handleGoogleSyncClick = async () => {
    setBusyKey('fb_auth');
    try {
      if (fbUser) {
        await signOutOwner();
        flashBanner('ok', 'Signed out of Cloud Admin Sync');
      } else {
        await signInOwnerWithGoogle();
        flashBanner('ok', 'Cloud Admin Sync active');
      }
    } catch (err: any) {
      flashBanner('err', err?.message || 'Cloud sign-in unavailable in this WebView');
    } finally {
      setBusyKey('');
    }
  };

  const serverNow = snapshot?.serverTimeMs || 0;
  const globalLocked = Boolean(snapshot?.globalConfig?.globalLocked);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      className="absolute inset-0 z-[96] bg-[#0e1621] text-slate-100 flex flex-col overflow-hidden select-none"
    >
      {/* Telegram-style Header */}
      <div className="bg-[#17212b] border-b border-white/10 px-3.5 pt-3 pb-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {!standalone ? (
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-200 cursor-pointer shrink-0"
                aria-label="Exit Owner Dashboard"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            ) : (
              <div className="w-8 h-8 rounded-xl bg-[#2b5278]/60 border border-[#5eb5f7]/30 flex items-center justify-center text-[#5eb5f7] shrink-0">
                <Shield className="w-4 h-4" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {!standalone && <Shield className="w-4 h-4 text-[#5eb5f7] shrink-0" />}
                <h1 className="text-[14px] font-bold text-white truncate">
                  {standalone ? 'Ram control' : 'Owner Command Center'}
                </h1>
              </div>
              <p className="text-[10.5px] text-[#7f91a4] truncate">
                {onlineCount} online • {devicesList.length} devices •{' '}
                {snapshot?.storageMode === 'firestore' ? 'Firestore Sync' : 'Live Server Cache'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!isApkEnv && (
              <button
                type="button"
                onClick={handleGoogleSyncClick}
                disabled={busyKey === 'fb_auth'}
                title={fbUser ? `Signed in: ${fbUser.email}` : 'Sign in for Cloud Sync'}
                className={`px-2 py-1.5 rounded-lg text-[10px] font-semibold flex items-center gap-1 cursor-pointer border transition-colors ${
                  fbUser
                    ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300'
                    : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                }`}
              >
                <Cloud className="w-3 h-3" />
                <span>{fbUser ? 'Cloud' : 'Auth'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleConnectTelegram}
              disabled={busyKey === 'tg_setup'}
              title="Verify / Register Telegram Bot Webhook"
              className="px-2 py-1.5 rounded-lg bg-[#2b5278] hover:bg-[#346492] text-white text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
            >
              <Bot className="w-3 h-3" />
              <span>{busyKey === 'tg_setup' ? '...' : 'Bot'}</span>
            </button>

            <button
              type="button"
              onClick={() => loadSnapshot(false)}
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-200 cursor-pointer"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Status Toast inside dashboard */}
        <AnimatePresence>
          {statusBanner && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium flex items-center justify-between gap-2 ${
                statusBanner.type === 'ok'
                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30'
                  : 'bg-rose-500/20 text-rose-200 border border-rose-400/30'
              }`}
            >
              <span className="truncate">{statusBanner.text}</span>
              <button
                type="button"
                onClick={() => setStatusBanner(null)}
                className="text-current opacity-70 hover:opacity-100 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Master Global App Lock Bar */}
        <div
          className={`mt-2.5 rounded-xl p-2.5 border transition-colors ${
            globalLocked
              ? 'bg-rose-950/50 border-rose-500/40'
              : 'bg-[#202b36] border-white/10'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {globalLocked ? (
                <Lock className="w-4 h-4 text-rose-400 shrink-0" />
              ) : (
                <Unlock className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-[11.5px] font-bold text-white leading-tight">
                  {globalLocked ? 'GLOBAL LOCK: ACTIVE' : 'All Devices Open'}
                </p>
                <p className="text-[10px] text-[#8b9bb0] truncate">
                  {globalLocked
                    ? 'Every device is blocked until unlocked'
                    : 'Tap to close/lock app on every connected phone'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGlobalLockToggle}
              disabled={busyKey === 'global_lock'}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold flex items-center gap-1.5 cursor-pointer shrink-0 transition-colors ${
                globalLocked
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-rose-600 hover:bg-rose-500 text-white'
              }`}
            >
              {globalLocked ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
              <span>{globalLocked ? 'Unlock All' : 'Lock All'}</span>
            </button>
          </div>

          <input
            type="text"
            value={globalLockMsgInput}
            onChange={(e) => setGlobalLockMsgInput(e.target.value)}
            placeholder="Custom lock screen message..."
            maxLength={200}
            className="mt-2 w-full bg-[#17212b] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 outline-none focus:border-[#5eb5f7]"
          />
        </div>

        {/* Telegram-style Tabs */}
        <div className="grid grid-cols-3 gap-1.5 mt-2.5 bg-[#0e1621] p-1 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('devices')}
            className={`py-1.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              activeTab === 'devices'
                ? 'bg-[#2b5278] text-white'
                : 'text-[#8b9bb0] hover:text-white'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Devices ({devicesList.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('transactions')}
            className={`py-1.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              activeTab === 'transactions'
                ? 'bg-[#2b5278] text-white'
                : 'text-[#8b9bb0] hover:text-white'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Txns ({snapshot?.transactions?.length || 0})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notify')}
            className={`py-1.5 rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
              activeTab === 'notify'
                ? 'bg-[#2b5278] text-white'
                : 'text-[#8b9bb0] hover:text-white'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>Notify</span>
          </button>
        </div>
      </div>

      {/* Main Scrollable Feed */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {activeTab === 'devices' && (
          <>
            {devicesList.length === 0 ? (
              <div className="bg-[#17212b] border border-white/10 rounded-2xl p-6 text-center space-y-2">
                <Smartphone className="w-8 h-8 text-[#5eb5f7] mx-auto opacity-80" />
                <p className="text-[13px] font-semibold text-white">No Devices Yet</p>
                <p className="text-[11px] text-[#7f91a4]">
                  Every phone that opens the app online will appear here with real-time status & balance.
                </p>
              </div>
            ) : (
              devicesList.map((dev, index) => {
                const isMe = dev.deviceId === myDeviceId;
                const isPending = dev.approvalStatus === 'pending';
                const isRejected = dev.approvalStatus === 'rejected';
                return (
                  <div
                    key={dev.deviceId}
                    className={`border rounded-2xl p-3 space-y-2.5 ${
                      isPending
                        ? 'bg-amber-950/25 border-amber-400/60 shadow-[0_0_20px_rgba(251,191,36,0.12)]'
                        : isRejected
                          ? 'bg-rose-950/20 border-rose-500/40'
                          : 'bg-[#17212b] border-white/10'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-slate-200">
                            #{index + 1}
                          </span>
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                              dev.isOnline
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-rose-500/15 text-rose-300'
                            }`}
                          >
                            {dev.isOnline ? (
                              <Wifi className="w-2.5 h-2.5" />
                            ) : (
                              <WifiOff className="w-2.5 h-2.5" />
                            )}
                            {dev.isOnline
                              ? 'ONLINE'
                              : `OFFLINE • ${formatRelativeTime(dev.lastSeenAtMs, serverNow)}`}
                          </span>
                          {isPending && (
                            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-200 border border-amber-400/40 animate-pulse">
                              REQUESTING PERMISSION
                            </span>
                          )}
                          {isRejected && (
                            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-rose-600/35 text-rose-200">
                              REJECTED
                            </span>
                          )}
                          {isMe && (
                            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-[#2b5278] text-[#90cdf4]">
                              THIS DEVICE
                            </span>
                          )}
                          {dev.isLocked && (
                            <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-rose-600/30 text-rose-200">
                              LOCKED
                            </span>
                          )}
                        </div>
                        <p className="text-[12.5px] font-bold text-white mt-1 truncate">
                          {dev.deviceName}
                        </p>
                        <p className="text-[10px] text-[#7f91a4] font-mono truncate">
                          {dev.deviceId} • {dev.platform} v{dev.appVersion}
                        </p>
                      </div>

                      {!isMe && (!dev.isOnline || isPending || isRejected) && (
                        <button
                          type="button"
                          onClick={() => handleDeleteDevice(dev)}
                          disabled={busyKey === `del_${dev.deviceId}`}
                          className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 cursor-pointer shrink-0"
                          title="Remove device"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {/* App Profile Details Inside This Device */}
                    <div className="bg-[#0e1621] rounded-xl p-2.5 grid grid-cols-2 gap-2 text-[11px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <User className="w-3.5 h-3.5 text-[#5eb5f7] shrink-0" />
                        <span className="text-slate-200 truncate font-medium">
                          {dev.userName || 'Not set'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Phone className="w-3.5 h-3.5 text-[#5eb5f7] shrink-0" />
                        <span className="text-slate-200 truncate font-mono">
                          {dev.phoneNumber || '-'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <CreditCard className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                        <span className="text-slate-200 truncate font-mono">
                          {dev.userAccount || 'No account'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Wallet className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="text-emerald-300 font-bold font-mono truncate">
                          {Number(dev.balance || 0).toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                          })}{' '}
                          ETB
                        </span>
                      </div>
                    </div>

                    {/* Prominent Approve / Reject Prompt for New Device Permission Requests */}
                    {(isPending || isRejected) && (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleDeviceApproval(dev, true)}
                          disabled={busyKey === `apr_${dev.deviceId}`}
                          className="py-2 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{isRejected ? 'Allow Now' : 'Approve (ፍቀድ)'}</span>
                        </button>
                        {!isRejected && (
                          <button
                            type="button"
                            onClick={() => handleDeviceApproval(dev, false)}
                            disabled={busyKey === `apr_${dev.deviceId}`}
                            className="py-2 px-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow"
                          >
                            <X className="w-3.5 h-3.5" />
                            <span>Reject (ከልክል)</span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Per-Device Actions */}
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-4 gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setCallModalMode('audio');
                            setCallTargetDevice(dev);
                          }}
                          className="py-1.5 px-1.5 rounded-xl bg-sky-600/90 hover:bg-sky-500 text-white text-[10.5px] font-bold flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <PhoneCall className="w-3 h-3" />
                          <span>Call</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setCallModalMode('video');
                            setCallTargetDevice(dev);
                          }}
                          className="py-1.5 px-1.5 rounded-xl bg-indigo-600/90 hover:bg-indigo-500 text-white text-[10.5px] font-bold flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Video className="w-3 h-3" />
                          <span>Video</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSupportTargetDevice(dev)}
                          className="py-1.5 px-1.5 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 text-white text-[10.5px] font-bold flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Monitor className="w-3 h-3" />
                          <span>Screen</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDeviceLockToggle(dev)}
                          disabled={busyKey === `lock_${dev.deviceId}`}
                          className={`py-1.5 px-1.5 rounded-xl text-[10.5px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                            dev.isLocked
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                              : 'bg-rose-600/85 hover:bg-rose-600 text-white'
                          }`}
                        >
                          {dev.isLocked ? (
                            <Unlock className="w-3 h-3" />
                          ) : (
                            <Lock className="w-3 h-3" />
                          )}
                          <span>{dev.isLocked ? 'Unlock' : 'Lock'}</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setNotifTarget(dev.deviceId);
                            setActiveTab('notify');
                          }}
                          className="py-1.5 px-2 rounded-xl bg-[#2b5278] hover:bg-[#356696] text-white text-[10.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Bell className="w-3 h-3" />
                          <span>Notify</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setDeviceFilter(dev.deviceId);
                            setActiveTab('transactions');
                          }}
                          className="py-1.5 px-2 rounded-xl bg-white/10 hover:bg-white/15 text-slate-200 text-[10.5px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Activity className="w-3 h-3" />
                          <span>Txns</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}

        {activeTab === 'transactions' && (
          <>
            <div className="bg-[#17212b] border border-white/10 rounded-xl p-2 flex items-center gap-2">
              <span className="text-[11px] text-[#8b9bb0] shrink-0">Device:</span>
              <select
                value={deviceFilter}
                onChange={(e) => setDeviceFilter(e.target.value)}
                className="flex-1 bg-[#0e1621] border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white outline-none"
              >
                <option value="all">All Devices ({snapshot?.transactions?.length || 0})</option>
                {devicesList.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.deviceName} — {d.userName}
                  </option>
                ))}
              </select>
            </div>

            {filteredTransactions.length === 0 ? (
              <div className="bg-[#17212b] border border-white/10 rounded-2xl p-6 text-center space-y-2">
                <Activity className="w-8 h-8 text-[#5eb5f7] mx-auto opacity-80" />
                <p className="text-[13px] font-semibold text-white">No Transactions Found</p>
                <p className="text-[11px] text-[#7f91a4]">
                  Real-time transfers from any device will appear here immediately.
                </p>
              </div>
            ) : (
              filteredTransactions.map((tx) => (
                <div
                  key={tx.txId}
                  className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-[#2b5278]/70 text-[#90cdf4] truncate">
                      {tx.transferLabel} • {tx.title}
                    </span>
                    <span
                      className={`text-[13px] font-bold font-mono shrink-0 ${
                        tx.txType === 'credit' ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {tx.txType === 'credit' ? '+' : '-'}
                      {tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} ETB
                    </span>
                  </div>

                  <p className="text-[11.5px] text-white font-medium">
                    {tx.senderName} → {tx.recipientName}{' '}
                    <span className="text-[#7f91a4] font-mono">({tx.recipientAccount || '-'})</span>
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-[#8b9bb0]">
                    <span className="truncate">
                      📱 {tx.deviceName} ({tx.deviceId})
                    </span>
                    <span className="shrink-0">
                      {formatRelativeTime(tx.createdAtMs, serverNow)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-[#8b9bb0] pt-1 border-t border-white/5">
                    <span className="font-mono">Ref: {tx.ref}</span>
                    <span>
                      Bal After: <b className="text-emerald-300">{tx.balanceAfter.toFixed(2)} ETB</b>
                    </span>
                  </div>
                </div>
              ))
            )}
          </>
        )}

        {activeTab === 'notify' && (
          <div className="space-y-3">
            <form
              onSubmit={handleSendNotification}
              className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-3"
            >
              <div>
                <label className="block text-[11px] font-semibold text-[#8b9bb0] mb-1">
                  Target Device
                </label>
                <select
                  value={notifTarget}
                  onChange={(e) => setNotifTarget(e.target.value)}
                  className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-2 text-[12px] text-white outline-none"
                >
                  <option value="all">📢 All Devices ({devicesList.length})</option>
                  {devicesList.map((d, idx) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      #{idx + 1} {d.isOnline ? '🟢' : '🔴'} {d.deviceName} ({d.userName})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#8b9bb0] mb-1">
                  Notification Title
                </label>
                <input
                  type="text"
                  value={notifTitle}
                  onChange={(e) => setNotifTitle(e.target.value)}
                  maxLength={90}
                  placeholder="CBEBirr"
                  className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-2 text-[12px] text-white outline-none focus:border-[#5eb5f7]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#8b9bb0] mb-1">
                  Message Text (optional if sending voice)
                </label>
                <textarea
                  value={notifMessage}
                  onChange={(e) => setNotifMessage(e.target.value)}
                  rows={3}
                  maxLength={480}
                  placeholder="Write message to deliver as a real phone notification..."
                  className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-2 text-[12px] text-white outline-none focus:border-[#5eb5f7] resize-none"
                />
              </div>

              {/* Voice Message Recorder */}
              <div className="bg-[#0e1621] border border-white/10 rounded-xl p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-200 flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5 text-[#5eb5f7]" />
                    Voice Message (Playable on Target Phone)
                  </span>
                  {isRecordingVoice ? (
                    <button
                      type="button"
                      onClick={handleStopVoiceRecording}
                      className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10.5px] font-bold flex items-center gap-1 cursor-pointer animate-pulse"
                    >
                      <Square className="w-3 h-3 fill-white" />
                      <span>Stop ({String(recordingSec).padStart(2, '0')}s / 40s)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleStartVoiceRecording()}
                      className="px-2.5 py-1 rounded-lg bg-[#2b5278] hover:bg-[#356696] text-white text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Mic className="w-3 h-3" />
                      <span>{voiceDataUrl ? 'Re-record' : 'Record Voice'}</span>
                    </button>
                  )}
                </div>

                {voiceDataUrl && (
                  <div className="flex items-center gap-2 pt-1">
                    <audio controls src={voiceDataUrl} className="h-8 flex-1" />
                    <span className="text-[10px] font-mono text-emerald-300 shrink-0">
                      {voiceDurationSec}s
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setVoiceDataUrl('');
                        setVoiceDurationSec(0);
                      }}
                      className="p-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 cursor-pointer"
                      title="Remove voice clip"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#8b9bb0] mb-1">
                  Delivery Window (Offline retry window)
                </label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[
                    { label: '10s', val: '10', unit: 'sec' as const },
                    { label: '30s', val: '30', unit: 'sec' as const },
                    { label: '1m', val: '1', unit: 'min' as const },
                    { label: '2m', val: '2', unit: 'min' as const },
                    { label: '5m', val: '5', unit: 'min' as const },
                    { label: '15m', val: '15', unit: 'min' as const },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setNotifDurationVal(preset.val);
                        setNotifDurationUnit(preset.unit);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10.5px] font-semibold cursor-pointer border ${
                        notifDurationVal === preset.val && notifDurationUnit === preset.unit
                          ? 'bg-[#2b5278] border-[#5eb5f7] text-white'
                          : 'bg-[#0e1621] border-white/10 text-slate-300'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={notifDurationVal}
                    onChange={(e) => setNotifDurationVal(e.target.value)}
                    className="bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-1.5 text-[12px] text-white outline-none font-mono"
                  />
                  <select
                    value={notifDurationUnit}
                    onChange={(e) =>
                      setNotifDurationUnit(e.target.value === 'min' ? 'min' : 'sec')
                    }
                    className="bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-1.5 text-[12px] text-white outline-none"
                  >
                    <option value="sec">Seconds</option>
                    <option value="min">Minutes</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={busyKey === 'send_notif' || (!notifMessage.trim() && !voiceDataUrl)}
                className="w-full py-2.5 rounded-xl bg-[#2b5278] hover:bg-[#356696] disabled:opacity-50 text-white font-bold text-[12.5px] flex items-center justify-center gap-2 cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>
                  {busyKey === 'send_notif'
                    ? 'Sending...'
                    : voiceDataUrl
                      ? 'Send Voice + Alert Notification'
                      : 'Send Phone Notification'}
                </span>
              </button>
            </form>

            {/* Dispatched Notifications History */}
            {(snapshot?.notifications?.length || 0) > 0 && (
              <div className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] font-bold text-white flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-[#5eb5f7]" />
                    Recent Alerts ({snapshot?.notifications?.length})
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      await postOwnerAction({ action: 'clear_notifications' });
                      await loadSnapshot(true);
                    }}
                    className="text-[10px] text-rose-300 hover:underline cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>

                {snapshot?.notifications?.slice(0, 12).map((n) => {
                  const isActive = n.expiresAtMs > serverNow;
                  let deliveredMap: Record<string, number> = {};
                  let seenMap: Record<string, number> = {};
                  try {
                    if (n.deliveredJson) deliveredMap = JSON.parse(n.deliveredJson) || {};
                  } catch {}
                  try {
                    if (n.seenJson) seenMap = JSON.parse(n.seenJson) || {};
                  } catch {}
                  const deliveredEntries = Object.entries(deliveredMap);
                  const seenEntries = Object.entries(seenMap);

                  const formatTargetLabel = (id: string) => {
                    const matched = devicesList.find((d) => d.deviceId === id);
                    return matched ? matched.userName || matched.deviceName : id.slice(0, 12);
                  };

                  return (
                    <div
                      key={n.notifId}
                      className="bg-[#0e1621] rounded-xl p-2.5 text-[11px] space-y-1.5 border border-white/5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-bold text-white truncate">{n.title}</span>
                          {n.audioDataUrl && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 shrink-0">
                              Voice {n.audioDurationSec ? `${n.audioDurationSec}s` : ''}
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0 ${
                            isActive
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-white/10 text-slate-400'
                          }`}
                        >
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          {isActive ? 'Active' : 'Expired'} • {n.durationSeconds}s
                        </span>
                      </div>

                      {n.message && <p className="text-slate-300 break-words">{n.message}</p>}

                      {n.audioDataUrl && (
                        <audio controls src={n.audioDataUrl} className="w-full h-8 pt-0.5" />
                      )}

                      {/* Delivery & Seen Receipts */}
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-semibold ${
                            deliveredEntries.length > 0
                              ? 'bg-sky-500/20 text-sky-300'
                              : 'bg-white/5 text-slate-400'
                          }`}
                        >
                          <Check className="w-2.5 h-2.5" />
                          Delivered ({deliveredEntries.length})
                        </span>

                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-semibold ${
                            seenEntries.length > 0
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-white/5 text-slate-400'
                          }`}
                        >
                          <CheckCheck className="w-2.5 h-2.5" />
                          Seen ({seenEntries.length})
                        </span>
                      </div>

                      {(deliveredEntries.length > 0 || seenEntries.length > 0) && (
                        <div className="text-[9.5px] text-slate-400 space-y-0.5 bg-white/[0.03] rounded-lg px-2 py-1">
                          {seenEntries.map(([devId, ts]) => (
                            <p key={`seen_${devId}`} className="text-emerald-300/90 truncate">
                              ✓✓ Seen by {formatTargetLabel(devId)} ({formatRelativeTime(ts, serverNow)})
                            </p>
                          ))}
                          {deliveredEntries
                            .filter(([devId]) => !seenMap[devId])
                            .map(([devId, ts]) => (
                              <p key={`deliv_${devId}`} className="text-sky-300/80 truncate">
                                ✓ Delivered to {formatTargetLabel(devId)} ({formatRelativeTime(ts, serverNow)})
                              </p>
                            ))}
                        </div>
                      )}

                      <p className="text-[9.5px] text-[#7f91a4]">
                        Target: {n.targetDeviceId === 'all' ? 'All Devices' : formatTargetLabel(n.targetDeviceId)} • via {n.sentBy} •{' '}
                        {formatRelativeTime(n.createdAtMs, serverNow)}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Consent-Based Live Support View Modal */}
      <AnimatePresence>
        {supportTargetDevice && (
          <SupportViewModal
            device={supportTargetDevice}
            requestedBy={standalone ? 'ram_control' : 'app_0069'}
            onClose={() => setSupportTargetDevice(null)}
          />
        )}
      </AnimatePresence>

      {/* Owner Wi-Fi VoIP / Video Call Modal */}
      <AnimatePresence>
        {callTargetDevice && (
          <WiFiCallModal
            device={callTargetDevice}
            callerRole={standalone ? 'ram_control' : 'app_0069'}
            initialCallMode={callModalMode}
            onClose={() => setCallTargetDevice(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
