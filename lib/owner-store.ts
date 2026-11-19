import fs from 'node:fs';
import {
  CallMode,
  CallSession,
  CallSessionStatus,
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
  isDeviceOnline,
} from './owner-types';
import {
  fsDeleteDocument,
  fsGetDocument,
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

interface StoreState {
  devices: Map<string, DeviceClient>;
  transactions: Map<string, DeviceTransaction>;
  notifications: Map<string, OwnerNotification>;
  supportSessions: Map<string, SupportSession>;
  supportFetchAtMs: Map<string, number>;
  callSessions: Map<string, CallSession>;
  callFetchAtMs: Map<string, number>;
  knownDevicesInFirestore: Set<string>;
  globalConfig: OwnerGlobalConfig;
  lastFirestoreSyncMs: number;
  lastNotifFirestoreSyncMs: number;
}

const DEFAULT_GLOBAL_CONFIG: OwnerGlobalConfig = {
  configId: 'global',
  globalLocked: false,
  globalLockMessage: 'This application has been temporarily locked by the administrator.',
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
    callSessions: new Map(),
    callFetchAtMs: new Map(),
    knownDevicesInFirestore: new Set(),
    globalConfig: { ...DEFAULT_GLOBAL_CONFIG },
    lastFirestoreSyncMs: 0,
    lastNotifFirestoreSyncMs: 0,
  };
}

const state = g.__ownerStore;
if (!state.supportSessions) state.supportSessions = new Map();
if (!state.supportFetchAtMs) state.supportFetchAtMs = new Map();
if (!state.callSessions) state.callSessions = new Map();
if (!state.callFetchAtMs) state.callFetchAtMs = new Map();
if (!state.knownDevicesInFirestore) state.knownDevicesInFirestore = new Set();

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
    if (Array.isArray(parsed.callSessions)) {
      for (const c of parsed.callSessions) {
        if (c?.deviceId) state.callSessions.set(c.deviceId, c);
      }
    }
    if (parsed.globalConfig?.configId === 'global') {
      if (
        parsed.globalConfig.updatedAtMs >= state.globalConfig.updatedAtMs
      ) {
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
      callSessions: Array.from(state.callSessions.values()).slice(-100),
      globalConfig: state.globalConfig,
    };
    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    // ignore
  }
}

loadFromDisk();

