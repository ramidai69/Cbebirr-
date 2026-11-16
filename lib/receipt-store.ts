import fs from 'fs';
import {
  fsGetDocument,
  fsListCollection,
  fsSetDocument,
  isFirestoreServerConfigured,
} from './firestore-admin';

export interface StoredReceipt {
  ref: string;
  amt: string;
  date: string;
  rec: string;
  name: string;
  user: string;
  acc: string;
  reason: string;
  bank?: string;
  status?: string;
  orderId?: string;
  serviceCharge?: string;
  vat?: string;
  totalCharges?: string;
  totalPaidAmount?: string;
}

/**
 * Exact URL & parameters decoded verbatim from the untouched original PNG QR codes
 * (public/assets/cbe_authentic_receipt_qr_exact.png, public/screens/receipt_page.png,
 * and public/screens/official_receipt_hq.png).
 */
export const ORIGINAL_QR_URL = 'https://cbepay1.cbe.com.et/aureceipt';
export const ORIGINAL_QR_TID = 'DJM51SKYIQ3';
export const ORIGINAL_QR_PH = '';

const LATEST_KEY = '__LATEST__';
const STORAGE_FILE = '/tmp/cbe_receipts.json';
const RECEIPTS_COLLECTION = 'receipts';
const SYSTEM_OWNER_ID = 'system_owner';

// In-memory cache (starts completely clean with zero hardcoded personal seeds)
const memoryStore = new Map<string, StoredReceipt>();
let lastLoadedMtime = 0;

// Default fallback for any unknown reference
export const DEFAULT_RECEIPT: StoredReceipt = {
  ref: '',
  amt: '0.00',
  date: '',
  rec: '',
  name: '',
  user: 'CBEBirr Customer',
  acc: '',
  reason: 'Wallet Transfer',
  status: 'Completed',
  orderId: '',
};

const INITIAL_SEEDS: StoredReceipt[] = [];

for (const seed of INITIAL_SEEDS) {
  memoryStore.set(seed.ref, seed);
}

function sanitizeDocId(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_\-]/g, '_')
    .slice(0, 128);
}

function syncFromDisk(): void {
  try {
    if (!fs.existsSync(STORAGE_FILE)) return;
    const stat = fs.statSync(STORAGE_FILE);
    if (stat.mtimeMs <= lastLoadedMtime) return;
    const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      memoryStore.set(k, v as StoredReceipt);
    }
    lastLoadedMtime = stat.mtimeMs;
  } catch {
    // ignore
  }
}

syncFromDisk();

/**
 * Extracts a TID / ref from either a raw ID or the full scanned QR URL.
 */
export function extractReceiptRef(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (trimmed.includes('://') || trimmed.includes('?')) {
    try {
      const urlObj = new URL(
        trimmed.startsWith('http')
          ? trimmed
          : `https://cbepay1.cbe.com.et${trimmed.startsWith('/') ? '' : '/'}${trimmed}`
      );
      return (
        urlObj.searchParams.get('TID') ||
        urlObj.searchParams.get('tid') ||
        urlObj.searchParams.get('ref') ||
        ''
      ).trim();
    } catch {
      // fall through
    }
  }
  return trimmed;
}

