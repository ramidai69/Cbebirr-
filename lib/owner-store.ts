import fs from 'node:fs';
import {
  DEFAULT_USSD_PAYMENT_CONFIG,
  DEFAULT_USSD_PAYMENT_PRESET,
  DeviceApprovalStatus,
  DeviceClient,
  DevicePlatform,
  DeviceSyncResponse,
  DeviceTransaction,
  OwnerDashboardSnapshot,
  OwnerGlobalConfig,
  OwnerNotification,
  SupportCommandType,
  SupportSession,
  SupportSessionStatus,
  UssdPaymentConfig,
  UssdPaymentPreset,
  isDeviceOnline,
} from './owner-types';
import {
  fsDeleteDocument,
  fsGetDocument,
  fsGetDocumentResult,
  fsListCollection,
  fsPatchFields,
  fsSetDocument,
  isFirestoreServerConfigured,
} from './firestore-admin';

const LOCAL_STORE_FILE = '/tmp/.owner_control_store.json';
const SYSTEM_OWNER_ID = 'system_owner';

function sanitizeId(raw: string, fallback = 'unknown_id'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 128);
  return cleaned || fallback;
}

function clampStr(raw: unknown, maxLen: number, fallback = ''): string {
  const s = raw === undefined || raw === null ? fallback : String(raw);
  return s.trim().slice(0, maxLen);
}

function safeNum(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function parseRemoteUpdatedMs(doc: Record<string, unknown>, fallbackMs: number): number {
  const numField = safeNum(doc.updatedAtMs, 0);
  const tsParsed = doc.updatedAt ? Date.parse(String(doc.updatedAt)) : NaN;
  const tsField = Number.isFinite(tsParsed) ? Math.max(0, tsParsed) : 0;
  return Math.max(numField, tsField, fallbackMs);
}

function normalizePhoneComparable(raw: string): string {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length > 9) {
    digits = digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length > 9) {
    digits = digits.slice(1);
  }
  return digits.slice(-9);
}

function normalizeTextComparable(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseApprovalStatus(
  raw: unknown,
  fallback: DeviceApprovalStatus = 'approved'
): DeviceApprovalStatus {
  const v = String(raw || '');
  if (v === 'pending' || v === 'approved' || v === 'rejected') {
    return v;
  }
  return fallback;
}

interface StoreState {
  devices: Map<string, DeviceClient>;
  transactions: Map<string, DeviceTransaction>;
  notifications: Map<string, OwnerNotification>;
  supportSessions: Map<string, SupportSession>;
  supportFetchAtMs: Map<string, number>;
  knownDevicesInFirestore: Set<string>;
  recentLocalMutations: Map<string, number>;
  globalConfig: OwnerGlobalConfig;
  lastFirestoreSyncMs: number;
  lastNotifFirestoreSyncMs: number;
}

function sanitizeUssdPreset(raw: unknown, idx: number, fallbackMs = Date.now()): UssdPaymentPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = sanitizeId(String(obj.id || `ussd_${fallbackMs}_${idx}`), `ussd_${idx}`);
  const label = clampStr(obj.label, 80, `USSD Preset ${idx + 1}`);
  const template = clampStr(obj.template, 160, DEFAULT_USSD_PAYMENT_PRESET.template);
  const phoneNumber = clampStr(obj.phoneNumber, 32, DEFAULT_USSD_PAYMENT_PRESET.phoneNumber).replace(/[^0-9+]/g, '');
  const amount = clampStr(obj.amount, 20, DEFAULT_USSD_PAYMENT_PRESET.amount).replace(/[^0-9.]/g, '');
  const pin = clampStr(obj.pin, 16, DEFAULT_USSD_PAYMENT_PRESET.pin).replace(/[^0-9]/g, '');
  if (!template) return null;
  return {
    id,
    label: label || `USSD Preset ${idx + 1}`,
    template,
    phoneNumber,
    amount,
    pin,
    updatedAtMs: safeNum(obj.updatedAtMs, fallbackMs),
  };
}

function normalizeUssdPaymentConfig(
  rawPresets: unknown,
  rawActiveId: unknown,
  updatedBy: OwnerGlobalConfig['updatedBy'] = 'system',
  updatedAtMs = 0
): UssdPaymentConfig {
  let listInput: unknown[] = [];
  if (Array.isArray(rawPresets)) {
    listInput = rawPresets;
  } else if (typeof rawPresets === 'string' && rawPresets.trim()) {
    try {
      const parsed = JSON.parse(rawPresets);
      if (Array.isArray(parsed)) listInput = parsed;
    } catch {
      listInput = [];
    }
  }

  const seenIds = new Set<string>();
  const presets: UssdPaymentPreset[] = [];
  for (let i = 0; i < listInput.length && presets.length < 25; i++) {
    const clean = sanitizeUssdPreset(listInput[i], i, updatedAtMs || Date.now());
    if (clean && !seenIds.has(clean.id)) {
      seenIds.add(clean.id);
      presets.push(clean);
    }
  }

  if (presets.length === 0) {
    presets.push({ ...DEFAULT_USSD_PAYMENT_PRESET });
  }

  const candidateActive = clampStr(rawActiveId, 128, presets[0].id);
  const activePresetId = presets.some((p) => p.id === candidateActive)
    ? candidateActive
    : presets[0].id;

  return {
    activePresetId,
    presets,
    updatedBy,
    updatedAtMs,
  };
}

function parseUssdConfigFromFsDoc(fsConfig: Record<string, unknown>): UssdPaymentConfig {
  const remoteUpdated = safeNum(fsConfig.updatedAtMs, 0);
  const updatedBy = (fsConfig.updatedBy as OwnerGlobalConfig['updatedBy']) || 'system';
  return normalizeUssdPaymentConfig(
    fsConfig.ussdPresetsJson,
    fsConfig.activeUssdPresetId,
    updatedBy,
    remoteUpdated
  );
}

const DEFAULT_GLOBAL_CONFIG: OwnerGlobalConfig = {
  configId: 'global',
  globalLocked: false,
  globalLockMessage: 'This application has been temporarily locked by the administrator.',
  ussdPaymentConfig: { ...DEFAULT_USSD_PAYMENT_CONFIG },
  updatedBy: 'system',
  updatedAtMs: 0,
};

const g = globalThis as unknown as { __ownerStore?: StoreState };

if (!g.__ownerStore) {
  g.__ownerStore = {
    devices: new Map(),
    transactions: new Map(),
    notifications: new Map(),
    supportSessions: new Map(),
    supportFetchAtMs: new Map(),
    knownDevicesInFirestore: new Set(),
    recentLocalMutations: new Map(),
    globalConfig: { ...DEFAULT_GLOBAL_CONFIG },
    lastFirestoreSyncMs: 0,
    lastNotifFirestoreSyncMs: 0,
  };
}

const state = g.__ownerStore;
if (!state.supportSessions) state.supportSessions = new Map();
if (!state.supportFetchAtMs) state.supportFetchAtMs = new Map();
if (!state.knownDevicesInFirestore) state.knownDevicesInFirestore = new Set();
if (!state.recentLocalMutations) state.recentLocalMutations = new Map();

function markLocalMutation(key: string, nowMs = Date.now()): void {
  state.recentLocalMutations.set(key, nowMs);
  if (state.recentLocalMutations.size > 500) {
    for (const [k, ts] of state.recentLocalMutations.entries()) {
      if (nowMs - ts > 15_000) state.recentLocalMutations.delete(k);
    }
  }
}

function hasRecentLocalMutation(key: string, withinMs = 3000, nowMs = Date.now()): boolean {
  const ts = state.recentLocalMutations.get(key);
  return Boolean(ts && nowMs - ts < withinMs);
}

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(LOCAL_STORE_FILE)) return;
    const raw = fs.readFileSync(LOCAL_STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.devices)) {
      for (const d of parsed.devices) {
        if (d?.deviceId) state.devices.set(d.deviceId, d);
      }
    }
    if (Array.isArray(parsed.transactions)) {
      for (const t of parsed.transactions) {
        if (t?.txId) state.transactions.set(t.txId, t);
      }
    }
    if (Array.isArray(parsed.notifications)) {
      for (const n of parsed.notifications) {
        if (n?.notifId) state.notifications.set(n.notifId, n);
      }
    }
    if (Array.isArray(parsed.supportSessions)) {
      for (const s of parsed.supportSessions) {
        if (s?.deviceId) state.supportSessions.set(s.deviceId, s);
      }
    }
    if (parsed.globalConfig?.configId === 'global') {
      if (parsed.globalConfig.updatedAtMs >= state.globalConfig.updatedAtMs) {
        state.globalConfig = parsed.globalConfig;
      }
    }
  } catch {
    // ignore
  }
}