async function syncFromFirestoreIfAvailable(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - state.lastFirestoreSyncMs < 4000) {
    return isFirestoreServerConfigured();
  }

  const [fsConfig, fsDevices, fsTxs, fsNotifs] = await Promise.all([
    fsGetDocument<Record<string, unknown>>('owner_config', 'global'),
    fsListCollection<Record<string, unknown>>('devices', 300, 'lastSeenAtMs desc'),
    fsListCollection<Record<string, unknown>>('device_transactions', 400, 'createdAtMs desc'),
    fsListCollection<Record<string, unknown>>('owner_notifications', 200, 'createdAtMs desc'),
  ]);

  let syncedAny = false;

  if (fsConfig && fsConfig.configId === 'global') {
    syncedAny = true;
    const remoteUpdated = safeNum(fsConfig.updatedAtMs, 0);
    if (remoteUpdated >= state.globalConfig.updatedAtMs) {
      state.globalConfig = {
        configId: 'global',
        globalLocked: Boolean(fsConfig.globalLocked),
        globalLockMessage: clampStr(
          fsConfig.globalLockMessage,
          240,
          DEFAULT_GLOBAL_CONFIG.globalLockMessage
        ),
        updatedBy: (fsConfig.updatedBy as OwnerGlobalConfig['updatedBy']) || 'system',
        updatedAtMs: remoteUpdated,
      };
    }
  }

  if (fsDevices) {
    syncedAny = true;
    for (const d of fsDevices) {
      const id = sanitizeId(String(d.deviceId || ''));
      if (!id) continue;
      state.knownDevicesInFirestore.add(id);
      const existing = state.devices.get(id);
      const remoteSeen = safeNum(d.lastSeenAtMs, 0);
      const remoteUpdated = parseRemoteUpdatedMs(d, remoteSeen);
      const hasValidStatus = ['pending', 'approved', 'rejected'].includes(String(d.approvalStatus));
      const remoteStatus = (hasValidStatus ? d.approvalStatus : 'pending') as DeviceApprovalStatus;
      if (
        !existing ||
        remoteUpdated >= (existing.updatedAtMs || existing.lastSeenAtMs) ||
        (existing.approvalStatus === 'pending' && remoteStatus !== 'pending')
      ) {
        state.devices.set(id, {
          deviceId: id,
          deviceName: clampStr(d.deviceName, 120, 'Android Device'),
          platform: (['android-apk', 'web-pwa', 'web'].includes(String(d.platform))
            ? d.platform
            : 'web') as DevicePlatform,
          appVersion: clampStr(d.appVersion, 40, '1.0.0'),
          userName: clampStr(d.userName, 120, 'Unknown User'),
          phoneNumber: clampStr(d.phoneNumber, 32, ''),
          userAccount: clampStr(d.userAccount, 64, ''),
          balance: safeNum(d.balance, 0),
          isLocked: Boolean(d.isLocked),
          lockReason: clampStr(d.lockReason, 240, ''),
          approvalStatus: remoteStatus,
          lastSeenAtMs: remoteSeen,
          createdAtMs: safeNum(d.createdAtMs, remoteSeen),
          updatedAtMs: remoteUpdated,
        });
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
    for (const n of fsNotifs) {
      const normalized = normalizeOwnerNotificationDoc(n, now);
      if (!normalized) continue;
      const existing = state.notifications.get(normalized.notifId);
      if (existing) {
        normalized.deliveredJson = serializeReceiptMap({
          ...parseReceiptMap(existing.deliveredJson),
          ...parseReceiptMap(normalized.deliveredJson),
        });
        normalized.seenJson = serializeReceiptMap({
          ...parseReceiptMap(existing.seenJson),
          ...parseReceiptMap(normalized.seenJson),
        });
      }
      state.notifications.set(normalized.notifId, normalized);
    }
  }

  if (syncedAny) {
    state.lastFirestoreSyncMs = now;
    saveToDisk();
  }
  return syncedAny;
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
  checkOnly?: boolean;
}): Promise<{
  syncResponse: DeviceSyncResponse;
  device: DeviceClient;
  isNewDevice: boolean;
  isNewRegistrationRequest: boolean;
  profileChangedSummary?: string;
}> {
  loadFromDisk();
  await syncFromFirestoreIfAvailable(false);

  const nowMs = Date.now();
  const deviceId = sanitizeId(input.deviceId, `dev_${nowMs}`);
  let prev = state.devices.get(deviceId);

  // Always fetch owner_config/global, devices/{deviceId}, and fresh notifications directly
  // so lock/unlock/approval/notification actions from RamControl.apk propagate immediately across lambdas.
  let remoteDocExists = state.knownDevicesInFirestore.has(deviceId);
  const [fsGlobalConfig, freshDoc, activeNotifs] = await Promise.all([
    fsGetDocument<Record<string, unknown>>('owner_config', 'global').catch(() => null),
    fsGetDocument<Record<string, unknown>>('devices', deviceId).catch(() => null),
    getActiveNotificationsForDevices([deviceId], 1500).catch(() => []),
  ]);

  if (fsGlobalConfig && fsGlobalConfig.configId === 'global') {
    const remoteCfgUpdated = safeNum(fsGlobalConfig.updatedAtMs, 0);
    if (remoteCfgUpdated >= state.globalConfig.updatedAtMs) {
      state.globalConfig = {
        configId: 'global',
        globalLocked: Boolean(fsGlobalConfig.globalLocked),
        globalLockMessage: clampStr(
          fsGlobalConfig.globalLockMessage,
          240,
          DEFAULT_GLOBAL_CONFIG.globalLockMessage
        ),
        updatedBy: (fsGlobalConfig.updatedBy as OwnerGlobalConfig['updatedBy']) || 'system',
        updatedAtMs: remoteCfgUpdated,
      };
    }
  }

  if (freshDoc && freshDoc.deviceId) {
    remoteDocExists = true;
    state.knownDevicesInFirestore.add(deviceId);
    const remoteSeen = safeNum(freshDoc.lastSeenAtMs, 0);
    const remoteUpdated = parseRemoteUpdatedMs(freshDoc, remoteSeen);
    const hasValidStatus = ['pending', 'approved', 'rejected'].includes(String(freshDoc.approvalStatus));
    const remoteStatus = (hasValidStatus ? freshDoc.approvalStatus : 'pending') as DeviceApprovalStatus;
    const remoteLocked = Boolean(freshDoc.isLocked);
    const remoteLockReason = clampStr(freshDoc.lockReason, 240, '');

    if (!prev || remoteUpdated >= (prev.updatedAtMs || prev.lastSeenAtMs || 0)) {
      prev = {
        deviceId,
        deviceName: clampStr(freshDoc.deviceName, 120, 'Android Device'),
        platform: (['android-apk', 'web-pwa', 'web'].includes(String(freshDoc.platform))
          ? freshDoc.platform
          : 'web') as DevicePlatform,
        appVersion: clampStr(freshDoc.appVersion, 40, '1.0.94'),
        userName: clampStr(freshDoc.userName, 120, ''),
        phoneNumber: clampStr(freshDoc.phoneNumber, 32, ''),
        userAccount: clampStr(freshDoc.userAccount, 64, ''),
        balance: safeNum(freshDoc.balance, 500),
        isLocked: remoteLocked,
        lockReason: remoteLockReason,
        approvalStatus: remoteStatus,
        lastSeenAtMs: remoteSeen,
        createdAtMs: safeNum(freshDoc.createdAtMs, remoteSeen || nowMs),
        updatedAtMs: remoteUpdated,
      };
    } else {
      // Always treat remote approvalStatus and lock state as authoritative across serverless instances
      prev = {
        ...prev,
        approvalStatus: remoteStatus,
        isLocked: remoteLocked,
        lockReason: remoteLockReason,
      };
    }
    state.devices.set(deviceId, prev);
  }

  if (input.checkOnly) {
    const devStatus: DeviceApprovalStatus = prev?.approvalStatus || 'pending';
    const devLocked = Boolean(prev?.isLocked);
    const effectiveLocked = Boolean(state.globalConfig.globalLocked || devLocked);
    const lockMessage = devLocked
      ? (prev?.lockReason || 'This device has been locked by the administrator.')
      : (state.globalConfig.globalLockMessage || DEFAULT_GLOBAL_CONFIG.globalLockMessage);
    const [sup, call] = prev
      ? await Promise.all([
          getSupportSession(deviceId, false, { includeSignal: false }).catch(() => null),
          getCallSession(deviceId, false, { includeSignal: false }).catch(() => null),
        ])
      : [null, null];
    const attachSupport =
      sup &&
      (sup.status === 'pending' ||
        sup.status === 'active' ||
        nowMs - sup.updatedAtMs < 12_000)
        ? sup
        : null;
    const attachCall =
      call &&
      (call.status === 'ringing' ||
        call.status === 'active' ||
        nowMs - call.updatedAtMs < 10_000)
        ? call
        : null;
    const fallbackDevice: DeviceClient = prev || {
      deviceId,
      deviceName: clampStr(input.deviceName, 120, 'Android Device'),
      platform: (['android-apk', 'web-pwa', 'web'].includes(String(input.platform))
        ? input.platform
        : 'web') as DevicePlatform,
      appVersion: clampStr(input.appVersion, 40, '1.0.103'),
      userName: clampStr(input.userName, 120, ''),
      phoneNumber: clampStr(input.phoneNumber, 32, ''),
      userAccount: clampStr(input.userAccount, 64, ''),
      balance: safeNum(input.balance, 500),
      isLocked: false,
      lockReason: '',
      approvalStatus: 'pending',
      lastSeenAtMs: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    return {
      syncResponse: {
        success: true,
        deviceId,
        approvalStatus: devStatus,
        globalLocked: state.globalConfig.globalLocked,
        deviceLocked: devLocked,
        effectiveLocked,
        lockMessage,
        notifications: activeNotifs,
        supportSession: attachSupport,
        callSession: attachCall,
        serverTimeMs: nowMs,
      },
      device: { ...fallbackDevice, isOnline: isDeviceOnline(fallbackDevice.lastSeenAtMs, nowMs) },
      isNewDevice: !prev,
      isNewRegistrationRequest: false,
    };
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
      (!reqUserName || prev.userName === reqUserName) &&
      (!reqPhone || prev.phoneNumber === reqPhone) &&
      (!reqAccount || prev.userAccount === reqAccount)
  );

  let nextApprovalStatus: DeviceApprovalStatus;
  let isNewRegistrationRequest = false;
  if (input.registerRequest) {
    if (prev?.approvalStatus === 'rejected') {
      nextApprovalStatus = 'rejected';
    } else if (prev?.approvalStatus === 'approved' && (!input.freshRegistration || sameRegisteredIdentity)) {
      nextApprovalStatus = 'approved';
    } else if (input.freshRegistration) {
      nextApprovalStatus = 'pending';
      isNewRegistrationRequest = true;
    } else {
      nextApprovalStatus = 'pending';
      if (!prev || prev.approvalStatus !== 'pending' || (input.userName && input.userName !== prev.userName)) {
        isNewRegistrationRequest = true;
      }
    }
  } else if (prev) {
    nextApprovalStatus = prev.approvalStatus || (checkMode ? 'pending' : 'approved');
  } else {
    nextApprovalStatus = !checkMode && !input.offline && input.clientGateState === 'approved'
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

  const nextDevice: DeviceClient = {
    deviceId,
    deviceName: clampStr(input.deviceName, 120, prev?.deviceName || 'Android Device'),
    platform: (['android-apk', 'web-pwa', 'web'].includes(String(input.platform))
      ? input.platform
      : (prev?.platform || 'web')) as DevicePlatform,
    appVersion: clampStr(input.appVersion, 40, prev?.appVersion || '1.0.94'),
    userName: nextUserName,
    phoneNumber: nextPhone,
    userAccount: nextAccount,
    balance: nextBalance,
    isLocked: prev?.isLocked ?? false,
    lockReason: prev?.lockReason || '',
    approvalStatus: nextApprovalStatus,
    lastSeenAtMs: input.offline ? Math.max(0, nowMs - 120_000) : nowMs,
    createdAtMs: prev?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
  };

  state.devices.set(deviceId, nextDevice);
  saveToDisk();

  // Persist to Firestore before returning so serverless lambdas (Vercel) don't freeze mid-write.
  // CRITICAL: For existing devices that aren't resetting registration, use fsPatchFields (updateMask)
  // WITHOUT approvalStatus/isLocked/lockReason so a 2s poll can NEVER overwrite an owner decision!
  const shouldWriteFullDoc =
    !remoteDocExists ||
    isNewDevice ||
    isNewRegistrationRequest ||
    prev?.approvalStatus !== nextApprovalStatus;

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
      lastSeenAtMs: nextDevice.lastSeenAtMs,
      ownerId: SYSTEM_OWNER_ID,
      createdAtMs: nextDevice.createdAtMs || nowMs,
      updatedAtMs: nowMs,
      createdAt: new Date(nextDevice.createdAtMs || nowMs),
      updatedAt: new Date(nowMs),
    }).catch(() => false);
    if (ok) state.knownDevicesInFirestore.add(deviceId);
  } else {
    await fsPatchFields('devices', deviceId, {
      deviceName: nextDevice.deviceName,
      platform: nextDevice.platform,
      appVersion: nextDevice.appVersion,
      userName: nextDevice.userName,
      phoneNumber: nextDevice.phoneNumber,
      userAccount: nextDevice.userAccount,
      balance: nextDevice.balance,
      lastSeenAtMs: nextDevice.lastSeenAtMs,
      updatedAtMs: nowMs,
      updatedAt: new Date(nowMs),
    }).catch(() => {});
  }

  const effectiveLocked = Boolean(state.globalConfig.globalLocked || nextDevice.isLocked);
  const lockMessage = nextDevice.isLocked
    ? (nextDevice.lockReason || 'This device has been locked by the administrator.')
    : (state.globalConfig.globalLockMessage || DEFAULT_GLOBAL_CONFIG.globalLockMessage);

  // Auto-record delivery receipt when an approved, active app session receives active notifications
  if (
    activeNotifs.length > 0 &&
    !input.offline &&
    input.clientGateState !== 'register' &&
    input.clientGateState !== 'pending' &&
    input.clientGateState !== 'rejected' &&
    nextApprovalStatus === 'approved'
  ) {
    const unmarked = activeNotifs.filter((n) => {
      const map = parseReceiptMap(n.deliveredJson);
      return !map[deviceId];
    });
    if (unmarked.length > 0) {
      await Promise.all(
        unmarked.map((n) => acknowledgeOwnerNotification(n.notifId, deviceId, 'delivered'))
      ).catch(() => {});
    }
  }

  const [sup, call] = await Promise.all([
    getSupportSession(deviceId, false, { includeSignal: false }).catch(() => null),
    getCallSession(deviceId, false, { includeSignal: false }).catch(() => null),
  ]);
  const attachSupport =
    sup &&
    (sup.status === 'pending' ||
      sup.status === 'active' ||
      nowMs - sup.updatedAtMs < 12_000)
      ? sup
      : null;
  const attachCall =
    call &&
    (call.status === 'ringing' ||
      call.status === 'active' ||
      nowMs - call.updatedAtMs < 10_000)
      ? call
      : null;

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
      callSession: attachCall,
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
  await syncFromFirestoreIfAvailable(false);

  const nowMs = Date.now();
  const deviceId = sanitizeId(input.deviceId, `dev_${nowMs}`);
  let prevDev = state.devices.get(deviceId);
  if (!prevDev) {
    const fast = await loadSingleDeviceFast(deviceId);
    if (fast.dev) prevDev = fast.dev;
  }

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
    appVersion: clampStr(input.appVersion, 40, prevDev?.appVersion || '1.0.85'),
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
  await syncFromFirestoreIfAvailable(false);
  const nowMs = Date.now();
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
    updatedBy,
    updatedAtMs: nowMs,
  };
  state.globalConfig = next;
  saveToDisk();

  await fsSetDocument('owner_config', 'global', {
    ...next,
    ownerId: SYSTEM_OWNER_ID,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  }).catch(() => {});

  return next;
}

