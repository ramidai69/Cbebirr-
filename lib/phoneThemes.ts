export type OemFamily =
  | 'samsung'
  | 'pixel'
  | 'xiaomi'
  | 'tecno'
  | 'infinix'
  | 'oppo'
  | 'realme'
  | 'oneplus'
  | 'vivo'
  | 'huawei'
  | 'motorola'
  | 'nokia'
  | 'lg'
  | 'sony'
  | 'htc'
  | 'asus'
  | 'lenovo'
  | 'tcl'
  | '10or'
  | 'cat'
  | 'iphone';

export type InCallStyle =
  | 'samsung_card'
  | 'samsung_legacy_slider'
  | 'samsung_touchwiz'
  | 'pixel_material'
  | 'xiaomi_hyper'
  | 'xiaomi_miui_pastel'
  | 'xiaomi_miui_blue'
  | 'tecno_hios'
  | 'infinix_teal'
  | 'oppo_coloros'
  | 'vivo_funtouch'
  | 'huawei_emui'
  | 'lg_card'
  | 'sony_xperia'
  | 'htc_sense'
  | 'iphone_ios';

export type MessagesSkinFamily =
  | 'samsung'
  | 'pixel'
  | 'xiaomi'
  | 'tecno'
  | 'oppo'
  | 'huawei';

export interface DeviceThemeInfo {
  manufacturer?: string;
  brand?: string;
  model?: string;
  device?: string;
  sdkInt?: number;
  release?: string;
  darkMode?: boolean;
  fontScale?: number;
  accentColorHex?: string;
  accentContainerHex?: string;
  carrierName?: string;
}

export interface PhoneThemePreset {
  id: string;
  brandTab: string;
  name: string;
  oemFamily: OemFamily;
  inCallStyle: InCallStyle;
  messagesSkin: MessagesSkinFamily;
  darkMode: boolean;
  bgGradient: string;
  cardBg: string;
  cardDarkText: boolean;
  accentColor: string;
  endBtnColor: string;
  answerBtnColor: string;
  avatarBg: string;
  hasCallAssistChip?: boolean;
  dialerHeaderTitle: string;
  dialerNavStyle: 'samsung_underline' | 'pill_icons' | 'classic_icons';
  dialerBg: string;
  dialerSurface: string;
  dialerText: string;
  dialerMuted: string;
  dialerBorder: string;
  dialerDark: boolean;
  dialerKeyStyle: 'open' | 'pill' | 'circle' | 'flat';
}

export const PHONE_THEME_STORAGE_KEY = 'cbebirr_dialer_phone_theme_v1';
export const PHONE_THEME_MODE_KEY = 'cbebirr_dialer_theme_mode_v1'; // 'auto' | 'manual'

export const BRAND_TAB_ORDER: string[] = [
  'SAMSUNG',
  'XIAOMI',
  'OPPO',
  'VIVO',
  'INFINIX',
  'ONEPLUS',
  'HUAWEI',
  'TECNO',
  'MOTOROLA',
  'REALME',
  'LGE',
  'SONY',
  'HMD GLOBAL-NOKIA',
  'HTC',
  'GOOGLE',
  'ASUS',
  '10OR',
  'LENOVO',
  'TCL',
  'CAT(CATERPILLAR)',
  'OTHERS',
];

function makeSamsung(
  id: string,
  name: string,
  inCallStyle: InCallStyle,
  bgGradient: string,
  opts: {
    dark?: boolean;
    cardBg?: string;
    cardDarkText?: boolean;
    callAssist?: boolean;
    accent?: string;
  } = {}
): PhoneThemePreset {
  const isDark = Boolean(opts.dark);
  return {
    id,
    brandTab: 'SAMSUNG',
    name,
    oemFamily: 'samsung',
    inCallStyle,
    messagesSkin: 'samsung',
    darkMode: isDark,
    bgGradient,
    cardBg: opts.cardBg || (isDark ? 'rgba(26, 30, 36, 0.86)' : 'rgba(215, 224, 229, 0.92)'),
    cardDarkText: opts.cardDarkText ?? !isDark,
    accentColor: opts.accent || '#19b264',
    endBtnColor: '#e53935',
    answerBtnColor: '#19b264',
    avatarBg: '#a6c0f5',
    hasCallAssistChip: Boolean(opts.callAssist),
    dialerHeaderTitle: 'Phone',
    dialerNavStyle: 'samsung_underline',
    dialerBg: isDark ? '#0b0c0f' : '#fcfcfc',
    dialerSurface: isDark ? '#17191f' : '#ffffff',
    dialerText: isDark ? '#f3f4f6' : '#111111',
    dialerMuted: isDark ? '#9ca3af' : '#767676',
    dialerBorder: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
    dialerDark: isDark,
    dialerKeyStyle: 'open',
  };
}

function makeXiaomi(
  id: string,
  name: string,
  inCallStyle: InCallStyle,
  bgGradient: string,
  opts: {
    dark?: boolean;
    cardBg?: string;
    cardDarkText?: boolean;
    accent?: string;
    avatarBg?: string;
  } = {}
): PhoneThemePreset {
  const isDark = Boolean(opts.dark);
  return {
    id,
    brandTab: 'XIAOMI',
    name,
    oemFamily: 'xiaomi',
    inCallStyle,
    messagesSkin: 'xiaomi',
    darkMode: isDark,
    bgGradient,
    cardBg: opts.cardBg || (isDark ? 'rgba(24, 27, 34, 0.90)' : 'rgba(255, 255, 255, 0.94)'),
    cardDarkText: opts.cardDarkText ?? !isDark,
    accentColor: opts.accent || '#16c25b',
    endBtnColor: '#e53935',
    answerBtnColor: '#16c25b',
    avatarBg: opts.avatarBg || '#f5a623',
    dialerHeaderTitle: 'Phone',
    dialerNavStyle: 'classic_icons',
    dialerBg: isDark ? '#0e1015' : '#ffffff',
    dialerSurface: isDark ? '#191c24' : '#f5f6f8',
    dialerText: isDark ? '#f4f6fa' : '#15181c',
    dialerMuted: isDark ? '#9aa3b2' : '#737882',
    dialerBorder: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    dialerDark: isDark,
    dialerKeyStyle: 'circle',
  };
}

function makePreset(
  p: Omit<
    PhoneThemePreset,
    | 'dialerHeaderTitle'
    | 'dialerNavStyle'
    | 'dialerBg'
    | 'dialerSurface'
    | 'dialerText'
    | 'dialerMuted'
    | 'dialerBorder'
    | 'dialerDark'
    | 'dialerKeyStyle'
    | 'endBtnColor'
    | 'answerBtnColor'
    | 'avatarBg'
  > &
    Partial<
      Pick<
        PhoneThemePreset,
        | 'dialerHeaderTitle'
        | 'dialerNavStyle'
        | 'dialerBg'
        | 'dialerSurface'
        | 'dialerText'
        | 'dialerMuted'
        | 'dialerBorder'
        | 'dialerDark'
        | 'dialerKeyStyle'
        | 'endBtnColor'
        | 'answerBtnColor'
        | 'avatarBg'
      >
    >
): PhoneThemePreset {
  const isDark = p.darkMode;
  const isGoogleStyle =
    p.oemFamily === 'pixel' ||
    p.oemFamily === 'motorola' ||
    p.oemFamily === 'nokia' ||
    p.oemFamily === 'lenovo';
  return {
    endBtnColor: '#e53935',
    answerBtnColor: '#19b264',
    avatarBg: p.accentColor || '#1976d2',
    dialerHeaderTitle: isGoogleStyle ? 'Search contacts' : 'Phone',
    dialerNavStyle: isGoogleStyle
      ? 'pill_icons'
      : p.oemFamily === 'samsung'
        ? 'samsung_underline'
        : 'classic_icons',
    dialerBg: isDark ? '#111318' : '#fcfcfc',
    dialerSurface: isDark ? '#1d2028' : '#ffffff',
    dialerText: isDark ? '#f3f4f6' : '#121316',
    dialerMuted: isDark ? '#9ca3af' : '#6b7280',
    dialerBorder: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)',
    dialerDark: isDark,
    dialerKeyStyle: isGoogleStyle ? 'pill' : p.oemFamily === 'iphone' ? 'circle' : 'open',
    ...p,
  };
}

