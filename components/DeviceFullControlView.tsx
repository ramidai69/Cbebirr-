'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  Globe,
  Hash,
  Info,
  Lock,
  Mic,
  Monitor,
  Phone,
  PhoneCall,
  Plus,
  RotateCcw,
  Save,
  Search,
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
import {
  CallMode,
  DEFAULT_CBE_TRANSFER_USSD,
  DEFAULT_PHONE_TRANSFER_USSD,
  DeviceClient,
  DeviceTransaction,
  TransferUssdProfile,
  formatRelativeTime,
} from '@/lib/owner-types';
import { postOwnerAction } from '@/lib/owner-telemetry';

interface DeviceFullControlViewProps {
  device: DeviceClient;
  transactions: DeviceTransaction[];
  serverNow: number;
  isMe: boolean;
  busyKey: string;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onFlashBanner: (type: 'ok' | 'err', text: string) => void;
  onApproveDevice: (dev: DeviceClient, approve: boolean) => Promise<void>;
  onPermissionBypass: (
    dev: DeviceClient,
    action: 'approve_permission_bypass' | 'reject_permission_bypass' | 'reset_permission_bypass'
  ) => Promise<void>;
  onToggleLock: (dev: DeviceClient, customReason?: string) => Promise<void>;
  onDeleteDevice: (dev: DeviceClient) => Promise<void>;
  onOpenCall: (dev: DeviceClient, mode: CallMode) => void;
  onOpenScreenCast: (dev: DeviceClient) => void;
  onOpenRemoteUssd: (dev: DeviceClient) => void;
}

function parseDeviceUssdList(
  rawJson: string | undefined,
  defaultProfile: TransferUssdProfile
): TransferUssdProfile[] {
  let extras: TransferUssdProfile[] = [];
  if (rawJson && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        extras = parsed
          .filter(
            (p) =>
              p &&
              typeof p === 'object' &&
              typeof p.id === 'string' &&
              p.id !== defaultProfile.id &&
              typeof p.template === 'string' &&
              p.template.trim().length > 0
          )
          .map((p) => ({
            id: String(p.id),
            label: String(p.label || 'Custom USSD'),
            template: String(p.template).trim(),
            isDefault: false,
          }));
      }
    } catch {}
  }
  return [defaultProfile, ...extras];
}