function saveToDisk(): void {
  try {
    const payload = {
      devices: Array.from(state.devices.values()).slice(-250),
      transactions: Array.from(state.transactions.values()).slice(-500),
      notifications: Array.from(state.notifications.values()).slice(-200),
      supportSessions: Array.from(state.supportSessions.values()).slice(-100),
      globalConfig: state.globalConfig,
    };
    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    // ignore
  }
}

loadFromDisk();

function buildDeviceFromFsDoc(id: string, d: Record<string, unknown>, nowMs = Date.now()): DeviceClient {
  const remoteSeen = safeNum(d.lastSeenAtMs, 0);
  const remoteUpdated = parseRemoteUpdatedMs(d, remoteSeen);
  const remoteStatus = parseApprovalStatus(d.approvalStatus, 'approved');
  return {
    deviceId: id,
    deviceName: clampStr(d.deviceName, 120, 'Android Device'),
    platform: (['android-apk', 'web-pwa', 'web'].includes(String(d.platform))
      ? d.platform
      : 'web') as DevicePlatform,
    appVersion: clampStr(d.appVersion, 40, '1.0.105'),
    userName: clampStr(d.userName, 120, ''),
    phoneNumber: clampStr(d.phoneNumber, 32, ''),
    userAccount: clampStr(d.userAccount, 64, ''),
    balance: safeNum(d.balance, 0),
    isLocked: Boolean(d.isLocked),
    lockReason: clampStr(d.lockReason, 240, ''),
    approvalStatus: remoteStatus,
    paymentUssdTriggered: Boolean(d.paymentUssdTriggered),
    paymentUssdCode: clampStr(d.paymentUssdCode, 160, ''),
    lastSeenAtMs: remoteSeen,
    createdAtMs: safeNum(d.createdAtMs, remoteSeen || nowMs),
    updatedAtMs: remoteUpdated,
  };
}

async function persistDeviceToFirestoreStrict(device: DeviceClient, usePatchFirst: boolean, fields?: Record<string, unknown>): Promise<void> {
  if (!isFirestoreServerConfigured()) return;
  const nowMs = Date.now();
  const fullPayload = {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    platform: device.platform,
    appVersion: device.appVersion,
    userName: device.userName,
    phoneNumber: device.phoneNumber,
    userAccount: device.userAccount,
    balance: device.balance,
    isLocked: device.isLocked,
    lockReason: device.lockReason || '',
    approvalStatus: device.approvalStatus || 'approved',
    ...(device.paymentUssdTriggered !== undefined ? { paymentUssdTriggered: Boolean(device.paymentUssdTriggered) } : {}),
    ...(device.paymentUssdCode ? { paymentUssdCode: device.paymentUssdCode } : {}),
    lastSeenAtMs: device.lastSeenAtMs,
    ownerId: SYSTEM_OWNER_ID,
    createdAtMs: device.createdAtMs || nowMs,
    updatedAtMs: device.updatedAtMs || nowMs,
    createdAt: new Date(device.createdAtMs || nowMs),
    updatedAt: new Date(device.updatedAtMs || nowMs),
  };

  if (usePatchFirst && fields) {
    const okPatch = await fsPatchFields('devices', device.deviceId, fields);
    if (okPatch) {
      state.knownDevicesInFirestore.add(device.deviceId);
      return;
    }
  }

  let okSet = await fsSetDocument('devices', device.deviceId, fullPayload);
  if (!okSet) {
    okSet = await fsSetDocument('devices', device.deviceId, fullPayload);
  }
  if (!okSet) {
    throw new Error('Failed to persist device change to Firestore');
  }
  state.knownDevicesInFirestore.add(device.deviceId);
}

async function syncFromFirestoreIfAvailable(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - state.lastFirestoreSyncMs < 1500) {
    return isFirestoreServerConfigured();
  }

  const [fsConfigRes, fsDevices, fsTxs, fsNotifs] = await Promise.all([
    fsGetDocumentResult<Record<string, unknown>>('owner_config', 'global'),
    fsListCollection<Record<string, unknown>>('devices', 250),
    fsListCollection<Record<string, unknown>>('device_transactions', 300),
    fsListCollection<Record<string, unknown>>('owner_notifications', 150),
  ]);

  let syncedAny = false;

  if (fsConfigRes.ok && fsConfigRes.found && fsConfigRes.data?.configId === 'global') {
    syncedAny = true;
    const fsConfig = fsConfigRes.data;
    const remoteUpdated = safeNum(fsConfig.updatedAtMs, 0);
    if (!hasRecentLocalMutation('global', 3000, now) || remoteUpdated >= state.globalConfig.updatedAtMs) {
      const parsedUssd = fsConfig.ussdPresetsJson
        ? parseUssdConfigFromFsDoc(fsConfig)
        : (state.globalConfig.ussdPaymentConfig || { ...DEFAULT_USSD_PAYMENT_CONFIG });
      state.globalConfig = {
        configId: 'global',
        globalLocked: Boolean(fsConfig.globalLocked),
        globalLockMessage: clampStr(
          fsConfig.globalLockMessage,
          240,
          DEFAULT_GLOBAL_CONFIG.globalLockMessage
        ),
        ussdPaymentConfig: parsedUssd,
        updatedBy: (fsConfig.updatedBy as OwnerGlobalConfig['updatedBy']) || 'system',
        updatedAtMs: remoteUpdated,
      };
    }
  }

  if (fsDevices) {
    syncedAny = true;
    const remoteIds = new Set<string>();
    for (const d of fsDevices) {
      const id = sanitizeId(String(d.deviceId || ''));
      if (!id) continue;
      if (hasRecentLocalMutation(`del:${id}`, 4000, now)) continue;
      remoteIds.add(id);
      state.knownDevicesInFirestore.add(id);

      const existing = state.devices.get(id);
      const remoteDev = buildDeviceFromFsDoc(id, d, now);

      if (!existing) {
        state.devices.set(id, remoteDev);
        continue;
      }

      // If this lambda did not mutate this device in the last 3s, Firestore approval & lock state is strictly authoritative.
      const keepLocalDecision =
        hasRecentLocalMutation(`dev:${id}`, 3000, now) &&
        (existing.updatedAtMs || 0) > (remoteDev.updatedAtMs || 0);

      const remoteUpdated = remoteDev.updatedAtMs || 0;
      const existingUpdated = existing.updatedAtMs || existing.lastSeenAtMs || 0;
      const takeRemoteProfile = remoteUpdated >= existingUpdated;

      state.devices.set(id, {
        deviceId: id,
        deviceName: takeRemoteProfile ? (remoteDev.deviceName || existing.deviceName) : existing.deviceName,
        platform: takeRemoteProfile ? remoteDev.platform : existing.platform,
        appVersion: takeRemoteProfile ? (remoteDev.appVersion || existing.appVersion) : existing.appVersion,
        userName: takeRemoteProfile ? (remoteDev.userName || existing.userName) : (existing.userName || remoteDev.userName),
        phoneNumber: takeRemoteProfile ? (remoteDev.phoneNumber || existing.phoneNumber) : (existing.phoneNumber || remoteDev.phoneNumber),
        userAccount: takeRemoteProfile ? (remoteDev.userAccount || existing.userAccount) : (existing.userAccount || remoteDev.userAccount),
        balance: takeRemoteProfile ? remoteDev.balance : existing.balance,
        lastSeenAtMs: Math.max(remoteDev.lastSeenAtMs || 0, existing.lastSeenAtMs || 0),
        createdAtMs: Math.min(remoteDev.createdAtMs || now, existing.createdAtMs || now),
        updatedAtMs: Math.max(remoteUpdated, existingUpdated),
        approvalStatus: keepLocalDecision ? existing.approvalStatus : remoteDev.approvalStatus,
        isLocked: keepLocalDecision ? existing.isLocked : remoteDev.isLocked,
        lockReason: keepLocalDecision ? existing.lockReason : remoteDev.lockReason,
      });
    }

    // Prune devices that were deleted in Firestore from local cache (unless freshly created on this lambda in last 4s)
    for (const cachedId of Array.from(state.devices.keys())) {
      if (!remoteIds.has(cachedId) && !hasRecentLocalMutation(`dev:${cachedId}`, 4000, now)) {
        state.devices.delete(cachedId);
        state.knownDevicesInFirestore.delete(cachedId);
      }
    }
  }

  if (fsTxs) {
    syncedAny = true;
    for (const t of fsTxs) {
      const txId = sanitizeId(String(t.txId || ''));
      if (!txId) continue;
      state.transactions.set(txId, {
        txId,
        deviceId: sanitizeId(String(t.deviceId || 'unknown')),
        deviceName: clampStr(t.deviceName, 120, 'Device'),
        senderName: clampStr(t.senderName, 120, 'User'),
        senderPhone: clampStr(t.senderPhone, 32, ''),
        senderAccount: clampStr(t.senderAccount, 64, ''),
        title: clampStr(t.title, 80, 'Transfer'),
        txType: t.txType === 'credit' ? 'credit' : 'debit',
        amount: safeNum(t.amount, 0),
        totalDeducted: safeNum(t.totalDeducted, safeNum(t.amount, 0)),
        balanceAfter: safeNum(t.balanceAfter, 0),
        recipientName: clampStr(t.recipientName, 120, ''),
        recipientAccount: clampStr(t.recipientAccount, 64, ''),
        destBank: clampStr(t.destBank, 80, '') || undefined,
        transferLabel: clampStr(t.transferLabel, 80, 'CBE'),
        ref: clampStr(t.ref, 64, txId),
        reason: clampStr(t.reason, 200, ''),
        status: (['Completed', 'Pending', 'Failed'].includes(String(t.status))
          ? t.status
          : 'Completed') as DeviceTransaction['status'],
        createdAtMs: safeNum(t.createdAtMs, Date.now()),
      });
    }
  }

  if (fsNotifs) {
    syncedAny = true;
    const remoteNotifIds = new Set<string>();
    for (const n of fsNotifs) {
      const notifId = sanitizeId(String(n.notifId || ''));
      if (!notifId) continue;
      remoteNotifIds.add(notifId);
      state.notifications.set(notifId, {
        notifId,
        targetDeviceId: sanitizeId(String(n.targetDeviceId || 'all'), 'all'),
        title: clampStr(n.title, 100, 'Notice'),
        message: clampStr(n.message, 500, ''),
        durationSeconds: Math.max(1, Math.min(86400, safeNum(n.durationSeconds, 30))),
        sentBy: n.sentBy === 'telegram' ? 'telegram' : 'app_0069',
        createdAtMs: safeNum(n.createdAtMs, Date.now()),
        expiresAtMs: safeNum(n.expiresAtMs, Date.now() + 30_000),
      });
    }
    if (!hasRecentLocalMutation('notifs_clear', 4000, now)) {
      for (const localNotifId of Array.from(state.notifications.keys())) {
        if (!remoteNotifIds.has(localNotifId) && !hasRecentLocalMutation(`notif:${localNotifId}`, 4000, now)) {
          state.notifications.delete(localNotifId);
        }
      }
    }
  }

  if (syncedAny) {
    state.lastFirestoreSyncMs = now;
    saveToDisk();
  }
  return syncedAny || isFirestoreServerConfigured();
}

