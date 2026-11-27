'use client';

export type Support951Mode = 'hybrid' | 'mp3_only' | 'ai_only';
export type Support951Voice = 'Charon' | 'Kore' | 'Puck' | 'Fenrir' | 'Zephyr';

export interface Mp3StepItem {
  id: string;
  title: string;
  audioId: string;
}

export interface CustomAudioRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface AiTrainingPair {
  id: string;
  question: string;
  answer: string;
}

export interface Support951Config {
  configVersion?: number;
  mode: Support951Mode;
  agentName: string;
  voiceName: Support951Voice;
  aiGreeting: string;
  aiSkipIntroInAiOnly: boolean;
  aiKnowledge: string;
  aiTrainingPairs: AiTrainingPair[];
  welcomeClipId: string;
  amharicMenuClipId: string;
  amharicMenuRepeatClipId: string;
  skipMenuAfterFirstCall: boolean;
  loopWelcomeIfNoKey: boolean;
  holdClipId: string;
  waitFullHoldMp3: boolean;
  surveyClipId: string;
  holdDurationSec: number;
  systemNotes: string;
  mp3Steps: Mp3StepItem[];
  backgroundCall: {
    enabled: boolean;
    useReal951BeforeHandoff: boolean;
    targetPhone: string;
    maxRingSec: number;
    playHoldOnBusy: boolean;
    playSurveyOnEnd: boolean;
  };
}

export const BUILTIN_951_AUDIO_CLIPS: { id: string; name: string; url: string; durationHint: string }[] = [
  {
    id: 'cbe_951_welcome',
    name: '1. CBE 951 መቀበያ + ቋንቋ (ለመጀመሪያ ጊዜ)',
    url: '/assets/aistudio/cbe_951_welcome_lang.mp3',
    durationHint: 'Welcome + ለአማርኛ አንድን ይጫኑ',
  },
  {
    id: 'cbe_951_amharic_menu',
    name: '1b. CBE 951 የአማርኛ ሜኑ + ቋንቋ ተቀይሯል (1ኛ ጊዜ)',
    url: '/assets/aistudio/cbe_951_amharic_menu.mp3',
    durationHint: 'ወደ መረጡት ቋንቋ ተቀይሮሎታል + የአማርኛ ዝርዝር',
  },
  {
    id: 'cbe_951_amharic_menu_repeat',
    name: '1c. CBE 951 የአማርኛ ሜኑ (ከ2ኛ ጥሪ ጀምሮ / ያለ ቋንቋ ማስታወቂያ)',
    url: '/assets/aistudio/cbe_951_amharic_menu_repeat.mp3',
    durationHint: 'ባንኩ ስለሚሰጣቸው አገልግሎቶች... (4 ለሰራተኞች)',
  },
  {
    id: 'cbe_951_hold',
    name: '2. CBE 951 የጥበቃ ድምፅ (4 ከተጫነ እስኪነሳ)',
    url: '/assets/aistudio/951and_4_ferst__3__c0d8a32c.mp3',
    durationHint: 'Official 951 queue + ring + CBE jingle',
  },
  {
    id: 'cbe_951_survey',
    name: '3. CBE 951 የመዝጊያ ግምገማ (ጥሪ ሲዘጋ)',
    url: '/assets/aistudio/Custmersuportlast_0d3b0df8.mp3',
    durationHint: '1-3 ደረጃ ይስጡ (በራሱ ይዘጋል)',
  },
];

export const CONFIG_951_STORAGE_KEY = 'cbe_dialer_951_config_v1';
export const DIALER_951_LANG_SELECTED_KEY = 'cbe_dialer_951_lang_selected_v1';

