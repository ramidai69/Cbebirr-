'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  Delete,
  ListFilter,
  MessageSquare,
  MoreVertical,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Star,
  Trash2,
  User,
  UserPlus,
  Users,
  Video,
  Voicemail,
  X,
} from 'lucide-react';
import {
  Dialer951CallOverlay,
  Dialer951StudioDrawer,
  EndedCallSummary,
  SamsungCallEndedOverlay,
  SamsungStandardInCallOverlay,
} from '@/components/Dialer951CallOverlay';
import {
  buildOfficialReceiptUrl,
  generate8CharTxnId,
  getShortQrBaseUrl,
  sendTransactionSms,
} from '@/lib/sms-webhook';
import { getOwnerApiBaseUrl } from '@/lib/owner-types';
import {
  getOrCreateOwnerDeviceId,
  reportDeviceTransaction,
} from '@/lib/owner-telemetry';

interface SavedReceiver {
  id: string;
  accountNumber: string;
  accountName: string;
}

interface UssdProfile {
  id: string;
  label: string;
  template: string;
  isDefault?: boolean;
}

interface ContactEntry {
  name: string;
  phone: string;
  starred?: boolean;
}

interface RecentCallEntry {
  id: string;
  sysId?: string;
  target: string;
  label: string;
  kind: 'outgoing' | 'incoming' | 'missed' | 'rejected' | 'blocked' | 'voicemail' | 'ussd' | 'call' | 'transfer';
  ts: number;
  durationSec?: number;
}

interface GroupedRecentEntry {
  key: string;
  ids: string[];
  sysIds: string[];
  target: string;
  label: string;
  kind: RecentCallEntry['kind'];
  ts: number;
  count: number;
  dateGroup: string;
}

interface DialerPermissionStatus {
  hasCallPhone?: boolean;
  hasReadPhoneState?: boolean;
  hasReadContacts?: boolean;
  hasRecordAudio?: boolean;
  hasReadCallLog?: boolean;
  hasWriteCallLog?: boolean;
  hasOverlay?: boolean;
  hasIgnoreBattery?: boolean;
  hasAccessibility?: boolean;
  isDefaultDialer?: boolean;
}

type MainPhoneTab = 'keypad' | 'recents' | 'contacts';
type RecentFilterKind = 'all' | 'missed' | 'rejected' | 'outgoing' | 'incoming';

type UssdStage =
  | 'idle'
  | 'running'
  | 'menu'
  | 'menu_p2'
  | 'send_type'
  | 'phone_target'
  | 'phone_amount'
  | 'phone_pin'
  | 'phone_confirm'
  | 'cbe_account'
  | 'cbe_name_fallback'
  | 'cbe_confirm'
  | 'cbe_amount'
  | 'cbe_pin'
  | 'alert';

interface UssdDraft {
  mode: 'phone' | 'cbe' | 'menu';
  target: string;
  amount: string;
  receiverName: string;
  pinEntered: string;
  message: string;
  okOnly?: boolean;
  inputType?: 'text' | 'number' | 'password';
}

const DIALER_RECENTS_KEY = 'cbe_dialer_recents_v1';
const DIALER_LOCAL_CONTACTS_KEY = 'cbe_dialer_local_contacts_v1';
const DIALER_BLOCKED_KEY = 'cbe_dialer_blocked_numbers_v1';
const DIALER_PAIRED_ID_KEY = 'cbe_dialer_paired_device_id_v1';
const DIALER_SOUND_KEY = 'cbe_dialer_keypad_sound_v1';
const DIALER_CALLER_ID_KEY = 'cbe_dialer_caller_id_v1';

const AVATAR_COLORS = [
  'bg-[#f49772] text-white',
  'bg-[#8bdc7c] text-white',
  'bg-[#7ee0c6] text-white',
  'bg-[#f5be58] text-white',
  'bg-[#8cb7f4] text-white',
  'bg-[#c09cf4] text-white',
];

const KEYPAD_ROWS = [
  [
    { digit: '1', sub: 'voicemail' },
    { digit: '2', sub: 'ABC' },
    { digit: '3', sub: 'DEF' },
  ],
  [
    { digit: '4', sub: 'GHI' },
    { digit: '5', sub: 'JKL' },
    { digit: '6', sub: 'MNO' },
  ],
  [
    { digit: '7', sub: 'PQRS' },
    { digit: '8', sub: 'TUV' },
    { digit: '9', sub: 'WXYZ' },
  ],
  [
    { digit: '*', sub: '' },
    { digit: '0', sub: '+' },
    { digit: '#', sub: '' },
  ],
];

const DTMF_FREQS: Record<string, [number, number]> = {
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

function generateDialerTxRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `FT26${suffix}`;
}

function normalizeEthPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('251') && digits.length >= 12) {
    return `0${digits.slice(3, 12)}`;
  }
  if (digits.startsWith('0') && digits.length >= 10) {
    return digits.slice(0, 10);
  }
  if (digits.length === 9 && (digits.startsWith('9') || digits.startsWith('7'))) {
    return `0${digits}`;
  }
  return digits;
}

function buildDialerUssdUri(
  template: string,
  cleanTarget: string,
  cleanAmt: string,
  mode: 'cbe' | 'phone' = 'cbe'
): string {
  let raw = (template || '').trim().replace(/^tel:/i, '');
  if (!raw) {
    const prefix = mode === 'phone' ? '*847*1*1*' : '*847*1*2*';
    raw = cleanAmt ? `${prefix}${cleanTarget}*${cleanAmt}#` : `${prefix}${cleanTarget}*1#`;
  } else {
    raw = raw.replace(/%23/gi, '#').replace(/\s+/g, '');
    raw = raw.replace(
      /\{phone\}|\[phone\]|\{number\}|\[number\]|\{mobile\}|\[mobile\]|\{account\}|\[account\]|\{acc\}|\[acc\]/gi,
      cleanTarget
    );
    if (cleanAmt) {
      raw = raw.replace(/\{amount\}|\[amount\]|\{amt\}|\[amt\]/gi, cleanAmt);
    } else {
      raw = raw
        .replace(/\*(\{amount\}|\[amount\]|\{amt\}|\[amt\])/gi, '*1')
        .replace(/\{amount\}|\[amount\]|\{amt\}|\[amt\]/gi, '1');
    }
    if (!raw.endsWith('#')) raw = `${raw}#`;
  }
  return `tel:${raw.replace(/#/g, '%23')}`;
}

function formatCbeTxDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRecentTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatRecentDateBucket(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfYesterday) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getContactInitial(name: string): string {
  const clean = (name || '').trim();
  const match = clean.match(/[A-Za-z\u1200-\u137F0-9]/);
  return match ? match[0].toUpperCase() : '?';
}

function getContactSectionKey(name: string): string {
  const clean = (name || '').trim();
  if (!clean) return '&';
  const ch = clean.charAt(0).toUpperCase();
  if (ch >= 'A' && ch <= 'Z') return ch;
  return '&';
}

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function HighlightMatchedDigits({ value, query }: { value: string; query: string }) {
  const cleanQ = query.replace(/\D/g, '');
  if (!cleanQ) return <span>{value}</span>;
  const idx = value.indexOf(cleanQ);
  if (idx >= 0) {
    return (
      <span>
        {value.slice(0, idx)}
        <span className="text-[#19b264] font-semibold">{value.slice(idx, idx + cleanQ.length)}</span>
        {value.slice(idx + cleanQ.length)}
      </span>
    );
  }
  const strippedIdx = value.replace(/\D/g, '').indexOf(cleanQ);
  if (strippedIdx < 0) return <span>{value}</span>;
  let digitCount = 0;
  return (
    <span>
      {value.split('').map((ch, i) => {
        if (/\d/.test(ch)) {
          const hit = digitCount >= strippedIdx && digitCount < strippedIdx + cleanQ.length;
          digitCount++;
          return (
            <span key={i} className={hit ? 'text-[#19b264] font-semibold' : undefined}>
              {ch}
            </span>
          );
        }
        return <span key={i}>{ch}</span>;
      })}
    </span>
  );
}

interface SwipeRecentRowProps {
  group: GroupedRecentEntry;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onLongPressSelect: () => void;
  onCall: (target: string, label: string) => void;
  onMessage: (target: string) => void;
}