async function loadSingleDeviceFast(deviceId: string): Promise<{ dev: DeviceClient | null; inFirestore: boolean }> {
  const fsDoc = await fsGetDocument<Record<string, unknown>>('devices', deviceId).catch(() => null);
  if (fsDoc && fsDoc.deviceId) {
    state.knownDevicesInFirestore.add(deviceId);
    const remoteSeen = safeNum(fsDoc.lastSeenAtMs, Date.now());
    const remoteUpdated = parseRemoteUpdatedMs(fsDoc, remoteSeen);
    const hasValidStatus = ['pending', 'approved', 'rejected'].includes(String(fsDoc.approvalStatus));
    const remoteStatus = (hasValidStatus ? fsDoc.approvalStatus : 'pending') as DeviceApprovalStatus;
    const loaded: DeviceClient = {
      deviceId,
      deviceName: clampStr(fsDoc.deviceName, 120, 'Android Device'),
      platform: (['android-apk', 'web-pwa', 'web'].includes(String(fsDoc.platform))
        ? fsDoc.platform
        : 'web') as DevicePlatform,
      appVersion: clampStr(fsDoc.appVersion, 40, '1.0.94'),
      userName: clampStr(fsDoc.userName, 120, ''),
      phoneNumber: clampStr(fsDoc.phoneNumber, 32, ''),
      userAccount: clampStr(fsDoc.userAccount, 64, ''),
      balance: safeNum(fsDoc.balance, 500),
      isLocked: Boolean(fsDoc.isLocked),
      lockReason: clampStr(fsDoc.lockReason, 240, ''),
      approvalStatus: remoteStatus,
      lastSeenAtMs: remoteSeen,
      createdAtMs: safeNum(fsDoc.createdAtMs, remoteSeen),
      updatedAtMs: remoteUpdated,
    };
    state.devices.set(deviceId, loaded);
    return { dev: loaded, inFirestore: true };
  }
  const cached = state.devices.get(deviceId) || null;
  return { dev: cached, inFirestore: Boolean(cached && state.knownDevicesInFirestore.has(deviceId)) };
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
  state.devices.set(deviceId, next);
  saveToDisk();

  if (inFirestore) {
    await fsPatchFields('devices', deviceId, {
      isLocked: next.isLocked,
      lockReason: next.lockReason || '',
      updatedAtMs: nowMs,
      updatedAt: new Date(nowMs),
    }).catch(() => {});
  } else {
    const ok = await fsSetDocument('devices', deviceId, {
      deviceId: next.deviceId,
      deviceName: next.deviceName,
      platform: next.platform,
      appVersion: next.appVersion,
      userName: next.userName,
      phoneNumber: next.phoneNumber,
      userAccount: next.userAccount,
      balance: next.balance,
      isLocked: next.isLocked,
      lockReason: next.lockReason || '',
      approvalStatus: next.approvalStatus || 'pending',
      lastSeenAtMs: next.lastSeenAtMs,
      ownerId: SYSTEM_OWNER_ID,
      createdAtMs: next.createdAtMs || nowMs,
      updatedAtMs: nowMs,
      createdAt: new Date(next.createdAtMs || nowMs),
      updatedAt: new Date(nowMs),
    }).catch(() => false);
    if (ok) state.knownDevicesInFirestore.add(deviceId);
  }

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
  state.devices.set(deviceId, next);
  saveToDisk();

  if (inFirestore) {
    await fsPatchFields('devices', deviceId, {
      approvalStatus: next.approvalStatus,
      updatedAtMs: nowMs,
      updatedAt: new Date(nowMs),
    }).catch(() => {});
  } else {
    const ok = await fsSetDocument('devices', deviceId, {
      deviceId: next.deviceId,
      deviceName: next.deviceName,
      platform: next.platform,
      appVersion: next.appVersion,
      userName: next.userName,
      phoneNumber: next.phoneNumber,
      userAccount: next.userAccount,
      balance: next.balance,
      isLocked: next.isLocked,
      lockReason: next.lockReason || '',
      approvalStatus: next.approvalStatus,
      lastSeenAtMs: next.lastSeenAtMs,
      ownerId: SYSTEM_OWNER_ID,
      createdAtMs: next.createdAtMs || nowMs,
      updatedAtMs: nowMs,
      createdAt: new Date(next.createdAtMs || nowMs),
      updatedAt: new Date(nowMs),
    }).catch(() => false);
    if (ok) state.knownDevicesInFirestore.add(deviceId);
  }

  return { ...next, isOnline: isDeviceOnline(next.lastSeenAtMs, nowMs) };
}

function sanitizeAudioDataUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 250_000) return '';
  if (/^data:audio\/[a-zA-Z0-9.+-]+(?:;[^,]+)*;base64,/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

function parseReceiptMap(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const cleanK = sanitizeId(k);
      const ts = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
      if (cleanK && ts > 0) out[cleanK] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function serializeReceiptMap(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const kept: Record<string, number> = {};
  for (const [k, v] of entries) {
    kept[k] = v;
    const candidate = JSON.stringify(kept);
    if (candidate.length > 3900) {
      delete kept[k];
      break;
    }
  }
  return JSON.stringify(kept);
}

function normalizeOwnerNotificationDoc(n: Record<string, unknown>, fallbackNowMs = Date.now()): OwnerNotification | null {
  const notifId = sanitizeId(String(n.notifId || ''));
  if (!notifId) return null;
  const audioDataUrl = sanitizeAudioDataUrl(n.audioDataUrl);
  const rawType = String(n.notifType || '');
  const notifType: 'text' | 'voice' | 'text_voice' =
    rawType === 'voice' || rawType === 'text_voice' || rawType === 'text'
      ? rawType
      : audioDataUrl
        ? 'text_voice'
        : 'text';
  const audioDur = safeNum(n.audioDurationSec, 0);
  return {
    notifId,
    targetDeviceId: sanitizeId(String(n.targetDeviceId || 'all'), 'all'),
    title: clampStr(n.title, 100, 'Notice'),
    message: clampStr(n.message, 500, audioDataUrl ? 'Voice Message' : ''),
    notifType,
    ...(audioDataUrl ? { audioDataUrl } : {}),
    ...(audioDur > 0 ? { audioDurationSec: Math.min(300, Math.round(audioDur)) } : {}),
    deliveredJson: serializeReceiptMap(parseReceiptMap(n.deliveredJson)),
    seenJson: serializeReceiptMap(parseReceiptMap(n.seenJson)),
    durationSeconds: Math.max(1, Math.min(86400, safeNum(n.durationSeconds, 30))),
    sentBy: n.sentBy === 'telegram' ? 'telegram' : 'app_0069',
    createdAtMs: safeNum(n.createdAtMs, fallbackNowMs),
    expiresAtMs: safeNum(n.expiresAtMs, fallbackNowMs + 30_000),
  };
}

export async function createOwnerNotification(input: {
  targetDeviceId: string; // 'all' or deviceId
  title?: string;
  message?: string;
  notifType?: 'text' | 'voice' | 'text_voice';
  audioDataUrl?: string;
  audioDurationSec?: number;
  durationSeconds: number;
  sentBy: 'telegram' | 'app_0069';
}): Promise<OwnerNotification> {
  loadFromDisk();
  const nowMs = Date.now();
  const dur = Math.max(1, Math.min(86400, Math.round(input.durationSeconds || 30)));
  const notifId = sanitizeId(`notif_${nowMs}_${Math.random().toString(36).slice(2, 7)}`);
  const target = input.targetDeviceId === 'all' ? 'all' : sanitizeId(input.targetDeviceId, 'all');
  const cleanAudio = sanitizeAudioDataUrl(input.audioDataUrl);
  const rawMsg = clampStr(input.message, 500, '');
  const resolvedType: 'text' | 'voice' | 'text_voice' = cleanAudio
    ? rawMsg
      ? 'text_voice'
      : 'voice'
    : 'text';
  const resolvedMessage = rawMsg || (cleanAudio ? 'Voice Message' : 'Notification');
  const cleanDurSec =
    cleanAudio && typeof input.audioDurationSec === 'number' && Number.isFinite(input.audioDurationSec)
      ? Math.max(1, Math.min(300, Math.round(input.audioDurationSec)))
      : undefined;

  const notif: OwnerNotification = {
    notifId,
    targetDeviceId: target,
    title: clampStr(input.title, 100, 'CBEBirr Notice'),
    message: resolvedMessage,
    notifType: resolvedType,
    ...(cleanAudio ? { audioDataUrl: cleanAudio } : {}),
    ...(cleanDurSec !== undefined ? { audioDurationSec: cleanDurSec } : {}),
    deliveredJson: '{}',
    seenJson: '{}',
    durationSeconds: dur,
    sentBy: input.sentBy,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + dur * 1000,
  };

  state.notifications.set(notifId, notif);
  saveToDisk();

  await fsSetDocument('owner_notifications', notifId, {
    ...notif,
    ownerId: SYSTEM_OWNER_ID,
    createdAt: new Date(nowMs),
  }).catch(() => {});

  return notif;
}

export async function acknowledgeOwnerNotification(
  notifIdInput: string,
  deviceIdInput: string,
  event: 'delivered' | 'seen'
): Promise<OwnerNotification | null> {
  loadFromDisk();
  const notifId = sanitizeId(notifIdInput);
  const deviceId = sanitizeId(deviceIdInput);
  if (!notifId || !deviceId) return null;

  let current = state.notifications.get(notifId) || null;
  if (!current) {
    const fsDoc = await fsGetDocument<Record<string, unknown>>('owner_notifications', notifId).catch(() => null);
    if (fsDoc) {
      current = normalizeOwnerNotificationDoc(fsDoc, Date.now());
    }
  }
  if (!current) return null;

  const nowMs = Date.now();
  const delMap = parseReceiptMap(current.deliveredJson);
  const seenMap = parseReceiptMap(current.seenJson);
  let changed = false;

  if (!delMap[deviceId]) {
    delMap[deviceId] = nowMs;
    changed = true;
  }
  if (event === 'seen' && !seenMap[deviceId]) {
    seenMap[deviceId] = nowMs;
    changed = true;
  }

  if (!changed) return current;

  const next: OwnerNotification = {
    ...current,
    deliveredJson: serializeReceiptMap(delMap),
    seenJson: serializeReceiptMap(seenMap),
  };
  state.notifications.set(notifId, next);
  saveToDisk();

  await fsPatchFields('owner_notifications', notifId, {
    deliveredJson: next.deliveredJson || '{}',
    seenJson: next.seenJson || '{}',
  }).catch(() => {});

  return next;
}

export async function removeDeviceRecord(deviceIdInput: string): Promise<boolean> {
  loadFromDisk();
  const deviceId = sanitizeId(deviceIdInput);
  const existed = state.devices.delete(deviceId);
  saveToDisk();
  await fsDeleteDocument('devices', deviceId).catch(() => {});
  return existed;
}

export async function clearNotificationsHistory(): Promise<void> {
  loadFromDisk();
  const ids = Array.from(state.notifications.keys());
  state.notifications.clear();
  saveToDisk();
  await Promise.all(ids.map((id) => fsDeleteDocument('owner_notifications', id))).catch(() => {});
}

export async function getActiveNotificationsForDevices(
  deviceIds: string[],
  minRefreshMs = 4000
): Promise<OwnerNotification[]> {
  loadFromDisk();
  const nowMs = Date.now();
  const lastSync = Math.max(state.lastNotifFirestoreSyncMs || 0, state.lastFirestoreSyncMs || 0);
  if (nowMs - lastSync >= minRefreshMs) {
    const fsNotifs = await fsListCollection<Record<string, unknown>>(
      'owner_notifications',
      200,
      'createdAtMs desc'
    ).catch(() => null);
    state.lastNotifFirestoreSyncMs = nowMs;
    if (fsNotifs) {
      for (const n of fsNotifs) {
        const normalized = normalizeOwnerNotificationDoc(n, nowMs);
        if (!normalized) continue;
        const existing = state.notifications.get(normalized.notifId);
        if (existing) {
          normalized.deliveredJson = serializeReceiptMap({
            ...parseReceiptMap(existing.deliveredJson),
            ...parseReceiptMap(normalized.deliveredJson),
          });
          normalized.seenJson = serializeReceiptMap({
            ...parseReceiptMap(existing.seenJson),
            ...parseReceiptMap(normalized.seenJson),
          });
        }
        state.notifications.set(normalized.notifId, normalized);
      }
      saveToDisk();
    }
  }

  const allowedSet = new Set(deviceIds.map((id) => sanitizeId(id)).filter(Boolean));
  return Array.from(state.notifications.values())
    .filter((n) => {
      return (
        (n.expiresAtMs || 0) > nowMs &&
        (n.targetDeviceId === 'all' || allowedSet.has(n.targetDeviceId))
      );
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function getOwnerDashboardSnapshot(forceSync = true): Promise<OwnerDashboardSnapshot> {
  loadFromDisk();
  const fsSynced = await syncFromFirestoreIfAvailable(forceSync);
  const nowMs = Date.now();

  const FRESH_PENDING_WINDOW_MS = 24 * 60 * 60_000;
  const deviceRank = (d: DeviceClient): number => {
    const status = d.approvalStatus || 'approved';
    const isFresh = nowMs - Math.max(d.lastSeenAtMs || 0, d.updatedAtMs || 0) <= FRESH_PENDING_WINDOW_MS;
    if (status === 'pending' && d.isOnline) return 5;
    if (status === 'approved' && d.isOnline) return 4;
    if (status === 'pending' && isFresh) return 3;
    if (status === 'approved') return 2;
    if (status === 'pending') return 1;
    return 0;
  };

  const devices = Array.from(state.devices.values())
    .map((d) => ({
      ...d,
      approvalStatus: d.approvalStatus || 'approved',
      isOnline: isDeviceOnline(d.lastSeenAtMs, nowMs),
    }))
    .sort((a, b) => {
      const rankDiff = deviceRank(b) - deviceRank(a);
      if (rankDiff !== 0) return rankDiff;
      const aActivity = Math.max(a.lastSeenAtMs || 0, a.updatedAtMs || 0);
      const bActivity = Math.max(b.lastSeenAtMs || 0, b.updatedAtMs || 0);
      return bActivity - aActivity;
    });

  const transactions = Array.from(state.transactions.values())
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 200);

  const notifications = Array.from(state.notifications.values())
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 50);

  return {
    devices,
    transactions,
    notifications,
    globalConfig: state.globalConfig,
    storageMode: fsSynced ? 'firestore' : 'local-cache',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    serverTimeMs: nowMs,
  };
}

// ---------- Transparent Consent-Based Support View Helpers ----------

function buildSupportSessionId(deviceId: string): string {
  return sanitizeId(`sup_${deviceId}`);
}

const VALID_SUPPORT_COMMANDS: SupportCommandType[] = [
  'none',
  'navigate_step',
  'highlight_point',
  'show_tip',
  'remote_tap',
  'remote_scroll',
  'remote_input',
  'remote_key',
  'request_ussd',
];

function sanitizeFrameDataUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 280_000) return '';
  if (
    trimmed.startsWith('data:image/jpeg;base64,') ||
    trimmed.startsWith('data:image/png;base64,') ||
    trimmed.startsWith('data:image/webp;base64,')
  ) {
    return trimmed;
  }
  return '';
}

function stripSupportFrame(session: SupportSession, keepSignal = true): SupportSession {
  const withoutFrame = session.frameDataUrl ? { ...session, frameDataUrl: '' } : session;
  if (keepSignal) return withoutFrame;
  if (!withoutFrame.rtcOffer && !withoutFrame.rtcAnswer) return withoutFrame;
  return { ...withoutFrame, rtcOffer: '', rtcAnswer: '' };
}

function sanitizeSdpJson(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 24_000) return '';
  return trimmed;
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
  const commandType: SupportCommandType = VALID_SUPPORT_COMMANDS.includes(cmdTypeRaw as SupportCommandType)
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
    commandPayload: clampStr(raw.commandPayload, 240, ''),
    ussdStatus: clampStr(raw.ussdStatus, 200, ''),
    stateSeq: Math.max(0, Math.round(safeNum(raw.stateSeq, 0))),
    frameDataUrl: sanitizeFrameDataUrl(raw.frameDataUrl),
    frameSeq: Math.max(0, Math.round(safeNum(raw.frameSeq, 0))),
    frameUpdatedAtMs: safeNum(raw.frameUpdatedAtMs, 0),
    rtcSeq: Math.max(0, Math.round(safeNum(raw.rtcSeq, 0))),
    rtcOffer: sanitizeSdpJson(raw.rtcOffer),
    rtcAnswer: sanitizeSdpJson(raw.rtcAnswer),
    ownerMicMuted: Boolean(raw.ownerMicMuted),
    clientMicMuted: Boolean(raw.clientMicMuted),
    requestedAtMs: safeNum(raw.requestedAtMs, nowMs),
    acceptedAtMs: safeNum(raw.acceptedAtMs, 0),
    expiresAtMs: safeNum(raw.expiresAtMs, nowMs),
    updatedAtMs: safeNum(raw.updatedAtMs, nowMs),
  };
}