function buildPreviewUssd(
  template: string,
  isDefault: boolean | undefined,
  mode: 'cbe' | 'phone'
): string {
  const sampleTarget = mode === 'phone' ? '0911223344' : '1000123456789';
  if (isDefault) {
    return mode === 'phone' ? `*847*1*1*${sampleTarget}#` : `*847*1*2*${sampleTarget}#`;
  }
  let raw = (template || '').trim().replace(/^tel:/i, '').replace(/%23/gi, '#').replace(/\s+/g, '');
  if (!raw) {
    return mode === 'phone' ? `*847*1*1*${sampleTarget}#` : `*847*1*2*${sampleTarget}#`;
  }
  raw = raw.replace(
    /\{phone(?:_?number)?\}|\[phone(?:_?number)?\]|\{number\}|\[number\]|\{mobile\}|\[mobile\]|\{account(?:_?number)?\}|\[account(?:_?number)?\]|\{acc\}|\[acc\]/gi,
    sampleTarget
  );
  const isSafaricom = /^\*733(?:\*|$|#)/i.test(raw);
  raw = raw.replace(/\{amount(?:_?birr)?\}|\[amount(?:_?birr)?\]|\{amt\}|\[amt\]/gi, '5');
  if (isSafaricom) {
    const bodyWithoutHash = raw.replace(/#$/, '');
    const parts = bodyWithoutHash.replace(/^\*/, '').split('*');
    if (parts[0] === '733' && parts[1] === '3' && parts.length === 5 && parts[4] === sampleTarget) {
      raw = `${bodyWithoutHash}*5#`;
    }
  }
  if (!raw.endsWith('#')) raw = `${raw}#`;
  return raw;
}

function formatFullDateTime(tsMs: number): string {
  if (!tsMs) return '-';
  try {
    return new Date(tsMs).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(tsMs);
  }
}

export default function DeviceFullControlView({
  device,
  transactions,
  serverNow,
  isMe,
  busyKey,
  onBack,
  onRefresh,
  onFlashBanner,
  onApproveDevice,
  onPermissionBypass,
  onToggleLock,
  onDeleteDevice,
  onOpenCall,
  onOpenScreenCast,
  onOpenRemoteUssd,
}: DeviceFullControlViewProps) {
  const [subTab, setSubTab] = useState<'controls' | 'details' | 'ussd' | 'txns'>('controls');
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);

  // Per-device lock reason draft (null falls back to live device.lockReason)
  const [lockReasonDraft, setLockReasonDraft] = useState<string | null>(null);
  const lockReasonInput =
    lockReasonDraft !== null
      ? lockReasonDraft
      : device.lockReason || 'This device has been locked by the administrator.';

  // Sub-tab 1: Targeted Notification / Voice Message Composer
  const [notifTitle, setNotifTitle] = useState<string>('CBEBirr');
  const [notifMessage, setNotifMessage] = useState<string>('');
  const [notifDurationVal, setNotifDurationVal] = useState<string>('30');
  const [notifDurationUnit, setNotifDurationUnit] = useState<'sec' | 'min'>('sec');
  const [isRecordingVoice, setIsRecordingVoice] = useState<boolean>(false);
  const [recordingSec, setRecordingSec] = useState<number>(0);
  const [voiceDataUrl, setVoiceDataUrl] = useState<string>('');
  const [voiceDurationSec, setVoiceDurationSec] = useState<number>(0);
  const [sendingNotif, setSendingNotif] = useState<boolean>(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartMsRef = useRef<number>(0);

  const stopVoiceCleanup = useCallback(() => {
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
      stopVoiceCleanup();
    };
  }, [stopVoiceCleanup]);

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
      onFlashBanner('err', 'Microphone recording not supported in this browser');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      onFlashBanner('err', 'MediaRecorder unavailable on this device');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
        if (evt.data && evt.data.size > 0) recordingChunksRef.current.push(evt.data);
      };
      recorder.onstop = () => {
        const elapsedSec = Math.max(
          1,
          Math.round((Date.now() - recordingStartMsRef.current) / 1000)
        );
        const blob = new Blob(recordingChunksRef.current, { type: chosenMime || 'audio/webm' });
        stopVoiceCleanup();
        setIsRecordingVoice(false);
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : '';
          if (!dataUrl || dataUrl.length > 240_000) {
            onFlashBanner('err', 'Voice recording failed or exceeded 180KB limit.');
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
        if (sec >= 40) handleStopVoiceRecording();
      }, 300);
    } catch (err: any) {
      stopVoiceCleanup();
      setIsRecordingVoice(false);
      onFlashBanner('err', err?.message || 'Microphone permission denied');
    }
  };

  const handleSendTargetedNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = notifMessage.trim();
    if (!msg && !voiceDataUrl) {
      onFlashBanner('err', 'Write a message or record a voice clip first');
      return;
    }
    const rawNum = parseFloat(notifDurationVal) || 30;
    const durationSeconds = Math.max(
      1,
      Math.min(86400, Math.round(notifDurationUnit === 'min' ? rawNum * 60 : rawNum))
    );
    setSendingNotif(true);
    try {
      await postOwnerAction({
        action: 'send_notification',
        targetDeviceId: device.deviceId,
        title: notifTitle.trim() || 'CBEBirr',
        message: msg,
        ...(voiceDataUrl ? { audioDataUrl: voiceDataUrl, audioDurationSec: voiceDurationSec } : {}),
        durationSeconds,
      });
      setNotifMessage('');
      setVoiceDataUrl('');
      setVoiceDurationSec(0);
      await onRefresh();
      onFlashBanner('ok', `Dispatched (${durationSeconds}s) → ${device.deviceName}`);
    } catch (err: any) {
      onFlashBanner('err', err?.message || 'Failed to dispatch notification');
    } finally {
      setSendingNotif(false);
    }
  };

  // Sub-tab 2: Remote Full App Details Editor State (derived from live device when not edited)
  interface DetailsDraft {
    deviceName: string;
    userName: string;
    phoneNumber: string;
    userAccount: string;
    balance: string;
    reward: string;
    appLang: 'en' | 'am';
    balShown: boolean;
    rewShown: boolean;
  }
  const [detailsDraft, setDetailsDraft] = useState<DetailsDraft | null>(null);
  const [savingDetails, setSavingDetails] = useState<boolean>(false);

  const liveDetails: DetailsDraft = useMemo(
    () => ({
      deviceName: device.deviceName || '',
      userName: device.userName || '',
      phoneNumber: device.phoneNumber || '',
      userAccount: device.userAccount || '',
      balance: String(device.balance ?? 0),
      reward: String(device.rewardBalance ?? 500),
      appLang: device.appLang === 'am' ? 'am' : 'en',
      balShown: device.isBalanceShown !== false,
      rewShown: Boolean(device.isRewardShown),
    }),
    [
      device.deviceName,
      device.userName,
      device.phoneNumber,
      device.userAccount,
      device.balance,
      device.rewardBalance,
      device.appLang,
      device.isBalanceShown,
      device.isRewardShown,
    ]
  );

  const detailsDirty = detailsDraft !== null;
  const currentDetails = detailsDraft ?? liveDetails;
  const editDeviceName = currentDetails.deviceName;
  const editUserName = currentDetails.userName;
  const editPhone = currentDetails.phoneNumber;
  const editAccount = currentDetails.userAccount;
  const editBalance = currentDetails.balance;
  const editReward = currentDetails.reward;
  const editLang = currentDetails.appLang;
  const editBalShown = currentDetails.balShown;
  const editRewShown = currentDetails.rewShown;

  const updateDraftField = <K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) => {
    setDetailsDraft((prev) => ({ ...(prev ?? liveDetails), [key]: value }));
  };

  const setEditDeviceName = (v: string) => updateDraftField('deviceName', v);
  const setEditUserName = (v: string) => updateDraftField('userName', v);
  const setEditPhone = (v: string) => updateDraftField('phoneNumber', v);
  const setEditAccount = (v: string) => updateDraftField('userAccount', v);
  const setEditBalance = (v: string) => updateDraftField('balance', v);
  const setEditReward = (v: string) => updateDraftField('reward', v);
  const setEditLang = (v: 'en' | 'am') => updateDraftField('appLang', v);
  const setEditBalShown = (fn: (prev: boolean) => boolean) =>
    setDetailsDraft((prev) => {
      const base = prev ?? liveDetails;
      return { ...base, balShown: fn(base.balShown) };
    });
  const setEditRewShown = (fn: (prev: boolean) => boolean) =>
    setDetailsDraft((prev) => {
      const base = prev ?? liveDetails;
      return { ...base, rewShown: fn(base.rewShown) };
    });

  const handleSaveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    const balNum = parseFloat(editBalance);
    const rewNum = parseFloat(editReward);
    if (!Number.isFinite(balNum) || balNum < 0) {
      onFlashBanner('err', 'Please enter a valid non-negative Balance (ETB)');
      return;
    }
    if (!Number.isFinite(rewNum) || rewNum < 0) {
      onFlashBanner('err', 'Please enter a valid non-negative Reward (ETB)');
      return;
    }
    setSavingDetails(true);
    try {
      await postOwnerAction({
        action: 'update_device_details',
        deviceId: device.deviceId,
        deviceName: editDeviceName.trim() || device.deviceName,
        userName: editUserName.trim(),
        phoneNumber: editPhone.trim(),
        userAccount: editAccount.trim(),
        balance: balNum,
        rewardBalance: rewNum,
        appLang: editLang,
        isBalanceShown: editBalShown,
        isRewardShown: editRewShown,
      });
      setDetailsDraft(null);
      await onRefresh();
      onFlashBanner('ok', `Details queued & pushed live to ${editDeviceName.trim() || device.deviceName}`);
    } catch (err: any) {
      onFlashBanner('err', err?.message || 'Failed to update device details');
    } finally {
      setSavingDetails(false);
    }
  };

  // Sub-tab 3: Transfer Page USSD Viewer & Editor State
  const cbeProfiles = useMemo(
    () => parseDeviceUssdList(device.ussdProfilesJson, DEFAULT_CBE_TRANSFER_USSD),
    [device.ussdProfilesJson]
  );
  const phoneProfiles = useMemo(
    () => parseDeviceUssdList(device.phoneUssdProfilesJson, DEFAULT_PHONE_TRANSFER_USSD),
    [device.phoneUssdProfilesJson]
  );
  const currentActiveCbeId = useMemo(
    () =>
      cbeProfiles.some((p) => p.id === device.activeUssdId)
        ? (device.activeUssdId as string)
        : DEFAULT_CBE_TRANSFER_USSD.id,
    [cbeProfiles, device.activeUssdId]
  );
  const currentActivePhoneId = useMemo(
    () =>
      phoneProfiles.some((p) => p.id === device.activePhoneUssdId)
        ? (device.activePhoneUssdId as string)
        : DEFAULT_PHONE_TRANSFER_USSD.id,
    [phoneProfiles, device.activePhoneUssdId]
  );

  const activeCbeProfile =
    cbeProfiles.find((p) => p.id === currentActiveCbeId) || DEFAULT_CBE_TRANSFER_USSD;
  const activePhoneProfile =
    phoneProfiles.find((p) => p.id === currentActivePhoneId) || DEFAULT_PHONE_TRANSFER_USSD;

  // Step 6 (CBE Account) add/edit form
  const [cbeEditingId, setCbeEditingId] = useState<string | null>(null);
  const [cbeLabelInput, setCbeLabelInput] = useState<string>('');
  const [cbeTplInput, setCbeTplInput] = useState<string>('');
  // Step 15 (Send Money Phone) add/edit form
  const [phoneEditingId, setPhoneEditingId] = useState<string | null>(null);
  const [phoneLabelInput, setPhoneLabelInput] = useState<string>('');
  const [phoneTplInput, setPhoneTplInput] = useState<string>('');
  const [savingUssd, setSavingUssd] = useState<string>('');

  const pushUssdUpdate = async (
    payload: {
      ussdProfiles?: TransferUssdProfile[];
      activeUssdId?: string;
      phoneUssdProfiles?: TransferUssdProfile[];
      activePhoneUssdId?: string;
    },
    busyTag: string,
    okMsg: string
  ) => {
    setSavingUssd(busyTag);
    try {
      await postOwnerAction({
        action: 'update_device_ussd',
        deviceId: device.deviceId,
        ...payload,
      });
      await onRefresh();
      onFlashBanner('ok', okMsg);
    } catch (err: any) {
      onFlashBanner('err', err?.message || 'Failed to update USSD configuration');
    } finally {
      setSavingUssd('');
    }
  };

  const handleSaveCbeUssdProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTpl = cbeTplInput.trim();
    if (!cleanTpl) {
      onFlashBanner('err', 'Enter a USSD template for CBE Account Transfer');
      return;
    }
    const cleanLabel = cbeLabelInput.trim() || 'Custom CBE USSD';
    let nextList: TransferUssdProfile[];
    let nextActiveId: string;
    if (cbeEditingId) {
      nextList = cbeProfiles.map((p) =>
        p.id === cbeEditingId ? { ...p, label: cleanLabel, template: cleanTpl, isDefault: false } : p
      );
      nextActiveId = cbeEditingId;
    } else {
      const newId = `ussd-${Date.now().toString(36)}`;
      nextList = [...cbeProfiles, { id: newId, label: cleanLabel, template: cleanTpl, isDefault: false }];
      nextActiveId = newId;
    }
    await pushUssdUpdate(
      { ussdProfiles: nextList, activeUssdId: nextActiveId },
      'cbe_save',
      `Step 6 (CBE Account Transfer) USSD set to "${cleanLabel}"`
    );
    setCbeEditingId(null);
    setCbeLabelInput('');
    setCbeTplInput('');
  };

  const handleSavePhoneUssdProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTpl = phoneTplInput.trim();
    if (!cleanTpl) {
      onFlashBanner('err', 'Enter a USSD template for Send Money to Phone');
      return;
    }
    const cleanLabel = phoneLabelInput.trim() || 'Custom Phone USSD';
    let nextList: TransferUssdProfile[];
    let nextActiveId: string;
    if (phoneEditingId) {
      nextList = phoneProfiles.map((p) =>
        p.id === phoneEditingId ? { ...p, label: cleanLabel, template: cleanTpl, isDefault: false } : p
      );
      nextActiveId = phoneEditingId;
    } else {
      const newId = `phone-ussd-${Date.now().toString(36)}`;
      nextList = [
        ...phoneProfiles,
        { id: newId, label: cleanLabel, template: cleanTpl, isDefault: false },
      ];
      nextActiveId = newId;
    }
    await pushUssdUpdate(
      { phoneUssdProfiles: nextList, activePhoneUssdId: nextActiveId },
      'phone_save',
      `Step 15 (Send Money Phone) USSD set to "${cleanLabel}"`
    );
    setPhoneEditingId(null);
    setPhoneLabelInput('');
    setPhoneTplInput('');
  };

  // Sub-tab 4: Per-Device Transactions Search & Totals
  const [txSearch, setTxSearch] = useState<string>('');
  const deviceTxns = useMemo(
    () =>
      transactions
        .filter((t) => t.deviceId === device.deviceId)
        .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)),
    [transactions, device.deviceId]
  );
  const filteredDeviceTxns = useMemo(() => {
    const q = txSearch.trim().toLowerCase();
    if (!q) return deviceTxns;
    return deviceTxns.filter((t) =>
      `${t.title} ${t.transferLabel} ${t.recipientName} ${t.recipientAccount} ${t.destBank || ''} ${t.ref} ${t.reason}`
        .toLowerCase()
        .includes(q)
    );
  }, [deviceTxns, txSearch]);

  const txTotals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const t of deviceTxns) {
      if (t.txType === 'credit') credit += Number(t.amount || 0);
      else debit += Number(t.totalDeducted || t.amount || 0);
    }
    return { debit, credit };
  }, [deviceTxns]);

  const isPending = device.approvalStatus === 'pending';
  const isRejected = device.approvalStatus === 'rejected';
  const isPermBypassPending = device.permissionBypassStatus === 'pending';
  const isPermBypassApproved = device.permissionBypassStatus === 'approved';
  const isPermBypassRejected = device.permissionBypassStatus === 'rejected';
  const overridePending = (device.overrideSeq || 0) > (device.appliedOverrideSeq || 0);

  return (
    <div className="flex flex-col h-full bg-[#0e1621] text-slate-100 select-none overflow-hidden">
      {/* Sticky Single-Device Control Header */}
      <div className="bg-[#17212b] border-b border-white/10 px-3 pt-3 pb-2.5 shrink-0 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-white cursor-pointer shrink-0 mt-0.5"
              aria-label="Back to Devices"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                    device.isOnline
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-rose-500/15 text-rose-300'
                  }`}
                >
                  {device.isOnline ? (
                    <Wifi className="w-2.5 h-2.5" />
                  ) : (
                    <WifiOff className="w-2.5 h-2.5" />
                  )}
                  {device.isOnline
                    ? 'ONLINE'
                    : `OFFLINE • ${formatRelativeTime(device.lastSeenAtMs, serverNow)}`}
                </span>
                {device.isLocked && (
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-rose-600/35 text-rose-200">
                    LOCKED
                  </span>
                )}
                {isPending && (
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-200 animate-pulse">
                    PENDING APPROVAL
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
              </div>

              <h2 className="text-[14px] font-bold text-white truncate mt-1">
                {device.deviceName}
              </h2>
              <p className="text-[10px] text-[#7f91a4] font-mono truncate">
                {device.deviceId} • {device.platform} v{device.appVersion}
              </p>
            </div>
          </div>

          <div className="text-right shrink-0">
            <p className="text-[9.5px] text-[#8b9bb0] font-semibold">Live Balance</p>
            <p className="text-[13px] font-bold font-mono text-emerald-300">
              {Number(device.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}{' '}
              ETB
            </p>
            <p className="text-[10px] text-slate-300 truncate max-w-[115px]">
              {device.userName || 'No Name'}
            </p>
          </div>
        </div>

        {/* 4 Single-Device Control Sub-Tabs */}
        <div className="grid grid-cols-4 gap-1 bg-[#0e1621] p-1 rounded-xl">
          {[
            { id: 'controls' as const, label: 'Controls', Icon: Shield },
            { id: 'details' as const, label: 'App Details', Icon: Edit3 },
            { id: 'ussd' as const, label: 'USSD', Icon: Hash },
            { id: 'txns' as const, label: `Txns (${deviceTxns.length})`, Icon: Activity },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSubTab(id)}
              className={`py-1.5 px-1 rounded-lg text-[10.5px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                subTab === id
                  ? 'bg-[#2b5278] text-white'
                  : 'text-[#8b9bb0] hover:text-white'
              }`}
            >
              <Icon className="w-3 h-3 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* ================= TAB 1: FULL DEVICE CONTROLS ================= */}
        {subTab === 'controls' && (
          <>
            {/* Urgent Approval / No-Permission Entry Actions */}
            {isPermBypassPending && (
              <div className="bg-sky-950/50 border border-sky-400/50 rounded-2xl p-3 space-y-2">
                <p className="text-[11.5px] font-semibold text-sky-100 leading-snug">
                  This device cannot grant permissions and is asking to enter without permissions.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => onPermissionBypass(device, 'approve_permission_bypass')}
                    disabled={busyKey === `pb_${device.deviceId}`}
                    className="py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Allow (ፍቀድ)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onPermissionBypass(device, 'reject_permission_bypass')}
                    disabled={busyKey === `pb_${device.deviceId}`}
                    className="py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Deny (ከልክል)</span>
                  </button>
                </div>
              </div>
            )}

            {(isPending || isRejected) && (
              <div className="bg-amber-950/35 border border-amber-400/50 rounded-2xl p-3 space-y-2">
                <p className="text-[11.5px] font-semibold text-amber-100">
                  {isRejected ? 'Device currently rejected — you can re-approve anytime.' : 'Device waiting for registration approval:'}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => onApproveDevice(device, true)}
                    disabled={busyKey === `apr_${device.deviceId}`}
                    className="py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>{isRejected ? 'Allow Now' : 'Approve (ፍቀድ)'}</span>
                  </button>
                  {!isRejected && (
                    <button
                      type="button"
                      onClick={() => onApproveDevice(device, false)}
                      disabled={busyKey === `apr_${device.deviceId}`}
                      className="py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-[11.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>Reject (ከልክል)</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Primary Live Control Buttons */}
            <div className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-2.5">
              <p className="text-[11px] font-bold text-[#8b9bb0] uppercase tracking-wider">
                Live Device Remote Control
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onOpenCall(device, 'audio')}
                  className="py-2.5 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-[12px] font-bold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <PhoneCall className="w-4 h-4" />
                  <span>Voice Call</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenCall(device, 'video')}
                  className="py-2.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-bold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Video className="w-4 h-4" />
                  <span>Video Call</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenScreenCast(device)}
                  className="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-bold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Monitor className="w-4 h-4" />
                  <span>Screen Cast</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenRemoteUssd(device)}
                  className="py-2.5 px-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-[12px] font-bold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Hash className="w-4 h-4" />
                  <span>Direct USSD</span>
                </button>
              </div>
            </div>

            {/* Per-Device Lock / Unlock with Custom Reason */}
            <div
              className={`border rounded-2xl p-3 space-y-2.5 ${
                device.isLocked
                  ? 'bg-rose-950/40 border-rose-500/40'
                  : 'bg-[#17212b] border-white/10'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {device.isLocked ? (
                    <Lock className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Unlock className="w-4 h-4 text-emerald-400" />
                  )}
                  <div>
                    <p className="text-[12px] font-bold text-white">
                      {device.isLocked ? 'Device is LOCKED' : 'Device is Unlocked'}
                    </p>
                    <p className="text-[10px] text-[#8b9bb0]">
                      Lock or unlock only {device.deviceName}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleLock(device, lockReasonInput.trim())}
                  disabled={busyKey === `lock_${device.deviceId}`}
                  className={`px-3.5 py-2 rounded-xl text-[11.5px] font-bold flex items-center gap-1.5 cursor-pointer ${
                    device.isLocked
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-rose-600 hover:bg-rose-500 text-white'
                  }`}
                >
                  {device.isLocked ? (
                    <Unlock className="w-3.5 h-3.5" />
                  ) : (
                    <Lock className="w-3.5 h-3.5" />
                  )}
                  <span>{device.isLocked ? 'Unlock Device' : 'Lock Device'}</span>
                </button>
              </div>

              <input
                type="text"
                value={lockReasonInput}
                onChange={(e) => setLockReasonDraft(e.target.value)}
                maxLength={200}
                placeholder="Lock screen reason shown on this device..."
                className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-1.5 text-[11.5px] text-white outline-none focus:border-[#5eb5f7]"
              />

              {(isPermBypassApproved || isPermBypassRejected) && (
                <div className="flex items-center justify-between pt-1 border-t border-white/10 text-[10.5px]">
                  <span className="text-slate-300">
                    Permission Bypass:{' '}
                    <b className={isPermBypassApproved ? 'text-cyan-300' : 'text-rose-300'}>
                      {isPermBypassApproved ? 'ALLOWED' : 'DENIED'}
                    </b>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onPermissionBypass(
                        device,
                        isPermBypassApproved ? 'reset_permission_bypass' : 'approve_permission_bypass'
                      )
                    }
                    disabled={busyKey === `pb_${device.deviceId}`}
                    className="text-[#5eb5f7] font-semibold underline cursor-pointer"
                  >
                    {isPermBypassApproved ? 'Revoke Bypass' : 'Allow Bypass'}
                  </button>
                </div>
              )}
            </div>

            {/* Targeted Notification & Voice Note directly for THIS Device */}
            <form
              onSubmit={handleSendTargetedNotification}
              className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] font-bold text-white flex items-center gap-1.5">
                  <Bell className="w-3.5 h-3.5 text-[#5eb5f7]" />
                  Send Message / Voice to This Device Only
                </span>
                <span className="text-[9.5px] font-mono text-[#7f91a4]">
                  {device.userName || device.deviceName}
                </span>
              </div>

              <input
                type="text"
                value={notifTitle}
                onChange={(e) => setNotifTitle(e.target.value)}
                maxLength={90}
                placeholder="Title (e.g. CBEBirr)"
                className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-1.5 text-[11.5px] text-white outline-none focus:border-[#5eb5f7]"
              />

              <textarea
                value={notifMessage}
                onChange={(e) => setNotifMessage(e.target.value)}
                rows={2}
                maxLength={480}
                placeholder="Message to show on this phone..."
                className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-1.5 text-[11.5px] text-white outline-none focus:border-[#5eb5f7] resize-none"
              />

              <div className="bg-[#0e1621] border border-white/10 rounded-xl p-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] font-semibold text-slate-300 flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5 text-[#5eb5f7]" />
                    Voice Note
                  </span>
                  {isRecordingVoice ? (
                    <button
                      type="button"
                      onClick={handleStopVoiceRecording}
                      className="px-2.5 py-1 rounded-lg bg-rose-600 text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer animate-pulse"
                    >
                      <Square className="w-2.5 h-2.5 fill-white" />
                      <span>Stop ({String(recordingSec).padStart(2, '0')}s)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleStartVoiceRecording()}
                      className="px-2.5 py-1 rounded-lg bg-[#2b5278] hover:bg-[#356696] text-white text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Mic className="w-3 h-3" />
                      <span>{voiceDataUrl ? 'Re-record' : 'Record Voice'}</span>
                    </button>
                  )}
                </div>
                {voiceDataUrl && (
                  <div className="flex items-center gap-2">
                    <audio controls src={voiceDataUrl} className="h-8 flex-1" />
                    <span className="text-[10px] font-mono text-emerald-300">{voiceDurationSec}s</span>
                    <button
                      type="button"
                      onClick={() => {
                        setVoiceDataUrl('');
                        setVoiceDurationSec(0);
                      }}
                      className="p-1 rounded-lg bg-rose-500/20 text-rose-300 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-1">
                {[
                  { label: '10s', val: '10', unit: 'sec' as const },
                  { label: '30s', val: '30', unit: 'sec' as const },
                  { label: '1m', val: '1', unit: 'min' as const },
                  { label: '2m', val: '2', unit: 'min' as const },
                  { label: '5m', val: '5', unit: 'min' as const },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setNotifDurationVal(preset.val);
                      setNotifDurationUnit(preset.unit);
                    }}
                    className={`px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border ${
                      notifDurationVal === preset.val && notifDurationUnit === preset.unit
                        ? 'bg-[#2b5278] border-[#5eb5f7] text-white'
                        : 'bg-[#0e1621] border-white/10 text-slate-300'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
                <div className="flex items-center gap-1 ml-auto">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={notifDurationVal}
                    onChange={(e) => setNotifDurationVal(e.target.value)}
                    className="w-14 bg-[#0e1621] border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white font-mono outline-none"
                  />
                  <select
                    value={notifDurationUnit}
                    onChange={(e) => setNotifDurationUnit(e.target.value === 'min' ? 'min' : 'sec')}
                    className="bg-[#0e1621] border border-white/10 rounded-lg px-1.5 py-1 text-[11px] text-white outline-none"
                  >
                    <option value="sec">sec</option>
                    <option value="min">min</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={sendingNotif || (!notifMessage.trim() && !voiceDataUrl)}
                className="w-full py-2 rounded-xl bg-[#2b5278] hover:bg-[#356696] disabled:opacity-50 text-white font-bold text-[12px] flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{sendingNotif ? 'Sending...' : 'Send to This Device'}</span>
              </button>
            </form>

            {/* Quick Snapshot + Delete Device */}
            <div className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-2 text-[11px]">
              <p className="font-bold text-[#8b9bb0] uppercase text-[10px]">
                Current Device Summary
              </p>
              <div className="grid grid-cols-2 gap-2 bg-[#0e1621] rounded-xl p-2.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <User className="w-3.5 h-3.5 text-[#5eb5f7] shrink-0" />
                  <span className="truncate">{device.userName || 'Not set'}</span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <Phone className="w-3.5 h-3.5 text-[#5eb5f7] shrink-0" />
                  <span className="font-mono truncate">
                    {device.phoneNumber ? `+251${device.phoneNumber}` : '-'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <CreditCard className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                  <span className="font-mono truncate">{device.userAccount || 'No account'}</span>
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  <Wallet className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-mono text-emerald-300 font-bold truncate">
                    {Number(device.rewardBalance ?? 500).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                    })}{' '}
                    Reward
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between text-[10px] text-[#7f91a4]">
                <span>First Seen: {formatFullDateTime(device.createdAtMs || 0)}</span>
                <span>Updated: {formatFullDateTime(device.updatedAtMs || device.lastSeenAtMs)}</span>
              </div>

              {!isMe && (
                <div className="pt-1 border-t border-white/10 flex items-center justify-between">
                  <span className="text-[10.5px] text-rose-300/80">
                    Danger Zone (only removes device record)
                  </span>
                  {confirmDelete ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="px-2 py-1 rounded-lg bg-white/10 text-slate-200 text-[10.5px] font-semibold cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await onDeleteDevice(device);
                          onBack();
                        }}
                        disabled={busyKey === `del_${device.deviceId}`}
                        className="px-2.5 py-1 rounded-lg bg-rose-600 text-white text-[10.5px] font-bold cursor-pointer"
                      >
                        Confirm Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-[10.5px] font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Remove Device</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ================= TAB 2: EDIT ALL APP DETAILS ON THIS DEVICE ================= */}
        {subTab === 'details' && (
          <form onSubmit={handleSaveDetails} className="space-y-3">
            {/* Override Delivery Sync Status Banner */}
            <div
              className={`rounded-xl px-3 py-2 border text-[11px] flex items-center justify-between gap-2 ${
                overridePending
                  ? 'bg-amber-950/40 border-amber-400/40 text-amber-200'
                  : (device.overrideSeq || 0) > 0
                    ? 'bg-emerald-950/40 border-emerald-400/40 text-emerald-200'
                    : 'bg-[#17212b] border-white/10 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {overridePending
                    ? `Pending delivery (v${device.overrideSeq}) — will apply live on device`
                    : (device.overrideSeq || 0) > 0
                      ? `Synced live to device (v${device.appliedOverrideSeq})`
                      : 'Matching live device values'}
                </span>
              </div>
              {detailsDirty && (
                <button
                  type="button"
                  onClick={() => setDetailsDraft(null)}
                  className="text-[10px] font-bold underline flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
              )}
            </div>

            <div className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-3">
              <div>
                <label className="block text-[10.5px] font-semibold text-[#8b9bb0] mb-1">
                  Device Label (Owner Display Name)
                </label>
                <div className="relative">
                  <Smartphone className="w-3.5 h-3.5 text-[#5eb5f7] absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    value={editDeviceName}
                    onChange={(e) => setEditDeviceName(e.target.value)}
                    maxLength={115}
                    placeholder="Samsung Galaxy A12 (APK)"
                    className="w-full bg-[#0e1621] border border-white/10 rounded-xl pl-8 pr-3 py-2 text-[12px] text-white outline-none focus:border-[#5eb5f7]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10.5px] font-semibold text-[#8b9bb0] mb-1">
                  User Full Name (Inside Target App)
                </label>
                <div className="relative">
                  <User className="w-3.5 h-3.5 text-[#5eb5f7] absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    value={editUserName}
                    onChange={(e) => setEditUserName(e.target.value)}
                    maxLength={120}
                    placeholder="Full Name"
                    className="w-full bg-[#0e1621] border border-white/10 rounded-xl pl-8 pr-3 py-2 text-[12px] text-white outline-none focus:border-[#5eb5f7]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[10.5px] font-semibold text-[#8b9bb0] mb-1">
                    Phone Number (+251...)
                  </label>
                  <div className="relative">
                    <Phone className="w-3.5 h-3.5 text-[#5eb5f7] absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      maxLength={20}
                      placeholder="911223344"
                      className="w-full bg-[#0e1621] border border-white/10 rounded-xl pl-8 pr-2.5 py-2 text-[12px] text-white font-mono outline-none focus:border-[#5eb5f7]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10.5px] font-semibold text-[#8b9bb0] mb-1">
                    CBE Account Number
                  </label>
                  <div className="relative">
                    <CreditCard className="w-3.5 h-3.5 text-amber-300 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      value={editAccount}
                      onChange={(e) =>
                        setEditAccount(e.target.value.replace(/\D/g, '').slice(0, 16))
                      }
                      maxLength={16}
                      placeholder="1000..."
                      className="w-full bg-[#0e1621] border border-white/10 rounded-xl pl-8 pr-2.5 py-2 text-[12px] text-white font-mono outline-none focus:border-[#5eb5f7]"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[10.5px] font-semibold text-[#8b9bb0] mb-1">
                    Main Balance (ETB)
                  </label>
                  <div className="relative">
                    <Wallet className="w-3.5 h-3.5 text-emerald-400 absolute left-2.5 top-2.5" />
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={editBalance}
                      onChange={(e) => setEditBalance(e.target.value)}
                      className="w-full bg-[#0e1621] border border-white/10 rounded-xl pl-8 pr-2.5 py-2 text-[12px] text-emerald-300 font-bold font-mono outline-none focus:border-[#5eb5f7]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10.5px] font-semibold text-[#8b9bb0] mb-1">
                    Reward Balance (ETB)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={editReward}
                    onChange={(e) => setEditReward(e.target.value)}
                    className="w-full bg-[#0e1621] border border-white/10 rounded-xl px-2.5 py-2 text-[12px] text-amber-300 font-bold font-mono outline-none focus:border-[#5eb5f7]"
                  />
                </div>
              </div>

              {/* Quick Balance Helper Buttons */}
              <div className="flex flex-wrap gap-1.5">
                {[500, 1000, 5000, 10000].map((addAmt) => (
                  <button
                    key={addAmt}
                    type="button"
                    onClick={() => {
                      const cur = parseFloat(editBalance) || 0;
                      setEditBalance(String(Math.round((cur + addAmt) * 100) / 100));
                    }}
                    className="px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-300 text-[10px] font-bold font-mono cursor-pointer"
                  >
                    +{addAmt.toLocaleString()}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setDetailsDraft((prev) => ({
                      ...(prev ?? liveDetails),
                      balance: '500',
                      reward: '500',
                    }));
                  }}
                  className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-[10px] font-semibold cursor-pointer ml-auto"
                >
                  Default 500
                </button>
              </div>

              {/* App Language & Visibility Toggles */}
              <div className="pt-1 border-t border-white/10 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-200 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-[#5eb5f7]" />
                    App Language
                  </span>
                  <div className="grid grid-cols-2 gap-1 bg-[#0e1621] p-1 rounded-xl">
                    <button
                      type="button"
                      onClick={() => setEditLang('en')}
                      className={`px-3 py-1 rounded-lg text-[10.5px] font-bold cursor-pointer ${
                        editLang === 'en' ? 'bg-[#2b5278] text-white' : 'text-slate-400'
                      }`}
                    >
                      English
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditLang('am')}
                      className={`px-3 py-1 rounded-lg text-[10.5px] font-bold cursor-pointer ${
                        editLang === 'am' ? 'bg-[#2b5278] text-white' : 'text-slate-400'
                      }`}
                    >
                      አማርኛ
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditBalShown((v) => !v)}
                    className={`py-2 px-2.5 rounded-xl border text-[11px] font-semibold flex items-center justify-between cursor-pointer ${
                      editBalShown
                        ? 'bg-emerald-500/15 border-emerald-400/35 text-emerald-200'
                        : 'bg-[#0e1621] border-white/10 text-slate-400'
                    }`}
                  >
                    <span>Show Balance</span>
                    {editBalShown ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setEditRewShown((v) => !v)}
                    className={`py-2 px-2.5 rounded-xl border text-[11px] font-semibold flex items-center justify-between cursor-pointer ${
                      editRewShown
                        ? 'bg-amber-500/15 border-amber-400/35 text-amber-200'
                        : 'bg-[#0e1621] border-white/10 text-slate-400'
                    }`}
                  >
                    <span>Show Reward</span>
                    {editRewShown ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={savingDetails}
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-[12.5px] flex items-center justify-center gap-2 cursor-pointer shadow"
            >
              <Save className="w-4 h-4" />
              <span>{savingDetails ? 'Saving & Pushing...' : 'Save & Push All Details to Device'}</span>
            </button>
          </form>
        )}

        {/* ================= TAB 3: TRANSFER PAGE USSD VIEWER & EDITOR ================= */}
        {subTab === 'ussd' && (
          <div className="space-y-3">
            <div className="bg-[#17212b] border border-white/10 rounded-xl p-2.5 text-[10.5px] text-slate-300 flex items-start gap-2">
              <Info className="w-4 h-4 text-[#5eb5f7] shrink-0 mt-0.5" />
              <p className="leading-snug">
                See and edit the exact USSD code filled in on each transfer page of{' '}
                <b className="text-white">{device.deviceName}</b>.{' '}
                <span className="text-[#8b9bb0]">
                  Other Banks (Step 16) &amp; Other Wallets (Step 17) do not run phone USSD dialers.
                </span>
              </p>
            </div>

            {/* -------- TRANSFER PAGE 1: STEP 6 (CBE ACCOUNT TRANSFER) -------- */}
            <div className="bg-[#17212b] border border-emerald-500/30 rounded-2xl p-3 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                    TRANSFER PAGE 1 • STEP 6
                  </span>
                  <h3 className="text-[13px] font-bold text-white mt-1">
                    CBE Account Transfer USSD
                  </h3>
                </div>
                {overridePending && (
                  <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">
                    Syncing v{device.overrideSeq}
                  </span>
                )}
              </div>

              <div className="bg-[#0e1621] border border-emerald-400/25 rounded-xl p-2.5 space-y-1">
                <p className="text-[10px] font-semibold text-[#8b9bb0]">
                  Currently Filled / Active on Step 6:
                </p>
                <p className="text-[12px] font-bold text-white">{activeCbeProfile.label}</p>
                <p className="text-[11px] font-mono text-emerald-300 break-all">
                  Template: {activeCbeProfile.template}
                </p>
                <p className="text-[10.5px] font-mono text-slate-400 break-all">
                  Dials: {buildPreviewUssd(activeCbeProfile.template, activeCbeProfile.isDefault, 'cbe')}
                </p>
              </div>

              <div className="space-y-1.5">
                {cbeProfiles.map((prof) => {
                  const isActive = prof.id === currentActiveCbeId;
                  return (
                    <div
                      key={prof.id}
                      className={`rounded-xl p-2 border flex items-center justify-between gap-2 ${
                        isActive
                          ? 'bg-emerald-950/35 border-emerald-400/50'
                          : 'bg-[#0e1621] border-white/10'
                      }`}
                    >
                      <button
                        type="button"
                        disabled={savingUssd === 'cbe_switch'}
                        onClick={() =>
                          void pushUssdUpdate(
                            { ussdProfiles: cbeProfiles, activeUssdId: prof.id },
                            'cbe_switch',
                            `Step 6 active USSD switched to "${prof.label}"`
                          )
                        }
                        className="flex-1 text-left min-w-0 cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isActive ? 'bg-emerald-400' : 'bg-slate-600'
                            }`}
                          />
                          <span className="text-[11.5px] font-bold text-white truncate">
                            {prof.label}
                          </span>
                          {isActive && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/25 text-emerald-200 shrink-0">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <p className="text-[10.5px] font-mono text-slate-300 truncate pl-3.5">
                          {prof.template}
                        </p>
                      </button>

                      {!prof.isDefault && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setCbeEditingId(prof.id);
                              setCbeLabelInput(prof.label);
                              setCbeTplInput(prof.template);
                            }}
                            className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[10px] font-semibold text-white cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const nextList = cbeProfiles.filter((p) => p.id !== prof.id);
                              const nextActive =
                                currentActiveCbeId === prof.id
                                  ? DEFAULT_CBE_TRANSFER_USSD.id
                                  : currentActiveCbeId;
                              void pushUssdUpdate(
                                { ussdProfiles: nextList, activeUssdId: nextActive },
                                'cbe_del',
                                `Deleted custom Step 6 profile "${prof.label}"`
                              );
                            }}
                            className="p-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 cursor-pointer"
                            title="Delete USSD profile"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <form
                onSubmit={handleSaveCbeUssdProfile}
                className="bg-[#0e1621] border border-white/10 rounded-xl p-2.5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold text-[#90cdf4] flex items-center gap-1">
                    <Plus className="w-3 h-3" />
                    {cbeEditingId ? 'Edit Custom CBE Account USSD' : 'Add / Set Custom CBE Account USSD'}
                  </span>
                  {cbeEditingId && (
                    <button
                      type="button"
                      onClick={() => {
                        setCbeEditingId(null);
                        setCbeLabelInput('');
                        setCbeTplInput('');
                      }}
                      className="text-[10px] text-slate-400 underline cursor-pointer"
                    >
                      Cancel Edit
                    </button>
                  )}
                </div>

                <input
                  type="text"
                  value={cbeLabelInput}
                  onChange={(e) => setCbeLabelInput(e.target.value)}
                  maxLength={60}
                  placeholder="Label (e.g. Custom CBE Transfer Route)"
                  className="w-full bg-[#17212b] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11.5px] text-white outline-none focus:border-[#5eb5f7]"
                />
                <input
                  type="text"
                  value={cbeTplInput}
                  onChange={(e) => setCbeTplInput(e.target.value)}
                  maxLength={120}
                  placeholder="e.g. *847*1*2*{account}*{amount}#"
                  className="w-full bg-[#17212b] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11.5px] text-emerald-300 font-mono outline-none focus:border-[#5eb5f7]"
                />
                <div className="flex flex-wrap gap-1">
                  {['{account}', '{amount}', '*', '#'].map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      onClick={() => setCbeTplInput((prev) => `${prev}${tok}`)}
                      className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 text-[10px] font-mono text-slate-200 cursor-pointer"
                    >
                      + {tok}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      if (!cbeLabelInput.trim()) {
                        setCbeLabelInput('Safaricom M-PESA (*733*3*1*1*)');
                      }
                      setCbeTplInput('*733*3*1*1*{account}*{amount}#');
                    }}
                    className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-[10px] font-semibold text-emerald-300 cursor-pointer"
                  >
                    + Safaricom (*733#)
                  </button>
                </div>
                {cbeTplInput.trim() && (
                  <p className="text-[10px] font-mono text-slate-400 break-all">
                    Preview: {buildPreviewUssd(cbeTplInput, false, 'cbe')}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={savingUssd === 'cbe_save'}
                  className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11.5px] font-bold cursor-pointer"
                >
                  {savingUssd === 'cbe_save'
                    ? 'Saving...'
                    : cbeEditingId
                      ? 'Save & Activate on Step 6'
                      : 'Add & Activate on Step 6'}
                </button>
              </form>
            </div>

            {/* -------- TRANSFER PAGE 2: STEP 15 (SEND MONEY TO PHONE) -------- */}
            <div className="bg-[#17212b] border border-sky-500/30 rounded-2xl p-3 space-y-2.5">
              <div>
                <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300">
                  TRANSFER PAGE 2 • STEP 15
                </span>
                <h3 className="text-[13px] font-bold text-white mt-1">
                  Send Money (Phone Number) USSD
                </h3>
              </div>

              <div className="bg-[#0e1621] border border-sky-400/25 rounded-xl p-2.5 space-y-1">
                <p className="text-[10px] font-semibold text-[#8b9bb0]">
                  Currently Filled / Active on Step 15:
                </p>
                <p className="text-[12px] font-bold text-white">{activePhoneProfile.label}</p>
                <p className="text-[11px] font-mono text-sky-300 break-all">
                  Template: {activePhoneProfile.template}
                </p>
                <p className="text-[10.5px] font-mono text-slate-400 break-all">
                  Dials: {buildPreviewUssd(activePhoneProfile.template, activePhoneProfile.isDefault, 'phone')}
                </p>
              </div>

              <div className="space-y-1.5">
                {phoneProfiles.map((prof) => {
                  const isActive = prof.id === currentActivePhoneId;
                  return (
                    <div
                      key={prof.id}
                      className={`rounded-xl p-2 border flex items-center justify-between gap-2 ${
                        isActive
                          ? 'bg-sky-950/35 border-sky-400/50'
                          : 'bg-[#0e1621] border-white/10'
                      }`}
                    >
                      <button
                        type="button"
                        disabled={savingUssd === 'phone_switch'}
                        onClick={() =>
                          void pushUssdUpdate(
                            { phoneUssdProfiles: phoneProfiles, activePhoneUssdId: prof.id },
                            'phone_switch',
                            `Step 15 active USSD switched to "${prof.label}"`
                          )
                        }
                        className="flex-1 text-left min-w-0 cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isActive ? 'bg-sky-400' : 'bg-slate-600'
                            }`}
                          />
                          <span className="text-[11.5px] font-bold text-white truncate">
                            {prof.label}
                          </span>
                          {isActive && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-500/25 text-sky-200 shrink-0">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <p className="text-[10.5px] font-mono text-slate-300 truncate pl-3.5">
                          {prof.template}
                        </p>
                      </button>

                      {!prof.isDefault && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setPhoneEditingId(prof.id);
                              setPhoneLabelInput(prof.label);
                              setPhoneTplInput(prof.template);
                            }}
                            className="px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[10px] font-semibold text-white cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const nextList = phoneProfiles.filter((p) => p.id !== prof.id);
                              const nextActive =
                                currentActivePhoneId === prof.id
                                  ? DEFAULT_PHONE_TRANSFER_USSD.id
                                  : currentActivePhoneId;
                              void pushUssdUpdate(
                                { phoneUssdProfiles: nextList, activePhoneUssdId: nextActive },
                                'phone_del',
                                `Deleted custom Step 15 profile "${prof.label}"`
                              );
                            }}
                            className="p-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 cursor-pointer"
                            title="Delete USSD profile"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <form
                onSubmit={handleSavePhoneUssdProfile}
                className="bg-[#0e1621] border border-white/10 rounded-xl p-2.5 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold text-sky-300 flex items-center gap-1">
                    <Plus className="w-3 h-3" />
                    {phoneEditingId
                      ? 'Edit Custom Send Money Phone USSD'
                      : 'Add / Set Custom Send Money Phone USSD'}
                  </span>
                  {phoneEditingId && (
                    <button
                      type="button"
                      onClick={() => {
                        setPhoneEditingId(null);
                        setPhoneLabelInput('');
                        setPhoneTplInput('');
                      }}
                      className="text-[10px] text-slate-400 underline cursor-pointer"
                    >
                      Cancel Edit
                    </button>
                  )}
                </div>

                <input
                  type="text"
                  value={phoneLabelInput}
                  onChange={(e) => setPhoneLabelInput(e.target.value)}
                  maxLength={60}
                  placeholder="Label (e.g. Custom Phone Transfer USSD)"
                  className="w-full bg-[#17212b] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11.5px] text-white outline-none focus:border-[#5eb5f7]"
                />
                <input
                  type="text"
                  value={phoneTplInput}
                  onChange={(e) => setPhoneTplInput(e.target.value)}
                  maxLength={120}
                  placeholder="e.g. *847*1*1*{phone}*{amount}#"
                  className="w-full bg-[#17212b] border border-white/10 rounded-lg px-2.5 py-1.5 text-[11.5px] text-sky-300 font-mono outline-none focus:border-[#5eb5f7]"
                />
                <div className="flex flex-wrap gap-1">
                  {['{phone}', '{amount}', '*', '#'].map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      onClick={() => setPhoneTplInput((prev) => `${prev}${tok}`)}
                      className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 text-[10px] font-mono text-slate-200 cursor-pointer"
                    >
                      + {tok}
                    </button>
                  ))}
                </div>
                {phoneTplInput.trim() && (
                  <p className="text-[10px] font-mono text-slate-400 break-all">
                    Preview: {buildPreviewUssd(phoneTplInput, false, 'phone')}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={savingUssd === 'phone_save'}
                  className="w-full py-2 rounded-lg bg-[#2b5278] hover:bg-[#356696] disabled:opacity-50 text-white text-[11.5px] font-bold cursor-pointer"
                >
                  {savingUssd === 'phone_save'
                    ? 'Saving...'
                    : phoneEditingId
                      ? 'Save & Activate on Step 15'
                      : 'Add & Activate on Step 15'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ================= TAB 4: PERMANENT TRANSACTIONS FOR THIS DEVICE ================= */}
        {subTab === 'txns' && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-3 gap-1.5">
              <div className="bg-[#17212b] border border-white/10 rounded-xl p-2">
                <p className="text-[9.5px] text-[#8b9bb0]">Total Saved</p>
                <p className="text-[13px] font-bold text-white">{deviceTxns.length}</p>
              </div>
              <div className="bg-[#17212b] border border-white/10 rounded-xl p-2">
                <p className="text-[9.5px] text-[#8b9bb0]">Total Sent</p>
                <p className="text-[11.5px] font-bold font-mono text-amber-300 truncate">
                  -{txTotals.debit.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="bg-[#17212b] border border-white/10 rounded-xl p-2">
                <p className="text-[9.5px] text-[#8b9bb0]">Total Received</p>
                <p className="text-[11.5px] font-bold font-mono text-emerald-300 truncate">
                  +{txTotals.credit.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
              </div>
            </div>

            {deviceTxns.length > 0 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={txSearch}
                  onChange={(e) => setTxSearch(e.target.value)}
                  placeholder="Search recipient, ref, bank, account, reason..."
                  className="w-full bg-[#17212b] border border-white/10 rounded-xl pl-8 pr-3 py-2 text-[11.5px] text-white placeholder:text-slate-500 outline-none focus:border-[#5eb5f7]"
                />
              </div>
            )}

            {filteredDeviceTxns.length === 0 ? (
              <div className="bg-[#17212b] border border-white/10 rounded-2xl p-6 text-center space-y-2">
                <Clock className="w-8 h-8 text-[#5eb5f7] mx-auto opacity-80" />
                <p className="text-[13px] font-semibold text-white">No Transactions Yet</p>
                <p className="text-[11px] text-[#7f91a4]">
                  Every transfer made on this device is permanently stored and shown here.
                </p>
              </div>
            ) : (
              filteredDeviceTxns.map((tx) => (
                <div
                  key={tx.txId}
                  className="bg-[#17212b] border border-white/10 rounded-2xl p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] font-bold px-2 py-0.5 rounded bg-[#2b5278]/75 text-[#90cdf4] truncate">
                      {tx.transferLabel} • {tx.title}
                      {tx.destBank ? ` (${tx.destBank})` : ''}
                    </span>
                    <span
                      className={`text-[13px] font-bold font-mono shrink-0 ${
                        tx.txType === 'credit' ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {tx.txType === 'credit' ? '+' : '-'}
                      {Number(tx.amount || 0).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                      })}{' '}
                      ETB
                    </span>
                  </div>

                  <p className="text-[11.5px] text-white font-medium break-words">
                    {tx.senderName || 'Sender'} ({tx.senderAccount || tx.senderPhone || '-'}) →{' '}
                    {tx.recipientName}{' '}
                    <span className="text-[#7f91a4] font-mono">
                      ({tx.recipientAccount || '-'})
                    </span>
                  </p>

                  {tx.reason && (
                    <p className="text-[10.5px] text-slate-300">
                      Reason: <span className="text-slate-200">{tx.reason}</span>
                    </p>
                  )}

                  <div className="flex items-center justify-between text-[10px] text-[#8b9bb0]">
                    <span>{formatFullDateTime(tx.createdAtMs)}</span>
                    <span className="shrink-0">{formatRelativeTime(tx.createdAtMs, serverNow)}</span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-[#8b9bb0] pt-1 border-t border-white/5">
                    <span className="font-mono">
                      Ref: {tx.ref} • {tx.status}
                    </span>
                    <span>
                      Bal After:{' '}
                      <b className="text-emerald-300">
                        {Number(tx.balanceAfter || 0).toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                        })}{' '}
                        ETB
                      </b>
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