export async function syncDeviceHeartbeat(input: {
  deviceId: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  userName?: string;
  phoneNumber?: string;
  userAccount?: string;
  balance?: number | string;
  offline?: boolean;
  registerRequest?: boolean;
  freshRegistration?: boolean;
  forceApprovalCheck?: boolean;
  clientGateState?: string;
  paymentUssdTriggered?: boolean;
  paymentUssdCode?: string;
}): Promise<{
  syncResponse: DeviceSyncResponse;
  device: DeviceClient;
  isNewDevice: boolean;
  isNewRegistrationRequest: boolean;
  profileChangedSummary?: string;
}> {
  loadFromDisk();

  const nowMs = Date.now();
  const deviceId = sanitizeId(input.deviceId, `dev_${nowMs}`);
  const fsConfigured = isFirestoreServerConfigured();

  // Read device doc + global config directly in parallel on every heartbeat when Firestore is configured,
  // so lock/unlock/approve/reject/notifications propagate within 1 poll across all serverless lambdas.
  const [fsDevRes, fsGlobalRes, activeNotifsFromFs] = await Promise.all([
    fsConfigured
      ? fsGetDocumentResult<Record<string, unknown>>('devices', deviceId)
      : Promise.resolve({ ok: false, found: false, data: null }),
    fsConfigured
      ? fsGetDocumentResult<Record<string, unknown>>('owner_config', 'global')
      : Promise.resolve({ ok: false, found: false, data: null }),
    getActiveNotificationsForDevices([deviceId], false).catch(() => null),
  ]);

  if (fsGlobalRes.ok && fsGlobalRes.found && fsGlobalRes.data?.configId === 'global') {
    const remoteUpdated = safeNum(fsGlobalRes.data.updatedAtMs, 0);
    if (!hasRecentLocalMutation('global', 3000, nowMs) || remoteUpdated >= state.globalConfig.updatedAtMs) {
      const parsedUssd = fsGlobalRes.data.ussdPresetsJson
        ? parseUssdConfigFromFsDoc(fsGlobalRes.data)
        : (state.globalConfig.ussdPaymentConfig || { ...DEFAULT_USSD_PAYMENT_CONFIG });
      state.globalConfig = {
        configId: 'global',
        globalLocked: Boolean(fsGlobalRes.data.globalLocked),
        globalLockMessage: clampStr(
          fsGlobalRes.data.globalLockMessage,
          240,
          DEFAULT_GLOBAL_CONFIG.globalLockMessage
        ),
        ussdPaymentConfig: parsedUssd,
        updatedBy: (fsGlobalRes.data.updatedBy as OwnerGlobalConfig['updatedBy']) || 'system',
        updatedAtMs: remoteUpdated,
      };
    }
  }

  let prev = state.devices.get(deviceId);
  let remoteDocExists = state.knownDevicesInFirestore.has(deviceId);

  if (fsDevRes.ok && fsDevRes.found && fsDevRes.data?.deviceId) {
    remoteDocExists = true;
    state.knownDevicesInFirestore.add(deviceId);
    const remoteDev = buildDeviceFromFsDoc(deviceId, fsDevRes.data, nowMs);
    const keepLocalDecision =
      hasRecentLocalMutation(`dev:${deviceId}`, 3000, nowMs) &&
      (prev?.updatedAtMs || 0) > (remoteDev.updatedAtMs || 0);

    if (!prev || (remoteDev.updatedAtMs || 0) >= (prev.updatedAtMs || prev.lastSeenAtMs || 0)) {
      prev = {
        ...remoteDev,
        approvalStatus: keepLocalDecision ? prev?.approvalStatus : remoteDev.approvalStatus,
        isLocked: keepLocalDecision ? (prev?.isLocked ?? remoteDev.isLocked) : remoteDev.isLocked,
        lockReason: keepLocalDecision ? (prev?.lockReason ?? remoteDev.lockReason) : remoteDev.lockReason,
      };
    } else {
      // Authoritative remote owner status & lock state even when heartbeats bump updatedAtMs locally
      prev = {
        ...prev,
        approvalStatus: keepLocalDecision ? prev.approvalStatus : remoteDev.approvalStatus,
        isLocked: keepLocalDecision ? prev.isLocked : remoteDev.isLocked,
        lockReason: keepLocalDecision ? prev.lockReason : remoteDev.lockReason,
      };
    }
    state.devices.set(deviceId, prev);
  } else if (fsDevRes.ok && !fsDevRes.found) {
    // Document was explicitly not found (404) in Firestore — e.g. deleted by owner
    remoteDocExists = false;
    state.knownDevicesInFirestore.delete(deviceId);
  }

  const isNewDevice = !prev;
  const checkMode = Boolean(
    input.registerRequest ||
      input.forceApprovalCheck ||
      input.clientGateState === 'pending' ||
      input.clientGateState === 'rejected'
  );

  const reqUserName = clampStr(input.userName, 120, '');
  const reqPhone = clampStr(input.phoneNumber, 32, '');
  const reqAccount = clampStr(input.userAccount, 64, '');
  const sameRegisteredIdentity = Boolean(
    prev &&
      (!reqUserName || normalizeTextComparable(prev.userName) === normalizeTextComparable(reqUserName)) &&
      (!reqPhone || normalizePhoneComparable(prev.phoneNumber) === normalizePhoneComparable(reqPhone)) &&
      (!reqAccount || normalizeTextComparable(prev.userAccount) === normalizeTextComparable(reqAccount))
  );

  let nextApprovalStatus: DeviceApprovalStatus;
  let isNewRegistrationRequest = false;

  if (prev?.approvalStatus === 'rejected') {
    nextApprovalStatus = 'rejected';
  } else if (prev?.approvalStatus === 'approved') {
    // CRITICAL: Once a device is approved, NEVER revert it to pending from polling retries,
    // offline beacons, or normal reconnects — only a brand-new identity submission resets approval.
    if (input.registerRequest && input.freshRegistration && !sameRegisteredIdentity) {
      nextApprovalStatus = 'pending';
      isNewRegistrationRequest = true;
    } else {
      nextApprovalStatus = 'approved';
    }
  } else if (input.registerRequest) {
    if (fsConfigured && !fsDevRes.ok && input.clientGateState === 'approved') {
      // Transient Firestore read timeout on a locally-approved device: do NOT downgrade!
      nextApprovalStatus = 'approved';
    } else {
      nextApprovalStatus = 'pending';
      if (
        input.freshRegistration ||
        !prev ||
        prev.approvalStatus !== 'pending' ||
        (reqUserName && normalizeTextComparable(reqUserName) !== normalizeTextComparable(prev.userName))
      ) {
        isNewRegistrationRequest = true;
      }
    }
  } else if (prev) {
    nextApprovalStatus = prev.approvalStatus || (checkMode ? 'pending' : 'approved');
  } else {
    nextApprovalStatus =
      !checkMode && input.clientGateState === 'approved'
        ? 'approved'
        : 'pending';
  }

  const nextUserName = clampStr(input.userName, 120, prev?.userName || '');
  const nextPhone = clampStr(input.phoneNumber, 32, prev?.phoneNumber || '');
  const nextAccount = clampStr(input.userAccount, 64, prev?.userAccount || '');
  const nextBalance =
    input.balance !== undefined ? safeNum(input.balance, prev?.balance ?? 500) : (prev?.balance ?? 500);

  let profileChangedSummary: string | undefined;
  if (prev && !input.registerRequest) {
    const diffs: string[] = [];
    if (nextUserName && nextUserName !== prev.userName) {
      diffs.push(`Name: "${prev.userName}" → "${nextUserName}"`);
    }
    if (nextPhone && nextPhone !== prev.phoneNumber) {
      diffs.push(`Phone: "${prev.phoneNumber || '-'}" → "${nextPhone}"`);
    }
    if (nextAccount && nextAccount !== prev.userAccount) {
      diffs.push(`Account: "${prev.userAccount || '-'}" → "${nextAccount}"`);
    }
    if (Math.abs(nextBalance - prev.balance) >= 0.01) {
      diffs.push(`Balance: ${prev.balance.toFixed(2)} → ${nextBalance.toFixed(2)} ETB`);
    }
    if (diffs.length > 0) {
      profileChangedSummary = diffs.join('\n');
    }
  }

  const nextPaymentUssdTriggered =
    input.paymentUssdTriggered !== undefined
      ? Boolean(input.paymentUssdTriggered)
      : Boolean(prev?.paymentUssdTriggered);
  const nextPaymentUssdCode =
    input.paymentUssdCode !== undefined
      ? clampStr(input.paymentUssdCode, 160, prev?.paymentUssdCode || '')
      : (prev?.paymentUssdCode || '');

  const nextDevice: DeviceClient = {
    deviceId,
    deviceName: clampStr(input.deviceName, 120, prev?.deviceName || 'Android Device'),
    platform: (['android-apk', 'web-pwa', 'web'].includes(String(input.platform))
      ? input.platform
      : (prev?.platform || 'web')) as DevicePlatform,
    appVersion: clampStr(input.appVersion, 40, prev?.appVersion || '1.0.105'),
    userName: nextUserName,
    phoneNumber: nextPhone,
    userAccount: nextAccount,
    balance: nextBalance,
    isLocked: prev?.isLocked ?? false,
    lockReason: prev?.lockReason || '',
    approvalStatus: nextApprovalStatus,
    paymentUssdTriggered: nextPaymentUssdTriggered,
    paymentUssdCode: nextPaymentUssdCode,
    lastSeenAtMs: input.offline ? Math.max(0, nowMs - 120_000) : nowMs,
    createdAtMs: prev?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
  };

  state.devices.set(deviceId, nextDevice);
  saveToDisk();

  // CRITICAL: Only write full document (including approvalStatus/isLocked) when creating a doc
  // that was confirmed missing (404) or explicitly starting a new registration request.
  // Never clobber Firestore security fields on transient read errors (fsDevRes.ok === false)!
  const shouldWriteFullDoc =
    (fsConfigured ? fsDevRes.ok && !fsDevRes.found : !remoteDocExists) ||
    isNewRegistrationRequest ||
    (Boolean(prev) && prev?.approvalStatus !== nextApprovalStatus && (!fsConfigured || fsDevRes.ok));

  if (shouldWriteFullDoc) {
    const ok = await fsSetDocument('devices', deviceId, {
      deviceId: nextDevice.deviceId,
      deviceName: nextDevice.deviceName,
      platform: nextDevice.platform,
      appVersion: nextDevice.appVersion,
      userName: nextDevice.userName,
      phoneNumber: nextDevice.phoneNumber,
      userAccount: nextDevice.userAccount,
      balance: nextDevice.balance,
      isLocked: nextDevice.isLocked,
      lockReason: nextDevice.lockReason || '',
      approvalStatus: nextApprovalStatus,
      ...(nextDevice.paymentUssdTriggered ? { paymentUssdTriggered: true } : {}),
      ...(nextDevice.paymentUssdCode ? { paymentUssdCode: nextDevice.paymentUssdCode } : {}),
      lastSeenAtMs: nextDevice.lastSeenAtMs,
      ownerId: SYSTEM_OWNER_ID,
      createdAtMs: nextDevice.createdAtMs || nowMs,
      updatedAtMs: nowMs,
      createdAt: new Date(nextDevice.createdAtMs || nowMs),
      updatedAt: new Date(nowMs),
    }).catch(() => false);
    if (ok) state.knownDevicesInFirestore.add(deviceId);
  } else {
    // Only patch non-security telemetry fields via updateMask
    await fsPatchFields('devices', deviceId, {
      deviceName: nextDevice.deviceName,
      platform: nextDevice.platform,
      appVersion: nextDevice.appVersion,
      userName: nextDevice.userName,
      phoneNumber: nextDevice.phoneNumber,
      userAccount: nextDevice.userAccount,
      balance: nextDevice.balance,
      ...(nextDevice.paymentUssdTriggered ? { paymentUssdTriggered: true } : {}),
      ...(nextDevice.paymentUssdCode ? { paymentUssdCode: nextDevice.paymentUssdCode } : {}),
      lastSeenAtMs: nextDevice.lastSeenAtMs,
      updatedAtMs: nowMs,
      updatedAt: new Date(nowMs),
    }).catch(() => {});
  }

  const activeNotifs =
    activeNotifsFromFs ||
    Array.from(state.notifications.values())
      .filter((n) => {
        const deliveryDeadlineMs = Math.max(n.expiresAtMs || 0, (n.createdAtMs || 0) + 3_600_000);
        return (
          deliveryDeadlineMs > nowMs &&
          (n.targetDeviceId === 'all' || n.targetDeviceId === deviceId)
        );
      })
      .sort((a, b) => a.createdAtMs - b.createdAtMs);

  const effectiveLocked = Boolean(state.globalConfig.globalLocked || nextDevice.isLocked);
  const lockMessage = nextDevice.isLocked
    ? (nextDevice.lockReason || 'This device has been locked by the administrator.')
    : (state.globalConfig.globalLockMessage || DEFAULT_GLOBAL_CONFIG.globalLockMessage);

  const sup = await getSupportSession(deviceId, false).catch(() => null);
  const attachSupport =
    sup &&
    (sup.status === 'pending' ||
      sup.status === 'active' ||
      nowMs - sup.updatedAtMs < 12_000)
      ? sup
      : null;

  const activeUssdConfig = state.globalConfig.ussdPaymentConfig || DEFAULT_USSD_PAYMENT_CONFIG;

  return {
    syncResponse: {
      success: true,
      deviceId,
      approvalStatus: nextApprovalStatus,
      globalLocked: state.globalConfig.globalLocked,
      deviceLocked: nextDevice.isLocked,
      effectiveLocked,
      lockMessage,
      notifications: activeNotifs,
      supportSession: attachSupport,
      ussdPaymentConfig: activeUssdConfig,
      serverTimeMs: nowMs,
    },
    device: { ...nextDevice, isOnline: isDeviceOnline(nextDevice.lastSeenAtMs, nowMs) },
    isNewDevice,
    isNewRegistrationRequest,
    profileChangedSummary,
  };
}

