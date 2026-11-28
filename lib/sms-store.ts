import fs from 'fs';
import path from 'path';
import { getReceipt, saveReceipt, StoredReceipt } from './receipt-store';
import { formatCbeDateTime, repairTransferLabelInSmsText, resolveDestBankName } from './sms-webhook';
import {
  fsDeleteDocument,
  fsListCollection,
  fsSetDocument,
  isFirestoreServerConfigured,
} from './firestore-admin';

import {
  SmsMessage,
  ConversationSummary,
  MASTER_API_KEY,
  BANK_API_KEYS,
} from './sms-types';

export type { SmsMessage, ConversationSummary };
export { MASTER_API_KEY, BANK_API_KEYS };

const SMS_STORE_FILE = path.join(process.cwd(), '.sms_store.json');
const TMP_SMS_STORE_FILE = '/tmp/.sms_store.json';
const SMS_COLLECTION = 'sms_messages';
const SYSTEM_OWNER_ID = 'system_owner';
const FIRESTORE_SYNC_TTL_MS = 4000;

const RESERVED_SHARED_DEVICE_IDS = new Set([
  'all',
  'dev_galaxy_a12',
  'unknown',
  'unknown_id',
  'unknown_device',
  'dev_server',
  'dev_browser_tmp',
]);

export function isValidServerDeviceId(id?: string | null): boolean {
  if (!id || typeof id !== 'string') return false;
  const clean = id.trim();
  if (!/^[a-zA-Z0-9_\-]{6,128}$/.test(clean)) return false;
  return !RESERVED_SHARED_DEVICE_IDS.has(clean.toLowerCase());
}

export function normalizeDeviceIdFilter(
  deviceIds?: string | string[] | null
): Set<string> {
  const out = new Set<string>();
  if (!deviceIds) return out;
  const parts = Array.isArray(deviceIds)
    ? deviceIds
    : String(deviceIds)
        .split(',')
        .map((s) => s.trim());
  for (const part of parts) {
    if (isValidServerDeviceId(part)) {
      out.add(part.trim());
    }
  }
  return out;
}

function sanitizeSmsDocId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 128);
  return cleaned || `sms_${Date.now()}`;
}

function clampStr(raw: unknown, maxLen: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  return s.slice(0, maxLen);
}

// Real-time dynamic messages only - strictly isolated per deviceId
const INITIAL_SMS_SEEDS: SmsMessage[] = [];

class SmsStore {
  private messages: SmsMessage[] = [];
  private initialized = false;
  private lastFirestoreSyncMs = 0;

  constructor() {
    this.init();
  }