function cacheReceiptLocally(normalized: StoredReceipt): void {
  const cleanRef = normalized.ref.trim();
  memoryStore.set(cleanRef, normalized);
  memoryStore.set(cleanRef.toUpperCase(), normalized);
  memoryStore.set(cleanRef.toLowerCase(), normalized);
  memoryStore.set(LATEST_KEY, normalized);

  if (normalized.orderId) {
    const oId = normalized.orderId.trim();
    memoryStore.set(oId, normalized);
    memoryStore.set(oId.toUpperCase(), normalized);
  }

  if (cleanRef.length >= 8) {
    const last8 = cleanRef.slice(-8).toUpperCase();
    memoryStore.set(last8, normalized);
  }
  if (cleanRef.toUpperCase().startsWith('FT') && cleanRef.length >= 10) {
    memoryStore.set(cleanRef.slice(2, 10).toUpperCase(), normalized);
  }

  try {
    const obj: Record<string, StoredReceipt> = {};
    for (const [k, v] of memoryStore.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    lastLoadedMtime = fs.statSync(STORAGE_FILE).mtimeMs;
  } catch {
    // ignore
  }
}

function buildFirestoreReceiptRecord(receiptId: string, normalized: StoredReceipt): Record<string, unknown> {
  const now = new Date();
  return {
    receiptId,
    ref: String(normalized.ref || '').slice(0, 64),
    orderId: String(normalized.orderId || normalized.ref || '').slice(0, 64),
    amt: String(normalized.amt || '0.00').slice(0, 32),
    date: String(normalized.date || '').slice(0, 64),
    rec: String(normalized.rec || '').slice(0, 64),
    name: String(normalized.name || '').slice(0, 120),
    user: String(normalized.user || 'CBEBirr Customer').slice(0, 120),
    acc: String(normalized.acc || '').slice(0, 64),
    reason: String(normalized.reason || 'Wallet Transfer').slice(0, 200),
    bank: String(normalized.bank || '').slice(0, 80),
    status: String(normalized.status || 'Completed').slice(0, 32),
    serviceCharge: String(normalized.serviceCharge || '').slice(0, 32),
    vat: String(normalized.vat || '').slice(0, 32),
    totalCharges: String(normalized.totalCharges || '').slice(0, 32),
    totalPaidAmount: String(normalized.totalPaidAmount || '').slice(0, 32),
    ownerId: SYSTEM_OWNER_ID,
    createdAt: now,
    updatedAt: now,
  };
}

function parseFirestoreReceiptDoc(doc: Record<string, unknown> | null): StoredReceipt | null {
  if (!doc || !doc.ref) return null;
  return {
    ref: String(doc.ref || ''),
    orderId: doc.orderId ? String(doc.orderId) : undefined,
    amt: String(doc.amt || '0.00'),
    date: String(doc.date || ''),
    rec: String(doc.rec || ''),
    name: String(doc.name || ''),
    user: String(doc.user || 'CBEBirr Customer'),
    acc: String(doc.acc || ''),
    reason: String(doc.reason || 'Wallet Transfer'),
    bank: doc.bank ? String(doc.bank) : undefined,
    status: doc.status ? String(doc.status) : 'Completed',
    serviceCharge: doc.serviceCharge ? String(doc.serviceCharge) : undefined,
    vat: doc.vat ? String(doc.vat) : undefined,
    totalCharges: doc.totalCharges ? String(doc.totalCharges) : undefined,
    totalPaidAmount: doc.totalPaidAmount ? String(doc.totalPaidAmount) : undefined,
  };
}

async function persistReceiptToFirestore(normalized: StoredReceipt): Promise<void> {
  if (!isFirestoreServerConfigured()) return;
  const cleanRef = normalized.ref.trim();
  const keys = new Set<string>();
  const primaryKey = sanitizeDocId(cleanRef);
  if (primaryKey) keys.add(primaryKey);

  if (normalized.orderId) {
    const oKey = sanitizeDocId(normalized.orderId);
    if (oKey) keys.add(oKey);
  }
  if (cleanRef.toUpperCase().startsWith('FT') && cleanRef.length >= 10) {
    keys.add(sanitizeDocId(cleanRef.slice(2, 10)));
  }
  keys.add(LATEST_KEY);

  await Promise.allSettled(
    Array.from(keys).map((key) =>
      fsSetDocument(RECEIPTS_COLLECTION, key, buildFirestoreReceiptRecord(key, normalized))
    )
  );
}

export function saveReceipt(data: StoredReceipt): void {
  if (!data || !data.ref) return;
  syncFromDisk();

  const cleanRef = data.ref.trim();
  const normalized: StoredReceipt = { ...data, ref: cleanRef };
  cacheReceiptLocally(normalized);
  void persistReceiptToFirestore(normalized).catch(() => {});
}

export async function saveReceiptAsync(data: StoredReceipt): Promise<void> {
  if (!data || !data.ref) return;
  syncFromDisk();

  const cleanRef = data.ref.trim();
  const normalized: StoredReceipt = { ...data, ref: cleanRef };
  cacheReceiptLocally(normalized);
  await persistReceiptToFirestore(normalized).catch(() => {});
}

export function getReceipt(ref: string): StoredReceipt {
  syncFromDisk();

  const clean = extractReceiptRef(ref);

  // When scanned from the untouched original PNG QR code (TID=DJM51SKYIQ3),
  // or requesting the latest transaction, return the latest live transaction if saved.
  if (
    !clean ||
    clean.toUpperCase() === ORIGINAL_QR_TID ||
    clean === LATEST_KEY ||
    clean.toLowerCase() === 'latest'
  ) {
    const latest = memoryStore.get(LATEST_KEY);
    if (latest) return latest;
    return memoryStore.get(ORIGINAL_QR_TID) || DEFAULT_RECEIPT;
  }

  if (memoryStore.has(clean)) return memoryStore.get(clean)!;
  if (memoryStore.has(clean.toUpperCase())) return memoryStore.get(clean.toUpperCase())!;

  // Try case-insensitive or partial match (skipping internal __LATEST__ key)
  const upper = clean.toUpperCase();
  for (const [k, v] of memoryStore.entries()) {
    if (k === LATEST_KEY) continue;
    const kUpper = k.toUpperCase();
    if (
      kUpper === upper ||
      (upper.length >= 8 && kUpper.includes(upper)) ||
      (kUpper.length >= 8 && upper.includes(kUpper))
    ) {
      return v;
    }
  }

  return { ...DEFAULT_RECEIPT, ref: clean };
}

function formatIsoToReceiptDate(ms: number): string {
  const d = new Date(ms || Date.now());
  const DD = String(d.getDate()).padStart(2, '0');
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const YYYY = d.getFullYear();
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${DD}-${MM}-${YYYY} ${HH}:${mm}:${ss}`;
}

export async function getReceiptAsync(ref: string): Promise<StoredReceipt> {
  const local = getReceipt(ref);
  const clean = extractReceiptRef(ref);
  const isOriginalOrLatest =
    !clean ||
    clean.toUpperCase() === ORIGINAL_QR_TID ||
    clean === LATEST_KEY ||
    clean.toLowerCase() === 'latest';

  const hasRichLocalData =
    Boolean(local.rec) &&
    Boolean(local.amt) &&
    local.amt !== '0.00';

  if (hasRichLocalData || !isFirestoreServerConfigured()) {
    return local;
  }

  try {
    const lookupKeys: string[] = [];
    if (isOriginalOrLatest) {
      lookupKeys.push(LATEST_KEY);
    } else {
      const upper = sanitizeDocId(clean);
      if (upper) lookupKeys.push(upper);
      if (upper.startsWith('FT') && upper.length >= 10) {
        lookupKeys.push(upper.slice(2, 10));
      }
      if (upper.length >= 8) {
        lookupKeys.push(upper.slice(-8));
      }
    }

    for (const key of lookupKeys) {
      const fsDoc = await fsGetDocument<Record<string, unknown>>(RECEIPTS_COLLECTION, key);
      const parsed = parseFirestoreReceiptDoc(fsDoc);
      if (parsed && parsed.amt && parsed.amt !== '0.00') {
        cacheReceiptLocally(parsed);
        return parsed;
      }
    }

    // Fallback: check device_transactions in Firestore matching this ref
    const txDocs = await fsListCollection<Record<string, unknown>>('device_transactions', 100);
    if (txDocs && txDocs.length > 0) {
      const cleanUpper = clean.toUpperCase();
      const matched = isOriginalOrLatest
        ? txDocs.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0))[0]
        : txDocs.find((t) => {
            const tRef = String(t.ref || '').toUpperCase();
            const tId = String(t.txId || '').toUpperCase();
            return (
              tRef === cleanUpper ||
              tId === cleanUpper ||
              (cleanUpper.length >= 8 && (tRef.includes(cleanUpper) || cleanUpper.includes(tRef)))
            );
          });

      if (matched) {
        const amtNum = Number(matched.amount || 0);
        const totalDeducted = Number(matched.totalDeducted || amtNum);
        const extra = Math.max(0, totalDeducted - amtNum);
        const sc = extra > 0 ? +(extra / 1.15).toFixed(2) : 0;
        const vatVal = extra > 0 ? +(extra - sc).toFixed(2) : 0;

        const mapped: StoredReceipt = {
          ref: String(matched.ref || clean || ORIGINAL_QR_TID),
          orderId: String(matched.ref || matched.txId || clean),
          amt: amtNum.toFixed(2),
          date: formatIsoToReceiptDate(Number(matched.createdAtMs || Date.now())),
          rec: String(matched.recipientAccount || ''),
          name: String(matched.recipientName || ''),
          user: String(matched.senderName || 'CBEBirr Customer'),
          acc: String(matched.senderPhone || matched.senderAccount || ''),
          reason: String(matched.reason || 'Wallet Transfer'),
          bank: matched.destBank ? String(matched.destBank) : undefined,
          status: String(matched.status || 'Completed'),
          serviceCharge: sc > 0 ? sc.toFixed(2) : undefined,
          vat: vatVal > 0 ? vatVal.toFixed(2) : undefined,
          totalPaidAmount: totalDeducted > 0 ? totalDeducted.toFixed(2) : undefined,
        };
        cacheReceiptLocally(mapped);
        return mapped;
      }
    }
  } catch {
    // fallback to local
  }

  return local;
}