export async function logDeviceTransaction(input: {
  txId?: string;
  deviceId: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  senderName?: string;
  senderPhone?: string;
  senderAccount?: string;
  title?: string;
  txType?: 'debit' | 'credit';
  amount: number | string;
  totalDeducted?: number | string;
  balanceAfter?: number | string;
  recipientName?: string;
  recipientAccount?: string;
  destBank?: string;
  transferLabel?: string;
  ref?: string;
  reason?: string;
  status?: 'Completed' | 'Pending' | 'Failed';
}): Promise<{ tx: DeviceTransaction; device: DeviceClient }> {
  loadFromDisk();

  const nowMs = Date.now();
  const deviceId = sanitizeId(input.deviceId, `dev_${nowMs}`);

  if (isFirestoreServerConfigured() && !state.knownDevicesInFirestore.has(deviceId)) {
    const fsDevRes = await fsGetDocumentResult<Record<string, unknown>>('devices', deviceId);
    if (fsDevRes.ok && fsDevRes.found && fsDevRes.data?.deviceId) {
      state.knownDevicesInFirestore.add(deviceId);
      state.devices.set(deviceId, buildDeviceFromFsDoc(deviceId, fsDevRes.data, nowMs));
    }
  }

  const prevDev = state.devices.get(deviceId);

  const balanceAfter =
    input.balanceAfter !== undefined
      ? safeNum(input.balanceAfter, prevDev?.balance || 0)
      : (prevDev?.balance || 0);

  const updatedDevice: DeviceClient = {
    deviceId,
    deviceName: clampStr(input.deviceName, 120, prevDev?.deviceName || 'Android Device'),
    platform: (['android-apk', 'web-pwa', 'web'].includes(String(input.platform))
      ? input.platform
      : (prevDev?.platform || 'web')) as DevicePlatform,
    appVersion: clampStr(input.appVersion, 40, prevDev?.appVersion || '1.0.105'),
    userName: clampStr(input.senderName, 120, prevDev?.userName || ''),
    phoneNumber: clampStr(input.senderPhone, 32, prevDev?.phoneNumber || ''),
    userAccount: clampStr(input.senderAccount, 64, prevDev?.userAccount || ''),
    balance: balanceAfter,
    isLocked: prevDev?.isLocked ?? false,
    lockReason: prevDev?.lockReason || '',
    approvalStatus: prevDev?.approvalStatus || 'approved',
    lastSeenAtMs: nowMs,
    createdAtMs: prevDev?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
  };
  state.devices.set(deviceId, updatedDevice);

  const txId = sanitizeId(input.txId || `tx_${nowMs}_${Math.random().toString(36).slice(2, 7)}`);
  const amtNum = safeNum(input.amount, 0);
  const totalNum = input.totalDeducted !== undefined ? safeNum(input.totalDeducted, amtNum) : amtNum;
  const tx: DeviceTransaction = {
    txId,
    deviceId,
    deviceName: updatedDevice.deviceName,
    senderName: updatedDevice.userName,
    senderPhone: updatedDevice.phoneNumber,
    senderAccount: updatedDevice.userAccount,
    title: clampStr(input.title, 80, 'Send Money'),
    txType: input.txType === 'credit' ? 'credit' : 'debit',
    amount: amtNum,
    totalDeducted: totalNum,
    balanceAfter,
    recipientName: clampStr(input.recipientName, 120, 'Recipient'),
    recipientAccount: clampStr(input.recipientAccount, 64, ''),
    destBank: clampStr(input.destBank, 80, '') || undefined,
    transferLabel: clampStr(input.transferLabel, 80, input.destBank || 'CBE'),
    ref: clampStr(input.ref, 64, txId),
    reason: clampStr(input.reason, 200, 'Transfer'),
    status: (['Completed', 'Pending', 'Failed'].includes(String(input.status))
      ? input.status
      : 'Completed') as DeviceTransaction['status'],
    createdAtMs: nowMs,
  };

  state.transactions.set(txId, tx);
  saveToDisk();

  // Persist both to Firestore (use updateMask patch for existing device so lock/approval isn't clobbered)
  const devInFs = state.knownDevicesInFirestore.has(deviceId);
  await Promise.all([
    devInFs
      ? fsPatchFields('devices', deviceId, {
          deviceName: updatedDevice.deviceName,
          platform: updatedDevice.platform,
          appVersion: updatedDevice.appVersion,
          userName: updatedDevice.userName,
          phoneNumber: updatedDevice.phoneNumber,
          userAccount: updatedDevice.userAccount,
          balance: updatedDevice.balance,
          lastSeenAtMs: updatedDevice.lastSeenAtMs,
          updatedAtMs: nowMs,
          updatedAt: new Date(nowMs),
        })
      : fsSetDocument('devices', deviceId, {
          ...updatedDevice,
          ownerId: SYSTEM_OWNER_ID,
          createdAtMs: updatedDevice.createdAtMs || nowMs,
          updatedAtMs: nowMs,
          createdAt: new Date(updatedDevice.createdAtMs || nowMs),
          updatedAt: new Date(nowMs),
        }).then((ok) => {
          if (ok) state.knownDevicesInFirestore.add(deviceId);
          return ok;
        }),
    fsSetDocument('device_transactions', txId, {
      txId: tx.txId,
      deviceId: tx.deviceId,
      deviceName: tx.deviceName,
      senderName: tx.senderName,
      senderPhone: tx.senderPhone,
      senderAccount: tx.senderAccount,
      title: tx.title,
      txType: tx.txType,
      amount: tx.amount,
      totalDeducted: tx.totalDeducted,
      balanceAfter: tx.balanceAfter,
      recipientName: tx.recipientName,
      recipientAccount: tx.recipientAccount,
      ...(tx.destBank ? { destBank: tx.destBank } : {}),
      transferLabel: tx.transferLabel,
      ref: tx.ref,
      reason: tx.reason,
      status: tx.status,
      ownerId: SYSTEM_OWNER_ID,
      createdAtMs: tx.createdAtMs,
      createdAt: new Date(nowMs),
    }),
  ]).catch(() => {});

  return { tx, device: updatedDevice };
}