  private sanitizeRecord(raw: Partial<SmsMessage> & { smsId?: string }): SmsMessage | null {
    const devId = raw.deviceId ? String(raw.deviceId).trim() : '';
    if (!isValidServerDeviceId(devId)) return null;

    let senderName = (raw.senderName || raw.sender || 'CBEBirr').trim();
    let conversationId = (raw.conversationId || senderName).trim();
    if (
      conversationId === 'All Banks' ||
      senderName === 'All Banks' ||
      conversationId.toLowerCase().includes('cbe')
    ) {
      conversationId = 'CBEBirr';
      senderName = 'CBEBirr';
    }

    let cleanedText = String(raw.text || '')
      .replace(/For your feedback please click the link https:\/\/shorturl\.at\/[^\s]+/gi, '')
      .replace(
        /For invoice\s+https:\/\/cbepay1\.cbe\.com\.et\/aureceipt/gi,
        'Thank You! CBEBirr transaction Receipt. Com https://cbepay1.cbe.com.et/aureceipt'
      )
      .trim();

    if (!cleanedText) return null;

    if (conversationId === 'CBEBirr' || raw.sender === 'CBEBirr' || raw.isBank) {
      cleanedText = repairTransferLabelInSmsText(cleanedText, {
        transferLabel: raw.transferLabel,
        destBank: raw.destBank,
        bank: raw.bankName,
        receiptUrl: raw.receiptUrl,
        recipientAccount: raw.recipientAccount,
      });
    }

    const id = sanitizeSmsDocId(raw.id || raw.smsId || `sms-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const status = raw.status === 'read' || raw.status === 'pending' ? raw.status : 'delivered';

    return {
      id,
      conversationId: conversationId.slice(0, 80),
      sender: (raw.sender === 'All Banks' ? 'CBEBirr' : raw.sender || senderName).slice(0, 80),
      senderName: senderName.slice(0, 80),
      text: cleanedText.slice(0, 2000),
      timestamp: (raw.timestamp || new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })).slice(0, 40),
      date: (raw.date || new Date().toISOString()).slice(0, 64),
      isOutgoing: Boolean(raw.isOutgoing),
      status,
      isBank: raw.isBank ?? ['CBEBirr', '127', 'Safaricom'].includes(conversationId),
      bankName: clampStr(raw.bankName || (conversationId === 'CBEBirr' ? 'CBEBirr' : undefined), 80),
      destBank: clampStr(raw.destBank, 80),
      transferLabel: clampStr(raw.transferLabel, 80),
      reason: clampStr(raw.reason, 200),
      creditAccountType: clampStr(raw.creditAccountType, 80),
      amount: clampStr(raw.amount, 32),
      balance: clampStr(raw.balance, 32),
      recipient: clampStr(raw.recipient, 120),
      recipientAccount: clampStr(raw.recipientAccount, 64),
      fullName: clampStr(raw.fullName, 120),
      userPhone: clampStr(raw.userPhone, 40),
      serviceCharge: clampStr(raw.serviceCharge, 32),
      vat: clampStr(raw.vat, 32),
      totalPaid: clampStr(raw.totalPaid, 32),
      reference: clampStr(raw.reference, 64),
      txnId: clampStr(raw.txnId, 64),
      receiptUrl: clampStr(raw.receiptUrl, 1000),
      deviceId: devId,
      synced: raw.synced ?? false,
      isDeposit: raw.isDeposit,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    };
  }

  private init() {
    if (this.initialized) return;
    this.messages = [...INITIAL_SMS_SEEDS];

    const targets = [SMS_STORE_FILE, TMP_SMS_STORE_FILE];
    for (const f of targets) {
      try {
        if (fs.existsSync(f)) {
          const raw = fs.readFileSync(f, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const map = new Map<string, SmsMessage>();
            for (const m of this.messages) map.set(m.id, m);
            for (const rawItem of parsed) {
              const sanitized = this.sanitizeRecord(rawItem);
              if (sanitized) map.set(sanitized.id, sanitized);
            }
            this.messages = Array.from(map.values());
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    this.initialized = true;
  }

  private persist() {
    try {
      const data = JSON.stringify(this.messages.slice(-500), null, 2);
      try {
        fs.writeFileSync(SMS_STORE_FILE, data, 'utf-8');
      } catch {}
      try {
        fs.writeFileSync(TMP_SMS_STORE_FILE, data, 'utf-8');
      } catch {}
    } catch {
      // ignore
    }
  }

  private async saveToFirestore(msg: SmsMessage): Promise<void> {
    if (!isFirestoreServerConfigured()) return;
    if (!isValidServerDeviceId(msg.deviceId)) return;

    const nowDate = new Date();
    const docData: Record<string, unknown> = {
      smsId: sanitizeSmsDocId(msg.id),
      deviceId: msg.deviceId,
      conversationId: (msg.conversationId || 'CBEBirr').slice(0, 80),
      sender: (msg.sender || msg.senderName || 'CBEBirr').slice(0, 80),
      senderName: (msg.senderName || msg.sender || 'CBEBirr').slice(0, 80),
      text: msg.text.slice(0, 2000),
      timestamp: (msg.timestamp || '').slice(0, 40),
      date: (msg.date || nowDate.toISOString()).slice(0, 64),
      isOutgoing: Boolean(msg.isOutgoing),
      status: msg.status || 'delivered',
      isBank: Boolean(msg.isBank),
      createdAtMs: typeof msg.createdAt === 'number' ? msg.createdAt : Date.now(),
      ownerId: SYSTEM_OWNER_ID,
      createdAt: nowDate,
      updatedAt: nowDate,
    };

    const optFields: Array<[string, unknown]> = [
      ['bankName', clampStr(msg.bankName, 80)],
      ['destBank', clampStr(msg.destBank, 80)],
      ['transferLabel', clampStr(msg.transferLabel, 80)],
      ['reason', clampStr(msg.reason, 200)],
      ['creditAccountType', clampStr(msg.creditAccountType, 80)],
      ['amount', clampStr(msg.amount, 32)],
      ['balance', clampStr(msg.balance, 32)],
      ['recipient', clampStr(msg.recipient, 120)],
      ['recipientAccount', clampStr(msg.recipientAccount, 64)],
      ['fullName', clampStr(msg.fullName, 120)],
      ['userPhone', clampStr(msg.userPhone, 40)],
      ['serviceCharge', clampStr(msg.serviceCharge, 32)],
      ['vat', clampStr(msg.vat, 32)],
      ['totalPaid', clampStr(msg.totalPaid, 32)],
      ['reference', clampStr(msg.reference, 64)],
      ['txnId', clampStr(msg.txnId, 64)],
      ['receiptUrl', clampStr(msg.receiptUrl, 1000)],
      ['synced', typeof msg.synced === 'boolean' ? msg.synced : undefined],
      ['isDeposit', typeof msg.isDeposit === 'boolean' ? msg.isDeposit : undefined],
    ];
    for (const [k, v] of optFields) {
      if (v !== undefined) docData[k] = v;
    }

    await fsSetDocument(SMS_COLLECTION, sanitizeSmsDocId(msg.id), docData).catch(() => {});
  }

  private async syncFromFirestoreIfAvailable(force = false): Promise<void> {
    this.init();
    if (!isFirestoreServerConfigured()) return;
    const now = Date.now();
    if (!force && now - this.lastFirestoreSyncMs < FIRESTORE_SYNC_TTL_MS) return;

    const docs = await fsListCollection<Record<string, unknown>>(SMS_COLLECTION, 400);
    if (!docs) return;

    this.lastFirestoreSyncMs = now;
    const map = new Map<string, SmsMessage>();
    for (const m of this.messages) {
      if (isValidServerDeviceId(m.deviceId)) map.set(m.id, m);
    }
    for (const d of docs) {
      const sanitized = this.sanitizeRecord({
        ...(d as Partial<SmsMessage>),
        id: String(d.smsId || d.id || ''),
        createdAt: typeof d.createdAtMs === 'number' ? d.createdAtMs : undefined,
      });
      if (sanitized) {
        map.set(sanitized.id, sanitized);
      }
    }
    this.messages = Array.from(map.values());
    this.persist();
  }

  public getAllMessages(deviceIds?: string | string[], unsyncedOnly?: boolean): SmsMessage[] {
    this.init();
    const allowedSet = normalizeDeviceIdFilter(deviceIds);
    if (allowedSet.size === 0) {
      return [];
    }
    let res = this.messages.filter(
      (m) => Boolean(m.deviceId) && allowedSet.has(m.deviceId!.trim())
    );
    if (unsyncedOnly) {
      res = res.filter((m) => !m.synced);
    }
    return res.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  public async getAllMessagesAsync(
    deviceIds?: string | string[],
    unsyncedOnly?: boolean
  ): Promise<SmsMessage[]> {
    await this.syncFromFirestoreIfAvailable();
    return this.getAllMessages(deviceIds, unsyncedOnly);
  }

  public getConversationMessages(
    conversationId: string,
    deviceIds?: string | string[]
  ): SmsMessage[] {
    const cleanId = conversationId.trim().toLowerCase();
    return this.getAllMessages(deviceIds).filter(
      (m) => m.conversationId.trim().toLowerCase() === cleanId
    );
  }

  public getConversations(deviceIds?: string | string[]): ConversationSummary[] {
    const scopedMessages = this.getAllMessages(deviceIds);
    if (scopedMessages.length === 0) return [];

    const map = new Map<string, SmsMessage[]>();
    for (const m of scopedMessages) {
      const key = m.conversationId || m.senderName || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }

    const summaries: ConversationSummary[] = [];

    const colorMap: Record<string, string> = {
      CBEBirr: '#7a1c7d',
      Safaricom: '#e60000',
      '127': '#009fe3',
      'My 😘': '#10b981',
      '34000': '#64748b',
      '994': '#0284c7',
      '•': '#2563eb',
      '251994': '#0284c7',
      '131': '#f59e0b',
      'ጅብሪል': '#8b5cf6',
      BeepCall710: '#64748b',
      'A A': '#10b981',
      '+251708279538': '#6b7280',
      EoC: '#6b7280',
      CallSign: '#6b7280',
    };

    for (const [key, msgs] of map.entries()) {
      msgs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const last = msgs[msgs.length - 1];
      const unreadCount = msgs.filter((m) => !m.isOutgoing && m.status !== 'read').length;

      let avatarLetter = key.slice(0, 1).toUpperCase();
      if (key === 'My 😘') avatarLetter = 'M';
      if (key === '•') avatarLetter = '•';

      summaries.push({
        id: key,
        senderName: key,
        lastMessage: last.text,
        lastTimestamp: last.timestamp,
        lastDate: last.date,
        unreadCount,
        avatarColor: colorMap[key] || '#64748b',
        avatarLetter,
        isBank: msgs.some((m) => m.isBank),
        isContact: ['My 😘', 'A A', 'ጅብሪል', '•'].includes(key),
      });
    }

    return summaries.sort((a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime());
  }

  public addMessage(msgInput: Partial<SmsMessage>): SmsMessage {
    this.init();

    const targetDeviceId = msgInput.deviceId ? String(msgInput.deviceId).trim() : '';
    if (!isValidServerDeviceId(targetDeviceId)) {
      throw new Error('Valid deviceId is required for device-isolated SMS storage');
    }

    const now = new Date();
    const id = sanitizeSmsDocId(
      msgInput.id || `sms-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    let senderName = (msgInput.senderName || msgInput.sender || 'CBEBirr').trim();
    let conversationId = (msgInput.conversationId || senderName).trim();
    if (
      conversationId === 'All Banks' ||
      senderName === 'All Banks' ||
      conversationId.toLowerCase().includes('cbe')
    ) {
      conversationId = 'CBEBirr';
      senderName = 'CBEBirr';
    }
    const dateStr = (msgInput.date || now.toISOString()).slice(0, 64);

    const hours = now.getHours();
    const mins = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 || 12;
    const timestamp = (msgInput.timestamp || `${hour12}:${mins} ${ampm}`).slice(0, 40);

    let extractedDestBank = resolveDestBankName(msgInput.destBank);
    if (!extractedDestBank) {
      extractedDestBank = resolveDestBankName(msgInput.bankName);
    }
    if (!extractedDestBank && msgInput.receiptUrl) {
      try {
        const u = new URL(msgInput.receiptUrl);
        const ub = u.searchParams.get('bank') || u.searchParams.get('destBank') || '';
        extractedDestBank = resolveDestBankName(ub);
      } catch {}
    }
    if (!extractedDestBank && msgInput.text) {
      const pm = msgInput.text.match(/to\s+[0-9]+\s*[-–]\s*.+?\s*\(([^)]+)\)\s+on\s+/i);
      if (pm && pm[1]) {
        extractedDestBank = resolveDestBankName(pm[1]);
      }
    }

    const repairedText = repairTransferLabelInSmsText(msgInput.text || '', {
      transferLabel: msgInput.transferLabel,
      destBank: extractedDestBank,
      bank: msgInput.bankName,
      receiptUrl: msgInput.receiptUrl,
      recipientAccount: msgInput.recipientAccount,
    });

    // Deduplicate by (deviceId, txnId) ONLY within the SAME device so devices never interfere
    if (msgInput.txnId) {
      const cleanTxn = msgInput.txnId.trim().toUpperCase();
      const existing = this.messages.find(
        (m) =>
          m.deviceId === targetDeviceId &&
          m.txnId &&
          m.txnId.trim().toUpperCase() === cleanTxn
      );
      if (existing) {
        let changed = false;
        const upgradedExistingText = repairTransferLabelInSmsText(
          /\(\s*Transfer\s*\)/i.test(existing.text) && !/\(\s*Transfer\s*\)/i.test(repairedText)
            ? repairedText
            : existing.text,
          {
            transferLabel: msgInput.transferLabel || existing.transferLabel,
            destBank: extractedDestBank || existing.destBank,
            bank: existing.bankName,
            receiptUrl: msgInput.receiptUrl || existing.receiptUrl,
            recipientAccount: msgInput.recipientAccount || existing.recipientAccount,
          }
        );
        if (upgradedExistingText && upgradedExistingText !== existing.text) {
          existing.text = upgradedExistingText;
          changed = true;
        }
        if (extractedDestBank && !existing.destBank) {
          existing.destBank = extractedDestBank;
          changed = true;
        }
        if (
          msgInput.transferLabel &&
          !/^transfer$/i.test(msgInput.transferLabel.trim()) &&
          existing.transferLabel !== msgInput.transferLabel
        ) {
          existing.transferLabel = msgInput.transferLabel;
          changed = true;
        }
        if (msgInput.reason && !existing.reason) {
          existing.reason = msgInput.reason;
          changed = true;
        }
        if (msgInput.fullName && (!existing.fullName || existing.fullName === 'Customer')) {
          existing.fullName = msgInput.fullName;
          changed = true;
        }
        if (msgInput.userPhone && !existing.userPhone) {
          existing.userPhone = msgInput.userPhone;
          changed = true;
        }
        if (msgInput.serviceCharge && !existing.serviceCharge) {
          existing.serviceCharge = msgInput.serviceCharge;
          changed = true;
        }
        if (msgInput.vat && !existing.vat) {
          existing.vat = msgInput.vat;
          changed = true;
        }
        if (msgInput.totalPaid && !existing.totalPaid) {
          existing.totalPaid = msgInput.totalPaid;
          changed = true;
        }
        if (msgInput.amount && !existing.amount) {
          existing.amount = msgInput.amount;
          changed = true;
        }
        if (msgInput.recipient && !existing.recipient) {
          existing.recipient = msgInput.recipient;
          changed = true;
        }
        if (msgInput.recipientAccount && !existing.recipientAccount) {
          existing.recipientAccount = msgInput.recipientAccount;
          changed = true;
        }
        if (
          msgInput.receiptUrl &&
          (!existing.receiptUrl || msgInput.receiptUrl.length > existing.receiptUrl.length)
        ) {
          existing.receiptUrl = msgInput.receiptUrl;
          changed = true;
        }
        if (changed) {
          this.persist();
          void this.saveToFirestore(existing);
        }
        return existing;
      }
    }

    // Deduplicate by exact document id within the same device (idempotent SIM SMS uploads)
    if (msgInput.id) {
      const existingById = this.messages.find(
        (m) => m.deviceId === targetDeviceId && m.id === id
      );
      if (existingById) {
        return existingById;
      }
    }

    const newMsg: SmsMessage = {
      id,
      conversationId: conversationId.slice(0, 80),
      sender: (msgInput.sender === 'All Banks' ? 'CBEBirr' : msgInput.sender || senderName).slice(0, 80),
      senderName: senderName.slice(0, 80),
      text: repairedText.slice(0, 2000),
      timestamp,
      date: dateStr,
      isOutgoing: !!msgInput.isOutgoing,
      status: msgInput.status === 'read' || msgInput.status === 'pending' ? msgInput.status : 'delivered',
      isBank: msgInput.isBank ?? ['CBEBirr', '127', 'Safaricom'].includes(conversationId),
      bankName: clampStr(msgInput.bankName || (conversationId === 'CBEBirr' ? 'CBEBirr' : undefined), 80),
      destBank: clampStr(extractedDestBank, 80),
      transferLabel: clampStr(msgInput.transferLabel, 80),
      reason: clampStr(msgInput.reason, 200),
      creditAccountType: clampStr(msgInput.creditAccountType, 80),
      amount: clampStr(msgInput.amount, 32),
      balance: clampStr(msgInput.balance, 32),
      recipient: clampStr(msgInput.recipient, 120),
      recipientAccount: clampStr(msgInput.recipientAccount, 64),
      fullName: clampStr(msgInput.fullName, 120),
      userPhone: clampStr(msgInput.userPhone, 40),
      serviceCharge: clampStr(msgInput.serviceCharge, 32),
      vat: clampStr(msgInput.vat, 32),
      totalPaid: clampStr(msgInput.totalPaid, 32),
      reference: clampStr(msgInput.reference, 64),
      txnId: clampStr(msgInput.txnId, 64),
      receiptUrl: clampStr(msgInput.receiptUrl, 1000),
      deviceId: targetDeviceId,
      synced: msgInput.synced ?? false,
      isDeposit: msgInput.isDeposit,
      createdAt: typeof msgInput.createdAt === 'number' ? msgInput.createdAt : Date.now(),
    };

    if (newMsg.txnId) {
      try {
        const existingReceipt = getReceipt(newMsg.txnId);
        const hasExactSavedReceipt =
          existingReceipt &&
          (existingReceipt.ref?.toUpperCase() === newMsg.txnId.toUpperCase() ||
            existingReceipt.orderId?.toUpperCase() === newMsg.txnId.toUpperCase() ||
            (existingReceipt.ref?.toUpperCase().startsWith('FT') &&
              existingReceipt.ref.slice(2, 10).toUpperCase() === newMsg.txnId.toUpperCase()));

        let parsedAcc = newMsg.userPhone || '';
        if (!parsedAcc && newMsg.receiptUrl) {
          try {
            const u = new URL(newMsg.receiptUrl);
            parsedAcc = u.searchParams.get('PH') || u.searchParams.get('acc') || '';
          } catch {}
        }
        const formattedReceiptDate = /^\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}/.test(newMsg.date)
          ? newMsg.date
          : formatCbeDateTime(newMsg.date);

        if (!hasExactSavedReceipt) {
          const isPhoneRec =
            (newMsg.recipientAccount || '').startsWith('09') ||
            (newMsg.recipientAccount || '').startsWith('07');
          const storedRec: StoredReceipt = {
            ref: newMsg.reference || newMsg.txnId,
            amt: newMsg.amount || '0.00',
            date: formattedReceiptDate,
            rec: newMsg.recipientAccount || '',
            name: newMsg.recipient || 'CBE Customer',
            user: newMsg.fullName || 'CBEBirr Customer',
            acc: parsedAcc,
            bank: extractedDestBank,
            reason: newMsg.isDeposit
              ? 'Deposit to CBE Birr'
              : newMsg.reason ||
                (extractedDestBank
                  ? `Transfer to ${extractedDestBank}`
                  : isPhoneRec
                  ? 'Wallet Transfer'
                  : 'Customer transfer to CBE account'),
            serviceCharge: newMsg.serviceCharge,
            vat: newMsg.vat,
            totalPaidAmount: newMsg.totalPaid,
            status: 'Completed',
            orderId: newMsg.txnId,
          };
          saveReceipt(storedRec);
        } else if (
          (extractedDestBank && !existingReceipt.bank) ||
          (parsedAcc && !existingReceipt.acc) ||
          (newMsg.serviceCharge && !existingReceipt.serviceCharge)
        ) {
          saveReceipt({
            ...existingReceipt,
            bank: extractedDestBank || existingReceipt.bank,
            acc: parsedAcc || existingReceipt.acc,
            serviceCharge: newMsg.serviceCharge || existingReceipt.serviceCharge,
            vat: newMsg.vat || existingReceipt.vat,
            totalPaidAmount: newMsg.totalPaid || existingReceipt.totalPaidAmount,
            reason:
              newMsg.reason ||
              existingReceipt.reason ||
              (extractedDestBank ? `Transfer to ${extractedDestBank}` : 'Wallet Transfer'),
          });
        }
      } catch {}
    }