export const DEFAULT_951_CONFIG: Support951Config = {
  configVersion: 3,
  mode: 'hybrid',
  agentName: 'እድሪስ',
  voiceName: 'Charon',
  aiGreeting: 'ሰላም ደንበኛችን፣ ከኢትዮጵያ ንግድ ባንክ የደንበኞች አገልግሎት እድሪስ ነኝ፤ በምን ልርዳዎት?',
  aiSkipIntroInAiOnly: true,
  aiKnowledge:
    'የኢትዮጵያ ንግድ ባንክ (CBE / CBEBirr 951) የደንበኞች አገልግሎት 24 ሰዓት ይሰራል። በCBEBirr የተላከ ገንዘብ በሲስተም መጨናነቅ ምክንያት SMS ቢዘገይም ከተረጋገጠ በ24 ሰዓት ውስጥ በተቀባዩ ሂሳብ ገቢ ይሆናል።',
  aiTrainingPairs: [
    {
      id: 'train_default_1',
      question: 'ገንዘብ አስተላልፌ አልደረሰም ወይም SMS አልመጣም',
      answer:
        'በባንካችን ሲስተም ፍተሻ መሠረት ግብይቱ መከናወኑን አረጋግጫለሁ፤ አልፎ አልፎ በሲስተም መጨናነቅ ምክንያት ቢዘገይም በ24 ሰዓት ውስጥ ገቢ ይሆናል።',
    },
    {
      id: 'train_default_2',
      question: 'ቀሪ ሂሳቤን ወይም የመጨረሻ ግብይቴን አረጋግጥልኝ',
      answer:
        'በተመዘገበው አካውንትዎ መሠረት የመጨረሻ ግብይትዎ በሰላም ተጠናቋል፤ ሌላ ተጨማሪ እገዛ ከፈለጉ ይንገሩኝ።',
    },
  ],
  welcomeClipId: 'cbe_951_welcome',
  amharicMenuClipId: 'cbe_951_amharic_menu',
  amharicMenuRepeatClipId: 'cbe_951_amharic_menu_repeat',
  skipMenuAfterFirstCall: false,
  loopWelcomeIfNoKey: false,
  holdClipId: 'cbe_951_hold',
  waitFullHoldMp3: false,
  surveyClipId: 'cbe_951_survey',
  holdDurationSec: 12,
  systemNotes:
    'ደንበኛው ገንዘብ አስተላልፌ አልደረሰም ካለ የግብይቱን መረጃ አረጋግጥና በባንኩ ሲስተም መጨናነቅ ምክንያት በ24 ሰዓት ውስጥ ገቢ እንደሚሆን አረጋጋው።',
  mp3Steps: [],
  backgroundCall: {
    enabled: false,
    useReal951BeforeHandoff: true,
    targetPhone: '',
    maxRingSec: 8,
    playHoldOnBusy: true,
    playSurveyOnEnd: true,
  },
};

export function hasCompletedFirst951Welcome(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(DIALER_951_LANG_SELECTED_KEY) === 'am';
  } catch {
    return false;
  }
}

export function markFirst951WelcomeCompleted(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DIALER_951_LANG_SELECTED_KEY, 'am');
  } catch {}
}

export function resetFirst951Welcome(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(DIALER_951_LANG_SELECTED_KEY);
  } catch {}
}