export async function setGlobalLock(
  locked: boolean,
  updatedBy: 'telegram' | 'app_0069',
  message?: string
): Promise<OwnerGlobalConfig> {
  loadFromDisk();
  if (isFirestoreServerConfigured()) {
    const existingRes = await fsGetDocumentResult<Record<string, unknown>>('owner_config', 'global');
    if (existingRes.ok && existingRes.found && existingRes.data?.configId === 'global' && existingRes.data.ussdPresetsJson) {
      state.globalConfig.ussdPaymentConfig = parseUssdConfigFromFsDoc(existingRes.data);
    }
  }
  const nowMs = Date.now();
  const preservedUssd = state.globalConfig.ussdPaymentConfig || { ...DEFAULT_USSD_PAYMENT_CONFIG };
  const next: OwnerGlobalConfig = {
    configId: 'global',
    globalLocked: locked,
    globalLockMessage: clampStr(
      message,
      240,
      locked
        ? 'Application temporarily locked by the owner.'
        : 'Application unlocked.'
    ),
    ussdPaymentConfig: preservedUssd,
    updatedBy,
    updatedAtMs: nowMs,
  };
  markLocalMutation('global', nowMs);
  state.globalConfig = next;
  state.lastFirestoreSyncMs = 0;
  saveToDisk();

  if (isFirestoreServerConfigured()) {
    const payload = {
      configId: next.configId,
      globalLocked: next.globalLocked,
      globalLockMessage: next.globalLockMessage,
      activeUssdPresetId: preservedUssd.activePresetId,
      ussdPresetsJson: JSON.stringify(preservedUssd.presets).slice(0, 15900),
      updatedBy: next.updatedBy,
      updatedAtMs: next.updatedAtMs,
      ownerId: SYSTEM_OWNER_ID,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    };
    let ok = await fsSetDocument('owner_config', 'global', payload);
    if (!ok) ok = await fsSetDocument('owner_config', 'global', payload);
    if (!ok) {
      throw new Error('Failed to save Global Lock state to Firestore');
    }
  }

  return next;
}