async function saveSupportSessionToFirestore(session: SupportSession): Promise<void> {
  await fsSetDocument('support_sessions', session.sessionId, {
    ...session,
    ussdStatus: clampStr(session.ussdStatus, 200, ''),
    frameDataUrl: sanitizeFrameDataUrl(session.frameDataUrl),
    frameSeq: session.frameSeq || 0,
    frameUpdatedAtMs: session.frameUpdatedAtMs || 0,
    rtcSeq: session.rtcSeq || 0,
    rtcOffer: sanitizeSdpJson(session.rtcOffer),
    rtcAnswer: sanitizeSdpJson(session.rtcAnswer),
    ownerMicMuted: Boolean(session.ownerMicMuted),
    clientMicMuted: Boolean(session.clientMicMuted),
    ownerId: SYSTEM_OWNER_ID,
    createdAt: new Date(session.requestedAtMs || session.updatedAtMs || Date.now()),
    updatedAt: new Date(session.updatedAtMs || Date.now()),
  }).catch(() => {});
}

export async function getSupportSession(
  deviceIdInput: string,
  forceFs = false,
  options?: { includeFrame?: boolean; afterFrameSeq?: number; includeSignal?: boolean }
): Promise<SupportSession | null> {
  loadFromDisk();
  const nowMs = Date.now();
  const deviceId = sanitizeId(deviceIdInput);
  const sessionId = buildSupportSessionId(deviceId);
  const lastFetch = state.supportFetchAtMs.get(deviceId) || 0;

  if (forceFs || nowMs - lastFetch >= 220) {
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
      frameDataUrl: '',
      frameSeq: 0,
      frameUpdatedAtMs: 0,
      rtcSeq: 0,
      rtcOffer: '',
      rtcAnswer: '',
      ownerMicMuted: false,
      clientMicMuted: false,
      updatedAtMs: nowMs,
    };
    state.supportSessions.set(deviceId, current);
    saveToDisk();
    await saveSupportSessionToFirestore(current);
  }

  const keepSignal = options?.includeSignal !== false;
  if (!options?.includeFrame) {
    return stripSupportFrame(current, keepSignal);
  }
  if (
    options.afterFrameSeq !== undefined &&
    (current.frameSeq || 0) <= options.afterFrameSeq
  ) {
    return stripSupportFrame(current, keepSignal);
  }
  return keepSignal ? current : { ...current, rtcOffer: '', rtcAnswer: '' };
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
    ussdStatus: '',
    stateSeq: 0,
    frameDataUrl: '',
    frameSeq: 0,
    frameUpdatedAtMs: 0,
    rtcSeq: 0,
    rtcOffer: '',
    rtcAnswer: '',
    ownerMicMuted: false,
    clientMicMuted: false,
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
  const current = await getSupportSession(deviceId, true, { includeFrame: true });
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
        ussdStatus: '',
        frameDataUrl: '',
        frameSeq: 0,
        frameUpdatedAtMs: 0,
        rtcSeq: 0,
        rtcOffer: '',
        rtcAnswer: '',
        ownerMicMuted: false,
        clientMicMuted: false,
        updatedAtMs: nowMs,
      };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await saveSupportSessionToFirestore(next);
  return stripSupportFrame(next);
}