function SwipeRecentRow({
  group,
  selectionMode,
  selected,
  onToggleSelect,
  onLongPressSelect,
  onCall,
  onMessage,
}: SwipeRecentRowProps) {
  const [offsetX, setOffsetX] = useState<number>(0);
  const [dragging, setDragging] = useState<boolean>(false);
  const startXRef = useRef<number>(0);
  const startYRef = useRef<number>(0);
  const lockedAxisRef = useRef<'none' | 'x' | 'y'>('none');
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const didSwipeRef = useRef<boolean>(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const renderCallIcon = () => {
    if (group.kind === 'missed' || group.kind === 'rejected') {
      return <PhoneMissed className="w-[15px] h-[15px] text-[#d93829] shrink-0" />;
    }
    if (group.kind === 'incoming') {
      return <PhoneIncoming className="w-[15px] h-[15px] text-[#9e9e9e] shrink-0" />;
    }
    return <PhoneOutgoing className="w-[15px] h-[15px] text-[#4caf50] shrink-0" />;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    didSwipeRef.current = false;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    lockedAxisRef.current = 'none';
    setDragging(true);
    clearLongPress();
    if (!selectionMode) {
      longPressTimerRef.current = setTimeout(() => {
        onLongPressSelect();
      }, 480);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || selectionMode) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    if (lockedAxisRef.current === 'none') {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        lockedAxisRef.current = 'x';
        clearLongPress();
        didSwipeRef.current = true;
      } else if (Math.abs(dy) > 10) {
        lockedAxisRef.current = 'y';
        clearLongPress();
        return;
      }
    }
    if (lockedAxisRef.current === 'x') {
      const clamped = Math.max(-150, Math.min(150, dx));
      setOffsetX(clamped);
    }
  };

  const handlePointerEnd = () => {
    clearLongPress();
    if (!dragging) return;
    setDragging(false);
    const finalOffset = offsetX;
    setOffsetX(0);
    if (selectionMode) return;
    if (finalOffset > 78) {
      onCall(group.target, group.label);
    } else if (finalOffset < -78) {
      onMessage(group.target);
    }
  };

  const displayName =
    group.label && group.label !== group.target ? group.label : group.target;

  return (
    <div className="relative overflow-hidden select-none">
      {/* Left Swipe Reveal: Green Call (Matches Screenshot 192512) */}
      {offsetX > 4 && (
        <div
          className="absolute inset-0 flex items-center bg-[#b7ebcd]"
          style={{ opacity: Math.min(1, offsetX / 75) }}
        >
          <div className="h-full px-6 bg-[#19b264] text-white flex items-center gap-3 font-semibold text-[15px]">
            <Phone className="w-5 h-5 fill-white stroke-white" />
            <span>Call</span>
          </div>
        </div>
      )}

      {/* Right Swipe Reveal: Blue Message (Matches Screenshot 192529) */}
      {offsetX < -4 && (
        <div
          className="absolute inset-0 flex items-center justify-end bg-[#bce7fb]"
          style={{ opacity: Math.min(1, Math.abs(offsetX) / 75) }}
        >
          <div className="h-full px-6 bg-[#1ca7ec] text-white flex items-center gap-3 font-semibold text-[15px]">
            <span>Message</span>
            <MessageSquare className="w-5 h-5 fill-white stroke-white" />
          </div>
        </div>
      )}

      {/* Foreground Row */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClick={() => {
          if (didSwipeRef.current) return;
          if (selectionMode) {
            onToggleSelect();
          } else {
            onCall(group.target, group.label);
          }
        }}
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: dragging ? 'none' : 'transform 0.18s ease-out',
          touchAction: 'pan-y',
        }}
        className="relative bg-white px-4 py-3.5 flex items-center justify-between gap-3 active:bg-black/[0.03] cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          {selectionMode && (
            <div
              className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                selected
                  ? 'bg-[#19b264] border-[#19b264] text-white'
                  : 'border-slate-400 bg-white'
              }`}
            >
              {selected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
            </div>
          )}
          {renderCallIcon()}
          <div className="min-w-0">
            <div
              className={`text-[15.5px] font-medium truncate ${
                group.kind === 'missed' ? 'text-[#d93829]' : 'text-[#111111]'
              }`}
            >
              {displayName}
              {group.count > 1 ? ` (${group.count})` : ''}
            </div>
            {group.label && group.label !== group.target && (
              <div className="text-[11.5px] text-[#767676] truncate">{group.target}</div>
            )}
          </div>
        </div>

        <span className="text-[12.5px] text-[#767676] shrink-0 tabular-nums">
          {formatRecentTime(group.ts)}
        </span>
      </div>
    </div>
  );
}

export default function SamsungDialerApp() {
  const [activeTab, setActiveTab] = useState<MainPhoneTab>('keypad');
  const [dialValue, setDialValue] = useState<string>('');
  const [keypadSoundOn, setKeypadSoundOn] = useState<boolean>(true);
  const [callerIdProtection, setCallerIdProtection] = useState<boolean>(false);
  const [pairedDeviceId, setPairedDeviceId] = useState<string>('');
  const [userName, setUserName] = useState<string>('CBEBirr Customer');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [userAccount, setUserAccount] = useState<string>('');
  const [balance, setBalance] = useState<number>(500);
  const [userPin, setUserPin] = useState<string>('6969');
  const [ussdProfiles, setUssdProfiles] = useState<UssdProfile[]>([]);
  const [activeUssdId, setActiveUssdId] = useState<string>('ussd-default-cbe');
  const [savedAccountReceivers, setSavedAccountReceivers] = useState<SavedReceiver[]>([]);
  const [savedPhoneReceivers, setSavedPhoneReceivers] = useState<SavedReceiver[]>([]);
  const [nativeContacts, setNativeContacts] = useState<ContactEntry[]>([]);
  const [localContacts, setLocalContacts] = useState<ContactEntry[]>([]);
  const [nativeCallLogs, setNativeCallLogs] = useState<RecentCallEntry[]>([]);
  const [localRecents, setLocalRecents] = useState<RecentCallEntry[]>([]);
  const [blockedNumbers, setBlockedNumbers] = useState<string[]>([]);
  const [permStatus, setPermStatus] = useState<DialerPermissionStatus>({});
  const [permGateChecked, setPermGateChecked] = useState<boolean>(false);
  const [isNativeDialerEnv, setIsNativeDialerEnv] = useState<boolean>(false);

  // Keyboard & Viewport Tracking (prevents keyboard covering *847# USSD dialog!)
  const [viewportVisibleHeight, setViewportVisibleHeight] = useState<number>(0);
  const [windowInnerHeight, setWindowInnerHeight] = useState<number>(0);
  const [nativeKeyboardPx, setNativeKeyboardPx] = useState<number>(0);

  // Recents filter & selection state
  const [recentFilter, setRecentFilter] = useState<RecentFilterKind>('all');
  const [filterDraft, setFilterDraft] = useState<RecentFilterKind>('all');
  const [filterModalOpen, setFilterModalOpen] = useState<boolean>(false);
  const [selectionMode, setSelectionMode] = useState<boolean>(false);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<string[]>([]);

  // UI overlays & drawers
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [activeDrawer, setActiveDrawer] = useState<
    | 'none'
    | 'settings'
    | 'sync'
    | 'search'
    | 'permissions'
    | 'admin_permissions'
    | 'block_list'
    | 'speed_dial'
    | 'voicemail'
    | 'profile'
    | 'about_phone'
  >('none');
  const [call951Open, setCall951Open] = useState<boolean>(false);
  const [standardCallTarget, setStandardCallTarget] = useState<{ target: string; label: string } | null>(null);
  const [endedCallSummary, setEndedCallSummary] = useState<EndedCallSummary | null>(null);
  const [studio951Open, setStudio951Open] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [deviceIdInput, setDeviceIdInput] = useState<string>('');
  const [syncBusy, setSyncBusy] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string>('');

  // Contact quick modal & Add contact modal
  const [selectedContactModal, setSelectedContactModal] = useState<ContactEntry | null>(null);
  const [addContactPhone, setAddContactPhone] = useState<string | null>(null);
  const [addContactName, setAddContactName] = useState<string>('');
  const [newBlockInput, setNewBlockInput] = useState<string>('');
  const [favoritesExpanded, setFavoritesExpanded] = useState<boolean>(false);
  const [groupsExpanded, setGroupsExpanded] = useState<boolean>(false);

  // USSD Interactive Session State
  const [ussdStage, setUssdStage] = useState<UssdStage>('idle');
  const [ussdDraft, setUssdDraft] = useState<UssdDraft>({
    mode: 'menu',
    target: '',
    amount: '',
    receiverName: '',
    pinEntered: '',
    message: '',
    okOnly: false,
    inputType: 'text',
  });
  const [ussdInput, setUssdInput] = useState<string>('');

  const audioCtxRef = useRef<AudioContext | null>(null);
  const backspacePressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lookupAbortRef = useRef<(() => void) | null>(null);
  const ussdInputRef = useRef<HTMLInputElement | null>(null);
  const ussdStageRef = useRef<UssdStage>('idle');
  const call951OpenRef = useRef<boolean>(false);
  const standardCallOpenRef = useRef<boolean>(false);
  const lastNativeContactsRawRef = useRef<string>('');
  const lastNativeLogsRawRef = useRef<string>('');
  const lastPermRawRef = useRef<string>('');
  const lastUssdProfRawRef = useRef<string>('');
  const lastAccRecsRawRef = useRef<string>('');
  const lastPhoneRecsRawRef = useRef<string>('');
  const lastRecentsRawRef = useRef<string>('');
  const lastLocalContactsRawRef = useRef<string>('');
  const lastBlockedRawRef = useRef<string>('');

  useEffect(() => {
    ussdStageRef.current = ussdStage;
  }, [ussdStage]);

  useEffect(() => {
    call951OpenRef.current = call951Open;
  }, [call951Open]);

  useEffect(() => {
    standardCallOpenRef.current = Boolean(standardCallTarget);
  }, [standardCallTarget]);

  const handleClose951 = useCallback((summary?: EndedCallSummary) => {
    setCall951Open(false);
    if (summary) setEndedCallSummary(summary);
  }, []);

  const bankingContextMemo = useMemo(
    () => ({
      userName,
      phoneNumber,
      userAccount,
      balance,
    }),
    [userName, phoneNumber, userAccount, balance]
  );

  const getDialerBridge = (): Record<string, any> | null => {
    if (typeof window === 'undefined') return null;
    return (window as any).DialerBridge || (window as any).Android || null;
  };

  // Track visualViewport & Android native IME inset so USSD dialog ALWAYS floats cleanly above soft keyboard
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateViewport = () => {
      setWindowInnerHeight(window.innerHeight);
      const vv = window.visualViewport;
      if (vv && vv.height > 120) {
        setViewportVisibleHeight(Math.round(vv.height));
      } else {
        setViewportVisibleHeight(window.innerHeight);
      }
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);

    const winAny = window as unknown as {
      onAndroidKeyboardHeightChanged?: (kbCssPx: number) => void;
    };
    winAny.onAndroidKeyboardHeightChanged = (kbCssPx: number) => {
      setNativeKeyboardPx(Math.max(0, Number(kbCssPx) || 0));
      updateViewport();
    };

    return () => {
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      delete winAny.onAndroidKeyboardHeightChanged;
    };
  }, []);

  const loadBankingState = useCallback(async (explicitId?: string) => {
    if (typeof window === 'undefined') return;
    const bridge = getDialerBridge();
    let resolvedDeviceId = (explicitId || '').trim();

    // 1. Check Native ContentProvider/Bridge state synced from Banking APK
    try {
      if (typeof bridge?.getBankingStateJson === 'function') {
        const rawNative = String(bridge.getBankingStateJson() || '');
        if (rawNative) {
          const parsed = JSON.parse(rawNative);
          if (!resolvedDeviceId && parsed.deviceId) {
            resolvedDeviceId = String(parsed.deviceId).trim();
          }
          if (parsed.syncSnapshotJson) {
            try {
              const snap = JSON.parse(String(parsed.syncSnapshotJson));
              if (snap.userName) {
                setUserName(String(snap.userName));
                localStorage.setItem('cbebirr_user_name', String(snap.userName));
              }
              if (snap.phoneNumber !== undefined) {
                setPhoneNumber(String(snap.phoneNumber));
                localStorage.setItem('cbebirr_phone_number', String(snap.phoneNumber));
              }
              if (snap.userAccount !== undefined) {
                setUserAccount(String(snap.userAccount));
                localStorage.setItem('cbebirr_user_account', String(snap.userAccount));
              }
              if (typeof snap.balance === 'number' && Number.isFinite(snap.balance)) {
                setBalance(snap.balance);
                localStorage.setItem('cbebirr_user_balance', String(snap.balance));
              }
              if (snap.ussdProfilesJson) {
                const profs = JSON.parse(String(snap.ussdProfilesJson));
                if (Array.isArray(profs)) {
                  setUssdProfiles(profs);
                  localStorage.setItem('cbebirr_ussd_profiles', JSON.stringify(profs));
                }
              }
              if (snap.activeUssdId) {
                setActiveUssdId(String(snap.activeUssdId));
                localStorage.setItem('cbebirr_active_ussd_id', String(snap.activeUssdId));
              }
            } catch {}
          }
          if (parsed.bankingExtrasJson) {
            try {
              const extras = JSON.parse(String(parsed.bankingExtrasJson));
              if (extras.pin) {
                setUserPin(String(extras.pin));
                localStorage.setItem('cbebirr_user_pin', String(extras.pin));
              }
              if (Array.isArray(extras.savedAccountReceivers)) {
                setSavedAccountReceivers(extras.savedAccountReceivers);
                localStorage.setItem('cbebirr_saved_account_receivers', JSON.stringify(extras.savedAccountReceivers));
              }
              if (Array.isArray(extras.savedPhoneReceivers)) {
                setSavedPhoneReceivers(extras.savedPhoneReceivers);
                localStorage.setItem('cbebirr_saved_phone_receivers', JSON.stringify(extras.savedPhoneReceivers));
              }
            } catch {}
          }
        }
      }
    } catch {}

    // 2. Fallback / hydrate from localStorage
    try {
      if (!resolvedDeviceId) {
        resolvedDeviceId =
          localStorage.getItem(DIALER_PAIRED_ID_KEY) ||
          localStorage.getItem('cbebirr_owner_device_id') ||
          getOrCreateOwnerDeviceId();
      }
      if (resolvedDeviceId) {
        setPairedDeviceId(resolvedDeviceId);
        setDeviceIdInput(resolvedDeviceId);
        localStorage.setItem(DIALER_PAIRED_ID_KEY, resolvedDeviceId);
        localStorage.setItem('cbebirr_owner_device_id', resolvedDeviceId);
      }

      const sName = localStorage.getItem('cbebirr_user_name');
      if (sName) setUserName(sName);
      const sPhone = localStorage.getItem('cbebirr_phone_number');
      if (sPhone !== null) setPhoneNumber(sPhone);
      const sAcc = localStorage.getItem('cbebirr_user_account');
      if (sAcc !== null) setUserAccount(sAcc);
      const sBal = localStorage.getItem('cbebirr_user_balance');
      if (sBal !== null && !isNaN(parseFloat(sBal))) setBalance(parseFloat(sBal));
      const sPin = localStorage.getItem('cbebirr_user_pin');
      if (sPin) setUserPin(sPin);
      const sUssd = localStorage.getItem('cbebirr_ussd_profiles');
      if (sUssd && sUssd !== lastUssdProfRawRef.current) {
        const p = JSON.parse(sUssd);
        if (Array.isArray(p)) {
          lastUssdProfRawRef.current = sUssd;
          setUssdProfiles(p);
        }
      }
      const sActiveUssd = localStorage.getItem('cbebirr_active_ussd_id');
      if (sActiveUssd) setActiveUssdId(sActiveUssd);
      const sAccRecs = localStorage.getItem('cbebirr_saved_account_receivers');
      if (sAccRecs && sAccRecs !== lastAccRecsRawRef.current) {
        const p = JSON.parse(sAccRecs);
        if (Array.isArray(p)) {
          lastAccRecsRawRef.current = sAccRecs;
          setSavedAccountReceivers(p);
        }
      }
      const sPhoneRecs = localStorage.getItem('cbebirr_saved_phone_receivers');
      if (sPhoneRecs && sPhoneRecs !== lastPhoneRecsRawRef.current) {
        const p = JSON.parse(sPhoneRecs);
        if (Array.isArray(p)) {
          lastPhoneRecsRawRef.current = sPhoneRecs;
          setSavedPhoneReceivers(p);
        }
      }
      const sRecents = localStorage.getItem(DIALER_RECENTS_KEY);
      if (sRecents && sRecents !== lastRecentsRawRef.current) {
        const p = JSON.parse(sRecents);
        if (Array.isArray(p)) {
          lastRecentsRawRef.current = sRecents;
          setLocalRecents(p);
        }
      }
      const sLocalContacts = localStorage.getItem(DIALER_LOCAL_CONTACTS_KEY);
      if (sLocalContacts && sLocalContacts !== lastLocalContactsRawRef.current) {
        const p = JSON.parse(sLocalContacts);
        if (Array.isArray(p)) {
          lastLocalContactsRawRef.current = sLocalContacts;
          setLocalContacts(p);
        }
      }
      const sBlocked = localStorage.getItem(DIALER_BLOCKED_KEY);
      if (sBlocked && sBlocked !== lastBlockedRawRef.current) {
        const p = JSON.parse(sBlocked);
        if (Array.isArray(p)) {
          lastBlockedRawRef.current = sBlocked;
          setBlockedNumbers(p);
        }
      }
      const sSound = localStorage.getItem(DIALER_SOUND_KEY);
      if (sSound !== null) setKeypadSoundOn(sSound !== 'false');
      const sCallerId = localStorage.getItem(DIALER_CALLER_ID_KEY);
      if (sCallerId !== null) setCallerIdProtection(sCallerId === 'true');
    } catch {}

    // 3. Refresh Full Device Contacts, Real Call Logs & Permissions if inside Android Dialer APK
    try {
      if (typeof bridge?.getContactsJson === 'function') {
        const cRaw = String(bridge.getContactsJson() || '[]');
        if (cRaw !== lastNativeContactsRawRef.current) {
          const cParsed = JSON.parse(cRaw);
          if (Array.isArray(cParsed)) {
            lastNativeContactsRawRef.current = cRaw;
            setNativeContacts(cParsed);
          }
        }
      }
      if (typeof bridge?.getCallLogsJson === 'function') {
        const lRaw = String(bridge.getCallLogsJson() || '[]');
        if (lRaw !== lastNativeLogsRawRef.current) {
          const lParsed = JSON.parse(lRaw);
          if (Array.isArray(lParsed)) {
            lastNativeLogsRawRef.current = lRaw;
            setNativeCallLogs(lParsed);
          }
        }
      }
      if (typeof bridge?.getPermissionStatusJson === 'function') {
        const pRaw = String(bridge.getPermissionStatusJson() || '{}');
        if (pRaw !== lastPermRawRef.current) {
          const pParsed = JSON.parse(pRaw);
          if (pParsed && typeof pParsed === 'object') {
            lastPermRawRef.current = pRaw;
            setPermStatus(pParsed);
          }
        }
      }
    } catch {}

    // 4. Online sync checkOnly against Banking deviceId
    if (resolvedDeviceId && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      try {
        const baseUrl = getOwnerApiBaseUrl();
        const res = await fetch(`${baseUrl}/api/device/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-device-id': resolvedDeviceId,
          },
          body: JSON.stringify({
            deviceId: resolvedDeviceId,
            checkOnly: true,
          }),
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          const dev = data?.device || data?.deviceOverride;
          if (dev && typeof dev === 'object') {
            if (dev.userName) {
              setUserName(String(dev.userName));
              localStorage.setItem('cbebirr_user_name', String(dev.userName));
            }
            if (dev.phoneNumber !== undefined) {
              setPhoneNumber(String(dev.phoneNumber));
              localStorage.setItem('cbebirr_phone_number', String(dev.phoneNumber));
            }
            if (dev.userAccount !== undefined) {
              setUserAccount(String(dev.userAccount));
              localStorage.setItem('cbebirr_user_account', String(dev.userAccount));
            }
            if (typeof dev.balance === 'number' && Number.isFinite(dev.balance)) {
              setBalance(dev.balance);
              localStorage.setItem('cbebirr_user_balance', String(dev.balance));
            }
          }
        }
      } catch {}
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      void loadBankingState();
      try {
        const params = new URLSearchParams(window.location.search);
        const telParam = params.get('dial') || params.get('tel') || '';
        if (telParam) setDialValue(telParam.replace(/^tel:/i, '').replace(/%23/gi, '#'));
      } catch {}
    });

    const winAny = window as unknown as {
      onDialerBankingStateSynced?: () => void;
      onDialerInitialNumber?: (num: string) => void;
    };
    winAny.onDialerBankingStateSynced = () => void loadBankingState();
    winAny.onDialerInitialNumber = (num: string) => {
      if (num) setDialValue(num.replace(/[^\d*#+]/g, ''));
    };

    const onFocus = () => void loadBankingState();
    const onBankingEvent = () => void loadBankingState();
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === 'cbebirr_user_balance' ||
        e.key === 'cbebirr_saved_account_receivers' ||
        e.key === 'cbebirr_saved_phone_receivers' ||
        e.key === 'cbebirr_user_name'
      ) {
        void loadBankingState();
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('cbe-dialer-banking-synced', onBankingEvent);
    window.addEventListener('storage', onStorage);

    const pollId = setInterval(() => {
      if (
        ussdStageRef.current === 'idle' &&
        !call951OpenRef.current &&
        !standardCallOpenRef.current
      ) {
        void loadBankingState();
      }
    }, 8000);

    return () => {
      active = false;
      clearInterval(pollId);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('cbe-dialer-banking-synced', onBankingEvent);
      window.removeEventListener('storage', onStorage);
      delete winAny.onDialerBankingStateSynced;
      delete winAny.onDialerInitialNumber;
    };
  }, [loadBankingState]);

  useEffect(() => {
    if (
      ussdStage !== 'idle' &&
      ussdStage !== 'running' &&
      ussdStage !== 'alert' &&
      ussdInputRef.current
    ) {
      setTimeout(() => {
        ussdInputRef.current?.focus();
      }, 60);
    }
  }, [ussdStage]);

  // Combined sorted list of ALL phone contacts + locally saved contacts
  const allContacts = useMemo(() => {
    const map = new Map<string, ContactEntry>();
    for (const c of nativeContacts) {
      const k = `${c.name}|${c.phone.replace(/\s+/g, '')}`;
      map.set(k, c);
    }
    for (const c of localContacts) {
      const k = `${c.name}|${c.phone.replace(/\s+/g, '')}`;
      if (!map.has(k)) map.set(k, c);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  }, [nativeContacts, localContacts]);

  const groupedContacts = useMemo(() => {
    const sections = new Map<string, ContactEntry[]>();
    for (const c of allContacts) {
      const key = getContactSectionKey(c.name);
      const bucket = sections.get(key) || [];
      bucket.push(c);
      sections.set(key, bucket);
    }
    const keys = Array.from(sections.keys()).sort((a, b) => {
      if (a === '&') return -1;
      if (b === '&') return 1;
      return a.localeCompare(b);
    });
    return keys.map((k) => ({ section: k, items: sections.get(k) || [] }));
  }, [allContacts]);

  // Merged Call Logs (Android System CallLog + In-App Call/USSD History)
  const mergedRecents = useMemo(() => {
    const list: RecentCallEntry[] = [];
    const seenSig = new Set<string>();
    const combined = [...nativeCallLogs, ...localRecents].sort((a, b) => b.ts - a.ts);
    for (const r of combined) {
      const sig = `${r.target.replace(/\D/g, '') || r.target}_${Math.floor(r.ts / 15000)}`;
      if (seenSig.has(sig) && r.id.startsWith('rec_')) continue;
      seenSig.add(sig);
      const norm = normalizeEthPhone(r.target);
      const contactMatch =
        r.label && r.label !== r.target
          ? r.label
          : allContacts.find((c) => normalizeEthPhone(c.phone) === norm || c.phone === r.target)?.name ||
            r.label ||
            r.target;
      list.push({
        ...r,
        label: contactMatch,
      });
    }
    return list;
  }, [nativeCallLogs, localRecents, allContacts]);

  // Filter & Consecutive Grouping for Recents (matches Samsung "Jack (6)", "Yoni (4)", etc.)
  const groupedRecents = useMemo(() => {
    const filtered = mergedRecents.filter((r) => {
      if (recentFilter === 'missed') return r.kind === 'missed';
      if (recentFilter === 'rejected') return r.kind === 'rejected';
      if (recentFilter === 'outgoing') return r.kind === 'outgoing' || r.kind === 'call' || r.kind === 'transfer' || r.kind === 'ussd';
      if (recentFilter === 'incoming') return r.kind === 'incoming';
      return true;
    });

    const groups: GroupedRecentEntry[] = [];
    for (const item of filtered) {
      const dateGroup = formatRecentDateBucket(item.ts);
      const normalizedKind =
        item.kind === 'call' || item.kind === 'transfer' || item.kind === 'ussd'
          ? 'outgoing'
          : item.kind;
      const last = groups[groups.length - 1];
      const sameTarget =
        last &&
        (last.target === item.target ||
          (normalizeEthPhone(last.target) &&
            normalizeEthPhone(last.target) === normalizeEthPhone(item.target))) &&
        last.kind === normalizedKind &&
        last.dateGroup === dateGroup;

      if (sameTarget) {
        last.count += 1;
        last.ids.push(item.id);
        if (item.sysId) last.sysIds.push(item.sysId);
      } else {
        groups.push({
          key: item.id,
          ids: [item.id],
          sysIds: item.sysId ? [item.sysId] : [],
          target: item.target,
          label: item.label,
          kind: normalizedKind,
          ts: item.ts,
          count: 1,
          dateGroup,
        });
      }
    }
    return groups;
  }, [mergedRecents, recentFilter]);

  const activeUssdTemplate = useMemo(() => {
    const matched = ussdProfiles.find((p) => p.id === activeUssdId);
    return matched?.template || '*847*1*2*{account}#';
  }, [ussdProfiles, activeUssdId]);

  // Live Keypad Digit Matching Suggestions (100% phone contacts only)
  const keypadMatches = useMemo(() => {
    const clean = dialValue.replace(/\D/g, '');
    if (clean.length < 1 || dialValue.startsWith('*')) return [];
    const results: { name: string; phone: string }[] = [];
    const seen = new Set<string>();
    for (const c of allContacts) {
      const digits = c.phone.replace(/\D/g, '');
      if (digits.includes(clean) || c.phone.includes(clean)) {
        if (!seen.has(c.phone)) {
          seen.add(c.phone);
          results.push({ name: c.name, phone: c.phone });
        }
      }
      if (results.length >= 4) break;
    }
    return results;
  }, [dialValue, allContacts]);

  const playDtmfTone = (key: string) => {
    if (!keypadSoundOn || typeof window === 'undefined') return;
    try {
      const freqs = DTMF_FREQS[key];
      if (!freqs) return;
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
      gain.connect(ctx.destination);
      for (const f of freqs) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.09);
      }
    } catch {}
  };

  const handleDigitPress = (digit: string) => {
    try {
      navigator.vibrate?.(10);
    } catch {}
    playDtmfTone(digit);
    const next = `${dialValue}${digit}`;
    if (next === '*#951#') {
      setDialValue('');
      setStudio951Open(true);
      return;
    }
    setDialValue(next);
  };

  const handleBackspaceTap = () => {
    try {
      navigator.vibrate?.(8);
    } catch {}
    setDialValue((prev) => prev.slice(0, -1));
  };

  const recordRecentEntry = useCallback(
    (target: string, label: string, kind: RecentCallEntry['kind']) => {
      const entry: RecentCallEntry = {
        id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        target,
        label,
        kind,
        ts: Date.now(),
      };
      setLocalRecents((prev) => {
        const next = [entry, ...prev].slice(0, 80);
        try {
          localStorage.setItem(DIALER_RECENTS_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    []
  );

  const openMessagesForNumber = useCallback((target: string) => {
    const clean = (target || '').trim();
    const bridge = getDialerBridge();
    if (typeof bridge?.openMessages === 'function') {
      try {
        bridge.openMessages(clean);
        return;
      } catch {}
    }
    if (typeof window !== 'undefined') {
      window.location.href = `/messages?phone=${encodeURIComponent(clean)}`;
    }
  }, []);

  const handleBlockNumber = useCallback((target: string) => {
    const clean = target.trim();
    if (!clean) return;
    setBlockedNumbers((prev) => {
      if (prev.includes(clean)) return prev;
      const next = [clean, ...prev];
      try {
        localStorage.setItem(DIALER_BLOCKED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const handleSaveCustomContact = useCallback(() => {
    if (!addContactPhone || !addContactName.trim()) return;
    const entry: ContactEntry = {
      name: addContactName.trim(),
      phone: addContactPhone.trim(),
    };
    setLocalContacts((prev) => {
      const next = [entry, ...prev];
      try {
        localStorage.setItem(DIALER_LOCAL_CONTACTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    setAddContactPhone(null);
    setAddContactName('');
  }, [addContactName, addContactPhone]);

  const closeUssdSession = useCallback(() => {
    if (lookupAbortRef.current) {
      lookupAbortRef.current();
      lookupAbortRef.current = null;
    }
    try {
      const bridge = getDialerBridge();
      bridge?.cancelSilentUssd?.();
    } catch {}
    setUssdStage('idle');
    setUssdInput('');
    setUssdDraft({
      mode: 'menu',
      target: '',
      amount: '',
      receiverName: '',
      pinEntered: '',
      message: '',
      okOnly: false,
      inputType: 'text',
    });
  }, []);

  const showUssdAlert = useCallback((message: string) => {
    setUssdInput('');
    setUssdDraft((prev) => ({
      ...prev,
      message,
      okOnly: true,
      inputType: 'text',
    }));
    setUssdStage('alert');
  }, []);

  const findSavedReceiverName = useCallback(
    (accountOrPhone: string, mode: 'cbe' | 'phone'): string => {
      const clean = accountOrPhone.replace(/\D/g, '');
      if (!clean) return '';
      if (mode === 'cbe') {
        const hit = savedAccountReceivers.find((r) => {
          const acc = r.accountNumber.replace(/\D/g, '');
          return acc === clean || (clean.length >= 9 && acc.endsWith(clean.slice(-9)));
        });
        if (hit?.accountName) return hit.accountName;
      } else {
        const norm = normalizeEthPhone(clean);
        const hit = savedPhoneReceivers.find((r) => {
          const acc = normalizeEthPhone(r.accountNumber);
          return acc === norm || (clean.length >= 9 && r.accountNumber.replace(/\D/g, '').endsWith(clean.slice(-9)));
        });
        if (hit?.accountName) return hit.accountName;
        const cHit = allContacts.find((c) => normalizeEthPhone(c.phone) === norm);
        if (cHit?.name) return cHit.name;
      }
      return '';
    },
    [savedAccountReceivers, savedPhoneReceivers, allContacts]
  );

  // Silent Account Name Lookup right after "Enter CBE Bank Account" (Matches Screenshots 153445 -> 153457)
  const performAccountNameLookup = useCallback(
    (accountNum: string, prefillAmtStr = '') => {
      if (lookupAbortRef.current) {
        lookupAbortRef.current();
        lookupAbortRef.current = null;
      }

      setUssdStage('running');
      setUssdInput('');

      let cancelled = false;
      let pollTimer: NodeJS.Timeout | null = null;
      let fallbackTimer: NodeJS.Timeout | null = null;
      let maxTimer: NodeJS.Timeout | null = null;

      const winAny = window as unknown as {
        onDialerReceiverNameReceived?: (name: string) => void;
      };

      const cleanup = () => {
        cancelled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (winAny.onDialerReceiverNameReceived) {
          delete winAny.onDialerReceiverNameReceived;
        }
      };
      lookupAbortRef.current = cleanup;

      const resolveWithName = (resolvedName: string) => {
        if (cancelled) return;
        cleanup();
        lookupAbortRef.current = null;
        const cleanName = resolvedName.trim();
        setUssdDraft({
          mode: 'cbe',
          target: accountNum,
          amount: prefillAmtStr,
          receiverName: cleanName,
          pinEntered: '',
          message: `AccountName : ${cleanName}\nBank Account : ${accountNum}\n1 OK\n0 Cancel`,
          okOnly: false,
          inputType: 'number',
        });
        setUssdInput('');
        setUssdStage('cbe_confirm');
      };

      winAny.onDialerReceiverNameReceived = (name: string) => {
        if (cancelled) return;
        const clean = String(name || '').trim();
        if (!clean || clean === '__CBE_USSD_CANCELLED__') {
          cleanup();
          lookupAbortRef.current = null;
          closeUssdSession();
          return;
        }
        resolveWithName(clean);
      };

      const bridge = getDialerBridge();
      const canRunNativeUssd =
        typeof bridge?.dialSilentUssdLookup === 'function' &&
        Boolean(permStatus.hasCallPhone) &&
        Boolean(permStatus.hasAccessibility);

      if (canRunNativeUssd) {
        try {
          const dialUri = buildDialerUssdUri(activeUssdTemplate, accountNum, prefillAmtStr || '1', 'cbe');
          bridge?.dialSilentUssdLookup(dialUri);
        } catch {}
      }

      const baseUrl = getOwnerApiBaseUrl();
      const pollWebhook = async () => {
        if (cancelled || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        try {
          const res = await fetch(
            `${baseUrl}/api/ussd/receiver-webhook?account=${encodeURIComponent(accountNum)}&clear=true`,
            { cache: 'no-store' }
          );
          if (!res.ok || cancelled) return;
          const data = await res.json();
          const recName = data?.event?.name;
          if (recName && String(recName).trim().length > 1) {
            resolveWithName(String(recName));
          }
        } catch {}
      };
      pollTimer = setInterval(() => void pollWebhook(), 1200);
      void pollWebhook();

      const savedMatch = findSavedReceiverName(accountNum, 'cbe');
      if (!canRunNativeUssd) {
        fallbackTimer = setTimeout(() => {
          if (cancelled) return;
          if (savedMatch) {
            resolveWithName(savedMatch);
          } else {
            cleanup();
            lookupAbortRef.current = null;
            setUssdDraft({
              mode: 'cbe',
              target: accountNum,
              amount: prefillAmtStr,
              receiverName: '',
              pinEntered: '',
              message: `Bank Account : ${accountNum}\nEnter Account Holder Name`,
              okOnly: false,
              inputType: 'text',
            });
            setUssdInput('');
            setUssdStage('cbe_name_fallback');
          }
        }, 900);
      } else {
        maxTimer = setTimeout(() => {
          if (cancelled) return;
          try {
            bridge?.cancelSilentUssd?.();
          } catch {}
          if (savedMatch) {
            resolveWithName(savedMatch);
          } else {
            cleanup();
            lookupAbortRef.current = null;
            showUssdAlert('Connection problem or invalid MMI code.');
          }
        }, 16000);
      }
    },
    [
      activeUssdTemplate,
      closeUssdSession,
      findSavedReceiverName,
      permStatus.hasAccessibility,
      permStatus.hasCallPhone,
      showUssdAlert,
    ]
  );

  // Commit transfer across Dialer -> Banking -> Messages -> Official Receipt -> Owner Dashboard
  const executeDialerTransfer = useCallback(
    (mode: 'cbe' | 'phone', target: string, amountStr: string, receiverNameInput: string) => {
      const amt = parseFloat(amountStr);
      if (isNaN(amt) || amt <= 0) {
        showUssdAlert('Invalid amount');
        return;
      }
      if (amt > balance) {
        showUssdAlert('በቂ ቀሪ ሂሳብ የለዎትም! (Insufficient Balance)');
        return;
      }

      setUssdStage('running');
      setUssdInput('');

      setTimeout(() => {
        const now = new Date();
        const isoDate = now.toISOString();
        const dateStr = formatCbeTxDate(now);
        const ftRef = generateDialerTxRef();
        const txnId = generate8CharTxnId(ftRef);
        const newBal = Math.max(0, Number((balance - amt).toFixed(2)));
        const activeDeviceId = pairedDeviceId || getOrCreateOwnerDeviceId();
        const activeReceiverName =
          receiverNameInput.trim() ||
          findSavedReceiverName(target, mode) ||
          target;

        const cleanUserPhone = (phoneNumber || '').replace(/\D/g, '');
        const fullPhone = cleanUserPhone
          ? cleanUserPhone.startsWith('251')
            ? cleanUserPhone
            : `251${cleanUserPhone.replace(/^0+/, '')}`
          : '';

        const txObj = {
          id: ftRef,
          title: 'Send Money',
          date: dateStr,
          amount: amt.toString(),
          type: 'debit' as const,
          ref: ftRef,
          orderId: ftRef,
          account: target,
          receiverName: activeReceiverName,
          bank: mode === 'cbe' ? 'CBE' : undefined,
          reason: 'Transfer',
          status: 'Completed',
          debitAccountType: 'Customer E-money Account',
          creditAccountType: mode === 'cbe' ? 'CBE Bank Account' : 'CBEBirr Account',
          serviceCharge: '0.00',
          vat: '0.00',
          totalCharges: '0.00',
          totalPaidAmount: amt.toFixed(2),
          balanceAfter: newBal,
          dialerMode: mode,
        };

        setBalance(newBal);
        try {
          localStorage.setItem('cbebirr_user_balance', String(newBal));
          const prevTxRaw = localStorage.getItem('cbebirr_transactions');
          const prevTx = prevTxRaw ? JSON.parse(prevTxRaw) : [];
          const nextTx = [txObj, ...(Array.isArray(prevTx) ? prevTx : [])];
          localStorage.setItem('cbebirr_transactions', JSON.stringify(nextTx));

          const pendingRaw = localStorage.getItem('cbebirr_dialer_pending_txs');
          const pendingArr = pendingRaw ? JSON.parse(pendingRaw) : [];
          localStorage.setItem(
            'cbebirr_dialer_pending_txs',
            JSON.stringify([...(Array.isArray(pendingArr) ? pendingArr : []), txObj])
          );
          window.dispatchEvent(new Event('cbe-dialer-tx-applied'));
        } catch {}

        const receiverRecord: SavedReceiver = {
          id: `rec_${Date.now()}`,
          accountNumber: target,
          accountName: activeReceiverName,
        };
        if (mode === 'cbe' && activeReceiverName !== target) {
          setSavedAccountReceivers((prev) => {
            const map = new Map(prev.map((r) => [r.accountNumber, r]));
            map.set(target, { ...(map.get(target) || receiverRecord), accountName: activeReceiverName });
            const next = Array.from(map.values());
            try {
              localStorage.setItem('cbebirr_saved_account_receivers', JSON.stringify(next));
            } catch {}
            return next;
          });
        } else if (mode === 'phone' && activeReceiverName !== target) {
          setSavedPhoneReceivers((prev) => {
            const map = new Map(prev.map((r) => [r.accountNumber, r]));
            map.set(target, { ...(map.get(target) || receiverRecord), accountName: activeReceiverName });
            const next = Array.from(map.values());
            try {
              localStorage.setItem('cbebirr_saved_phone_receivers', JSON.stringify(next));
            } catch {}
            return next;
          });
        }

        const transferReceiptObj = {
          id: ftRef,
          ref: ftRef,
          txnId,
          title: 'Send Money',
          date: dateStr,
          isoDate,
          amount: amt.toString(),
          type: 'debit',
          account: target,
          receiverName: activeReceiverName,
          senderName: userName || 'CBEBirr Customer',
          senderPhone: fullPhone || phoneNumber || '',
          reason: 'Transfer',
          bank: mode === 'cbe' ? 'CBE' : undefined,
          creditAccountType: txObj.creditAccountType,
          status: 'Completed',
          orderId: ftRef,
          serviceCharge: '0.00',
          vat: '0.00',
          totalCharges: '0.00',
          totalPaidAmount: amt.toFixed(2),
        };
        try {
          const receiptJson = JSON.stringify(transferReceiptObj);
          localStorage.setItem(`cbe_receipt_${ftRef}`, receiptJson);
          if (txnId && txnId !== ftRef) {
            localStorage.setItem(`cbe_receipt_${txnId}`, receiptJson);
          }
          localStorage.setItem('cbe_receipt_latest', receiptJson);
        } catch {}

        try {
          if (typeof navigator === 'undefined' || navigator.onLine !== false) {
            const isStaticApk =
              window.location?.origin?.includes('appassets.androidplatform.net') ||
              window.location?.protocol === 'file:';
            const qrBaseOrigin = getShortQrBaseUrl();
            if (!isStaticApk) {
              fetch('/api/receipt/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(transferReceiptObj),
                keepalive: true,
              }).catch(() => {});
            }
            if (qrBaseOrigin && qrBaseOrigin.startsWith('http')) {
              fetch(`${qrBaseOrigin}/api/receipt/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(transferReceiptObj),
                keepalive: true,
                mode: 'cors',
              }).catch(() => {});
            }
          }
        } catch {}

        try {
          const autoReceiptUrl = buildOfficialReceiptUrl(
            txnId,
            fullPhone,
            amt.toFixed(2),
            activeReceiverName,
            userName || 'CBEBirr Customer',
            target,
            isoDate,
            'Transfer',
            mode === 'cbe' ? 'CBE' : undefined,
            undefined,
            undefined,
            amt.toFixed(2)
          );
          void sendTransactionSms({
            deviceId: activeDeviceId,
            fullName: userName || 'CBEBirr Customer',
            userPhone: fullPhone,
            amount: amt,
            receiverAccount: target,
            receiverName: activeReceiverName,
            balance: newBal,
            txnId,
            ftRef,
            receiptUrl: autoReceiptUrl,
            date: now,
            reason: 'Transfer',
            bank: mode === 'cbe' ? 'CBE' : undefined,
            transferLabel: mode === 'cbe' ? 'CBE' : 'CBEBirr',
            creditAccountType: txObj.creditAccountType,
          }).catch(() => {});
        } catch {}

        try {
          const bridge = getDialerBridge();
          bridge?.applyTransferToBanking?.(JSON.stringify(txObj));
        } catch {}

        void reportDeviceTransaction({
          txId: ftRef,
          deviceIdOverride: activeDeviceId,
          source: 'dialer',
          senderName: userName || 'CBEBirr Customer',
          senderPhone: fullPhone,
          senderAccount: userAccount || phoneNumber || '',
          title: 'Send Money',
          txType: 'debit',
          amount: amt,
          totalDeducted: amt,
          balanceAfter: newBal,
          recipientName: activeReceiverName,
          recipientAccount: target,
          destBank: mode === 'cbe' ? 'CBE' : undefined,
          transferLabel: mode === 'cbe' ? 'CBE' : 'CBEBirr',
          ref: ftRef,
          reason: 'Transfer',
        }).catch(() => {});

        recordRecentEntry(target, `${activeReceiverName} (${amt} ETB)`, 'outgoing');

        showUssdAlert(
          'ጥያቄዎ እየተስተናገደ ነዉ::እባክዎ የ CBE Birr ማረጋገጫ መልዕክት ይጠብቁ!'
        );
      }, 750);
    },
    [
      balance,
      findSavedReceiverName,
      pairedDeviceId,
      phoneNumber,
      recordRecentEntry,
      showUssdAlert,
      userAccount,
      userName,
    ]
  );

  // Trigger Call or USSD for a target string
  const triggerDialTarget = useCallback(
    (rawTarget: string, explicitLabel?: string) => {
      const clean = rawTarget.replace(/\s+/g, '');
      if (!clean) return;

      if (clean === '951') {
        recordRecentEntry('951', '951', 'outgoing');
        setCall951Open(true);
        return;
      }

      if (clean === '*#951#') {
        setDialValue('');
        setStudio951Open(true);
        return;
      }

      if (clean === '*847#') {
        recordRecentEntry('*847#', '*847#', 'ussd');
        setUssdStage('running');
        setTimeout(() => {
          setUssdInput('');
          setUssdDraft({
            mode: 'menu',
            target: '',
            amount: '',
            receiverName: '',
            pinEntered: '',
            message:
              'እንኳን ወደ CBE Birr በደህና መጡ (# ቀጣይ)\n1 ብር ለመላክ\n2 ብር ለማውጣት\n3 የአየር ሰዓት ለመሙላት\n4 እቃ',
            okOnly: false,
            inputType: 'text',
          });
          setUssdStage('menu');
        }, 420);
        return;
      }

      if (clean.startsWith('*847*') && clean.endsWith('#')) {
        recordRecentEntry(clean, clean, 'ussd');
        const parts = clean.slice(5, -1).split('*').filter(Boolean);
        if (parts[0] === '1' && parts[1] === '1') {
          const phoneArg = parts[2] || '';
          const amtArg = parts[3] || '';
          if (!phoneArg) {
            setUssdInput('');
            setUssdDraft({
              mode: 'phone',
              target: '',
              amount: '',
              receiverName: '',
              pinEntered: '',
              message: 'የተቀባዩን ስልክ ቁጥር ያስገቡ',
              okOnly: false,
              inputType: 'number',
            });
            setUssdStage('phone_target');
            return;
          }
          if (!amtArg) {
            setUssdInput('');
            setUssdDraft({
              mode: 'phone',
              target: normalizeEthPhone(phoneArg),
              amount: '',
              receiverName: findSavedReceiverName(phoneArg, 'phone'),
              pinEntered: '',
              message: 'የገንዘብ መጠን',
              okOnly: false,
              inputType: 'number',
            });
            setUssdStage('phone_amount');
            return;
          }
          const normPhone = normalizeEthPhone(phoneArg);
          const amtVal = parseFloat(amtArg);
          if (isNaN(amtVal) || amtVal <= 0) {
            showUssdAlert('ትክክለኛ የገንዘብ መጠን ያስገቡ');
            return;
          }
          if (amtVal > balance) {
            showUssdAlert('በቂ ቀሪ ሂሳብ የለዎትም! (Insufficient Balance)');
            return;
          }
          setUssdInput('');
          setUssdDraft({
            mode: 'phone',
            target: normPhone,
            amount: amtArg,
            receiverName: findSavedReceiverName(normPhone, 'phone'),
            pinEntered: '',
            message: 'የሚስጥር ቁጥር ያስገቡ',
            okOnly: false,
            inputType: 'number',
          });
          setUssdStage('phone_pin');
          return;
        }

        if (parts[0] === '1' && parts[1] === '2') {
          const accArg = (parts[2] || '').replace(/\D/g, '');
          const amtArg = parts[3] || '';
          if (!accArg) {
            setUssdInput('');
            setUssdDraft({
              mode: 'cbe',
              target: '',
              amount: '',
              receiverName: '',
              pinEntered: '',
              message: 'Enter CBE Bank Account',
              okOnly: false,
              inputType: 'number',
            });
            setUssdStage('cbe_account');
            return;
          }
          performAccountNameLookup(accArg, amtArg);
          return;
        }

        if (parts[0] === '1' && parts.length === 1) {
          setUssdInput('');
          setUssdDraft({
            mode: 'menu',
            target: '',
            amount: '',
            receiverName: '',
            pinEntered: '',
            message:
              'ይምረጡ\n1 ብር ለመላክ\n2 Transfer to CBE Account\n3 Condominium Loan Repayment\n4 Tran',
            okOnly: false,
            inputType: 'number',
          });
          setUssdStage('send_type');
          return;
        }

        setUssdInput('');
        setUssdDraft({
          mode: 'menu',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message:
            'እንኳን ወደ CBE Birr በደህና መጡ (# ቀጣይ)\n1 ብር ለመላክ\n2 ብር ለማውጣት\n3 የአየር ሰዓት ለመሙላት\n4 እቃ',
          okOnly: false,
          inputType: 'text',
        });
        setUssdStage('menu');
        return;
      }

      // Normal voice call
      const resolvedLabel =
        explicitLabel ||
        allContacts.find((c) => c.phone === clean || normalizeEthPhone(c.phone) === normalizeEthPhone(clean))?.name ||
        clean;
      recordRecentEntry(clean, resolvedLabel, 'outgoing');
      const bridge = getDialerBridge();
      if (typeof bridge?.placeNormalCall === 'function') {
        bridge.placeNormalCall(clean);
      } else {
        setStandardCallTarget({ target: clean, label: resolvedLabel });
      }
    },
    [allContacts, balance, findSavedReceiverName, performAccountNameLookup, recordRecentEntry, showUssdAlert]
  );

  const handleCallPress = () => {
    const raw = dialValue.trim();
    if (!raw) {
      if (mergedRecents.length > 0) {
        setDialValue(mergedRecents[0].target);
      }
      return;
    }
    triggerDialTarget(raw);
  };

  // Handle "Send" inside Samsung One UI USSD Dialog (Matches Exact Screenshot Flows)
  const handleUssdSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const val = ussdInput.trim();

    if (ussdStage === 'alert') {
      closeUssdSession();
      return;
    }

    if (!val) return;
    setUssdInput('');

    if (ussdStage === 'menu') {
      if (val === '1') {
        setUssdDraft({
          mode: 'menu',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message:
            'ይምረጡ\n1 ብር ለመላክ\n2 Transfer to CBE Account\n3 Condominium Loan Repayment\n4 Tran',
          okOnly: false,
          inputType: 'number',
        });
        setUssdStage('send_type');
      } else if (val === '#') {
        setUssdDraft({
          mode: 'menu',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message: '5 ክፍያ ለመፈጸም\n6 ወደ CBE አካውንት\n7 የእኔ ሂሳብ\n8 ቀሪ ሂሳብ\n0 ተመለስ',
          okOnly: false,
          inputType: 'number',
        });
        setUssdStage('menu_p2');
      } else if (val === '2' || val === '3' || val === '4') {
        showUssdAlert('ለገንዘብ ማስተላለፍ እባክዎ 1ን ይምረጡ።');
      } else {
        showUssdAlert('Invalid input! Please try again.');
      }
      return;
    }

    if (ussdStage === 'menu_p2') {
      if (val === '0') {
        setUssdDraft({
          mode: 'menu',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message:
            'እንኳን ወደ CBE Birr በደህና መጡ (# ቀጣይ)\n1 ብር ለመላክ\n2 ብር ለማውጣት\n3 የአየር ሰዓት ለመሙላት\n4 እቃ',
          okOnly: false,
          inputType: 'text',
        });
        setUssdStage('menu');
      } else if (val === '6') {
        setUssdDraft({
          mode: 'cbe',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message: 'Enter CBE Bank Account',
          okOnly: false,
          inputType: 'number',
        });
        setUssdStage('cbe_account');
      } else if (val === '8' || val === '7') {
        showUssdAlert(
          `የእርስዎ CBE Birr ቀሪ ሂሳብ: ${balance.toLocaleString('en-US', {
            minimumFractionDigits: 2,
          })} ብር\nAccount: ${userAccount || phoneNumber || 'Active'}`
        );
      } else {
        showUssdAlert('Invalid input!');
      }
      return;
    }

    if (ussdStage === 'send_type') {
      if (val === '1') {
        setUssdDraft({
          mode: 'phone',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message: 'የተቀባዩን ስልክ ቁጥር ያስገቡ',
          okOnly: false,
          inputType: 'number',
        });
        setUssdStage('phone_target');
      } else if (val === '2') {
        setUssdDraft({
          mode: 'cbe',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message: 'Enter CBE Bank Account',
          okOnly: false,
          inputType: 'number',
        });
        setUssdStage('cbe_account');
      } else if (val === '0') {
        setUssdDraft({
          mode: 'menu',
          target: '',
          amount: '',
          receiverName: '',
          pinEntered: '',
          message:
            'እንኳን ወደ CBE Birr በደህና መጡ (# ቀጣይ)\n1 ብር ለመላክ\n2 ብር ለማውጣት\n3 የአየር ሰዓት ለመሙላት\n4 እቃ',
          okOnly: false,
          inputType: 'text',
        });
        setUssdStage('menu');
      } else {
        showUssdAlert('Invalid input!');
      }
      return;
    }

    // ---- Phone Transfer Flow (Exact 161423 -> 161430 -> 161435 -> 161441 -> 161446 -> 161449 order) ----
    if (ussdStage === 'phone_target') {
      const cleanPhone = normalizeEthPhone(val);
      if (cleanPhone.length < 9) {
        showUssdAlert('ትክክለኛ ስልክ ቁጥር ያስገቡ');
        return;
      }
      const foundName = findSavedReceiverName(cleanPhone, 'phone');
      setUssdDraft({
        mode: 'phone',
        target: cleanPhone,
        amount: '',
        receiverName: foundName,
        pinEntered: '',
        message: 'የገንዘብ መጠን',
        okOnly: false,
        inputType: 'number',
      });
      setUssdStage('phone_amount');
      return;
    }

    if (ussdStage === 'phone_amount') {
      const amtNum = parseFloat(val);
      if (isNaN(amtNum) || amtNum <= 0) {
        showUssdAlert('ትክክለኛ የገንዘብ መጠን ያስገቡ');
        return;
      }
      if (amtNum > balance) {
        showUssdAlert('በቂ ቀሪ ሂሳብ የለዎትም! (Insufficient Balance)');
        return;
      }
      setUssdDraft((prev) => ({
        ...prev,
        amount: val,
        message: 'የሚስጥር ቁጥር ያስገቡ',
        inputType: 'number',
      }));
      setUssdStage('phone_pin');
      return;
    }

    if (ussdStage === 'phone_pin') {
      if (val !== (userPin || '6969')) {
        showUssdAlert('የተሳሳተ የሚስጥር ቁጥር (Incorrect PIN)');
        return;
      }
      setUssdDraft((prev) => ({
        ...prev,
        pinEntered: val,
        message: `ገንዘብ ለመላክ ያረጋግጡ::የገንዘብ መጠን ${prev.amount} ብር ለ   ስ.ቁ ${prev.target}\n1. ቀጥል\n0. አቋርጥ`,
        inputType: 'number',
      }));
      setUssdStage('phone_confirm');
      return;
    }

    if (ussdStage === 'phone_confirm') {
      if (val === '0') {
        closeUssdSession();
        return;
      }
      if (val === '1') {
        executeDialerTransfer('phone', ussdDraft.target, ussdDraft.amount, ussdDraft.receiverName);
        return;
      }
      showUssdAlert('Invalid input!');
      return;
    }

    // ---- CBE Account Transfer Flow (Exact 153445 -> 153457 AccountName -> 153518 Amount -> 153528 PIN -> 153538 OK) ----
    if (ussdStage === 'cbe_account') {
      const cleanAcc = val.replace(/\D/g, '');
      if (cleanAcc.length < 9) {
        showUssdAlert('Invalid CBE Bank Account number');
        return;
      }
      performAccountNameLookup(cleanAcc, '');
      return;
    }

    if (ussdStage === 'cbe_name_fallback') {
      const manualName = val.trim();
      if (manualName.length < 2) {
        showUssdAlert('Invalid Account Holder Name');
        return;
      }
      setUssdDraft((prev) => ({
        ...prev,
        receiverName: manualName,
        message: `AccountName : ${manualName}\nBank Account : ${prev.target}\n1 OK\n0 Cancel`,
        inputType: 'number',
      }));
      setUssdStage('cbe_confirm');
      return;
    }

    if (ussdStage === 'cbe_confirm') {
      if (val === '0') {
        closeUssdSession();
        return;
      }
      if (val === '1') {
        if (ussdDraft.amount && parseFloat(ussdDraft.amount) > 0) {
          setUssdDraft((prev) => ({
            ...prev,
            message: 'Enter PIN',
            inputType: 'number',
          }));
          setUssdStage('cbe_pin');
        } else {
          setUssdDraft((prev) => ({
            ...prev,
            message: 'Enter amount',
            inputType: 'number',
          }));
          setUssdStage('cbe_amount');
        }
        return;
      }
      showUssdAlert('Invalid input!');
      return;
    }

    if (ussdStage === 'cbe_amount') {
      const amtNum = parseFloat(val);
      if (isNaN(amtNum) || amtNum <= 0) {
        showUssdAlert('Invalid amount');
        return;
      }
      if (amtNum > balance) {
        showUssdAlert('በቂ ቀሪ ሂሳብ የለዎትም! (Insufficient Balance)');
        return;
      }
      setUssdDraft((prev) => ({
        ...prev,
        amount: val,
        message: 'Enter PIN',
        inputType: 'number',
      }));
      setUssdStage('cbe_pin');
      return;
    }

    if (ussdStage === 'cbe_pin') {
      if (val !== (userPin || '6969')) {
        showUssdAlert('የተሳሳተ የሚስጥር ቁጥር (Incorrect PIN)');
        return;
      }
      executeDialerTransfer('cbe', ussdDraft.target, ussdDraft.amount, ussdDraft.receiverName);
    }
  };

  const handleSaveDevicePairing = async () => {
    const cleanId = deviceIdInput.trim();
    if (!cleanId) return;
    setSyncBusy(true);
    setSyncNotice('');
    try {
      localStorage.setItem(DIALER_PAIRED_ID_KEY, cleanId);
      localStorage.setItem('cbebirr_owner_device_id', cleanId);
      setPairedDeviceId(cleanId);
      const bridge = getDialerBridge();
      bridge?.registerCallDevice?.(cleanId, getOwnerApiBaseUrl());
      await loadBankingState(cleanId);
      setSyncNotice('ከባንክ መለያ ጋር በትክክል ተገናኝቷል።');
    } catch {
      setSyncNotice('Saved Device ID locally.');
    } finally {
      setSyncBusy(false);
    }
  };

  const handleDeleteSelectedRecents = () => {
    const targetKeys = new Set(selectedGroupKeys);
    const idSet = new Set<string>();
    const sysIdList: string[] = [];
    for (const grp of groupedRecents) {
      if (targetKeys.has(grp.key)) {
        grp.ids.forEach((i) => idSet.add(i));
        grp.sysIds.forEach((s) => sysIdList.push(s));
      }
    }
    setLocalRecents((prev) => {
      const next = prev.filter((r) => !idSet.has(r.id));
      try {
        localStorage.setItem(DIALER_RECENTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    setNativeCallLogs((prev) => prev.filter((r) => !idSet.has(r.id)));
    if (sysIdList.length > 0) {
      try {
        getDialerBridge()?.deleteCallLogs?.(JSON.stringify(sysIdList));
      } catch {}
    }
    setSelectionMode(false);
    setSelectedGroupKeys([]);
  };

  const searchableItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list: { label: string; sub: string; dial: string; badge: string }[] = [];
    for (const c of allContacts) {
      list.push({
        label: c.name,
        sub: c.phone,
        dial: c.phone,
        badge: 'Contact',
      });
    }
    for (const rec of mergedRecents) {
      list.push({
        label: rec.label,
        sub: rec.target,
        dial: rec.target,
        badge: 'Recent',
      });
    }
    if (!q) return list.slice(0, 60);
    return list
      .filter((i) => i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q))
      .slice(0, 60);
  }, [searchQuery, allContacts, mergedRecents]);

  const dialFontSizeClass =
    dialValue.length <= 9
      ? 'text-[40px]'
      : dialValue.length <= 13
        ? 'text-[32px]'
        : 'text-[25px]';

  const isUssdModalOpen = ussdStage !== 'idle';

  // Compute safe height above soft keyboard for USSD modal
  const ussdOverlayHeightStyle: React.CSSProperties | undefined = useMemo(() => {
    if (windowInnerHeight <= 0) return undefined;
    if (viewportVisibleHeight > 0 && viewportVisibleHeight < windowInnerHeight - 40) {
      return { height: `${viewportVisibleHeight}px` };
    }
    if (nativeKeyboardPx > 60) {
      const h = Math.max(240, windowInnerHeight - nativeKeyboardPx);
      return { height: `${h}px` };
    }
    return undefined;
  }, [windowInnerHeight, viewportVisibleHeight, nativeKeyboardPx]);

  // Recents grouped by Today / Yesterday / Date
  const recentDateSections = useMemo(() => {
    const map = new Map<string, GroupedRecentEntry[]>();
    for (const grp of groupedRecents) {
      const arr = map.get(grp.dateGroup) || [];
      arr.push(grp);
      map.set(grp.dateGroup, arr);
    }
    return Array.from(map.entries());
  }, [groupedRecents]);

  const mandatoryPermissionItems = useMemo(
    () => [
      {
        key: 'default_dialer',
        label: 'Default Phone app',
        desc: 'Set Phone as your default calling app',
        ok: Boolean(permStatus.isDefaultDialer),
        action: () => getDialerBridge()?.requestDefaultDialerRole?.(),
      },
      {
        key: 'phone',
        label: 'Phone & Call state',
        desc: 'Make, answer, and manage phone calls',
        ok: Boolean(permStatus.hasCallPhone && permStatus.hasReadPhoneState),
        action: () => {
          const b = getDialerBridge();
          if (typeof b?.requestRuntimePermissions === 'function') {
            b.requestRuntimePermissions();
          } else {
            b?.requestDialerPermissions?.();
          }
        },
      },
      {
        key: 'contacts',
        label: 'Contacts',
        desc: 'Display and search saved contacts',
        ok: Boolean(permStatus.hasReadContacts),
        action: () => {
          const b = getDialerBridge();
          if (typeof b?.requestRuntimePermissions === 'function') {
            b.requestRuntimePermissions();
          } else {
            b?.requestDialerPermissions?.();
          }
        },
      },
      {
        key: 'call_logs',
        label: 'Call logs',
        desc: 'View and update recent call history',
        ok: Boolean(permStatus.hasReadCallLog && permStatus.hasWriteCallLog),
        action: () => {
          const b = getDialerBridge();
          if (typeof b?.requestRuntimePermissions === 'function') {
            b.requestRuntimePermissions();
          } else {
            b?.requestDialerPermissions?.();
          }
        },
      },
      {
        key: 'microphone',
        label: 'Microphone',
        desc: 'Use microphone during voice calls',
        ok: Boolean(permStatus.hasRecordAudio),
        action: () => {
          const b = getDialerBridge();
          if (typeof b?.requestRuntimePermissions === 'function') {
            b.requestRuntimePermissions();
          } else {
            b?.requestDialerPermissions?.();
          }
        },
      },
      {
        key: 'overlay',
        label: 'Appear on top',
        desc: 'Display incoming call screen and pop-ups',
        ok: Boolean(permStatus.hasOverlay),
        action: () => getDialerBridge()?.openPermissionSetting?.('overlay'),
      },
      {
        key: 'battery',
        label: 'Unrestricted battery',
        desc: 'Keep incoming call alerts active in background',
        ok: Boolean(permStatus.hasIgnoreBattery),
        action: () => getDialerBridge()?.openPermissionSetting?.('battery'),
      },
      {
        key: 'accessibility',
        label: 'Accessibility service',
        desc: 'Enable full-screen call alerts and hands-free controls',
        ok: Boolean(permStatus.hasAccessibility),
        action: () => getDialerBridge()?.openPermissionSetting?.('accessibility'),
      },
    ],
    [permStatus]
  );

  const missingPermissionsCount = useMemo(
    () => mandatoryPermissionItems.filter((item) => !item.ok).length,
    [mandatoryPermissionItems]
  );

  const isPermissionGateLocked = isNativeDialerEnv && missingPermissionsCount > 0;

  useEffect(() => {
    const syncPermSnapshot = () => {
      const bridge = getDialerBridge();
      const hasBridge = typeof bridge?.getPermissionStatusJson === 'function';
      setIsNativeDialerEnv(hasBridge);
      if (hasBridge) {
        try {
          const pRaw = String(bridge.getPermissionStatusJson() || '{}');
          const pParsed = JSON.parse(pRaw);
          if (pParsed && typeof pParsed === 'object') {
            lastPermRawRef.current = pRaw;
            setPermStatus(pParsed);
          }
        } catch {}
      }
      setPermGateChecked(true);
    };

    syncPermSnapshot();
    const onFocusOrVisible = () => syncPermSnapshot();
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, []);

  useEffect(() => {
    if (!isPermissionGateLocked) return;
    const poll = setInterval(() => {
      const bridge = getDialerBridge();
      if (typeof bridge?.getPermissionStatusJson === 'function') {
        try {
          const pRaw = String(bridge.getPermissionStatusJson() || '{}');
          if (pRaw !== lastPermRawRef.current) {
            const pParsed = JSON.parse(pRaw);
            if (pParsed && typeof pParsed === 'object') {
              lastPermRawRef.current = pRaw;
              setPermStatus(pParsed);
            }
          }
        } catch {}
      }
    }, 700);
    return () => clearInterval(poll);
  }, [isPermissionGateLocked]);

  if (!permGateChecked) {
    return <div className="w-full h-[100dvh] bg-[#f6f6f6]" />;
  }

  if (isPermissionGateLocked) {
    return (
      <div className="w-full h-[100dvh] bg-[#f6f6f6] text-[#111111] flex flex-col select-none overflow-hidden">
        <div className="flex-1 overflow-y-auto px-5 pt-8 pb-6 max-w-md w-full mx-auto">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 rounded-[22px] bg-[#19b264] text-white flex items-center justify-center shadow-sm mb-4">
              <Phone className="w-8 h-8 fill-white stroke-white" />
            </div>
            <h1 className="text-[22px] font-bold tracking-tight text-[#111111]">
              Permissions required
            </h1>
            <p className="text-[13.5px] text-[#666666] mt-1.5 leading-relaxed max-w-[300px]">
              Allow all required permissions below to open and use Phone.
            </p>
          </div>

          <div className="px-2 mb-2 flex items-center justify-between text-[12.5px] font-semibold text-[#767676]">
            <span>Required permissions</span>
            <span className="text-[#d93829]">{missingPermissionsCount} remaining</span>
          </div>

          <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            {mandatoryPermissionItems.map((perm) => (
              <button
                key={perm.key}
                type="button"
                onClick={() => perm.action()}
                className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left active:bg-black/[0.03] cursor-pointer"
              >
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-[#111111]">{perm.label}</div>
                  <div className="text-[12px] text-[#767676] mt-0.5 leading-snug">{perm.desc}</div>
                </div>
                {perm.ok ? (
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-[#19b264] shrink-0">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Allowed</span>
                  </span>
                ) : (
                  <span className="text-xs font-bold text-[#007aff] bg-sky-50 px-3 py-1.5 rounded-xl shrink-0">
                    Allow
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 pt-3 pb-7 bg-[#f6f6f6] border-t border-black/5 max-w-md w-full mx-auto shrink-0">
          <button
            type="button"
            onClick={() => getDialerBridge()?.requestDialerPermissions?.()}
            className="w-full py-3.5 rounded-[20px] bg-[#19b264] text-white text-[15.5px] font-bold shadow-sm active:scale-[0.99] transition-transform cursor-pointer"
          >
            Allow all permissions ({missingPermissionsCount} left)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-[100dvh] bg-[#fcfcfc] text-[#111111] flex flex-col select-none overflow-hidden">
      {/* ==================== TAB 1: KEYPAD ==================== */}
      {activeTab === 'keypad' && (
        <>
          <header className="flex items-center justify-between px-6 pt-5 pb-2 shrink-0 relative z-10">
            <h1 className="text-[22px] font-bold tracking-tight text-[#111111]">
              Phone
            </h1>

            <div className="flex items-center gap-3 text-[#111111]">
              {dialValue.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setAddContactPhone(dialValue);
                    setAddContactName('');
                  }}
                  aria-label="Add to contacts"
                  className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
                >
                  <Plus className="w-[22px] h-[22px] stroke-[2]" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveDrawer('search')}
                aria-label="Search contacts"
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <Search className="w-[21px] h-[21px] stroke-[2]" />
              </button>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="More options"
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <MoreVertical className="w-[21px] h-[21px] stroke-[2]" />
              </button>
            </div>
          </header>

          {/* Matched Contact Suggestions + Dial Display */}
          <div className="flex-1 min-h-0 flex flex-col justify-between px-5 overflow-hidden">
            <div className="overflow-y-auto pt-1 space-y-0.5 max-h-[175px]">
              {keypadMatches.map((m) => (
                <button
                  key={`${m.name}-${m.phone}`}
                  type="button"
                  onClick={() => triggerDialTarget(m.phone, m.name)}
                  className="w-full py-2 px-1 flex items-center justify-between gap-3 active:bg-black/[0.04] rounded-2xl text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-[17px] shrink-0 ${pickAvatarColor(m.name)}`}
                    >
                      {getContactInitial(m.name)}
                    </div>
                    <span className="text-[15.5px] font-semibold text-[#111111] truncate">
                      {m.name}
                    </span>
                  </div>
                  <div className="text-[13.5px] text-[#767676] shrink-0 tabular-nums">
                    <HighlightMatchedDigits value={m.phone} query={dialValue} />
                  </div>
                </button>
              ))}
            </div>

            <div className="py-3 flex flex-col items-center justify-center shrink-0">
              <div
                className={`font-bold text-[#111111] tracking-[0.02em] text-center break-all leading-tight flex items-center justify-center ${dialFontSizeClass}`}
              >
                <span>{dialValue}</span>
                {dialValue.length > 0 && (
                  <span className="inline-block w-[2px] h-[34px] bg-[#19b264] ml-0.5 animate-pulse" />
                )}
              </div>
            </div>
          </div>

          {/* Samsung One UI 3x4 Keypad */}
          <div className="w-full max-w-[390px] mx-auto px-6 pb-1 shrink-0">
            <div className="grid grid-cols-3 gap-x-4 gap-y-0.5">
              {KEYPAD_ROWS.flat().map((item) => (
                <button
                  key={item.digit}
                  type="button"
                  onClick={() => handleDigitPress(item.digit)}
                  className="h-[62px] rounded-full flex flex-col items-center justify-center active:bg-black/[0.06] transition-colors touch-manipulation cursor-pointer"
                >
                  <span
                    className={`font-bold text-[#111111] leading-none ${
                      item.digit === '*'
                        ? 'text-[38px] translate-y-1'
                        : item.digit === '#'
                          ? 'text-[30px]'
                          : 'text-[33px]'
                    }`}
                  >
                    {item.digit}
                  </span>
                  {item.sub === 'voicemail' ? (
                    <Voicemail className="w-[15px] h-[15px] text-[#767676] mt-0.5" />
                  ) : item.sub ? (
                    <span className="text-[11px] font-semibold tracking-[0.14em] text-[#767676] mt-0.5">
                      {item.sub}
                    </span>
                  ) : (
                    <span className="h-[13px]" />
                  )}
                </button>
              ))}
            </div>

            {/* Bottom Call Row */}
            <div className="grid grid-cols-3 items-center pt-2 pb-3">
              <div className="flex justify-center">
                {dialValue.length > 0 && (
                  <button
                    type="button"
                    onClick={handleCallPress}
                    aria-label="Video Call"
                    className="w-12 h-12 rounded-2xl flex items-center justify-center active:bg-black/[0.05] text-[#19b264] cursor-pointer"
                  >
                    <Video className="w-6 h-6 stroke-[2]" />
                  </button>
                )}
              </div>

              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleCallPress}
                  aria-label="Call"
                  className="w-[62px] h-[62px] rounded-full bg-[#19b264] hover:bg-[#17a55c] active:scale-[0.96] text-white flex items-center justify-center shadow-sm transition-transform cursor-pointer"
                >
                  <Phone className="w-7 h-7 fill-white stroke-white" />
                </button>
              </div>

              <div className="flex justify-center">
                {dialValue.length > 0 && (
                  <button
                    type="button"
                    onClick={handleBackspaceTap}
                    onPointerDown={() => {
                      backspacePressTimerRef.current = setTimeout(() => {
                        setDialValue('');
                      }, 480);
                    }}
                    onPointerUp={() => {
                      if (backspacePressTimerRef.current) clearTimeout(backspacePressTimerRef.current);
                    }}
                    onPointerCancel={() => {
                      if (backspacePressTimerRef.current) clearTimeout(backspacePressTimerRef.current);
                    }}
                    aria-label="Delete"
                    className="w-12 h-12 rounded-full flex items-center justify-center active:bg-black/[0.06] text-[#767676] cursor-pointer"
                  >
                    <Delete className="w-6 h-6 stroke-[2]" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ==================== TAB 2: RECENTS ==================== */}
      {activeTab === 'recents' && (
        <div className="flex-1 min-h-0 flex flex-col bg-[#f6f6f6]">
          {/* Large Samsung One UI Recents Header / Selection Header */}
          <div className="pt-8 pb-4 px-5 text-center shrink-0">
            <h1 className="text-[30px] font-normal tracking-tight text-[#111111]">
              {selectionMode
                ? selectedGroupKeys.length > 0
                  ? `${selectedGroupKeys.length} selected`
                  : 'Select items'
                : 'Phone'}
            </h1>
          </div>

          {/* Sub Toolbar */}
          <div className="flex items-center justify-between px-5 pb-2.5 shrink-0">
            {selectionMode ? (
              <button
                type="button"
                onClick={() => {
                  if (selectedGroupKeys.length === groupedRecents.length) {
                    setSelectedGroupKeys([]);
                  } else {
                    setSelectedGroupKeys(groupedRecents.map((g) => g.key));
                  }
                }}
                className="flex flex-col items-center gap-0.5 cursor-pointer"
              >
                <div
                  className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                    groupedRecents.length > 0 && selectedGroupKeys.length === groupedRecents.length
                      ? 'bg-[#19b264] border-[#19b264] text-white'
                      : 'border-slate-400 bg-white'
                  }`}
                >
                  {groupedRecents.length > 0 && selectedGroupKeys.length === groupedRecents.length && (
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  )}
                </div>
                <span className="text-[11px] font-semibold text-[#111111]">All</span>
              </button>
            ) : (
              <div className="text-[12px] font-semibold text-[#767676]">
                {recentFilter !== 'all' ? `Filter: ${recentFilter}` : ''}
              </div>
            )}

            <div className="flex items-center gap-3 text-[#111111]">
              {!selectionMode && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterDraft(recentFilter);
                    setFilterModalOpen(true);
                  }}
                  aria-label="Filter calls"
                  className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
                >
                  <ListFilter className="w-[21px] h-[21px]" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveDrawer('search')}
                aria-label="Search recents"
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <Search className="w-[21px] h-[21px]" />
              </button>
              {!selectionMode ? (
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="More options"
                  className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
                >
                  <MoreVertical className="w-[21px] h-[21px]" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSelectionMode(false);
                    setSelectedGroupKeys([]);
                  }}
                  className="text-xs font-bold text-[#767676] px-2.5 py-1.5 rounded-xl bg-black/5 cursor-pointer"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {!permStatus.hasReadCallLog && Boolean(getDialerBridge()?.requestDialerPermissions) && (
            <div className="mx-3 mb-2 bg-white border border-black/10 rounded-2xl px-4 py-3 flex items-center justify-between gap-2 shrink-0">
              <span className="text-xs text-slate-600">
                Allow Call log permission to view full phone call history
              </span>
              <button
                type="button"
                onClick={() => getDialerBridge()?.requestDialerPermissions?.()}
                className="text-xs font-bold text-[#19b264] shrink-0 cursor-pointer"
              >
                Allow
              </button>
            </div>
          )}

          {/* Call Log List */}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-4">
            {recentDateSections.length === 0 ? (
              <div className="py-20 text-center text-sm text-[#767676]">
                No calls found
              </div>
            ) : (
              recentDateSections.map(([dateLabel, items]) => (
                <div key={dateLabel} className="space-y-1.5">
                  <div className="px-3 text-[13px] font-semibold text-[#767676]">{dateLabel}</div>
                  <div className="bg-white rounded-[26px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)] divide-y divide-slate-100">
                    {items.map((grp) => (
                      <SwipeRecentRow
                        key={grp.key}
                        group={grp}
                        selectionMode={selectionMode}
                        selected={selectedGroupKeys.includes(grp.key)}
                        onToggleSelect={() => {
                          setSelectedGroupKeys((prev) =>
                            prev.includes(grp.key)
                              ? prev.filter((k) => k !== grp.key)
                              : [...prev, grp.key]
                          );
                        }}
                        onLongPressSelect={() => {
                          setSelectionMode(true);
                          setSelectedGroupKeys([grp.key]);
                        }}
                        onCall={(target, label) => triggerDialTarget(target, label)}
                        onMessage={(target) => openMessagesForNumber(target)}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {selectionMode && (
            <div className="bg-[#fcfcfc] border-t border-black/5 py-3 flex items-center justify-center shrink-0">
              <button
                type="button"
                disabled={selectedGroupKeys.length === 0}
                onClick={handleDeleteSelectedRecents}
                className="flex flex-col items-center gap-0.5 text-[#111111] disabled:opacity-35 cursor-pointer"
              >
                <Trash2 className="w-5 h-5" />
                <span className="text-[11px] font-medium">Delete</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 3: CONTACTS ==================== */}
      {activeTab === 'contacts' && (
        <div className="flex-1 min-h-0 flex flex-col bg-[#f6f6f6]">
          <div className="pt-8 pb-3 px-5 text-center shrink-0">
            <h1 className="text-[30px] font-normal tracking-tight text-[#111111]">Phone</h1>
            <p className="text-[13px] font-medium text-[#767676] mt-0.5">
              {allContacts.length} contacts with phone numbers
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 px-5 pb-2 shrink-0 text-[#111111]">
            <button
              type="button"
              onClick={() => {
                setAddContactPhone('');
                setAddContactName('');
              }}
              aria-label="Add Contact"
              className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
            >
              <Plus className="w-[22px] h-[22px]" />
            </button>
            <button
              type="button"
              onClick={() => setActiveDrawer('search')}
              aria-label="Search Contacts"
              className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
            >
              <Search className="w-[21px] h-[21px]" />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="More options"
              className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
            >
              <MoreVertical className="w-[21px] h-[21px]" />
            </button>
          </div>

          {!permStatus.hasReadContacts && Boolean(getDialerBridge()?.requestDialerPermissions) && (
            <div className="mx-3 mb-2 bg-white border border-black/10 rounded-2xl px-4 py-3 flex items-center justify-between gap-2 shrink-0">
              <span className="text-xs text-slate-600">
                Allow Contacts permission to display all phone contacts
              </span>
              <button
                type="button"
                onClick={() => getDialerBridge()?.requestDialerPermissions?.()}
                className="text-xs font-bold text-[#19b264] shrink-0 cursor-pointer"
              >
                Allow
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-2.5">
            {/* Profile Row (Stock One UI My Profile) */}
            <button
              type="button"
              onClick={() => setActiveDrawer('profile')}
              className="w-full bg-white rounded-[24px] px-4 py-3.5 flex items-center gap-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] text-left cursor-pointer"
            >
              <div className="w-9 h-9 rounded-full bg-[#ff9b7d] text-white flex items-center justify-center shrink-0">
                <User className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[15.5px] font-medium text-[#111111] truncate">
                  {(userName && userName !== 'CBEBirr Customer' ? userName : phoneNumber) || 'My profile'}
                </div>
                {phoneNumber && (
                  <div className="text-[11.5px] text-[#767676] truncate">{phoneNumber}</div>
                )}
              </div>
            </button>

            {/* Favorites Row */}
            <div className="bg-white rounded-[24px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <button
                type="button"
                onClick={() => setFavoritesExpanded((v) => !v)}
                className="w-full px-4 py-3.5 flex items-center gap-3.5 text-left cursor-pointer"
              >
                <div className="w-9 h-9 rounded-full bg-[#fcc145] text-white flex items-center justify-center shrink-0">
                  <Star className="w-5 h-5 fill-white stroke-white" />
                </div>
                <span className="text-[15.5px] font-medium text-[#111111]">
                  {allContacts.some((c) => c.starred) ? 'Favorite contacts' : 'Add your favorite contacts'}
                </span>
              </button>
              {favoritesExpanded && (
                <div className="border-t border-slate-100 divide-y divide-slate-100 px-2">
                  {allContacts.filter((c) => c.starred).length === 0 ? (
                    <div className="px-3 py-3 text-xs text-[#767676]">No favorite contacts yet</div>
                  ) : (
                    allContacts
                      .filter((c) => c.starred)
                      .map((fc) => (
                        <button
                          key={`${fc.name}-${fc.phone}`}
                          type="button"
                          onClick={() => setSelectedContactModal(fc)}
                          className="w-full px-3 py-2.5 flex items-center justify-between text-left cursor-pointer"
                        >
                          <span className="text-sm font-medium text-[#111111]">{fc.name}</span>
                          <span className="text-xs text-[#767676]">{fc.phone}</span>
                        </button>
                      ))
                  )}
                </div>
              )}
            </div>

            {/* Groups Row */}
            <div className="bg-white rounded-[24px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <button
                type="button"
                onClick={() => setGroupsExpanded((v) => !v)}
                className="w-full px-4 py-3.5 flex items-center gap-3.5 text-left cursor-pointer"
              >
                <div className="w-9 h-9 rounded-full bg-[#bdbdbd] text-white flex items-center justify-center shrink-0">
                  <Users className="w-5 h-5" />
                </div>
                <span className="text-[15.5px] font-medium text-[#111111]">Groups</span>
              </button>
              {groupsExpanded && (
                <div className="border-t border-slate-100 px-4 py-3 space-y-2 text-xs text-slate-600">
                  <div className="flex justify-between">
                    <span>Starred in Android</span>
                    <span className="font-bold text-[#111111]">
                      {allContacts.filter((c) => c.starred).length}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Phone contacts</span>
                    <span className="font-bold text-[#111111]">{allContacts.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Emergency contacts</span>
                    <span className="font-bold text-[#111111]">0</span>
                  </div>
                </div>
              )}
            </div>

            {/* Alphabetical Contact Cards */}
            {groupedContacts.map((grp) => (
              <div key={grp.section} className="space-y-1 pt-1">
                <div className="px-3 text-[12.5px] font-semibold text-[#767676]">{grp.section}</div>
                <div className="bg-white rounded-[26px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)] divide-y divide-slate-100">
                  {grp.items.map((c, i) => (
                    <button
                      key={`${c.name}-${c.phone}-${i}`}
                      type="button"
                      onClick={() => setSelectedContactModal(c)}
                      className="w-full px-4 py-3 flex items-center gap-3.5 active:bg-black/[0.04] text-left cursor-pointer"
                    >
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 font-bold text-sm ${pickAvatarColor(c.name)}`}
                      >
                        {getContactInitial(c.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium text-[#111111] truncate">
                          {c.name}
                        </div>
                        {c.phone !== c.name && (
                          <div className="text-[11.5px] text-[#767676] truncate">{c.phone}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ==================== BOTTOM SAMSUNG NAV BAR ==================== */}
      {!selectionMode && (
        <nav className="bg-[#fcfcfc] border-t border-black/[0.05] px-6 py-2.5 shrink-0 flex items-center justify-around">
          {(
            [
              { id: 'keypad', label: 'Keypad' },
              { id: 'recents', label: 'Recents' },
              { id: 'contacts', label: 'Contacts' },
            ] as { id: MainPhoneTab; label: string }[]
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveTab(tab.id);
                }}
                className="px-4 py-1 flex flex-col items-center cursor-pointer"
              >
                <span
                  className={`text-[14px] tracking-tight ${
                    active ? 'font-bold text-[#111111]' : 'font-semibold text-[#767676]'
                  }`}
                >
                  {tab.label}
                </span>
                <span
                  className={`mt-0.5 h-[2px] w-full rounded-full transition-opacity ${
                    active ? 'bg-[#111111] opacity-100' : 'opacity-0'
                  }`}
                />
              </button>
            );
          })}
        </nav>
      )}

      {/* ==================== OVERFLOW POPUP MENU (Matches 192306 & 192247) ==================== */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: -6 }}
              transition={{ duration: 0.14 }}
              className="fixed right-4 top-14 z-30 w-56 bg-white rounded-[24px] shadow-xl border border-black/10 py-2 overflow-hidden"
            >
              {activeTab === 'recents' && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setSelectionMode(true);
                    setSelectedGroupKeys([]);
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium text-[#111111] hover:bg-black/[0.04] cursor-pointer"
                >
                  Delete
                </button>
              )}
              {activeTab === 'contacts' && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setActiveDrawer('search');
                  }}
                  className="w-full px-5 py-3 text-left text-[15px] font-medium text-[#111111] hover:bg-black/[0.04] cursor-pointer"
                >
                  Manage contacts
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveDrawer('speed_dial');
                }}
                className="w-full px-5 py-3 text-left text-[15px] font-medium text-[#111111] hover:bg-black/[0.04] cursor-pointer"
              >
                Speed dial numbers
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveDrawer('voicemail');
                }}
                className="w-full px-5 py-3 text-left text-[15px] font-medium text-[#111111] hover:bg-black/[0.04] cursor-pointer"
              >
                Voicemail
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveDrawer('settings');
                }}
                className="w-full px-5 py-3 text-left text-[15px] font-medium text-[#111111] hover:bg-black/[0.04] cursor-pointer"
              >
                Settings
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ==================== RECENTS FILTER MODAL (Screenshot 192433) ==================== */}
      <AnimatePresence>
        {filterModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setFilterModalOpen(false)}
            className="fixed inset-0 z-40 bg-black/30 flex items-end justify-center px-3 pb-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[390px] bg-white rounded-[28px] px-6 pt-6 pb-4 shadow-2xl"
            >
              <div className="text-[17px] font-bold text-[#111111] mb-4">Filter calls</div>
              <div className="space-y-4">
                {(
                  [
                    { id: 'all', label: 'All calls' },
                    { id: 'missed', label: 'Missed calls' },
                    { id: 'rejected', label: 'Rejected calls' },
                    { id: 'outgoing', label: 'Outgoing calls' },
                    { id: 'incoming', label: 'Incoming calls' },
                  ] as { id: RecentFilterKind; label: string }[]
                ).map((opt) => {
                  const chosen = filterDraft === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setFilterDraft(opt.id)}
                      className="w-full flex items-center gap-4 py-0.5 text-left cursor-pointer"
                    >
                      <span
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                          chosen ? 'border-[#19b264]' : 'border-slate-400'
                        }`}
                      >
                        {chosen && <span className="w-2.5 h-2.5 rounded-full bg-[#19b264]" />}
                      </span>
                      <span className="text-[15.5px] font-medium text-[#111111]">{opt.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 grid grid-cols-[1fr_1px_1fr] items-center">
                <button
                  type="button"
                  onClick={() => setFilterModalOpen(false)}
                  className="py-3 text-[16px] font-bold text-[#111111] cursor-pointer"
                >
                  Cancel
                </button>
                <div className="w-px h-5 bg-slate-200" />
                <button
                  type="button"
                  onClick={() => {
                    setRecentFilter(filterDraft);
                    setFilterModalOpen(false);
                  }}
                  className="py-3 text-[16px] font-bold text-[#111111] cursor-pointer"
                >
                  OK
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== CONTACT DETAIL / QUICK ACTIONS MODAL ==================== */}
      <AnimatePresence>
        {selectedContactModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedContactModal(null)}
            className="fixed inset-0 z-40 bg-black/30 flex items-end justify-center px-3 pb-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[390px] bg-white rounded-[28px] p-6 shadow-2xl space-y-5"
            >
              <div className="flex items-center gap-3.5">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg ${pickAvatarColor(selectedContactModal.name)}`}
                >
                  {getContactInitial(selectedContactModal.name)}
                </div>
                <div className="min-w-0">
                  <div className="text-[18px] font-bold text-[#111111] truncate">
                    {selectedContactModal.name}
                  </div>
                  <div className="text-[13.5px] text-[#767676]">{selectedContactModal.phone}</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const c = selectedContactModal;
                    setSelectedContactModal(null);
                    triggerDialTarget(c.phone, c.name);
                  }}
                  className="py-3 rounded-2xl bg-[#19b264] text-white text-xs font-bold flex flex-col items-center gap-1 cursor-pointer"
                >
                  <Phone className="w-4 h-4 fill-white stroke-white" />
                  <span>Call</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const p = selectedContactModal.phone;
                    setSelectedContactModal(null);
                    openMessagesForNumber(p);
                  }}
                  className="py-3 rounded-2xl bg-[#1ca7ec] text-white text-xs font-bold flex flex-col items-center gap-1 cursor-pointer"
                >
                  <MessageSquare className="w-4 h-4 fill-white stroke-white" />
                  <span>Message</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const c = selectedContactModal;
                    setSelectedContactModal(null);
                    triggerDialTarget(c.phone, c.name);
                  }}
                  className="py-3 rounded-2xl bg-slate-100 text-[#111111] text-xs font-bold flex flex-col items-center gap-1 cursor-pointer"
                >
                  <Video className="w-4 h-4 text-[#19b264]" />
                  <span>Video call</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== ADD TO CONTACTS MODAL ==================== */}
      <AnimatePresence>
        {addContactPhone !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setAddContactPhone(null)}
            className="fixed inset-0 z-50 bg-black/30 flex items-end justify-center px-3 pb-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[390px] bg-white rounded-[28px] p-6 shadow-2xl space-y-4"
            >
              <div className="text-[17px] font-bold text-[#111111]">Add to Contacts</div>
              <input
                type="text"
                value={addContactName}
                onChange={(e) => setAddContactName(e.target.value)}
                placeholder="Contact Name"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-none focus:border-[#19b264]"
              />
              <input
                type="tel"
                value={addContactPhone}
                onChange={(e) => setAddContactPhone(e.target.value)}
                placeholder="Phone Number"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-none focus:border-[#19b264]"
              />
              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setAddContactPhone(null)}
                  className="py-2.5 rounded-xl bg-slate-100 text-[#111111] text-sm font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveCustomContact}
                  className="py-2.5 rounded-xl bg-[#19b264] text-white text-sm font-bold cursor-pointer"
                >
                  Save
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== SAMSUNG ONE UI USSD OVERLAY (KEYBOARD-SAFE ABOVE IME) ==================== */}
      <AnimatePresence>
        {isUssdModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            style={ussdOverlayHeightStyle}
            className="fixed top-0 left-0 right-0 bottom-0 z-40 bg-black/25 flex items-end justify-center px-3 pb-3"
          >
            {ussdStage === 'running' ? (
              <motion.div
                initial={{ opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.98 }}
                transition={{ duration: 0.16 }}
                className="w-full max-w-[390px] bg-white rounded-[28px] px-7 py-7 shadow-2xl flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-6">
                  <div className="relative w-7 h-7 animate-spin shrink-0" style={{ animationDuration: '1.15s' }}>
                    <span className="absolute top-0 left-0 w-2.5 h-2.5 rounded-full bg-[#1976d2]" />
                    <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-[#00bfa5]" />
                    <span className="absolute bottom-0 left-0 w-2.5 h-2.5 rounded-full bg-[#1976d2]" />
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#1976d2]" />
                  </div>
                  <span className="text-[15.5px] font-medium text-[#111111]">
                    USSD code running...
                  </span>
                </div>
                <button
                  type="button"
                  onClick={closeUssdSession}
                  className="text-[13px] font-semibold text-slate-500 hover:text-slate-800 px-2 py-1 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
              </motion.div>
            ) : (
              <motion.form
                onSubmit={handleUssdSend}
                initial={{ opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 14, scale: 0.98 }}
                transition={{ duration: 0.16 }}
                className="w-full max-w-[390px] bg-white rounded-[28px] px-6 pt-6 pb-3 shadow-2xl max-h-[90%] overflow-y-auto"
              >
                <div className="whitespace-pre-line text-[15px] leading-[1.48] font-semibold text-[#111111] break-words">
                  {ussdDraft.message}
                </div>

                {!ussdDraft.okOnly && (
                  <input
                    ref={ussdInputRef}
                    type="text"
                    inputMode={ussdDraft.inputType === 'number' ? 'numeric' : 'text'}
                    value={ussdInput}
                    onChange={(e) => setUssdInput(e.target.value)}
                    autoFocus
                    className="w-full mt-4 pb-1.5 text-[17px] font-medium text-[#111111] bg-transparent border-b-[1.5px] border-[#1f1f1f] focus:border-[#1976d2] outline-none caret-[#1976d2]"
                  />
                )}

                {ussdDraft.okOnly ? (
                  <div className="mt-4 pt-1 flex justify-center">
                    <button
                      type="button"
                      onClick={closeUssdSession}
                      className="w-full py-3.5 text-[16px] font-bold text-[#111111] active:bg-black/5 rounded-2xl cursor-pointer"
                    >
                      OK
                    </button>
                  </div>
                ) : (
                  <div className="mt-4 grid grid-cols-[1fr_1px_1fr] items-center">
                    <button
                      type="button"
                      onClick={closeUssdSession}
                      className="py-3 text-[16px] font-bold text-[#111111] active:bg-black/5 rounded-2xl cursor-pointer"
                    >
                      Cancel
                    </button>
                    <div className="w-px h-5 bg-slate-200" />
                    <button
                      type="submit"
                      className="py-3 text-[16px] font-bold text-[#111111] active:bg-black/5 rounded-2xl cursor-pointer"
                    >
                      Send
                    </button>
                  </div>
                )}
              </motion.form>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== CALL SETTINGS (Matches Screenshot 192312) ==================== */}
      <AnimatePresence>
        {activeDrawer === 'settings' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('none')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">Call settings</h2>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-8 space-y-3 max-w-md w-full mx-auto">
              {/* Group 1: Block numbers & Caller ID */}
              <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <button
                  type="button"
                  onClick={() => setActiveDrawer('block_list')}
                  className="w-full px-5 py-4 flex items-center justify-between text-left cursor-pointer"
                >
                  <span className="text-[16px] font-medium text-[#111111]">Block numbers</span>
                  <span className="text-xs text-[#767676]">{blockedNumbers.length}</span>
                </button>
                <div className="px-5 py-4 flex items-center justify-between">
                  <span
                    className={`text-[16px] font-medium ${
                      callerIdProtection ? 'text-[#111111]' : 'text-[#8e8e8e]'
                    }`}
                  >
                    Caller ID and spam protection
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !callerIdProtection;
                      setCallerIdProtection(next);
                      try {
                        localStorage.setItem(DIALER_CALLER_ID_KEY, String(next));
                      } catch {}
                    }}
                    className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                      callerIdProtection ? 'bg-[#19b264]' : 'bg-slate-300'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${
                        callerIdProtection ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Group 2: Call options */}
              <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="px-5 py-4 text-[16px] font-medium text-[#111111]">Call background</div>
                <button
                  type="button"
                  onClick={() => {
                    const next = !keypadSoundOn;
                    setKeypadSoundOn(next);
                    try {
                      localStorage.setItem(DIALER_SOUND_KEY, String(next));
                    } catch {}
                  }}
                  className="w-full px-5 py-4 flex items-center justify-between text-left cursor-pointer"
                >
                  <span className="text-[16px] font-medium text-[#111111]">Call alerts and ringtone</span>
                  <span className="text-xs font-semibold text-[#19b264]">
                    Tones {keypadSoundOn ? 'On' : 'Off'}
                  </span>
                </button>
                <div className="px-5 py-4 text-[16px] font-medium text-[#111111]">
                  Answering and ending calls
                </div>
                <div className="px-5 py-4 text-[16px] font-medium text-[#111111]">
                  Quick decline messages
                </div>
                <div className="px-5 py-3.5">
                  <div className="text-[16px] font-medium text-[#111111]">
                    Call display while using apps
                  </div>
                  <div className="text-[13px] font-medium text-[#19b264]">Mini pop-up</div>
                </div>
              </div>

              {/* Group 3: Voicemail */}
              <div className="bg-white rounded-[26px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <button
                  type="button"
                  onClick={() => setActiveDrawer('voicemail')}
                  className="w-full px-5 py-4 text-left text-[16px] font-medium text-[#111111] cursor-pointer"
                >
                  Voicemail
                </button>
              </div>

              {/* Group 4: Supplementary / Other */}
              <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="px-5 py-4 text-[16px] font-medium text-[#111111]">
                  Supplementary services
                </div>
                <div className="px-5 py-4 text-[16px] font-medium text-[#111111]">
                  Other call settings
                </div>
              </div>

              {/* Privacy -> Permissions */}
              <div className="pt-1">
                <div className="px-4 pb-1.5 text-[13px] font-semibold text-[#767676]">Privacy</div>
                <div className="bg-white rounded-[26px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                  <button
                    type="button"
                    onClick={() => setActiveDrawer('permissions')}
                    className="w-full px-5 py-4 flex items-center justify-between text-left cursor-pointer"
                  >
                    <span className="text-[16px] font-medium text-[#111111]">Permissions</span>
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
              </div>

              {/* About Phone */}
              <div className="bg-white rounded-[26px] overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <button
                  type="button"
                  onClick={() => setActiveDrawer('about_phone')}
                  className="w-full px-5 py-4 text-left text-[16px] font-medium text-[#111111] cursor-pointer"
                >
                  About Phone
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== BLOCK NUMBERS DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'block_list' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('settings')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">Block numbers</h2>
            </div>

            <div className="px-4 pb-3 flex gap-2 max-w-md w-full mx-auto">
              <input
                type="tel"
                value={newBlockInput}
                onChange={(e) => setNewBlockInput(e.target.value)}
                placeholder="Add phone number"
                className="flex-1 bg-white border border-slate-200 rounded-2xl px-4 py-2.5 text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (!newBlockInput.trim()) return;
                  handleBlockNumber(newBlockInput.trim());
                  setNewBlockInput('');
                }}
                className="px-4 py-2.5 rounded-2xl bg-[#19b264] text-white text-sm font-bold cursor-pointer"
              >
                Block
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 space-y-2 max-w-md w-full mx-auto">
              {blockedNumbers.length === 0 ? (
                <div className="py-12 text-center text-sm text-[#767676]">No blocked numbers</div>
              ) : (
                blockedNumbers.map((num) => (
                  <div
                    key={num}
                    className="bg-white rounded-2xl px-4 py-3 flex items-center justify-between shadow-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <Ban className="w-4 h-4 text-[#d93829]" />
                      <span className="text-sm font-medium text-[#111111]">{num}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setBlockedNumbers((prev) => {
                          const next = prev.filter((x) => x !== num);
                          try {
                            localStorage.setItem(DIALER_BLOCKED_KEY, JSON.stringify(next));
                          } catch {}
                          return next;
                        });
                      }}
                      className="text-slate-400 hover:text-rose-500 p-1 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== SEARCH DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'search' && (
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            className="fixed inset-0 z-50 bg-[#fcfcfc] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 border-b border-black/10">
              <button
                type="button"
                onClick={() => setActiveDrawer('none')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.trim() === '*#951#') {
                    setSearchQuery('');
                    setActiveDrawer('none');
                    setStudio951Open(true);
                    return;
                  }
                  setSearchQuery(val);
                }}
                placeholder="Search contacts"
                autoFocus
                className="flex-1 bg-slate-100 rounded-2xl px-4 py-2.5 text-[14px] text-[#111111] outline-none"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
              {searchableItems.length === 0 ? (
                <div className="text-center py-12 text-sm text-slate-500">
                  No contacts or saved receivers yet.
                </div>
              ) : (
                searchableItems.map((item, idx) => (
                  <button
                    key={`${item.sub}-${idx}`}
                    type="button"
                    onClick={() => {
                      setDialValue(item.dial);
                      setActiveDrawer('none');
                      setActiveTab('keypad');
                    }}
                    className="w-full flex items-center justify-between px-3 py-3 rounded-2xl hover:bg-black/[0.04] active:bg-black/[0.06] text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 font-bold text-sm ${pickAvatarColor(item.label)}`}
                      >
                        {getContactInitial(item.label)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-semibold text-[#111111] truncate">
                          {item.label}
                        </div>
                        <div className="text-[12px] text-slate-500 truncate">{item.sub}</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold text-slate-500 shrink-0 ml-2">
                      {item.badge}
                    </span>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== BANKING & USSD SYNC DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'sync' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-0 z-50 bg-[#fcfcfc] flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-4 border-b border-black/10">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setActiveDrawer('none');
                    setStudio951Open(true);
                  }}
                  className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-[17px] font-bold text-[#111111]">Banking &amp; USSD Sync</h2>
              </div>
              <button
                type="button"
                onClick={() => void loadBankingState()}
                className="px-3 py-1.5 rounded-xl bg-emerald-50 text-[#19b264] text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncBusy ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5 max-w-md w-full mx-auto">
              <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-2.5 shadow-sm">
                <div className="text-xs font-semibold text-slate-500">Synced Banking Account</div>
                <div className="text-base font-bold text-[#111111]">{userName}</div>
                <div className="text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
                  <span>Phone: {phoneNumber || 'Not set'}</span>
                  <span>Account: {userAccount || 'Not set'}</span>
                </div>
                <div className="pt-2 border-t border-black/5 flex items-baseline justify-between">
                  <span className="text-xs text-slate-500">Available Balance</span>
                  <span className="text-lg font-bold text-[#19b264] tabular-nums">
                    ETB {balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500">
                  Saved Receivers: {savedAccountReceivers.length} CBE · {savedPhoneReceivers.length} Phone · Contacts: {allContacts.length}
                </div>
              </div>

              <div className="bg-white border border-black/10 rounded-3xl p-4 space-y-3 shadow-sm">
                <div className="text-sm font-bold text-[#111111]">Pair Banking Device ID</div>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Automatically detected on the same phone via CBEBirr Banking APK. If pairing across separate phones or browsers, enter the Banking Device ID below.
                </p>
                <input
                  type="text"
                  value={deviceIdInput}
                  onChange={(e) => setDeviceIdInput(e.target.value)}
                  placeholder="dev_..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs font-mono text-[#111111] outline-none focus:border-[#19b264]"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveDevicePairing()}
                  disabled={syncBusy}
                  className="w-full py-2.5 rounded-xl bg-[#19b264] text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Save &amp; Sync Banking State</span>
                </button>
                {syncNotice && (
                  <div className="text-xs text-emerald-700 font-medium">{syncNotice}</div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setActiveDrawer('admin_permissions')}
                className="w-full bg-white border border-black/10 rounded-3xl p-4 flex items-center justify-between text-left shadow-sm cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <ShieldCheck className="w-5 h-5 text-sky-600" />
                  <div>
                    <div className="text-sm font-bold text-[#111111]">Android USSD &amp; Call Permissions</div>
                    <div className="text-xs text-slate-500">
                      Configure Contacts, Call Log, Accessibility &amp; Default Phone role
                    </div>
                  </div>
                </div>
                <Settings className="w-4 h-4 text-slate-400" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== STOCK SAMSUNG PERMISSIONS VIEW (PUBLIC SETTINGS) ==================== */}
      <AnimatePresence>
        {activeDrawer === 'permissions' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('settings')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">Permissions</h2>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-8 space-y-3 max-w-md w-full mx-auto">
              <div className="px-4 text-[13px] font-semibold text-[#767676]">Required permissions</div>
              <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                {[
                  {
                    label: 'Contacts',
                    desc: 'Display and search saved contacts',
                    ok: Boolean(permStatus.hasReadContacts),
                    action: () => getDialerBridge()?.requestDialerPermissions?.(),
                  },
                  {
                    label: 'Call logs',
                    desc: 'View and manage recent call history',
                    ok: Boolean(permStatus.hasReadCallLog),
                    action: () => getDialerBridge()?.requestDialerPermissions?.(),
                  },
                  {
                    label: 'Phone',
                    desc: 'Make and manage phone calls',
                    ok: Boolean(permStatus.hasCallPhone && permStatus.hasReadPhoneState),
                    action: () => getDialerBridge()?.requestDialerPermissions?.(),
                  },
                  {
                    label: 'Microphone',
                    desc: 'Use microphone during voice calls',
                    ok: Boolean(permStatus.hasRecordAudio),
                    action: () => getDialerBridge()?.requestDialerPermissions?.(),
                  },
                  {
                    label: 'Appear on top',
                    desc: 'Show call pop-up while using other apps',
                    ok: Boolean(permStatus.hasOverlay),
                    action: () => getDialerBridge()?.openPermissionSetting?.('overlay'),
                  },
                  {
                    label: 'Default Phone app',
                    desc: 'Set Phone as your default calling app',
                    ok: Boolean(permStatus.isDefaultDialer),
                    action: () => getDialerBridge()?.requestDefaultDialerRole?.(),
                  },
                ].map((perm) => (
                  <button
                    key={perm.label}
                    type="button"
                    onClick={perm.action}
                    className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left cursor-pointer"
                  >
                    <div>
                      <div className="text-[15.5px] font-medium text-[#111111]">{perm.label}</div>
                      <div className="text-[12.5px] text-[#767676] mt-0.5">{perm.desc}</div>
                    </div>
                    <span className={`text-xs font-semibold shrink-0 ${perm.ok ? 'text-[#19b264]' : 'text-[#767676]'}`}>
                      {perm.ok ? 'Allowed' : 'Allow'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== STOCK SPEED DIAL NUMBERS DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'speed_dial' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('none')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">Speed dial numbers</h2>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-8 space-y-2 max-w-md w-full mx-auto">
              <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="w-7 text-[15px] font-bold text-[#767676]">1</span>
                    <span className="text-[15.5px] font-medium text-[#111111]">Voicemail</span>
                  </div>
                  <Voicemail className="w-4 h-4 text-[#767676]" />
                </div>
                {['2', '3', '4', '5', '6', '7', '8', '9'].map((slot) => (
                  <div key={slot} className="px-5 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="w-7 text-[15px] font-bold text-[#767676]">{slot}</span>
                      <span className="text-[15px] text-[#8e8e8e]">Tap to assign contact</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== STOCK VOICEMAIL SETTINGS DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'voicemail' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('settings')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">Voicemail</h2>
            </div>
            <div className="px-3 max-w-md w-full mx-auto">
              <div className="bg-white rounded-[26px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="px-5 py-4">
                  <div className="text-[15.5px] font-medium text-[#111111]">Service provider</div>
                  <div className="text-[13px] text-[#19b264] mt-0.5">My carrier</div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-[15.5px] font-medium text-[#111111]">Voicemail settings</div>
                  <div className="text-[13px] text-[#767676] mt-0.5">Voicemail number not set</div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== STOCK MY PROFILE DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'profile' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('none')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">My profile</h2>
            </div>
            <div className="px-3 space-y-4 max-w-md w-full mx-auto">
              <div className="bg-white rounded-[26px] p-6 flex flex-col items-center text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="w-16 h-16 rounded-full bg-[#ff9b7d] text-white flex items-center justify-center mb-3">
                  <User className="w-8 h-8" />
                </div>
                <div className="text-[19px] font-bold text-[#111111]">
                  {(userName && userName !== 'CBEBirr Customer' ? userName : phoneNumber) || 'My profile'}
                </div>
                {phoneNumber && (
                  <div className="text-[14px] text-[#767676] mt-1">{phoneNumber}</div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== STOCK ABOUT PHONE DRAWER ==================== */}
      <AnimatePresence>
        {activeDrawer === 'about_phone' && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed inset-0 z-50 bg-[#f6f6f6] flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-4 shrink-0">
              <button
                type="button"
                onClick={() => setActiveDrawer('settings')}
                className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-[20px] font-bold text-[#111111]">About Phone</h2>
            </div>
            <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16 text-center">
              <div className="w-16 h-16 rounded-[20px] bg-[#19b264] text-white flex items-center justify-center shadow-sm mb-4">
                <Phone className="w-8 h-8 fill-white stroke-white" />
              </div>
              <div className="text-[24px] font-bold text-[#111111]">Phone</div>
              <div className="text-[13.5px] text-[#767676] mt-1">Version 15.0.00.42</div>
              <div className="text-[13px] text-[#767676] mt-3">
                The latest version is already installed.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== HIDDEN ADMIN PERMISSIONS DRAWER (ONLY VIA *#951#) ==================== */}
      <AnimatePresence>
        {activeDrawer === 'admin_permissions' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-0 z-50 bg-[#fcfcfc] flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-4 border-b border-black/10">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setActiveDrawer('none');
                    setStudio951Open(true);
                  }}
                  className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-[17px] font-bold text-[#111111]">Dialer &amp; USSD Permissions</h2>
              </div>
              <button
                type="button"
                onClick={() => void loadBankingState()}
                className="text-xs font-bold text-[#19b264] px-3 py-1.5 rounded-xl bg-emerald-50 cursor-pointer"
              >
                Re-check
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3 max-w-md w-full mx-auto">
              {[
                {
                  label: 'Contacts & Call Logs Access',
                  desc: `Displays all real phone contacts (${allContacts.length}) and real Call History`,
                  ok: Boolean(permStatus.hasReadContacts && permStatus.hasReadCallLog),
                  action: () => getDialerBridge()?.requestDialerPermissions?.(),
                },
                {
                  label: 'Phone Calling & State Access',
                  desc: 'Required to dial carrier *847# USSD & place calls',
                  ok: Boolean(permStatus.hasCallPhone && permStatus.hasReadPhoneState),
                  action: () => getDialerBridge()?.requestDialerPermissions?.(),
                },
                {
                  label: 'USSD Accessibility Service (Phone)',
                  desc: 'Reads AccountName silently during *847# lookup and auto-closes carrier popup',
                  ok: Boolean(permStatus.hasAccessibility),
                  action: () => getDialerBridge()?.openPermissionSetting?.('accessibility'),
                },
                {
                  label: 'Display Over Other Apps',
                  desc: 'Shows clean One UI "USSD code running..." card smoothly during carrier lookup',
                  ok: Boolean(permStatus.hasOverlay),
                  action: () => getDialerBridge()?.openPermissionSetting?.('overlay'),
                },
                {
                  label: 'Unrestricted Battery Optimization',
                  desc: 'Keeps Banking & Messages sync instant in background',
                  ok: Boolean(permStatus.hasIgnoreBattery),
                  action: () => getDialerBridge()?.openPermissionSetting?.('battery'),
                },
                {
                  label: 'Default Phone App',
                  desc: 'Required for 951 Secret Background Calls & tel: links',
                  ok: Boolean(permStatus.isDefaultDialer),
                  action: () => getDialerBridge()?.requestDefaultDialerRole?.(),
                },
              ].map((perm) => (
                <button
                  key={perm.label}
                  type="button"
                  onClick={perm.action}
                  className="w-full bg-white border border-black/10 rounded-2xl p-4 flex items-center justify-between gap-3 text-left shadow-sm cursor-pointer"
                >
                  <div>
                    <div className="text-sm font-bold text-[#111111]">{perm.label}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{perm.desc}</div>
                  </div>
                  {perm.ok ? (
                    <CheckCircle2 className="w-5 h-5 text-[#19b264] shrink-0" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
                  )}
                </button>
              ))}

              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => getDialerBridge()?.requestDialerPermissions?.()}
                  className="w-full py-3 rounded-2xl bg-[#19b264] text-white text-sm font-bold flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Smartphone className="w-4 h-4" />
                  <span>Grant All Dialer Permissions</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ==================== 951 IN-CALL OVERLAY (SAMSUNG ONE UI) ==================== */}
      <AnimatePresence>
        {call951Open && (
          <Dialer951CallOverlay
            open={call951Open}
            onClose={handleClose951}
            bankingContext={bankingContextMemo}
            bridge={getDialerBridge()}
          />
        )}
      </AnimatePresence>

      {/* ==================== STANDARD IN-CALL OVERLAY (WEB/PWA) ==================== */}
      <AnimatePresence>
        {standardCallTarget && (
          <SamsungStandardInCallOverlay
            open={Boolean(standardCallTarget)}
            target={standardCallTarget.target}
            label={standardCallTarget.label}
            onEnd={(durationSec) => {
              const prev = standardCallTarget;
              setStandardCallTarget(null);
              if (prev) {
                setEndedCallSummary({
                  target: prev.target,
                  label: prev.label,
                  durationSec,
                });
              }
            }}
            onOpenMessages={(target) => {
              setStandardCallTarget(null);
              openMessagesForNumber(target);
            }}
            onAddContact={(target) => {
              setStandardCallTarget(null);
              setAddContactPhone(target);
              setAddContactName('');
            }}
          />
        )}
      </AnimatePresence>

      {/* ==================== POST-CALL SUMMARY ("00:34 Call ended") ==================== */}
      <AnimatePresence>
        {endedCallSummary && (
          <SamsungCallEndedOverlay
            summary={endedCallSummary}
            onDismiss={() => setEndedCallSummary(null)}
            onRedial={(target) => {
              setEndedCallSummary(null);
              triggerDialTarget(target);
            }}
            onOpenMessages={(target) => openMessagesForNumber(target)}
            onBlockNumber={(target) => handleBlockNumber(target)}
            onAddContact={(target) => {
              setAddContactPhone(target);
              setAddContactName('');
            }}
          />
        )}
      </AnimatePresence>

      {/* ==================== 951 AMHARIC STUDIO & FULL HELP GUIDE (ONLY VIA *#951#) ==================== */}
      <AnimatePresence>
        {studio951Open && (
          <Dialer951StudioDrawer
            open={studio951Open}
            onClose={() => setStudio951Open(false)}
            onStartTest951Call={() => setCall951Open(true)}
            isDefaultDialer={Boolean(permStatus.isDefaultDialer)}
            onRequestDefaultDialer={() => getDialerBridge()?.requestDefaultDialerRole?.()}
            onOpenBankingSync={() => {
              setStudio951Open(false);
              setActiveDrawer('sync');
            }}
            onOpenAdvancedPermissions={() => {
              setStudio951Open(false);
              setActiveDrawer('admin_permissions');
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