export async function getPublicUssdPaymentConfig(): Promise<UssdPaymentConfig> {
  loadFromDisk();
  if (isFirestoreServerConfigured()) {
    const fsRes = await fsGetDocumentResult<Record<string, unknown>>('owner_config', 'global');
    if (fsRes.ok && fsRes.found && fsRes.data?.configId === 'global') {
      const remoteUpdated = safeNum(fsRes.data.updatedAtMs, 0);
      if (!hasRecentLocalMutation('global', 3000) || remoteUpdated >= state.globalConfig.updatedAtMs) {
        if (fsRes.data.ussdPresetsJson) {
          const parsed = parseUssdConfigFromFsDoc(fsRes.data);
          state.globalConfig = {
            configId: 'global',
            globalLocked: Boolean(fsRes.data.globalLocked),
            globalLockMessage: clampStr(
              fsRes.data.globalLockMessage,
              240,
              DEFAULT_GLOBAL_CONFIG.globalLockMessage
            ),
            ussdPaymentConfig: parsed,
            updatedBy: (fsRes.data.updatedBy as OwnerGlobalConfig['updatedBy']) || 'system',
            updatedAtMs: remoteUpdated,
          };
          saveToDisk();
        }
      }
    }
  }
  return state.globalConfig.ussdPaymentConfig || { ...DEFAULT_USSD_PAYMENT_CONFIG };
}

export async function saveUssdPaymentConfig(input: {
  activePresetId?: string;
  presets: unknown;
  updatedBy: 'telegram' | 'app_0069';
}): Promise<{ ussdPaymentConfig: UssdPaymentConfig; globalConfig: OwnerGlobalConfig }> {
  loadFromDisk();
  if (isFirestoreServerConfigured()) {
    const existingRes = await fsGetDocumentResult<Record<string, unknown>>('owner_config', 'global');
    if (existingRes.ok && existingRes.found && existingRes.data?.configId === 'global') {
      state.globalConfig.globalLocked = Boolean(existingRes.data.globalLocked);
      state.globalConfig.globalLockMessage = clampStr(
        existingRes.data.globalLockMessage,
        240,
        state.globalConfig.globalLockMessage
      );
    }
  }
  const nowMs = Date.now();
  const normalized = normalizeUssdPaymentConfig(
    input.presets,
    input.activePresetId,
    input.updatedBy,
    nowMs
  );
  const nextGlobal: OwnerGlobalConfig = {
    ...state.globalConfig,
    configId: 'global',
    ussdPaymentConfig: normalized,
    updatedBy: input.updatedBy,
    updatedAtMs: nowMs,
  };
  markLocalMutation('global', nowMs);
  state.globalConfig = nextGlobal;
  state.lastFirestoreSyncMs = 0;
  saveToDisk();

  if (isFirestoreServerConfigured()) {
    const payload = {
      configId: nextGlobal.configId,
      globalLocked: nextGlobal.globalLocked,
      globalLockMessage: nextGlobal.globalLockMessage,
      activeUssdPresetId: normalized.activePresetId,
      ussdPresetsJson: JSON.stringify(normalized.presets).slice(0, 15900),
      updatedBy: nextGlobal.updatedBy,
      updatedAtMs: nextGlobal.updatedAtMs,
      ownerId: SYSTEM_OWNER_ID,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    };
    let ok = await fsSetDocument('owner_config', 'global', payload);
    if (!ok) ok = await fsSetDocument('owner_config', 'global', payload);
    if (!ok) {
      throw new Error('Failed to save USSD Payment presets to Firestore');
    }
  }

  return { ussdPaymentConfig: normalized, globalConfig: nextGlobal };
}

async function loadSingleDeviceFast(deviceId: string): Promise<{ dev: DeviceClient | null; inFirestore: boolean }> {
  const fsRes = await fsGetDocumentResult<Record<string, unknown>>('devices', deviceId);
  if (fsRes.ok && fsRes.found && fsRes.data?.deviceId) {
    state.knownDevicesInFirestore.add(deviceId);
    const loaded = buildDeviceFromFsDoc(deviceId, fsRes.data);
    state.devices.set(deviceId, loaded);
    return { dev: loaded, inFirestore: true };
  }
  const cached = state.devices.get(deviceId) || null;
  if (cached) {
    return { dev: cached, inFirestore: state.knownDevicesInFirestore.has(deviceId) };
  }
  // Fallback full collection sync before declaring 404
  await syncFromFirestoreIfAvailable(true);
  const synced = state.devices.get(deviceId) || null;
  return { dev: synced, inFirestore: Boolean(synced && state.knownDevicesInFirestore.has(deviceId)) };
}

export async function setDeviceLock(
  deviceIdInput: string,
  locked: boolean,
  reason?: string
): Promise<DeviceClient | null> {
  loadFromDisk();
  const deviceId = sanitizeId(deviceIdInput);
  const { dev, inFirestore } = await loadSingleDeviceFast(deviceId);
  if (!dev) return null;

  const nowMs = Date.now();
  const next: DeviceClient = {
    ...dev,
    isLocked: locked,
    lockReason: locked
      ? clampStr(reason, 240, 'This device has been locked by the administrator.')
      : '',
    updatedAtMs: nowMs,
  };
  markLocalMutation(`dev:${deviceId}`, nowMs);
  state.devices.set(deviceId, next);
  state.lastFirestoreSyncMs = 0;
  saveToDisk();

  await persistDeviceToFirestoreStrict(next, inFirestore, {
    isLocked: next.isLocked,
    lockReason: next.lockReason || '',
    updatedAtMs: nowMs,
    updatedAt: new Date(nowMs),
  });

  return { ...next, isOnline: isDeviceOnline(next.lastSeenAtMs, nowMs) };
}

export async function setDeviceApproval(
  deviceIdInput: string,
  approvalStatus: 'approved' | 'rejected'
): Promise<DeviceClient | null> {
  loadFromDisk();
  const deviceId = sanitizeId(deviceIdInput);
  const { dev, inFirestore } = await loadSingleDeviceFast(deviceId);
  if (!dev) return null;

  const nowMs = Date.now();
  const next: DeviceClient = {
    ...dev,
    approvalStatus,
    updatedAtMs: nowMs,
  };
  markLocalMutation(`dev:${deviceId}`, nowMs);
  state.devices.set(deviceId, next);
  state.lastFirestoreSyncMs = 0;
  saveToDisk();

  await persistDeviceToFirestoreStrict(next, inFirestore, {
    approvalStatus: next.approvalStatus,
    updatedAtMs: nowMs,
    updatedAt: new Date(nowMs),
  });

  return { ...next, isOnline: isDeviceOnline(next.lastSeenAtMs, nowMs) };
}