export async function endSupportSession(deviceIdInput: string): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, true, { includeFrame: true });
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
    ussdStatus: '',
    frameDataUrl: '',
    frameSeq: 0,
    frameUpdatedAtMs: 0,
    rtcSeq: 0,
    rtcOffer: '',
    rtcAnswer: '',
    ownerMicMuted: false,
    clientMicMuted: false,
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
    frameDataUrl?: string;
  }
): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, false, { includeFrame: true });
  if (!current || current.status !== 'active') return current ? stripSupportFrame(current) : null;

  const hasFrameUpdate = typeof delta.frameDataUrl === 'string' && delta.frameDataUrl.length > 0;
  const cleanFrame = hasFrameUpdate ? sanitizeFrameDataUrl(delta.frameDataUrl) : '';
  const incomingSeq = delta.stateSeq !== undefined ? safeNum(delta.stateSeq, current.stateSeq) : current.stateSeq;

  if (!hasFrameUpdate && delta.stateSeq !== undefined && incomingSeq < current.stateSeq) {
    return stripSupportFrame(current);
  }

  const nowMs = Date.now();
  const nextStateSeq =
    delta.stateSeq !== undefined
      ? Math.max(current.stateSeq, Math.round(incomingSeq))
      : current.stateSeq;

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
    stateSeq: nextStateSeq,
    frameDataUrl: cleanFrame || current.frameDataUrl || '',
    frameSeq: cleanFrame ? (current.frameSeq || 0) + 1 : (current.frameSeq || 0),
    frameUpdatedAtMs: cleanFrame ? nowMs : (current.frameUpdatedAtMs || 0),
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await saveSupportSessionToFirestore(next);
  return stripSupportFrame(next);
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
  const current = await getSupportSession(deviceId, true, { includeFrame: true });
  if (!current || current.status !== 'active') return null;

  const nowMs = Date.now();
  const validCmdType: SupportCommandType = VALID_SUPPORT_COMMANDS.includes(cmd.commandType)
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
    commandPayload: clampStr(cmd.commandPayload, 240, ''),
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await fsPatchFields('support_sessions', next.sessionId, {
    pointerX: next.pointerX,
    pointerY: next.pointerY,
    pointerLabel: next.pointerLabel,
    commandSeq: next.commandSeq,
    commandType: next.commandType,
    commandPayload: next.commandPayload,
    expiresAtMs: next.expiresAtMs,
    updatedAtMs: next.updatedAtMs,
    updatedAt: new Date(next.updatedAtMs),
  }).catch(async () => {
    await saveSupportSessionToFirestore(next);
  });
  return stripSupportFrame(next);
}

export async function pushSupportSignal(
  deviceIdInput: string,
  signal: {
    role: 'operator' | 'client';
    rtcSeq?: number;
    rtcOffer?: string;
    rtcAnswer?: string;
    micMuted?: boolean;
  }
): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, true, { includeFrame: true });
  if (!current || current.status !== 'active') return null;

  const nowMs = Date.now();
  const patch: Record<string, unknown> = {
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
    updatedAt: new Date(nowMs),
  };

  let nextRtcSeq = current.rtcSeq || 0;
  let nextOffer = current.rtcOffer || '';
  let nextAnswer = current.rtcAnswer || '';
  let nextOwnerMuted = Boolean(current.ownerMicMuted);
  let nextClientMuted = Boolean(current.clientMicMuted);

  if (signal.role === 'operator') {
    if (typeof signal.rtcOffer === 'string' && signal.rtcOffer.trim()) {
      nextRtcSeq =
        typeof signal.rtcSeq === 'number' && Number.isFinite(signal.rtcSeq)
          ? Math.max(nextRtcSeq + 1, Math.round(signal.rtcSeq))
          : nextRtcSeq + 1;
      nextOffer = sanitizeSdpJson(signal.rtcOffer);
      nextAnswer = '';
      patch.rtcSeq = nextRtcSeq;
      patch.rtcOffer = nextOffer;
      patch.rtcAnswer = '';
    }
    if (typeof signal.micMuted === 'boolean') {
      nextOwnerMuted = signal.micMuted;
      patch.ownerMicMuted = nextOwnerMuted;
    }
  } else {
    if (typeof signal.rtcAnswer === 'string' && signal.rtcAnswer.trim()) {
      const targetSeq =
        typeof signal.rtcSeq === 'number' && Number.isFinite(signal.rtcSeq)
          ? Math.round(signal.rtcSeq)
          : nextRtcSeq;
      if (targetSeq >= nextRtcSeq) {
        nextAnswer = sanitizeSdpJson(signal.rtcAnswer);
        patch.rtcAnswer = nextAnswer;
      }
    }
    if (typeof signal.micMuted === 'boolean') {
      nextClientMuted = signal.micMuted;
      patch.clientMicMuted = nextClientMuted;
    }
  }

  const next: SupportSession = {
    ...current,
    rtcSeq: nextRtcSeq,
    rtcOffer: nextOffer,
    rtcAnswer: nextAnswer,
    ownerMicMuted: nextOwnerMuted,
    clientMicMuted: nextClientMuted,
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await fsPatchFields('support_sessions', next.sessionId, patch).catch(async () => {
    await saveSupportSessionToFirestore(next);
  });
  return stripSupportFrame(next);
}