export const PHONE_THEME_CATALOG: PhoneThemePreset[] = [
  // ==================== SAMSUNG (Extensive One UI & TouchWiz Catalog) ====================
  makeSamsung('samsung_s23_ultra_14', 'Galaxy S23 Ultra 5G(Android 14+)', 'samsung_card', 'linear-gradient(175deg, #272233 0%, #3a2f4b 52%, #524264 100%)', { dark: true, cardBg: 'rgba(28, 30, 38, 0.85)', cardDarkText: false, callAssist: true }),
  makeSamsung('samsung_s23_ultra', 'Galaxy S23 Ultra 5G', 'samsung_legacy_slider', 'linear-gradient(175deg, #d6e4f2 0%, #c0d2eb 50%, #98b1d6 100%)', { dark: false }),
  makeSamsung('samsung_z_fold_7', 'Galaxy Z Fold 7', 'samsung_legacy_slider', 'linear-gradient(175deg, #323337 0%, #242529 55%, #16171a 100%)', { dark: true, callAssist: true }),
  makeSamsung('samsung_z_fold_6', 'Galaxy Z Fold 6', 'samsung_card', 'linear-gradient(175deg, #1b1530 0%, #261b3e 55%, #120d21 100%)', { dark: true, cardBg: 'rgba(30, 27, 46, 0.82)', cardDarkText: false, callAssist: true }),
  makeSamsung('samsung_z_flip_3', 'Galaxy Z Flip3', 'samsung_card', 'linear-gradient(175deg, #152b2a 0%, #20393b 52%, #131c20 100%)', { dark: true, cardBg: 'rgba(22, 26, 30, 0.85)', cardDarkText: false }),
  makeSamsung('samsung_a35_5g', 'Galaxy A35 5G', 'samsung_legacy_slider', 'linear-gradient(175deg, #1d323a 0%, #274a57 52%, #1d2c36 100%)', { dark: true, callAssist: true }),
  makeSamsung('samsung_a25_5g', 'Galaxy A25 5G', 'samsung_legacy_slider', 'linear-gradient(175deg, #20383f 0%, #2d4d58 55%, #1b2830 100%)', { dark: true, callAssist: true }),
  makeSamsung('samsung_a16_5g', 'Galaxy A16 5G', 'samsung_card', 'linear-gradient(175deg, #6b5239 0%, #524032 55%, #2f251e 100%)', { dark: false, cardBg: 'rgba(235, 224, 214, 0.88)', cardDarkText: true }),
  makeSamsung('samsung_a13', 'Galaxy A13', 'samsung_card', 'linear-gradient(175deg, #1b4f5a 0%, #2a5368 42%, #476e84 100%)', { dark: false, cardBg: 'rgba(215, 224, 229, 0.92)', cardDarkText: true }),
  makeSamsung('samsung_a12_nacho', 'Galaxy A12 Nacho', 'samsung_card', 'linear-gradient(175deg, #0b161b 0%, #102a33 52%, #1a2126 100%)', { dark: true, cardBg: 'rgba(24, 29, 34, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_a12', 'Galaxy A12', 'samsung_card', 'linear-gradient(175deg, #112e36 0%, #163b45 50%, #122126 100%)', { dark: true, cardBg: 'rgba(22, 27, 32, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_a11', 'Galaxy A11', 'samsung_card', 'linear-gradient(175deg, #3c62b5 0%, #3757a3 55%, #2d437a 100%)', { dark: false, cardBg: 'transparent', cardDarkText: false }),
  makeSamsung('samsung_a10', 'Galaxy A10', 'samsung_legacy_slider', 'linear-gradient(175deg, #3d64c4 0%, #3154b0 60%, #284491 100%)', { dark: false }),
  makeSamsung('samsung_a04', 'Galaxy A04', 'samsung_card', 'linear-gradient(175deg, #2b4a3e 0%, #355849 48%, #21342c 100%)', { dark: false, cardBg: 'rgba(229, 234, 229, 0.92)', cardDarkText: true }),
  makeSamsung('samsung_a03s', 'Galaxy A03s', 'samsung_card', 'linear-gradient(175deg, #1e2126 0%, #16181c 55%, #0e1013 100%)', { dark: true, cardBg: 'rgba(26, 28, 33, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_a02s', 'Galaxy A02s', 'samsung_legacy_slider', 'linear-gradient(175deg, #1b4b6e 0%, #173b56 55%, #11293b 100%)', { dark: true }),
  makeSamsung('samsung_a70', 'Galaxy A70', 'samsung_card', 'linear-gradient(175deg, #161c1d 0%, #1d2829 55%, #111516 100%)', { dark: true, cardBg: 'rgba(22, 25, 28, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_a50', 'Galaxy A50', 'samsung_card', 'linear-gradient(175deg, #566454 0%, #445044 55%, #2c332d 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeSamsung('samsung_a32', 'Galaxy A32', 'samsung_card', 'linear-gradient(175deg, #56456b 0%, #423354 55%, #2b2136 100%)', { dark: true, cardBg: 'rgba(28, 26, 36, 0.86)', cardDarkText: false }),
  makeSamsung('samsung_a31', 'Galaxy A31', 'samsung_card', 'linear-gradient(175deg, #275845 0%, #376d58 48%, #214034 100%)', { dark: false, cardBg: 'rgba(224, 232, 228, 0.92)', cardDarkText: true }),
  makeSamsung('samsung_a30', 'Samsung A30', 'samsung_card', 'linear-gradient(175deg, #4f5f57 0%, #3c4a43 55%, #27302c 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeSamsung('samsung_a23', 'Galaxy A23', 'samsung_legacy_slider', 'linear-gradient(175deg, #4b8061 0%, #619675 50%, #a5c4b0 100%)', { dark: false }),
  makeSamsung('samsung_a22', 'Galaxy A22', 'samsung_card', 'linear-gradient(175deg, #242126 0%, #1a181c 55%, #100f12 100%)', { dark: true, cardBg: 'rgba(26, 26, 30, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_a21s', 'Galaxy A21S', 'samsung_legacy_slider', 'linear-gradient(175deg, #627082 0%, #4b5869 55%, #343d4a 100%)', { dark: false }),
  makeSamsung('samsung_a20_11', 'Galaxy A20(Android 11)', 'samsung_card', 'linear-gradient(175deg, #261918 0%, #1c1313 55%, #120c0c 100%)', { dark: true, cardBg: 'rgba(25, 22, 22, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_a20s', 'Galaxy A20S', 'samsung_card', 'linear-gradient(175deg, #3c4d49 0%, #2c3b38 55%, #1d2624 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeSamsung('samsung_a20', 'Galaxy A20', 'samsung_legacy_slider', 'linear-gradient(175deg, #45527a 0%, #374366 55%, #28324d 100%)', { dark: false }),
  makeSamsung('samsung_f22', 'Galaxy F22', 'samsung_card', 'linear-gradient(175deg, #261b26 0%, #1e1721 55%, #120e14 100%)', { dark: true, cardBg: 'rgba(26, 24, 30, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_m13_5g', 'Galaxy M13 5G', 'samsung_legacy_slider', 'linear-gradient(175deg, #101214 0%, #0a0b0d 60%, #050507 100%)', { dark: true }),
  makeSamsung('samsung_m11', 'Galaxy M11', 'samsung_legacy_slider', 'linear-gradient(175deg, #6e6385 0%, #574d6b 55%, #3d354c 100%)', { dark: false }),
  makeSamsung('samsung_note_20_ultra', 'Galaxy Note 20 Ultra 5G', 'samsung_legacy_slider', 'linear-gradient(175deg, #6e633b 0%, #574e2d 55%, #3d361e 100%)', { dark: true }),
  makeSamsung('samsung_s21_ultra', 'Galaxy S21 Ultra 5G', 'samsung_card', 'linear-gradient(175deg, #192923 0%, #131f1b 55%, #0c1411 100%)', { dark: true, cardBg: 'rgba(24, 28, 28, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_note_10_12', 'Note 10(Android 12+)', 'samsung_card', 'linear-gradient(175deg, #3c2920 0%, #2b1d17 55%, #1c130f 100%)', { dark: true, cardBg: 'rgba(28, 24, 22, 0.88)', cardDarkText: false }),
  makeSamsung('samsung_note_10', 'Note 10, 10+', 'samsung_legacy_slider', 'linear-gradient(175deg, #51607a 0%, #404d63 55%, #2d3647 100%)', { dark: false }),
  makeSamsung('samsung_s10', 'Galaxy S10, S10+', 'samsung_legacy_slider', 'linear-gradient(175deg, #3b5bb5 0%, #2f4a99 55%, #233875 100%)', { dark: false }),
  makeSamsung('samsung_note_9', 'Note 9', 'samsung_legacy_slider', 'linear-gradient(175deg, #756b2e 0%, #5e5623 55%, #423c17 100%)', { dark: false }),
  makeSamsung('samsung_s9', 'Galaxy S9, S9+', 'samsung_legacy_slider', 'linear-gradient(175deg, #125866 0%, #0d4550 55%, #083038 100%)', { dark: false }),
  makeSamsung('samsung_note_8', 'Samsung Note 8', 'samsung_legacy_slider', 'linear-gradient(175deg, #7d59b8 0%, #654599 55%, #4a3173 100%)', { dark: false }),
  makeSamsung('samsung_s8_plus', 'Galaxy S8+(SM-G955U1)', 'samsung_card', 'linear-gradient(175deg, #4b5c58 0%, #3a4844 55%, #27302e 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeSamsung('samsung_s8', 'Galaxy S8, S8+', 'samsung_legacy_slider', 'linear-gradient(175deg, #3381cc 0%, #2869a8 55%, #1d4e7d 100%)', { dark: false }),
  makeSamsung('samsung_a9_pro', 'Galaxy A9 Pro', 'samsung_legacy_slider', 'linear-gradient(175deg, #786b2d 0%, #615622 55%, #453d17 100%)', { dark: false }),
  makeSamsung('samsung_a8_plus', 'Galaxy A8 Plus', 'samsung_legacy_slider', 'linear-gradient(175deg, #99795c 0%, #7d6149 55%, #5c4634 100%)', { dark: false }),
  makeSamsung('samsung_a6_plus', 'A6 Plus', 'samsung_legacy_slider', 'linear-gradient(175deg, #19565e 0%, #124249 55%, #0b2d32 100%)', { dark: false }),
  makeSamsung('samsung_a5', 'Galaxy A5', 'samsung_legacy_slider', 'linear-gradient(175deg, #1a5a6e 0%, #134656 55%, #0c313d 100%)', { dark: false }),
  makeSamsung('samsung_j8', 'Galaxy J8(J810G)', 'samsung_legacy_slider', 'linear-gradient(175deg, #566370 0%, #444f59 55%, #2f373f 100%)', { dark: false }),
  makeSamsung('samsung_j7_duo', 'Galaxy J7 Duo', 'samsung_legacy_slider', 'linear-gradient(175deg, #5c573c 0%, #48442e 55%, #333020 100%)', { dark: false }),
  makeSamsung('samsung_j7_prime', 'Galaxy J7 Prime', 'samsung_legacy_slider', 'linear-gradient(175deg, #454969 0%, #353954 55%, #25283b 100%)', { dark: false }),
  makeSamsung('samsung_j6_plus', 'Galaxy J6+', 'samsung_legacy_slider', 'linear-gradient(175deg, #2d738a 0%, #225a6d 55%, #173f4d 100%)', { dark: false }),
  makeSamsung('samsung_j6', 'Galaxy J6', 'samsung_legacy_slider', 'linear-gradient(175deg, #485b69 0%, #374652 55%, #253038 100%)', { dark: false }),
  makeSamsung('samsung_j4', 'Galaxy J4(J400F)', 'samsung_legacy_slider', 'linear-gradient(175deg, #4c5769 0%, #3b4452 55%, #282f3a 100%)', { dark: false }),
  makeSamsung('samsung_j3', 'Galaxy J3', 'samsung_legacy_slider', 'linear-gradient(175deg, #748594 0%, #5c6a78 55%, #424d57 100%)', { dark: false }),
  makeSamsung('samsung_j2', 'Galaxy J2', 'samsung_touchwiz', 'linear-gradient(175deg, #78b33c 0%, #689f38 45%, #ffffff 45%, #ffffff 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeSamsung('samsung_note_5', 'Note 5', 'samsung_touchwiz', 'linear-gradient(175deg, #7cb342 0%, #689f38 42%, #ffffff 42%, #ffffff 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeSamsung('samsung_s7_plus', 'Galaxy S7 Plus', 'samsung_legacy_slider', 'linear-gradient(175deg, #4f5f6e 0%, #3d4a57 55%, #2a333d 100%)', { dark: false }),
  makeSamsung('samsung_s7', 'Galaxy S7', 'samsung_touchwiz', 'linear-gradient(175deg, #7cb342 0%, #689f38 42%, #ffffff 42%, #ffffff 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeSamsung('samsung_note_4', 'Note 4', 'samsung_touchwiz', 'linear-gradient(175deg, #6da335 0%, #558b2f 40%, #9abcc7 40%, #9abcc7 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeSamsung('samsung_s6', 'Galaxy S6', 'samsung_touchwiz', 'linear-gradient(175deg, #7cb342 0%, #689f38 42%, #ffffff 42%, #ffffff 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeSamsung('samsung_s5', 'Galaxy S5', 'samsung_touchwiz', 'linear-gradient(175deg, #5d8c31 0%, #4e7828 36%, #9cbcc7 36%, #24333b 100%)', { dark: false, cardBg: '#1b262c', cardDarkText: false }),
  makeSamsung('samsung_s4', 'Galaxy S4 GT-I9505', 'samsung_touchwiz', 'linear-gradient(175deg, #6fa33a 0%, #58852b 36%, #dce2e6 36%, #212529 100%)', { dark: true, cardBg: '#1d2024', cardDarkText: false }),

  // ==================== XIAOMI / REDMI / POCO ====================
  makeXiaomi('xiaomi_note_14_pro', 'Redmi Note 14 Pro', 'xiaomi_hyper', 'linear-gradient(175deg, #211618 0%, #191214 55%, #0e0b0c 100%)', { dark: true, cardBg: 'rgba(30, 26, 28, 0.90)', cardDarkText: false }),
  makeXiaomi('xiaomi_redmi_14c', 'Redmi 14C', 'xiaomi_hyper', 'linear-gradient(175deg, #1b171b 0%, #141114 55%, #0d0b0d 100%)', { dark: true, cardBg: 'rgba(28, 25, 29, 0.90)', cardDarkText: false }),
  makeXiaomi('xiaomi_note_13', 'Redmi Note 13', 'xiaomi_hyper', 'linear-gradient(175deg, #1c191a 0%, #141213 55%, #0c0b0c 100%)', { dark: true, cardBg: 'rgba(27, 25, 27, 0.90)', cardDarkText: false }),
  makeXiaomi('xiaomi_redmi_13c', 'Redmi 13C', 'xiaomi_hyper', 'linear-gradient(175deg, #fcfcfc 0%, #f4f6f9 65%, #ebeff5 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true, avatarBg: '#f9b932' }),
  makeXiaomi('xiaomi_note_10s', 'Redmi Note 10S', 'xiaomi_hyper', 'linear-gradient(175deg, #181a1c 0%, #121315 55%, #0a0b0c 100%)', { dark: true, cardBg: 'rgba(25, 27, 30, 0.90)', cardDarkText: false }),
  makeXiaomi('xiaomi_redmi_10a', 'Redmi 10A', 'xiaomi_hyper', 'linear-gradient(175deg, #ffffff 0%, #f6f7f9 65%, #edf0f5 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeXiaomi('xiaomi_note_9_pro_max', 'Redmi Note 9 Pro Max', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #4f1d28 0%, #3b1c24 55%, #201215 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_note_9_pro', 'Redmi Note 9 Pro', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #98a2ad 0%, #7d8791 55%, #5c646b 100%)', { dark: false, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_note_9t_5g', 'Redmi Note 9T 5G', 'xiaomi_hyper', 'linear-gradient(175deg, #ffffff 0%, #f5f7fa 65%, #eaeff5 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true, avatarBg: '#9c4dff' }),
  makeXiaomi('xiaomi_redmi_9', 'Redmi 9', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #692338 0%, #521d2d 55%, #30121c 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_redmi_9t', 'Redmi 9T(LATAM)', 'xiaomi_hyper', 'linear-gradient(175deg, #212429 0%, #17191d 55%, #0e1012 100%)', { dark: true, cardBg: 'rgba(26, 28, 33, 0.92)', cardDarkText: false }),
  makeXiaomi('xiaomi_k20_pro', 'Redmi K20 Pro', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #161618 0%, #101012 60%, #09090a 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_note_8t', 'Redmi Note 8T', 'xiaomi_hyper', 'linear-gradient(175deg, #1c1e24 0%, #14151a 55%, #0c0d10 100%)', { dark: true, cardBg: 'rgba(26, 28, 34, 0.92)', cardDarkText: false, avatarBg: '#7e3ff2' }),
  makeXiaomi('xiaomi_note_7_pro', 'Redmi Note 7 Pro', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #3c1f2b 0%, #2a1820 55%, #1a1015 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_note_7_10', 'Redmi Note 7(Android 10+)', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #313d26 0%, #252e1e 55%, #171c13 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_note_7', 'Redmi Note 7', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #d7d4e6 0%, #f2d4cf 50%, #e0b9a9 100%)', { dark: false, cardBg: 'transparent', cardDarkText: true }),
  makeXiaomi('xiaomi_redmi_5_plus', 'Redmi Note 5 Pro', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1f487a 55%, #153154 100%)', { dark: true }),
  makeXiaomi('xiaomi_redmi_5a', 'Redmi 5A', 'xiaomi_miui_blue', 'linear-gradient(160deg, #295c9e 0%, #1f4b82 55%, #163359 100%)', { dark: true }),
  makeXiaomi('xiaomi_redmi_5', 'Redmi 5', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1d4678 55%, #143052 100%)', { dark: true }),
  makeXiaomi('xiaomi_redmi_4a', 'Redmi 4A', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #2c2d32 0%, #212226 55%, #141518 100%)', { dark: true, cardBg: 'transparent', cardDarkText: false }),
  makeXiaomi('xiaomi_redmi_note_4', 'Redmi Note 4', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1e477b 55%, #143054 100%)', { dark: true }),
  makeXiaomi('xiaomi_redmi_4', 'Redmi 4', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1e477b 55%, #143054 100%)', { dark: true }),
  makeXiaomi('xiaomi_redmi_3s', 'Redmi 3S', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1e477b 55%, #143054 100%)', { dark: true }),
  makeXiaomi('xiaomi_note_3', 'Redmi Note 3', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1e477b 55%, #143054 100%)', { dark: true }),
  makeXiaomi('xiaomi_redmi_3', 'Redmi 3', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1e477b 55%, #143054 100%)', { dark: true }),
  makeXiaomi('xiaomi_poco_m4_5g', 'Poco M4 5G', 'xiaomi_hyper', 'linear-gradient(175deg, #ffffff 0%, #f5f7fa 65%, #ecf0f6 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true, avatarBg: '#eab308' }),
  makeXiaomi('xiaomi_poco_m3', 'Poco M3', 'xiaomi_hyper', 'linear-gradient(175deg, #1b1d22 0%, #121418 55%, #0a0b0e 100%)', { dark: true, cardBg: 'rgba(26, 28, 34, 0.90)', cardDarkText: false, avatarBg: '#0ea5e9' }),
  makeXiaomi('xiaomi_poco_x3_nfc', 'Poco X3 NFC', 'xiaomi_hyper', 'linear-gradient(175deg, #ffffff 0%, #f5f7fa 65%, #ecf0f6 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeXiaomi('xiaomi_poco_f1', 'Pocophone F1', 'xiaomi_hyper', 'linear-gradient(175deg, #141518 0%, #0d0e10 60%, #070708 100%)', { dark: true, cardBg: 'rgba(24, 26, 30, 0.90)', cardDarkText: false }),
  makeXiaomi('xiaomi_mi_a3', 'Mi A3', 'pixel_material', 'linear-gradient(175deg, #202124 0%, #18191c 55%, #101113 100%)', { dark: true, cardBg: 'rgba(32, 33, 36, 0.92)', cardDarkText: false, avatarBg: '#f97316' }),
  makeXiaomi('xiaomi_mi_a2', 'Mi A2', 'pixel_material', 'linear-gradient(175deg, #ffffff 0%, #f7f8fa 65%, #eff1f5 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true, avatarBg: '#d97706' }),
  makeXiaomi('xiaomi_mi_a1', 'Mi A1', 'pixel_material', 'linear-gradient(175deg, #ffffff 0%, #f7f8fa 65%, #eff1f5 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true, avatarBg: '#d97706' }),
  makeXiaomi('xiaomi_mi_note_10_lite', 'Mi Note 10 Lite', 'xiaomi_hyper', 'linear-gradient(175deg, #ffffff 0%, #f6f7f9 65%, #eef1f5 100%)', { dark: false, cardBg: '#ffffff', cardDarkText: true }),
  makeXiaomi('xiaomi_mi_8', 'Mi 8', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #bcd9ec 0%, #dce6f7 48%, #f1d9eb 100%)', { dark: false, cardBg: 'transparent', cardDarkText: true }),
  makeXiaomi('xiaomi_redmi_y2', 'Redmi Y2', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #d6d3e6 0%, #f2d4cd 48%, #deb8a6 100%)', { dark: false, cardBg: 'transparent', cardDarkText: true }),
  makeXiaomi('xiaomi_mi_5x', 'Mi 5X', 'xiaomi_miui_pastel', 'linear-gradient(175deg, #b8b8ba 0%, #9c9c9e 55%, #7a7a7c 100%)', { dark: false, cardBg: 'transparent', cardDarkText: true }),
  makeXiaomi('xiaomi_mi_4w', 'Mi 4W', 'xiaomi_miui_blue', 'linear-gradient(160deg, #275896 0%, #1e477b 55%, #143054 100%)', { dark: true }),

  // ==================== OPPO ====================
  makePreset({ id: 'oppo_reno7_z_5g', brandTab: 'OPPO', name: 'Reno7 Z 5G', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #101114 0%, #0a0b0d 60%, #050506 100%)', cardBg: 'rgba(26, 28, 33, 0.90)', cardDarkText: false, accentColor: '#19b264' }),
  makePreset({ id: 'oppo_reno7_4g', brandTab: 'OPPO', name: 'Reno7 4G', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: false, bgGradient: 'linear-gradient(175deg, #f3f7d4 0%, #eef2ca 60%, #e5eabf 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#16c25b', avatarBg: '#9333ea' }),
  makePreset({ id: 'oppo_a77s', brandTab: 'OPPO', name: 'A77s', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f6f7fa 65%, #edf0f5 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#16c25b', avatarBg: '#9333ea' }),
  makePreset({ id: 'oppo_a76', brandTab: 'OPPO', name: 'A76', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1d1e22 0%, #141518 60%, #0c0d0f 100%)', cardBg: 'rgba(28, 30, 36, 0.90)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_a74', brandTab: 'OPPO', name: 'A74', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #27292e 0%, #1c1e22 55%, #111215 100%)', cardBg: 'rgba(30, 32, 38, 0.90)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_a53s_12', brandTab: 'OPPO', name: 'A53s(Android 12 above)', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #232026 0%, #18161b 55%, #0e0d10 100%)', cardBg: 'rgba(28, 26, 33, 0.90)', cardDarkText: false, accentColor: '#16c25b', avatarBg: '#9333ea' }),
  makePreset({ id: 'oppo_a53s', brandTab: 'OPPO', name: 'A53s', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #232924 0%, #181d19 55%, #0f1210 100%)', cardBg: 'rgba(26, 30, 28, 0.90)', cardDarkText: false, accentColor: '#16c25b', avatarBg: '#22c55e' }),
  makePreset({ id: 'oppo_a52', brandTab: 'OPPO', name: 'A52', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #101114 0%, #090a0c 60%, #040405 100%)', cardBg: 'rgba(24, 26, 30, 0.92)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_a9_2020', brandTab: 'OPPO', name: 'A9(2020)', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #131418 0%, #0b0c0e 60%, #050506 100%)', cardBg: 'rgba(24, 25, 30, 0.90)', cardDarkText: false, accentColor: '#16c25b', avatarBg: '#e11d48' }),
  makePreset({ id: 'oppo_f19s', brandTab: 'OPPO', name: 'F19s', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #242126 0%, #19171b 55%, #0f0e10 100%)', cardBg: 'rgba(28, 26, 32, 0.90)', cardDarkText: false, accentColor: '#16c25b', avatarBg: '#9333ea' }),
  makePreset({ id: 'oppo_f9_pro', brandTab: 'OPPO', name: 'F9 Pro', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #4b2429 0%, #33191c 55%, #1d0f11 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_f7', brandTab: 'OPPO', name: 'F7', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #2f3b2b 0%, #222b1f 55%, #131811 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_f5', brandTab: 'OPPO', name: 'F5', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #17344a 0%, #102536 55%, #091520 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_f1s', brandTab: 'OPPO', name: 'F1s', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #4a1c22 0%, #311217 55%, #1c0a0d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_f1', brandTab: 'OPPO', name: 'F1', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #3b1e40 0%, #27132b 55%, #150a18 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#f97316' }),
  makePreset({ id: 'oppo_a71', brandTab: 'OPPO', name: 'A71(2018)', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #756b6d 0%, #524a4c 55%, #2f2a2b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_a3s', brandTab: 'OPPO', name: 'A3s', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #3b2621 0%, #271916 55%, #140d0b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oppo_neo_9', brandTab: 'OPPO', name: 'Neo 9 (A37F)', oemFamily: 'oppo', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #2d424a 0%, #1f2e34 55%, #111a1d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),

  // ==================== REALME ====================
  makePreset({ id: 'realme_c21y', brandTab: 'REALME', name: 'Realme C21Y 4G', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #262529 0%, #1a191c 55%, #0f0e10 100%)', cardBg: 'rgba(28, 28, 34, 0.90)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'realme_8s_5g', brandTab: 'REALME', name: 'Realme 8s 5G', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1b1d1c 0%, #121413 55%, #0a0b0a 100%)', cardBg: 'rgba(26, 29, 28, 0.90)', cardDarkText: false, accentColor: '#16c25b', avatarBg: '#16a34a' }),
  makePreset({ id: 'realme_narzo_50a', brandTab: 'REALME', name: 'Realme Narzo 50A', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #302821 0%, #211c17 55%, #13100d 100%)', cardBg: 'rgba(28, 25, 22, 0.90)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'realme_8', brandTab: 'REALME', name: 'Realme 8', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #26252b 0%, #1a191e 55%, #0e0e11 100%)', cardBg: 'rgba(26, 26, 32, 0.90)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'realme_x2', brandTab: 'REALME', name: 'Realme X2', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #141914 0%, #0d110d 55%, #070907 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b', avatarBg: '#65a30d' }),
  makePreset({ id: 'realme_6', brandTab: 'REALME', name: 'Realme 6', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #3b3022 0%, #272017 55%, #14100b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#ea580c', avatarBg: '#c2410c' }),
  makePreset({ id: 'realme_2', brandTab: 'REALME', name: 'Realme 2', oemFamily: 'realme', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #2d424a 0%, #1e2d33 55%, #111a1d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),

  // ==================== ONEPLUS ====================
  makePreset({ id: 'oneplus_nord_n200', brandTab: 'ONEPLUS', name: 'OnePlus Nord N200 5G', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #14533c 0%, #0d3a29 55%, #062117 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_8_pro_11', brandTab: 'ONEPLUS', name: 'OnePlus 8 Pro(Android 11)', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #291c3d 0%, #1d142b 55%, #110c1a 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_nord_2', brandTab: 'ONEPLUS', name: 'OnePlus Nord 2 5G', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1e1e20 0%, #141416 55%, #0a0a0b 100%)', cardBg: 'rgba(26, 26, 30, 0.90)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_8_pro', brandTab: 'ONEPLUS', name: 'OnePlus 8 Pro', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1d3b2b 0%, #142b1f 55%, #0b1811 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_8', brandTab: 'ONEPLUS', name: 'OnePlus 8', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #19596e 0%, #113e4d 55%, #09252e 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_7t_pro', brandTab: 'ONEPLUS', name: 'OnePlus 7T Pro', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #183d2e 0%, #102b20 55%, #081812 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_7t', brandTab: 'ONEPLUS', name: 'OnePlus 7T', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1c2c38 0%, #131f28 55%, #0a1116 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_7_pro', brandTab: 'ONEPLUS', name: 'OnePlus 7 Pro', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #18141a 0%, #100d12 55%, #080609 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_6t', brandTab: 'ONEPLUS', name: 'OnePlus 6T', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #272433 0%, #1b1924 55%, #100f16 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_6', brandTab: 'ONEPLUS', name: 'OnePlus 6', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #121514 0%, #0b0d0c 55%, #050605 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: 'oneplus_5', brandTab: 'ONEPLUS', name: 'OnePlus 5', oemFamily: 'oneplus', inCallStyle: 'oppo_coloros', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #4f4e2b 0%, #38371e 55%, #202011 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16c25b' }),

  // ==================== TECNO (Ethiopia/Africa Hero Brand) ====================
  makePreset({ id: 'tecno_spark_10c', brandTab: 'TECNO', name: 'Spark 10C', oemFamily: 'tecno', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #141214 0%, #0d0c0d 55%, #060606 100%)', cardBg: 'rgba(26, 26, 30, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'tecno_pop_7', brandTab: 'TECNO', name: 'Pop 7', oemFamily: 'tecno', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #2f3b32 0%, #202923 55%, #111713 100%)', cardBg: 'rgba(25, 32, 28, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'tecno_spark_9t', brandTab: 'TECNO', name: 'Spark 9T', oemFamily: 'tecno', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #2e3440 0%, #20252e 55%, #13161c 100%)', cardBg: 'rgba(26, 29, 36, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'tecno_spark_8c', brandTab: 'TECNO', name: 'Spark 8C', oemFamily: 'tecno', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #141214 0%, #0d0c0d 55%, #060606 100%)', cardBg: 'rgba(24, 24, 28, 0.90)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'tecno_spark_4', brandTab: 'TECNO', name: 'Spark 4 (KC8)', oemFamily: 'tecno', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00897b 0%, #00796b 60%, #005b4f 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),
  makePreset({ id: 'tecno_camon_15', brandTab: 'TECNO', name: 'Camon 15(CD7)', oemFamily: 'tecno', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #695968 0%, #4d404c 55%, #2d252c 100%)', cardBg: 'rgba(30, 26, 30, 0.85)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'tecno_ca7', brandTab: 'TECNO', name: 'TECNO CA7', oemFamily: 'tecno', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #009688 0%, #00796b 65%, #005f56 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),
  makePreset({ id: 'tecno_cc7', brandTab: 'TECNO', name: 'TECNO CC7', oemFamily: 'tecno', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #4b5d69 0%, #37454e 55%, #222b30 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'tecno_kb7', brandTab: 'TECNO', name: 'TECNO KB7', oemFamily: 'tecno', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #009688 0%, #00796b 65%, #005f56 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),
  makePreset({ id: 'tecno_cf7', brandTab: 'TECNO', name: 'TECNO CF7', oemFamily: 'tecno', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00897b 0%, #00796b 65%, #005b4f 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),

  // ==================== INFINIX ====================
  makePreset({ id: 'infinix_zero_30_5g', brandTab: 'INFINIX', name: 'Zero 30 5G', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #324a4f 0%, #24363a 55%, #152022 100%)', cardBg: 'rgba(26, 34, 36, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_smart_8', brandTab: 'INFINIX', name: 'Smart 8', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #3d2e1e 0%, #261d13 55%, #120e09 100%)', cardBg: 'rgba(28, 24, 20, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_hot_30i', brandTab: 'INFINIX', name: 'Hot 30i', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #364e63 0%, #263847 55%, #162029 100%)', cardBg: 'rgba(24, 32, 40, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_note_12_g96', brandTab: 'INFINIX', name: 'Note 12 G96', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #27344d 0%, #1c2638 55%, #101621 100%)', cardBg: 'rgba(22, 28, 40, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_hot_11s', brandTab: 'INFINIX', name: 'Hot 11s', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #2a2463 0%, #1d1947 55%, #110e29 100%)', cardBg: 'rgba(24, 22, 44, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_hot_11', brandTab: 'INFINIX', name: 'Hot 11', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #364e63 0%, #263847 55%, #162029 100%)', cardBg: 'rgba(24, 32, 40, 0.88)', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_note_7', brandTab: 'INFINIX', name: 'Note 7', oemFamily: 'infinix', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00778a 0%, #006070 60%, #004754 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),
  makePreset({ id: 'infinix_hot_8', brandTab: 'INFINIX', name: 'Hot 8', oemFamily: 'infinix', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #006a78 0%, #005460 60%, #003e47 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),
  makePreset({ id: 'infinix_note_4', brandTab: 'INFINIX', name: 'Note 4', oemFamily: 'infinix', inCallStyle: 'samsung_touchwiz', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00b8d4 0%, #00acc1 68%, #ffffff 68%, #ffffff 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#00acc1' }),
  makePreset({ id: 'infinix_hot_6', brandTab: 'INFINIX', name: 'Hot 6', oemFamily: 'infinix', inCallStyle: 'infinix_teal', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00697a 0%, #005361 60%, #003b45 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00a884' }),
  makePreset({ id: 'infinix_hot_5', brandTab: 'INFINIX', name: 'Hot 5', oemFamily: 'infinix', inCallStyle: 'samsung_touchwiz', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00b8d4 0%, #00acc1 65%, #ffffff 65%, #ffffff 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#00acc1' }),
  makePreset({ id: 'infinix_hot_note', brandTab: 'INFINIX', name: 'Hot Note', oemFamily: 'infinix', inCallStyle: 'samsung_touchwiz', messagesSkin: 'tecno', darkMode: false, bgGradient: 'linear-gradient(175deg, #00796b 0%, #00695c 28%, #54595e 28%, #2e3236 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00796b' }),
  makePreset({ id: 'infinix_s5_lite', brandTab: 'INFINIX', name: 'S5 Lite', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #626b6e 0%, #484f52 55%, #2b3033 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16b978' }),
  makePreset({ id: 'infinix_zero_5', brandTab: 'INFINIX', name: 'Zero 5', oemFamily: 'infinix', inCallStyle: 'tecno_hios', messagesSkin: 'tecno', darkMode: true, bgGradient: 'linear-gradient(175deg, #6b5e54 0%, #4d433c 55%, #2c2622 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#16b978' }),

  // ==================== HUAWEI / HONOR ====================
  makePreset({ id: 'huawei_p30_pro', brandTab: 'HUAWEI', name: 'P30 Pro', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #1b1d20 0%, #101214 55%, #070809 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_mate_20_pro', brandTab: 'HUAWEI', name: 'Mate 20 Pro', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #1e4252 0%, #1a473e 52%, #13253b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_nova_5t', brandTab: 'HUAWEI', name: 'Nova 5T', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #27221d 0%, #3d382b 45%, #161512 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_nova_3i', brandTab: 'HUAWEI', name: 'Nova 3i', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #193852 0%, #12283b 55%, #0b1824 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_honor_8x', brandTab: 'HUAWEI', name: 'Honor 8X', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #627894 0%, #364e6e 52%, #1c2c42 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_y9', brandTab: 'HUAWEI', name: 'Y9', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #697a6b 0%, #4c594e 55%, #2b332d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_y7', brandTab: 'HUAWEI', name: 'Y7', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #3b4046 0%, #2a2e33 55%, #181a1d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_y6_pro', brandTab: 'HUAWEI', name: 'Y6 Pro(2019)', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #1d3c57 0%, #152b40 55%, #0d1a27 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_p9', brandTab: 'HUAWEI', name: 'P9', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #2d3842 0%, #20282f 55%, #13181c 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_g7_plus', brandTab: 'HUAWEI', name: 'G7 Plus', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #33193d 0%, #23112b 55%, #140919 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_honor_4c', brandTab: 'HUAWEI', name: 'Honor 4C', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #3c3e3b 0%, #2b2c2a 55%, #191a19 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),
  makePreset({ id: 'huawei_y3', brandTab: 'HUAWEI', name: 'Y3', oemFamily: 'huawei', inCallStyle: 'huawei_emui', messagesSkin: 'huawei', darkMode: true, bgGradient: 'linear-gradient(175deg, #272221 0%, #1b1716 55%, #0f0c0b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#0a59f7' }),

  // ==================== VIVO ====================
  makePreset({ id: 'vivo_v27_5g', brandTab: 'VIVO', name: 'V27 5G', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #24455e 0%, #193142 55%, #0f1e29 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_x50', brandTab: 'VIVO', name: 'X50', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #423522 0%, #2e2517 55%, #1a150d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_v2111', brandTab: 'VIVO', name: 'V2111', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #2b4c63 0%, #1e3647 55%, #11202b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_y95', brandTab: 'VIVO', name: 'Y95', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1a354d 0%, #122638 55%, #0a1621 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_v1901a', brandTab: 'VIVO', name: 'V1901A', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #173047 0%, #102132 55%, #09131d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_y93', brandTab: 'VIVO', name: 'Y93', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1c3245 0%, #132330 55%, #0b141c 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_v15_pro', brandTab: 'VIVO', name: 'V15 Pro', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1a354d 0%, #122638 55%, #0a1621 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_v11_pro', brandTab: 'VIVO', name: 'V11 Pro', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #625d69 0%, #45414a 55%, #28262b 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_y90', brandTab: 'VIVO', name: 'Y90', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #4f4b52 0%, #38353a 55%, #201e21 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_y71', brandTab: 'VIVO', name: 'Y71', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1a354d 0%, #122638 55%, #0a1621 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),
  makePreset({ id: 'vivo_y12g', brandTab: 'VIVO', name: 'Y12G', oemFamily: 'vivo', inCallStyle: 'vivo_funtouch', messagesSkin: 'oppo', darkMode: true, bgGradient: 'linear-gradient(175deg, #1f3245 0%, #152330 55%, #0c141c 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),

  // ==================== GOOGLE PIXEL ====================
  makePreset({ id: 'google_pixel_8', brandTab: 'GOOGLE', name: 'Pixel 8', oemFamily: 'pixel', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8fafc 65%, #f1f5f9 100%)', cardBg: '#f3f6fc', cardDarkText: true, accentColor: '#1a73e8' }),
  makePreset({ id: 'google_pixel_8_dark', brandTab: 'GOOGLE', name: 'Pixel 8 (Dark Mode)', oemFamily: 'pixel', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #17191d 0%, #121417 65%, #0c0d0f 100%)', cardBg: 'rgba(38, 42, 50, 0.92)', cardDarkText: false, accentColor: '#8ab4f8' }),
  makePreset({ id: 'google_pixel_2_xl', brandTab: 'GOOGLE', name: 'Pixel 2 XL', oemFamily: 'pixel', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8f9fa 65%, #f1f3f4 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#1a73e8', avatarBg: '#ef4444' }),
  makePreset({ id: 'google_pixel_2', brandTab: 'GOOGLE', name: 'Pixel 2', oemFamily: 'pixel', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8f9fa 65%, #f1f3f4 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#1a73e8' }),

  // ==================== MOTOROLA ====================
  makePreset({ id: 'moto_e40', brandTab: 'MOTOROLA', name: 'Moto E40', oemFamily: 'motorola', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8fafc 65%, #eff3f8 100%)', cardBg: '#f3f6fc', cardDarkText: true, accentColor: '#1a73e8' }),
  makePreset({ id: 'moto_g22', brandTab: 'MOTOROLA', name: 'Moto G22', oemFamily: 'motorola', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8fafc 65%, #eff3f8 100%)', cardBg: '#f3f6fc', cardDarkText: true, accentColor: '#1a73e8', avatarBg: '#f97316' }),
  makePreset({ id: 'moto_g5_plus', brandTab: 'MOTOROLA', name: 'G(5) Plus', oemFamily: 'motorola', inCallStyle: 'infinix_teal', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #00695c 0%, #00574b 60%, #00433a 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00897b', avatarBg: '#3b82f6' }),
  makePreset({ id: 'moto_z2_play', brandTab: 'MOTOROLA', name: 'Z2 Play', oemFamily: 'motorola', inCallStyle: 'infinix_teal', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #00695c 0%, #00574b 60%, #00433a 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00897b' }),
  makePreset({ id: 'moto_g5s_plus', brandTab: 'MOTOROLA', name: 'G(5S) Plus', oemFamily: 'motorola', inCallStyle: 'infinix_teal', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #00695c 0%, #00574b 60%, #00433a 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00897b' }),
  makePreset({ id: 'moto_x4', brandTab: 'MOTOROLA', name: 'X4', oemFamily: 'motorola', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #5c5761 0%, #423e46 55%, #262429 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8' }),

  // ==================== NOKIA ====================
  makePreset({ id: 'nokia_c21_plus', brandTab: 'HMD GLOBAL-NOKIA', name: 'Nokia C21 Plus', oemFamily: 'nokia', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #1b1d20 0%, #131517 60%, #0a0b0d 100%)', cardBg: 'rgba(32, 34, 38, 0.92)', cardDarkText: false, accentColor: '#1a73e8', avatarBg: '#dc2626' }),
  makePreset({ id: 'nokia_4_2', brandTab: 'HMD GLOBAL-NOKIA', name: 'Nokia 4.2', oemFamily: 'nokia', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #212226 0%, #17181b 60%, #0e0f11 100%)', cardBg: 'rgba(32, 34, 38, 0.92)', cardDarkText: false, accentColor: '#1a73e8', avatarBg: '#ea580c' }),
  makePreset({ id: 'nokia_6_1_plus', brandTab: 'HMD GLOBAL-NOKIA', name: 'Nokia 6.1 Plus', oemFamily: 'nokia', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #1c222e 0%, #141821 60%, #0c0e14 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#1a73e8', avatarBg: '#f97316' }),
  makePreset({ id: 'nokia_3', brandTab: 'HMD GLOBAL-NOKIA', name: 'Nokia 3', oemFamily: 'nokia', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8f9fa 65%, #f1f3f4 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#1a73e8' }),
  makePreset({ id: 'nokia_1', brandTab: 'HMD GLOBAL-NOKIA', name: 'Nokia 1', oemFamily: 'nokia', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #212224 0%, #17181a 60%, #0e0f10 100%)', cardBg: 'rgba(32, 34, 38, 0.92)', cardDarkText: false, accentColor: '#1a73e8', avatarBg: '#b91c1c' }),

  // ==================== LGE / SONY / HTC / ASUS / LENOVO / TCL / 10OR / CAT / OTHERS ====================
  makePreset({ id: 'lg_q9', brandTab: 'LGE', name: 'LG Q9', oemFamily: 'lg', inCallStyle: 'lg_card', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #f2f2f2 0%, #e5e7eb 65%, #d1d5db 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#10b981' }),
  makePreset({ id: 'lg_k40', brandTab: 'LGE', name: 'LG K40', oemFamily: 'lg', inCallStyle: 'lg_card', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #9ca3af 0%, #868e99 60%, #6b7280 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#10b981' }),
  makePreset({ id: 'lg_v30', brandTab: 'LGE', name: 'LG V30', oemFamily: 'lg', inCallStyle: 'lg_card', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #27223d 0%, #1d192e 55%, #110e1c 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#22c55e' }),
  makePreset({ id: 'lg_g6', brandTab: 'LGE', name: 'LG G6', oemFamily: 'lg', inCallStyle: 'lg_card', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #3b7537 0%, #2e5c2b 60%, #1f401d 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#22c55e' }),
  makePreset({ id: 'sony_z5', brandTab: 'SONY', name: 'Xperia Z5 Premium Dual', oemFamily: 'sony', inCallStyle: 'sony_xperia', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #262930 0%, #1c1e24 55%, #111317 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#eab308', avatarBg: '#eab308' }),
  makePreset({ id: 'sony_xa2', brandTab: 'SONY', name: 'XPERIA XA2 ULTRA DUAL', oemFamily: 'sony', inCallStyle: 'sony_xperia', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #00796b 0%, #00695c 60%, #004d40 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#14b8a6' }),
  makePreset({ id: 'sony_xa1_plus', brandTab: 'SONY', name: 'XPERIA XA1 Plus', oemFamily: 'sony', inCallStyle: 'sony_xperia', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #4c3b8c 0%, #3d2e73 60%, #2a1e52 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#6d28d9' }),
  makePreset({ id: 'htc_m8', brandTab: 'HTC', name: 'One M8/M8s', oemFamily: 'htc', inCallStyle: 'htc_sense', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #1565c0 0%, #1565c0 12%, #37474f 12%, #37474f 44%, #ffffff 44%, #ffffff 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#1565c0' }),
  makePreset({ id: 'htc_a9', brandTab: 'HTC', name: 'One A9', oemFamily: 'htc', inCallStyle: 'htc_sense', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #9e1c20 0%, #9e1c20 12%, #424242 12%, #424242 44%, #ffffff 44%, #ffffff 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#b91c1c' }),
  makePreset({ id: 'asus_max_pro', brandTab: 'ASUS', name: 'Zenfone Max Pro(M1)', oemFamily: 'asus', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #ffffff 0%, #f8fafc 65%, #f1f5f9 100%)', cardBg: '#ffffff', cardDarkText: true, accentColor: '#f97316', avatarBg: '#f97316' }),
  makePreset({ id: 'asus_max', brandTab: 'ASUS', name: 'Zenfone Max', oemFamily: 'asus', inCallStyle: 'infinix_teal', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #1b6b5c 0%, #145246 60%, #0d3830 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#10b981' }),
  makePreset({ id: 'lenovo_a6_note', brandTab: 'LENOVO', name: 'Lenovo A6 Note', oemFamily: 'lenovo', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #1c1e22 0%, #14161a 60%, #0c0d10 100%)', cardBg: 'rgba(28, 30, 35, 0.92)', cardDarkText: false, accentColor: '#ea580c', avatarBg: '#ea580c' }),
  makePreset({ id: 'tcl_alcatel_u5', brandTab: 'TCL', name: 'Alcatel U5', oemFamily: 'tcl', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #27272a 0%, #1c1c1f 60%, #111113 100%)', cardBg: 'rgba(32, 32, 36, 0.92)', cardDarkText: false, accentColor: '#16c25b' }),
  makePreset({ id: '10or_g', brandTab: '10OR', name: '10.or G', oemFamily: '10or', inCallStyle: 'infinix_teal', messagesSkin: 'pixel', darkMode: false, bgGradient: 'linear-gradient(175deg, #00796b 0%, #00695c 60%, #004d40 100%)', cardBg: 'transparent', cardDarkText: false, accentColor: '#00897b' }),
  makePreset({ id: 'cat_s42', brandTab: 'CAT(CATERPILLAR)', name: 'S42', oemFamily: 'cat', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #212224 0%, #17181a 60%, #0e0f10 100%)', cardBg: 'rgba(32, 34, 38, 0.92)', cardDarkText: false, accentColor: '#06b6d4', avatarBg: '#22d3ee' }),
  makePreset({ id: 'others_android', brandTab: 'OTHERS', name: 'Android', oemFamily: 'pixel', inCallStyle: 'pixel_material', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #1f2226 0%, #16181c 60%, #0c0d10 100%)', cardBg: 'rgba(30, 32, 38, 0.92)', cardDarkText: false, accentColor: '#19b264' }),
  makePreset({ id: 'others_iphone', brandTab: 'OTHERS', name: 'Iphone', oemFamily: 'iphone', inCallStyle: 'iphone_ios', messagesSkin: 'pixel', darkMode: true, bgGradient: 'linear-gradient(175deg, #262930 0%, #191c22 55%, #0e1014 100%)', cardBg: 'rgba(255, 255, 255, 0.14)', cardDarkText: false, accentColor: '#34c759' }),
];

export function getPhoneThemeById(id: string | null | undefined): PhoneThemePreset | null {
  if (!id) return null;
  return PHONE_THEME_CATALOG.find((p) => p.id === id) || null;
}

export function detectPhoneThemeFromDevice(info: DeviceThemeInfo | null | undefined): PhoneThemePreset {
  const manu = (info?.manufacturer || info?.brand || '').toLowerCase().trim();
  const model = (info?.model || info?.device || '').toLowerCase().trim();
  const wantDark = Boolean(info?.darkMode);
  const sdk = Number(info?.sdkInt || 33);
  const dynamicAccent = info?.accentColorHex && /^#[0-9a-fA-F]{6}$/.test(info.accentColorHex)
    ? info.accentColorHex
    : undefined;

  let base: PhoneThemePreset | undefined;

  // 1. Direct model match attempts
  if (model) {
    base = PHONE_THEME_CATALOG.find((p) => {
      const cleanName = p.name.toLowerCase().replace(/\(.*?\)/g, '').trim();
      const shortModel = model.replace(/^sm-/, '').replace(/^galaxy\s+/, '');
      return cleanName.includes(shortModel) || model.includes(cleanName);
    });
  }

  // 2. Brand + Dark/Light smart family match
  if (!base) {
    if (manu.includes('samsung')) {
      if (wantDark) {
        base = getPhoneThemeById(sdk >= 34 ? 'samsung_s23_ultra_14' : 'samsung_a12_nacho')!;
      } else {
        base = getPhoneThemeById('samsung_a13')!;
      }
    } else if (manu.includes('xiaomi') || manu.includes('redmi') || manu.includes('poco')) {
      base = getPhoneThemeById(wantDark ? 'xiaomi_note_13' : 'xiaomi_redmi_13c')!;
    } else if (manu.includes('tecno')) {
      base = getPhoneThemeById(wantDark ? 'tecno_spark_10c' : 'tecno_ca7')!;
    } else if (manu.includes('infinix')) {
      base = getPhoneThemeById(wantDark ? 'infinix_zero_30_5g' : 'infinix_hot_8')!;
    } else if (manu.includes('itel')) {
      base = getPhoneThemeById(wantDark ? 'tecno_pop_7' : 'tecno_spark_4')!;
    } else if (manu.includes('oppo')) {
      base = getPhoneThemeById(wantDark ? 'oppo_a76' : 'oppo_reno7_4g')!;
    } else if (manu.includes('realme')) {
      base = getPhoneThemeById('realme_8')!;
    } else if (manu.includes('oneplus')) {
      base = getPhoneThemeById('oneplus_nord_2')!;
    } else if (manu.includes('vivo') || manu.includes('iqoo')) {
      base = getPhoneThemeById('vivo_v27_5g')!;
    } else if (manu.includes('huawei') || manu.includes('honor')) {
      base = getPhoneThemeById('huawei_p30_pro')!;
    } else if (manu.includes('motorola') || manu.includes('moto')) {
      base = getPhoneThemeById('moto_g22')!;
    } else if (manu.includes('nokia') || manu.includes('hmd')) {
      base = getPhoneThemeById(wantDark ? 'nokia_c21_plus' : 'nokia_3')!;
    } else if (manu.includes('lge') || manu === 'lg') {
      base = getPhoneThemeById(wantDark ? 'lg_v30' : 'lg_q9')!;
    } else if (manu.includes('sony')) {
      base = getPhoneThemeById('sony_z5')!;
    } else if (manu.includes('htc')) {
      base = getPhoneThemeById('htc_m8')!;
    } else if (manu.includes('asus')) {
      base = getPhoneThemeById('asus_max_pro')!;
    } else if (manu.includes('google') || manu.includes('pixel')) {
      base = getPhoneThemeById(wantDark ? 'google_pixel_8_dark' : 'google_pixel_8')!;
    } else {
      // Browser/unknown or generic Android -> default Samsung One UI on web or Pixel Material You if native non-Samsung
      if (manu) {
        base = getPhoneThemeById(wantDark ? 'google_pixel_8_dark' : 'google_pixel_8')!;
      } else {
        base = getPhoneThemeById(wantDark ? 'samsung_a12_nacho' : 'samsung_a13')!;
      }
    }
  }

  // Apply Material You accent color tinting on Android 12+ Pixel/Stock phones
  if (dynamicAccent && (base.oemFamily === 'pixel' || base.oemFamily === 'motorola' || base.oemFamily === 'nokia')) {
    return {
      ...base,
      accentColor: dynamicAccent,
      darkMode: wantDark,
      dialerDark: wantDark,
    };
  }

  // Respect system dark mode on Samsung One UI when auto-detected
  if (base.oemFamily === 'samsung' && info?.darkMode !== undefined && wantDark && !base.darkMode) {
    return {
      ...base,
      darkMode: true,
      cardBg: 'rgba(26, 30, 36, 0.86)',
      cardDarkText: false,
      dialerBg: '#0b0c0f',
      dialerSurface: '#17191f',
      dialerText: '#f3f4f6',
      dialerMuted: '#9ca3af',
      dialerBorder: 'rgba(255,255,255,0.09)',
      dialerDark: true,
    };
  }

  return base;
}

export function resolveActivePhoneTheme(info?: DeviceThemeInfo | null): {
  mode: 'auto' | 'manual';
  preset: PhoneThemePreset;
} {
  if (typeof window !== 'undefined') {
    try {
      const mode = localStorage.getItem(PHONE_THEME_MODE_KEY) === 'manual' ? 'manual' : 'auto';
      const savedId = localStorage.getItem(PHONE_THEME_STORAGE_KEY);
      if (mode === 'manual' && savedId) {
        const found = getPhoneThemeById(savedId);
        if (found) return { mode: 'manual', preset: found };
      }
    } catch {}
  }
  return { mode: 'auto', preset: detectPhoneThemeFromDevice(info) };
}

export function savePhoneThemeSelection(mode: 'auto' | 'manual', presetId?: string | null) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PHONE_THEME_MODE_KEY, mode);
    if (mode === 'manual' && presetId) {
      localStorage.setItem(PHONE_THEME_STORAGE_KEY, presetId);
    } else if (mode === 'auto') {
      localStorage.removeItem(PHONE_THEME_STORAGE_KEY);
    }
    window.dispatchEvent(new Event('cbe-phone-theme-changed'));
  } catch {}
}