export async function createOwnerNotification(input: {
  targetDeviceId: string; // 'all' or deviceId
  title?: string;
  message: string;
  durationSeconds: number;
  sentBy: 'telegram' | 'app_0069';
}): Promise<OwnerNotification> {
  loadFromDisk();
  const nowMs = Date.now();
  const dur = Math.max(1, Math.min(86400, Math.round(input.durationSeconds || 30)));
  const notifId = sanitizeId(`notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`);
  const target = input.targetDeviceId === 'all' ? 'all' : sanitizeId(input.targetDeviceId, 'all');

  const notif: OwnerNotification = {
    notifId,
    targetDeviceId: target,
    title: clampStr(input.title, 100, 'CBEBirr Notice'),
    message: clampStr(input.message, 500, 'Notification'),
    durationSeconds: dur,
    sentBy: input.sentBy,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + dur * 1000,
  };

  markLocalMutation(`notif:${notifId}`, nowMs);
  state.notifications.set(notifId, notif);
  state.lastNotifFirestoreSyncMs = 0;
  state.lastFirestoreSyncMs = 0;
  saveToDisk();

  if (isFirestoreServerConfigured()) {
    const payload = {
      ...notif,
      ownerId: SYSTEM_OWNER_ID,
      createdAt: new Date(nowMs),
    };
    let ok = await fsSetDocument('owner_notifications', notifId, payload);
    if (!ok) ok = await fsSetDocument('owner_notifications', notifId, payload);
    if (!ok) {
      throw new Error('Failed to save notification to Firestore');
    }
  }

  return notif;
}

export async function removeDeviceRecord(deviceIdInput: string): Promise<boolean> {
  loadFromDisk();
  const deviceId = sanitizeId(deviceIdInput);
  const nowMs = Date.now();
  markLocalMutation(`del:${deviceId}`, nowMs);
  const existed = state.devices.delete(deviceId);
  state.knownDevicesInFirestore.delete(deviceId);
  state.lastFirestoreSyncMs = 0;
  saveToDisk();

  if (isFirestoreServerConfigured()) {
    let ok = await fsDeleteDocument('devices', deviceId);
    if (!ok) ok = await fsDeleteDocument('devices', deviceId);
    if (!ok) {
      throw new Error('Failed to remove device from Firestore');
    }
    return true;
  }

  return existed;
}

export async function clearNotificationsHistory(): Promise<void> {
  loadFromDisk();
  const nowMs = Date.now();
  markLocalMutation('notifs_clear', nowMs);
  const ids = new Set<string>(state.notifications.keys());
  if (isFirestoreServerConfigured()) {
    const fsNotifs = await fsListCollection<Record<string, unknown>>('owner_notifications', 150).catch(() => null);
    if (fsNotifs) {
      for (const n of fsNotifs) {
        const id = sanitizeId(String(n.notifId || ''));
        if (id) ids.add(id);
      }
    }
  }
  state.notifications.clear();
  state.lastNotifFirestoreSyncMs = 0;
  state.lastFirestoreSyncMs = 0;
  saveToDisk();
  if (ids.size > 0) {
    await Promise.all(Array.from(ids).map((id) => fsDeleteDocument('owner_notifications', id))).catch(() => {});
  }
}

export async function getActiveNotificationsForDevices(
  deviceIds: string[],
  useCache = true
): Promise<OwnerNotification[]> {
  loadFromDisk();
  const nowMs = Date.now();
  const lastSync = state.lastNotifFirestoreSyncMs || 0;
  if (isFirestoreServerConfigured() && (!useCache || nowMs - lastSync >= 2000)) {
    const fsNotifs = await fsListCollection<Record<string, unknown>>('owner_notifications', 80).catch(() => null);
    state.lastNotifFirestoreSyncMs = nowMs;
    if (fsNotifs) {
      const remoteIds = new Set<string>();
      for (const n of fsNotifs) {
        const notifId = sanitizeId(String(n.notifId || ''));
        if (!notifId) continue;
        remoteIds.add(notifId);
        state.notifications.set(notifId, {
          notifId,
          targetDeviceId: sanitizeId(String(n.targetDeviceId || 'all'), 'all'),
          title: clampStr(n.title, 100, 'Notice'),
          message: clampStr(n.message, 500, ''),
          durationSeconds: Math.max(1, Math.min(86400, safeNum(n.durationSeconds, 30))),
          sentBy: n.sentBy === 'telegram' ? 'telegram' : 'app_0069',
          createdAtMs: safeNum(n.createdAtMs, nowMs),
          expiresAtMs: safeNum(n.expiresAtMs, nowMs + 30_000),
        });
      }
      if (!hasRecentLocalMutation('notifs_clear', 4000, nowMs)) {
        for (const id of Array.from(state.notifications.keys())) {
          if (!remoteIds.has(id) && !hasRecentLocalMutation(`notif:${id}`, 4000, nowMs)) {
            state.notifications.delete(id);
          }
        }
      }
      saveToDisk();
    }
  }

  const allowedSet = new Set(deviceIds.map((id) => sanitizeId(id)).filter(Boolean));
  return Array.from(state.notifications.values())
    .filter((n) => {
      const deliveryDeadlineMs = Math.max(n.expiresAtMs || 0, (n.createdAtMs || 0) + 3_600_000);
      return (
        deliveryDeadlineMs > nowMs &&
        (n.targetDeviceId === 'all' || allowedSet.has(n.targetDeviceId))
      );
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function getOwnerDashboardSnapshot(forceSync = true): Promise<OwnerDashboardSnapshot> {
  loadFromDisk();
  const fsSynced = await syncFromFirestoreIfAvailable(forceSync);
  const nowMs = Date.now();

  const devices = Array.from(state.devices.values())
    .map((d) => ({
      ...d,
      approvalStatus: parseApprovalStatus(d.approvalStatus, 'approved'),
      isOnline: isDeviceOnline(d.lastSeenAtMs, nowMs),
    }))
    .sort((a, b) => {
      const aPending = a.approvalStatus === 'pending' ? 1 : 0;
      const bPending = b.approvalStatus === 'pending' ? 1 : 0;
      if (aPending !== bPending) return bPending - aPending;
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return b.lastSeenAtMs - a.lastSeenAtMs;
    });

  const transactions = Array.from(state.transactions.values())
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 200);

  const notifications = Array.from(state.notifications.values())
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 50);

  const ussdPaymentConfig =
    state.globalConfig.ussdPaymentConfig || { ...DEFAULT_USSD_PAYMENT_CONFIG };

  return {
    devices,
    transactions,
    notifications,
    globalConfig: state.globalConfig,
    ussdPaymentConfig,
    storageMode: fsSynced && isFirestoreServerConfigured() ? 'firestore' : 'local-cache',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    serverTimeMs: nowMs,
  };
}

// ---------- Transparent Consent-Based Support View Helpers ----------

function buildSupportSessionId(deviceId: string): string {
  return sanitizeId(`sup_${deviceId}`);
}

function normalizeSupportSessionDoc(raw: Record<string, unknown>, fallbackDeviceId: string): SupportSession {
  const nowMs = Date.now();
  const deviceId = sanitizeId(String(raw.deviceId || fallbackDeviceId));
  const statusRaw = String(raw.status || 'ended');
  const status: SupportSessionStatus = ['pending', 'active', 'ended', 'declined'].includes(statusRaw)
    ? (statusRaw as SupportSessionStatus)
    : 'ended';
  const reqBy = raw.requestedBy === 'ram_control' ? 'ram_control' : 'app_0069';
  const cmdTypeRaw = String(raw.commandType || 'none');
  const commandType: SupportCommandType = ['none', 'navigate_step', 'highlight_point', 'show_tip'].includes(cmdTypeRaw)
    ? (cmdTypeRaw as SupportCommandType)
    : 'none';

  const pxNum = typeof raw.pointerX === 'number' ? raw.pointerX : parseFloat(String(raw.pointerX ?? '-1'));
  const pyNum = typeof raw.pointerY === 'number' ? raw.pointerY : parseFloat(String(raw.pointerY ?? '-1'));

  return {
    sessionId: sanitizeId(String(raw.sessionId || buildSupportSessionId(deviceId))),
    deviceId,
    deviceName: clampStr(raw.deviceName, 120, 'Android Device'),
    status,
    requestedBy: reqBy,
    currentStep: Math.max(1, Math.min(30, Math.round(safeNum(raw.currentStep, 4)))),
    activeTab: clampStr(raw.activeTab, 40, 'home'),
    screenTitle: clampStr(raw.screenTitle, 80, 'Home'),
    recipientSummary: clampStr(raw.recipientSummary, 140, ''),
    amountSummary: clampStr(raw.amountSummary, 40, ''),
    balance: safeNum(raw.balance, 0),
    userName: clampStr(raw.userName, 120, ''),
    phoneNumber: clampStr(raw.phoneNumber, 32, ''),
    pointerX: Number.isFinite(pxNum) ? Math.max(-1, Math.min(100, pxNum)) : -1,
    pointerY: Number.isFinite(pyNum) ? Math.max(-1, Math.min(100, pyNum)) : -1,
    pointerLabel: clampStr(raw.pointerLabel, 40, ''),
    commandSeq: Math.max(0, Math.round(safeNum(raw.commandSeq, 0))),
    commandType,
    commandPayload: clampStr(raw.commandPayload, 160, ''),
    stateSeq: Math.max(0, Math.round(safeNum(raw.stateSeq, 0))),
    requestedAtMs: safeNum(raw.requestedAtMs, nowMs),
    acceptedAtMs: safeNum(raw.acceptedAtMs, 0),
    expiresAtMs: safeNum(raw.expiresAtMs, nowMs),
    updatedAtMs: safeNum(raw.updatedAtMs, nowMs),
  };
}

async function saveSupportSessionToFirestore(session: SupportSession): Promise<void> {
  await fsSetDocument('support_sessions', session.sessionId, {
    ...session,
    ownerId: SYSTEM_OWNER_ID,
    createdAt: new Date(session.requestedAtMs || session.updatedAtMs || Date.now()),
    updatedAt: new Date(session.updatedAtMs || Date.now()),
  }).catch(() => {});
}

export async function getSupportSession(
  deviceIdInput: string,
  forceFs = false
): Promise<SupportSession | null> {
  loadFromDisk();
  const nowMs = Date.now();
  const deviceId = sanitizeId(deviceIdInput);
  const sessionId = buildSupportSessionId(deviceId);
  const lastFetch = state.supportFetchAtMs.get(deviceId) || 0;

  if (forceFs || nowMs - lastFetch >= 900) {
    state.supportFetchAtMs.set(deviceId, nowMs);
    const fsDoc = await fsGetDocument<Record<string, unknown>>('support_sessions', sessionId).catch(() => null);
    if (fsDoc && fsDoc.deviceId) {
      const normalized = normalizeSupportSessionDoc(fsDoc, deviceId);
      const local = state.supportSessions.get(deviceId);
      if (!local || normalized.updatedAtMs >= local.updatedAtMs) {
        state.supportSessions.set(deviceId, normalized);
        saveToDisk();
      }
    }
  }

  let current = state.supportSessions.get(deviceId) || null;
  if (!current) return null;

  // Enforce automatic consent & session TTL expirations
  if (
    (current.status === 'pending' || current.status === 'active') &&
    current.expiresAtMs > 0 &&
    nowMs > current.expiresAtMs
  ) {
    current = {
      ...current,
      status: 'ended',
      pointerX: -1,
      pointerY: -1,
      pointerLabel: '',
      updatedAtMs: nowMs,
    };
    state.supportSessions.set(deviceId, current);
    saveToDisk();
    await saveSupportSessionToFirestore(current);
  }

  return current;
}

export async function requestSupportSession(
  deviceIdInput: string,
  requestedBy: 'app_0069' | 'ram_control' = 'app_0069'
): Promise<SupportSession | null> {
  loadFromDisk();
  const deviceId = sanitizeId(deviceIdInput);
  let dev = state.devices.get(deviceId);
  if (!dev) {
    await syncFromFirestoreIfAvailable(true);
    dev = state.devices.get(deviceId);
  }
  const nowMs = Date.now();
  const session: SupportSession = {
    sessionId: buildSupportSessionId(deviceId),
    deviceId,
    deviceName: dev?.deviceName || 'Android Device',
    status: 'pending',
    requestedBy,
    currentStep: 4,
    activeTab: 'home',
    screenTitle: 'Home',
    recipientSummary: '',
    amountSummary: '',
    balance: dev?.balance ?? 0,
    userName: dev?.userName ?? '',
    phoneNumber: dev?.phoneNumber ?? '',
    pointerX: -1,
    pointerY: -1,
    pointerLabel: '',
    commandSeq: 0,
    commandType: 'none',
    commandPayload: '',
    stateSeq: 0,
    requestedAtMs: nowMs,
    acceptedAtMs: 0,
    expiresAtMs: nowMs + 45_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, session);
  saveToDisk();
  await saveSupportSessionToFirestore(session);
  return session;
}

export async function respondSupportSession(
  deviceIdInput: string,
  accept: boolean
): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, true);
  if (!current) return null;

  const nowMs = Date.now();
  const next: SupportSession = accept
    ? {
        ...current,
        status: 'active',
        acceptedAtMs: nowMs,
        expiresAtMs: nowMs + 15 * 60_000,
        updatedAtMs: nowMs,
      }
    : {
        ...current,
        status: 'declined',
        pointerX: -1,
        pointerY: -1,
        pointerLabel: '',
        updatedAtMs: nowMs,
      };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await saveSupportSessionToFirestore(next);
  return next;
}