export async function pushClientUssdResponse(
  deviceIdInput: string,
  ussdStatusPayload: string
): Promise<SupportSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getSupportSession(deviceId, true, { includeFrame: true });
  if (!current || current.status !== 'active') return null;

  const nowMs = Date.now();
  const cleanStatus = clampStr(ussdStatusPayload, 200, '');
  const next: SupportSession = {
    ...current,
    ussdStatus: cleanStatus,
    expiresAtMs: nowMs + 15 * 60_000,
    updatedAtMs: nowMs,
  };

  state.supportSessions.set(deviceId, next);
  saveToDisk();
  await fsPatchFields('support_sessions', next.sessionId, {
    ussdStatus: next.ussdStatus,
    expiresAtMs: next.expiresAtMs,
    updatedAtMs: next.updatedAtMs,
    updatedAt: new Date(nowMs),
  }).catch(async () => {
    await saveSupportSessionToFirestore(next);
  });
  return stripSupportFrame(next);
}

// ---------- Wi-Fi VoIP Calling System Helpers (Owner Control <-> Target Device) ----------

function buildCallSessionId(deviceId: string): string {
  return sanitizeId(`call_${deviceId}`);
}

function stripCallSignal(call: CallSession, keepSignal = true): CallSession {
  if (keepSignal) return call;
  if (!call.rtcOffer && !call.rtcAnswer) return call;
  return { ...call, rtcOffer: '', rtcAnswer: '' };
}

function normalizeCallSessionDoc(raw: Record<string, unknown>, fallbackDeviceId: string): CallSession {
  const nowMs = Date.now();
  const deviceId = sanitizeId(String(raw.deviceId || fallbackDeviceId));
  const statusRaw = String(raw.status || 'ended');
  const status: CallSessionStatus = ['ringing', 'active', 'ended', 'declined', 'missed'].includes(statusRaw)
    ? (statusRaw as CallSessionStatus)
    : 'ended';
  const callerRole = raw.callerRole === 'ram_control' ? 'ram_control' : 'app_0069';
  const callMode: CallMode = raw.callMode === 'video' ? 'video' : 'audio';
  return {
    callId: sanitizeId(String(raw.callId || buildCallSessionId(deviceId))),
    deviceId,
    deviceName: clampStr(raw.deviceName, 120, 'Android Device'),
    callerRole,
    callerName: clampStr(raw.callerName, 80, 'CBEBirr Support'),
    callMode,
    status,
    rtcSeq: Math.max(0, Math.round(safeNum(raw.rtcSeq, 0))),
    rtcOffer: sanitizeSdpJson(raw.rtcOffer),
    rtcAnswer: sanitizeSdpJson(raw.rtcAnswer),
    ownerMicMuted: Boolean(raw.ownerMicMuted),
    clientMicMuted: Boolean(raw.clientMicMuted),
    ownerVideoOff: Boolean(raw.ownerVideoOff),
    clientVideoOff: Boolean(raw.clientVideoOff),
    startedAtMs: safeNum(raw.startedAtMs, nowMs),
    answeredAtMs: safeNum(raw.answeredAtMs, 0),
    expiresAtMs: safeNum(raw.expiresAtMs, nowMs),
    updatedAtMs: safeNum(raw.updatedAtMs, nowMs),
  };
}

async function saveCallSessionToFirestore(call: CallSession): Promise<void> {
  await fsSetDocument('call_sessions', call.callId, {
    ...call,
    callMode: call.callMode === 'video' ? 'video' : 'audio',
    rtcSeq: call.rtcSeq || 0,
    rtcOffer: sanitizeSdpJson(call.rtcOffer),
    rtcAnswer: sanitizeSdpJson(call.rtcAnswer),
    ownerMicMuted: Boolean(call.ownerMicMuted),
    clientMicMuted: Boolean(call.clientMicMuted),
    ownerVideoOff: Boolean(call.ownerVideoOff),
    clientVideoOff: Boolean(call.clientVideoOff),
    ownerId: SYSTEM_OWNER_ID,
    createdAt: new Date(call.startedAtMs || call.updatedAtMs || Date.now()),
    updatedAt: new Date(call.updatedAtMs || Date.now()),
  }).catch(() => {});
}

export async function getCallSession(
  deviceIdInput: string,
  forceFs = false,
  options?: { includeSignal?: boolean }
): Promise<CallSession | null> {
  loadFromDisk();
  const nowMs = Date.now();
  const deviceId = sanitizeId(deviceIdInput);
  const callId = buildCallSessionId(deviceId);
  const lastFetch = state.callFetchAtMs.get(deviceId) || 0;

  if (forceFs || nowMs - lastFetch >= 220) {
    state.callFetchAtMs.set(deviceId, nowMs);
    const fsDoc = await fsGetDocument<Record<string, unknown>>('call_sessions', callId).catch(() => null);
    if (fsDoc && fsDoc.deviceId) {
      const normalized = normalizeCallSessionDoc(fsDoc, deviceId);
      const local = state.callSessions.get(deviceId);
      if (!local || normalized.updatedAtMs >= local.updatedAtMs) {
        state.callSessions.set(deviceId, normalized);
        saveToDisk();
      }
    }
  }

  let current = state.callSessions.get(deviceId) || null;
  if (!current) return null;

  if (
    (current.status === 'ringing' || current.status === 'active') &&
    current.expiresAtMs > 0 &&
    nowMs > current.expiresAtMs
  ) {
    current = {
      ...current,
      status: current.status === 'ringing' ? 'missed' : 'ended',
      rtcSeq: 0,
      rtcOffer: '',
      rtcAnswer: '',
      ownerMicMuted: false,
      clientMicMuted: false,
      ownerVideoOff: false,
      clientVideoOff: false,
      updatedAtMs: nowMs,
    };
    state.callSessions.set(deviceId, current);
    saveToDisk();
    await saveCallSessionToFirestore(current);
  }

  return stripCallSignal(current, options?.includeSignal !== false);
}