export function load951Config(): Support951Config {
  if (typeof window === 'undefined') return DEFAULT_951_CONFIG;
  try {
    const raw = localStorage.getItem(CONFIG_951_STORAGE_KEY);
    if (!raw) return DEFAULT_951_CONFIG;
    const parsed = JSON.parse(raw) as Partial<Support951Config>;
    const ver = typeof parsed.configVersion === 'number' ? parsed.configVersion : 1;
    const migrated: Support951Config = {
      ...DEFAULT_951_CONFIG,
      ...parsed,
      configVersion: 3,
      aiGreeting:
        typeof parsed.aiGreeting === 'string' && parsed.aiGreeting.trim()
          ? parsed.aiGreeting
          : DEFAULT_951_CONFIG.aiGreeting,
      aiSkipIntroInAiOnly:
        typeof parsed.aiSkipIntroInAiOnly === 'boolean'
          ? parsed.aiSkipIntroInAiOnly
          : DEFAULT_951_CONFIG.aiSkipIntroInAiOnly,
      aiKnowledge:
        typeof parsed.aiKnowledge === 'string'
          ? parsed.aiKnowledge
          : DEFAULT_951_CONFIG.aiKnowledge,
      aiTrainingPairs: Array.isArray(parsed.aiTrainingPairs)
        ? parsed.aiTrainingPairs
        : DEFAULT_951_CONFIG.aiTrainingPairs,
      welcomeClipId: parsed.welcomeClipId ? parsed.welcomeClipId : DEFAULT_951_CONFIG.welcomeClipId,
      amharicMenuClipId: parsed.amharicMenuClipId
        ? parsed.amharicMenuClipId
        : DEFAULT_951_CONFIG.amharicMenuClipId,
      amharicMenuRepeatClipId: parsed.amharicMenuRepeatClipId
        ? parsed.amharicMenuRepeatClipId
        : DEFAULT_951_CONFIG.amharicMenuRepeatClipId,
      skipMenuAfterFirstCall:
        typeof parsed.skipMenuAfterFirstCall === 'boolean'
          ? parsed.skipMenuAfterFirstCall
          : DEFAULT_951_CONFIG.skipMenuAfterFirstCall,
      // Enforce silence after menu MP3 unless user explicitly saves loop=true on v2+
      loopWelcomeIfNoKey:
        ver >= 2 && typeof parsed.loopWelcomeIfNoKey === 'boolean'
          ? parsed.loopWelcomeIfNoKey
          : false,
      holdClipId: parsed.holdClipId ? parsed.holdClipId : DEFAULT_951_CONFIG.holdClipId,
      surveyClipId: parsed.surveyClipId ? parsed.surveyClipId : DEFAULT_951_CONFIG.surveyClipId,
      mp3Steps: Array.isArray(parsed.mp3Steps) ? parsed.mp3Steps : [],
      backgroundCall: {
        ...DEFAULT_951_CONFIG.backgroundCall,
        ...(parsed.backgroundCall || {}),
      },
    };
    if (ver < 3) {
      try {
        localStorage.setItem(CONFIG_951_STORAGE_KEY, JSON.stringify(migrated));
      } catch {}
    }
    return migrated;
  } catch {
    return DEFAULT_951_CONFIG;
  }
}

export function save951Config(cfg: Support951Config): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CONFIG_951_STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

// IndexedDB storage for custom uploaded MP3 clips
const IDB_NAME = 'cbe_dialer_951_audio_v1';
const IDB_STORE = 'audio_clips';

function openAudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
  });
}

export async function saveCustomAudioFile(file: File): Promise<CustomAudioRecord> {
  const db = await openAudioDb();
  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record: CustomAudioRecord & { blob: Blob } = {
    id,
    name: file.name.replace(/\.[^.]+$/, '') || 'Custom MP3',
    mimeType: file.type || 'audio/mpeg',
    size: file.size,
    createdAt: Date.now(),
    blob: file,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Save failed'));
  });
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
  };
}

export async function listCustomAudioFiles(): Promise<CustomAudioRecord[]> {
  try {
    const db = await openAudioDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => {
        const items = Array.isArray(req.result) ? req.result : [];
        resolve(
          items.map((r) => ({
            id: String(r.id),
            name: String(r.name || 'Custom MP3'),
            mimeType: String(r.mimeType || 'audio/mpeg'),
            size: Number(r.size || 0),
            createdAt: Number(r.createdAt || 0),
          }))
        );
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function resolveAudioClipUrl(audioId: string): Promise<string | null> {
  const builtin = BUILTIN_951_AUDIO_CLIPS.find((c) => c.id === audioId);
  if (builtin) return builtin.url;
  try {
    const db = await openAudioDb();
    const record = await new Promise<{ blob?: Blob } | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(audioId);
      req.onsuccess = () => resolve((req.result as { blob?: Blob }) || null);
      req.onerror = () => resolve(null);
    });
    if (record?.blob) {
      return URL.createObjectURL(record.blob);
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteCustomAudioFile(id: string): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
}