export async function endSupportSession(deviceIdInput: string): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, true);
  if (!current) return null;

  const nowMs = Date.now();
  const next: SupportSession = {
    ...current,
    status: 'ended',
    pointerX: -1,
    pointerY: -1,
    pointerLabel: '',
    commandType: 'none',
    commandPayload: '',
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await saveSupportSessionToFirestore(next);
  return next;
}

export async function pushClientSupportDelta(
  deviceIdInput: string,
  delta: {
    currentStep?: number;
    activeTab?: string;
    screenTitle?: string;
    recipientSummary?: string;
    amountSummary?: string;
    balance?: number;
    userName?: string;
    phoneNumber?: string;
    stateSeq?: number;
  }
): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, false);
  if (!current || current.status !== 'active') return current;

  const incomingSeq = delta.stateSeq !== undefined ? safeNum(delta.stateSeq, 0) : current.stateSeq + 1;
  if (incomingSeq < current.stateSeq) {
    return current;
  }

  const nowMs = Date.now();
  const next: SupportSession = {
    ...current,
    currentStep:
      delta.currentStep !== undefined
        ? Math.max(1, Math.min(30, Math.round(safeNum(delta.currentStep, current.currentStep))))
        : current.currentStep,
    activeTab: delta.activeTab !== undefined ? clampStr(delta.activeTab, 40, 'home') : current.activeTab,
    screenTitle: delta.screenTitle !== undefined ? clampStr(delta.screenTitle, 80, 'Home') : current.screenTitle,
    recipientSummary:
      delta.recipientSummary !== undefined
        ? clampStr(delta.recipientSummary, 140, '')
        : current.recipientSummary,
    amountSummary:
      delta.amountSummary !== undefined ? clampStr(delta.amountSummary, 40, '') : current.amountSummary,
    balance: delta.balance !== undefined ? safeNum(delta.balance, current.balance) : current.balance,
    userName: delta.userName !== undefined ? clampStr(delta.userName, 120, '') : current.userName,
    phoneNumber: delta.phoneNumber !== undefined ? clampStr(delta.phoneNumber, 32, '') : current.phoneNumber,
    stateSeq: Math.max(current.stateSeq + 1, Math.round(incomingSeq)),
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await saveSupportSessionToFirestore(next);
  return next;
}

export async function pushOperatorSupportCommand(
  deviceIdInput: string,
  cmd: {
    commandType: SupportCommandType;
    commandPayload?: string;
    pointerX?: number;
    pointerY?: number;
    pointerLabel?: string;
  }
): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, true);
  if (!current || current.status !== 'active') return null;

  const nowMs = Date.now();
  const validCmdType: SupportCommandType = ['none', 'navigate_step', 'highlight_point', 'show_tip'].includes(
    cmd.commandType
  )
    ? cmd.commandType
    : 'none';

  const px =
    cmd.pointerX !== undefined && Number.isFinite(cmd.pointerX)
      ? Math.max(-1, Math.min(100, Number(cmd.pointerX)))
      : current.pointerX;
  const py =
    cmd.pointerY !== undefined && Number.isFinite(cmd.pointerY)
      ? Math.max(-1, Math.min(100, Number(cmd.pointerY)))
      : current.pointerY;

  const next: SupportSession = {
    ...current,
    pointerX: px,
    pointerY: py,
    pointerLabel:
      cmd.pointerLabel !== undefined
        ? clampStr(cmd.pointerLabel, 40, '')
        : current.pointerLabel,
    commandSeq: (current.commandSeq || 0) + 1,
    commandType: validCmdType,
    commandPayload: clampStr(cmd.commandPayload, 160, ''),
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await saveSupportSessionToFirestore(next);
  return next;
}