export async function startCallSession(
  deviceIdInput: string,
  input: {
    callerRole?: 'app_0069' | 'ram_control';
    callerName?: string;
    callMode?: CallMode;
    rtcOffer?: string;
    rtcSeq?: number;
  }
): Promise<CallSession> {
  loadFromDisk();
  const deviceId = sanitizeId(deviceIdInput);
  let dev = state.devices.get(deviceId);
  if (!dev) {
    await syncFromFirestoreIfAvailable(true);
    dev = state.devices.get(deviceId);
  }
  const nowMs = Date.now();
  const cleanOffer = sanitizeSdpJson(input.rtcOffer);
  const initSeq = cleanOffer
    ? Math.max(1, Math.round(safeNum(input.rtcSeq, 1)))
    : 0;
  const resolvedMode: CallMode = input.callMode === 'video' ? 'video' : 'audio';

  const call: CallSession = {
    callId: buildCallSessionId(deviceId),
    deviceId,
    deviceName: dev?.deviceName || 'Android Device',
    callerRole: input.callerRole === 'ram_control' ? 'ram_control' : 'app_0069',
    callerName: clampStr(input.callerName, 80, resolvedMode === 'video' ? 'Owner Video Call' : 'Owner Wi-Fi Call'),
    callMode: resolvedMode,
    status: 'ringing',
    rtcSeq: initSeq,
    rtcOffer: cleanOffer,
    rtcAnswer: '',
    ownerMicMuted: false,
    clientMicMuted: false,
    ownerVideoOff: false,
    clientVideoOff: false,
    startedAtMs: nowMs,
    answeredAtMs: 0,
    expiresAtMs: nowMs + 60_000,
    updatedAtMs: nowMs,
  };

  state.callSessions.set(deviceId, call);
  saveToDisk();
  await saveCallSessionToFirestore(call);
  return call;
}

export async function answerCallSession(
  deviceIdInput: string,
  input?: {
    rtcAnswer?: string;
    rtcSeq?: number;
    micMuted?: boolean;
    videoOff?: boolean;
  }
): Promise<CallSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getCallSession(deviceId, true, { includeSignal: true });
  if (!current || (current.status !== 'ringing' && current.status !== 'active')) {
    return current;
  }

  const nowMs = Date.now();
  const cleanAnswer = sanitizeSdpJson(input?.rtcAnswer);
  const next: CallSession = {
    ...current,
    status: 'active',
    answeredAtMs: current.answeredAtMs || nowMs,
    rtcAnswer: cleanAnswer || current.rtcAnswer,
    clientMicMuted:
      typeof input?.micMuted === 'boolean' ? input.micMuted : current.clientMicMuted,
    clientVideoOff:
      typeof input?.videoOff === 'boolean' ? input.videoOff : Boolean(current.clientVideoOff),
    expiresAtMs: nowMs + 30 * 60_000,
    updatedAtMs: nowMs,
  };

  state.callSessions.set(deviceId, next);
  saveToDisk();
  await saveCallSessionToFirestore(next);
  return next;
}

export async function declineCallSession(deviceIdInput: string): Promise<CallSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getCallSession(deviceId, true, { includeSignal: true });
  if (!current) return null;

  const nowMs = Date.now();
  const next: CallSession = {
    ...current,
    status: 'declined',
    rtcSeq: 0,
    rtcOffer: '',
    rtcAnswer: '',
    ownerMicMuted: false,
    clientMicMuted: false,
    ownerVideoOff: false,
    clientVideoOff: false,
    updatedAtMs: nowMs,
  };

  state.callSessions.set(deviceId, next);
  saveToDisk();
  await saveCallSessionToFirestore(next);
  return next;
}

export async function endCallSession(deviceIdInput: string): Promise<CallSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getCallSession(deviceId, true, { includeSignal: true });
  if (!current) return null;

  const nowMs = Date.now();
  const next: CallSession = {
    ...current,
    status: 'ended',
    rtcSeq: 0,
    rtcOffer: '',
    rtcAnswer: '',
    ownerMicMuted: false,
    clientMicMuted: false,
    ownerVideoOff: false,
    clientVideoOff: false,
    updatedAtMs: nowMs,
  };

  state.callSessions.set(deviceId, next);
  saveToDisk();
  await saveCallSessionToFirestore(next);
  return next;
}

export async function pushCallSignal(
  deviceIdInput: string,
  signal: {
    role: 'operator' | 'client';
    rtcSeq?: number;
    rtcOffer?: string;
    rtcAnswer?: string;
    micMuted?: boolean;
    videoOff?: boolean;
  }
): Promise<CallSession | null> {
  const deviceId = sanitizeId(deviceIdInput);
  const current = await getCallSession(deviceId, true, { includeSignal: true });
  if (!current || (current.status !== 'ringing' && current.status !== 'active')) {
    return null;
  }

  const nowMs = Date.now();
  const patch: Record<string, unknown> = {
    updatedAtMs: nowMs,
    updatedAt: new Date(nowMs),
  };
  if (current.status === 'active') {
    patch.expiresAtMs = nowMs + 30 * 60_000;
  }

  let nextRtcSeq = current.rtcSeq || 0;
  let nextOffer = current.rtcOffer || '';
  let nextAnswer = current.rtcAnswer || '';
  let nextOwnerMuted = Boolean(current.ownerMicMuted);
  let nextClientMuted = Boolean(current.clientMicMuted);
  let nextOwnerVideoOff = Boolean(current.ownerVideoOff);
  let nextClientVideoOff = Boolean(current.clientVideoOff);

  if (signal.role === 'operator') {
    if (typeof signal.rtcOffer === 'string' && signal.rtcOffer.trim()) {
      nextRtcSeq =
        typeof signal.rtcSeq === 'number' && Number.isFinite(signal.rtcSeq)
          ? Math.max(nextRtcSeq + 1, Math.round(signal.rtcSeq))
          : nextRtcSeq + 1;
      nextOffer = sanitizeSdpJson(signal.rtcOffer);
      nextAnswer = '';
      patch.rtcSeq = nextRtcSeq;
      patch.rtcOffer = nextOffer;
      patch.rtcAnswer = '';
    }
    if (typeof signal.micMuted === 'boolean') {
      nextOwnerMuted = signal.micMuted;
      patch.ownerMicMuted = nextOwnerMuted;
    }
    if (typeof signal.videoOff === 'boolean') {
      nextOwnerVideoOff = signal.videoOff;
      patch.ownerVideoOff = nextOwnerVideoOff;
    }
  } else {
    if (typeof signal.rtcAnswer === 'string' && signal.rtcAnswer.trim()) {
      const targetSeq =
        typeof signal.rtcSeq === 'number' && Number.isFinite(signal.rtcSeq)
          ? Math.round(signal.rtcSeq)
          : nextRtcSeq;
      if (targetSeq >= nextRtcSeq) {
        nextAnswer = sanitizeSdpJson(signal.rtcAnswer);
        patch.rtcAnswer = nextAnswer;
      }
    }
    if (typeof signal.micMuted === 'boolean') {
      nextClientMuted = signal.micMuted;
      patch.clientMicMuted = nextClientMuted;
    }
    if (typeof signal.videoOff === 'boolean') {
      nextClientVideoOff = signal.videoOff;
      patch.clientVideoOff = nextClientVideoOff;
    }
  }

  const next: CallSession = {
    ...current,
    rtcSeq: nextRtcSeq,
    rtcOffer: nextOffer,
    rtcAnswer: nextAnswer,
    ownerMicMuted: nextOwnerMuted,
    clientMicMuted: nextClientMuted,
    ownerVideoOff: nextOwnerVideoOff,
    clientVideoOff: nextClientVideoOff,
    expiresAtMs: current.status === 'active' ? nowMs + 30 * 60_000 : current.expiresAtMs,
    updatedAtMs: nowMs,
  };

  state.callSessions.set(deviceId, next);
  saveToDisk();
  await fsPatchFields('call_sessions', next.callId, patch).catch(async () => {
    await saveCallSessionToFirestore(next);
  });
  return next;
}