    this.messages.push(newMsg);
    this.persist();
    void this.saveToFirestore(newMsg);
    return newMsg;
  }

  public async addMessageAsync(msgInput: Partial<SmsMessage>): Promise<SmsMessage> {
    await this.syncFromFirestoreIfAvailable();
    const created = this.addMessage(msgInput);
    await this.saveToFirestore(created);
    return created;
  }

  public markMessagesSynced(ids?: string[], deviceIds?: string | string[]): void {
    this.init();
    const allowedSet = normalizeDeviceIdFilter(deviceIds);
    const idSet = ids && ids.length > 0 ? new Set(ids) : null;

    for (const m of this.messages) {
      if (allowedSet.size > 0 && (!m.deviceId || !allowedSet.has(m.deviceId))) continue;
      if (idSet && !idSet.has(m.id)) continue;
      if (!m.synced) {
        m.synced = true;
        void this.saveToFirestore(m);
      }
    }
    this.persist();
  }

  public markConversationRead(conversationId: string, deviceIds?: string | string[]): void {
    this.init();
    const cleanId = conversationId.trim().toLowerCase();
    const allowedSet = normalizeDeviceIdFilter(deviceIds);
    if (allowedSet.size === 0) return;

    this.messages.forEach((m) => {
      if (
        m.deviceId &&
        allowedSet.has(m.deviceId) &&
        m.conversationId.trim().toLowerCase() === cleanId
      ) {
        m.status = 'read';
        void this.saveToFirestore(m);
      }
    });
    this.persist();
  }

  public async deleteMessagesAsync(
    ids: string[],
    deviceIds?: string | string[]
  ): Promise<number> {
    await this.syncFromFirestoreIfAvailable();
    const allowedSet = normalizeDeviceIdFilter(deviceIds);
    if (allowedSet.size === 0) return 0;

    const idSet = new Set(ids);
    const toDelete = this.messages.filter(
      (m) => idSet.has(m.id) && m.deviceId && allowedSet.has(m.deviceId)
    );
    if (toDelete.length === 0) return 0;

    const deletedIds = new Set(toDelete.map((m) => m.id));
    this.messages = this.messages.filter((m) => !deletedIds.has(m.id));
    this.persist();

    if (isFirestoreServerConfigured()) {
      await Promise.all(
        toDelete.map((m) => fsDeleteDocument(SMS_COLLECTION, sanitizeSmsDocId(m.id)).catch(() => false))
      );
    }
    return toDelete.length;
  }

  public async clearAllMessagesAsync(deviceIds?: string | string[]): Promise<number> {
    await this.syncFromFirestoreIfAvailable();
    const allowedSet = normalizeDeviceIdFilter(deviceIds);
    if (allowedSet.size === 0) return 0;

    const toDelete = this.messages.filter(
      (m) => m.deviceId && allowedSet.has(m.deviceId)
    );
    if (toDelete.length === 0) return 0;

    const deletedIds = new Set(toDelete.map((m) => m.id));
    this.messages = this.messages.filter((m) => !deletedIds.has(m.id));
    this.persist();

    if (isFirestoreServerConfigured()) {
      await Promise.all(
        toDelete.map((m) => fsDeleteDocument(SMS_COLLECTION, sanitizeSmsDocId(m.id)).catch(() => false))
      );
    }
    return toDelete.length;
  }

  public resetToSeeds(deviceIds?: string | string[]): void {
    const allowedSet = normalizeDeviceIdFilter(deviceIds);
    if (allowedSet.size === 0) return;
    this.messages = this.messages.filter(
      (m) => !m.deviceId || !allowedSet.has(m.deviceId)
    );
    this.persist();
  }

  public validateApiKey(apiKey?: string | null): {
    valid: boolean;
    bank?: string;
    isMaster?: boolean;
  } {
    if (!apiKey) return { valid: false };
    const clean = apiKey.trim();
    if (clean === MASTER_API_KEY) {
      return { valid: true, isMaster: true, bank: 'All Banks' };
    }
    if (BANK_API_KEYS[clean]) {
      return { valid: true, isMaster: false, bank: BANK_API_KEYS[clean] };
    }
    return { valid: false };
  }
}

export const smsStore = new SmsStore();
