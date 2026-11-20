export type CbeLang = 'en' | 'am';

export interface PayCardItem {
  id: string;
  title: Record<CbeLang, string>;
  description: Record<CbeLang, string>;
  topPct: number;
  heightPct: number;
}

export interface CbeBejeCardItem {
  id: string;
  title: Record<CbeLang, string>;
  description: Record<CbeLang, string>;
  topPct: number;
}

export interface MiniAppItem {
  id: string;
  label: Record<CbeLang, string>;
  enName: string;
  row: number;
  col: number;
  cardTop: string;
  cardLeft: string;
  textTopPct: number;
}

export const CBE_UI_TEXT = {
  langBadge: { en: 'EN', am: 'አማ' },
  nav: {
    home: { en: 'Home', am: 'መነሻ' },
    pay: { en: 'Pay', am: 'ክፈል' },
    cbebeje: { en: 'CBEBeje', am: 'ሲቢኢበጄ' },
    miniApps: { en: 'Mini Apps', am: 'ሚኒ አፕስ' },
    others: { en: 'Others', am: 'ሌሎች' },
  },
  home: {
    brandName: { en: 'CBEBirr Plus', am: 'ሲቢኢ ብር ፕላስ' },
    brandSlogan: { en: 'ባሉበት ሁሉ አለ!', am: 'ባሉበት ሁሉ አለ!' },
    bankNameAm: 'የኢትዮጵያ ንግድ ባንክ',
    bankNameEn: { en: 'Commercial Bank of Ethiopia', am: 'Commercial Bank of Ethiopia' },
    welcomeBack: { en: 'WELCOME BACK', am: 'እንኳን ደህና መጡ' },
    balanceLabel: { en: 'Balance (ETB)', am: 'ቀሪ ሂሳብ (ብር)' },
    rewardLabel: { en: 'Reward (Pts)', am: 'ሽልማት (ነጥብ)' },
    mekedonia: { en: 'Mekedonia', am: 'መቄዶንያ' },
    txDetail: { en: 'Transaction Detail', am: 'የሂሳብ እንቅስቃሴ' },
    qrCode: { en: 'QR code', am: 'QR ኮድ' },
    toIndividual: { en: 'To Individual', am: 'ለግለሰብ' },
    toGroup: { en: 'To Group', am: 'ለቡድን' },
    upperServices: [
      { id: 'linked_bank', en: 'Linked Bank\nAcct', am: 'የተገናኘ\nባንክ ሂሳብ' },
      { id: 'send_money', en: 'Send Money', am: 'ገንዘብ ላክ' },
      { id: 'to_cbe', en: 'To CBE Acct', am: 'ወደ ባንክ ሂሳብ' },
      { id: 'air_time', en: 'Air Time', am: 'የአየር ሰዓት' },
      { id: 'cash_out', en: 'Cash Out', am: 'ገንዘብ ማውጫ' },
      { id: 'airtime_pkg', en: 'Airtime\nPackage', am: 'የአየር ሰዓት\nጥቅል' },
      { id: 'scheduled_pay', en: 'Scheduled\nPay', am: 'የተቀጠረ\nክፍያ' },
      { id: 'magic_pay', en: 'MagicPay', am: 'ማጂክ ፔይ' },
    ],
    lowerServices: [
      { id: 'other_banks', en: 'Transfer To\nOther Banks', am: 'ወደ ሌሎች\nባንኮች' },
      {
        id: 'other_wallet',
        en: 'Transfer To\nOther Wallet &\nMicro Finance',
        am: 'ወደ ሌላ ዋሌት እና\nማይክሮ ፋይናንስ',
      },
      { id: 'merchant', en: 'Pay for\nMerchant', am: 'ለነጋዴ\nክፈል' },
      { id: 'fuel_pay', en: 'Fuel Pay', am: 'የነዳጅ ክፍያ' },
      { id: 'condominium', en: 'Condominium\nRepayment', am: 'የኮንዶሚኒየም\nክፍያ' },
      { id: 'money_request', en: 'Money\nRequest', am: 'የገንዘብ\nጥያቄ' },
      { id: 'location', en: 'Location', am: 'አድራሻ' },
      { id: 'play_win', en: 'Play and\nWin', am: 'ይጫወቱ\nይሸለሙ' },
    ],
  },
  pay: {
    headerTitle: { en: 'Pay Bill', am: 'ክፍያ ይፈጽሙ' },
    cards: [
      {
        id: 'pay_bill',
        title: { en: 'Pay Bill', am: 'ክፍያ ይፈጽሙ' },
        description: {
          en: 'To pay your school, entertainment and governmental utilities.',
          am: 'የትምህርት ቤት፣ የመዝናኛ እና የመንግስት አገልግሎት ክፍያዎችን ለመፈጸም።',
        },
        topPct: 0.96,
        heightPct: 12.26,
      },
      {
        id: 'traffic_penalty',
        title: { en: 'Traffic Penalty', am: 'የትራፊክ ቅጣት' },
        description: {
          en: 'To pay your traffic penalty please use this section',
          am: 'የትራፊክ ቅጣትዎን ለመክፈል እባክዎ ይህንን ክፍል ይጠቀሙ',
        },
        topPct: 14.90,
        heightPct: 12.26,
      },
      {
        id: 'electricity',
        title: { en: 'Electricity', am: 'መብራት' },
        description: {
          en: 'To settle your electric bill utility use this section.',
          am: 'የመብራት ቢል ክፍያዎን ለመፈጸም ይህንን ክፍል ይጠቀሙ።',
        },
        topPct: 28.93,
        heightPct: 12.26,
      },
      {
        id: 'water_supply',
        title: { en: 'Water Supply', am: 'ውሃ' },
        description: {
          en: 'To close your monthly household water consumption please use this section.',
          am: 'ወርሃዊ የቤት ውሃ አገልግሎት ክፍያዎን ለመክፈል ይህንን ክፍል ይጠቀሙ።',
        },
        topPct: 42.87,
        heightPct: 12.26,
      },
      {
        id: 'telecom',
        title: { en: 'Telecom', am: 'ቴሌኮም' },
        description: {
          en: 'To pay your month,daily or yearly telecom usage bill please select this section.',
          am: 'ወርሃዊ፣ ዕለታዊ ወይም ዓመታዊ የቴሌኮም ክፍያ ለመክፈል ይህንን ይምረጡ።',
        },
        topPct: 56.89,
        heightPct: 12.26,
      },
      {
        id: 'taxi',
        title: { en: 'Taxi', am: 'ታክሲ' },
        description: {
          en: "Taxi association's payment",
          am: 'የታክሲ ማህበራት ክፍያ',
        },
        topPct: 70.83,
        heightPct: 12.26,
      },
      {
        id: 'fundraising',
        title: { en: 'Fundraising', am: 'የበጎ አድራጎት እርዳታ' },
        description: {
          en: 'Donate, give to those who have no one. Help non profit organizations to flourish.',
          am: 'ለተቸገሩ ይለግሱ፤ ትርፋማ ያልሆኑ ድርጅቶች እንዲያድጉ ይርዱ።',
        },
        topPct: 85.10,
        heightPct: 8.73,
      },
    ] as PayCardItem[],
  },
  cbebeje: {
    headerTitle: { en: 'CBEBeje', am: 'ሲቢኢበጄ' },
    ordinaryTab: { en: 'Ordinary', am: 'መደበኛ' },
    overdraftTab: { en: 'Overdraft', am: 'ኦቨርድራፍት' },
    cards: [
      {
        id: 'micro_saving',
        title: { en: 'Micro Saving', am: 'ማይክሮ ቁጠባ' },
        description: {
          en: 'Save money and earn 7% interest.',
          am: 'ገንዘብ ይቆጥቡ እና 7% ወለድ ያግኙ።',
        },
        topPct: 42.3,
      },
      {
        id: 'micro_loan',
        title: { en: 'Micro Loan', am: 'ማይክሮ ብድር' },
        description: {
          en: "Let's assist to process a micro loan easily.",
          am: 'ማይክሮ ብድር በቀላሉ እንዲያገኙ እንርዳዎት።',
        },
        topPct: 52.85,
      },
      {
        id: 'fixed_saving',
        title: { en: 'Fixed Saving', am: 'ቋሚ ቁጠባ' },
        description: {
          en: 'Earn more interest(8% +) by saving using CBEBirr.',
          am: 'ሲቢኢ ብርን በመጠቀም በመቆጠብ 8%+ ወለድ ያግኙ።',
        },
        topPct: 63.3,
      },
    ] as CbeBejeCardItem[],
  },
  miniApps: {
    headerTitle: { en: 'Mini Apps', am: 'ሚኒ አፕስ' },
    items: [
      { id: 'henon', enName: 'Henon School Pay', label: { en: 'Henon School Pay', am: 'ሄኖን ት/ቤት ክፍያ' }, row: 0, col: 0, cardTop: '7.8%', cardLeft: '3.8%', textTopPct: 14.80 },
      { id: 'entoto', enName: 'Entoto Park Cbe Run', label: { en: 'Entoto Park Cbe Run', am: 'እንጦጦ ፓርክ ሩጫ' }, row: 0, col: 1, cardTop: '7.8%', cardLeft: '35.4%', textTopPct: 14.80 },
      { id: 'etre', enName: 'ETRE', label: { en: 'ETRE', am: 'ኢትሬ (ETRE)' }, row: 0, col: 2, cardTop: '7.8%', cardLeft: '67.0%', textTopPct: 14.80 },
      { id: 'commercepal', enName: 'Commercepal', label: { en: 'Commercepal', am: 'ኮመርስፓል' }, row: 1, col: 0, cardTop: '18.6%', cardLeft: '3.8%', textTopPct: 25.74 },
      { id: 'seregela', enName: 'SeregelaGebeya', label: { en: 'SeregelaGebeya', am: 'ሰረገላ ገበያ' }, row: 1, col: 1, cardTop: '18.6%', cardLeft: '35.4%', textTopPct: 25.74 },
      { id: 'digital_equb', enName: 'Digital Equb', label: { en: 'Digital Equb', am: 'ዲጂታል እቁብ' }, row: 1, col: 2, cardTop: '18.6%', cardLeft: '67.0%', textTopPct: 25.74 },
      { id: 'equb', enName: 'eQUB', label: { en: 'eQUB', am: 'ኢ-እቁብ' }, row: 2, col: 0, cardTop: '29.4%', cardLeft: '3.8%', textTopPct: 36.67 },
      { id: 'get_rest', enName: 'Get Rest', label: { en: 'Get Rest', am: 'ጌት ሬስት' }, row: 2, col: 1, cardTop: '29.4%', cardLeft: '35.4%', textTopPct: 36.67 },
      { id: 'ichereta', enName: 'iChereta', label: { en: 'iChereta', am: 'አይጨረታ' }, row: 2, col: 2, cardTop: '29.4%', cardLeft: '67.0%', textTopPct: 36.67 },
      { id: 'kelal', enName: 'Kelal Gateway', label: { en: 'Kelal Gateway', am: 'ቀላል ጌትዌይ' }, row: 3, col: 0, cardTop: '40.2%', cardLeft: '3.8%', textTopPct: 47.61 },
      { id: 'hello_equb', enName: 'Hello Equb', label: { en: 'Hello Equb', am: 'ሄሎ እቁብ' }, row: 3, col: 1, cardTop: '40.2%', cardLeft: '35.4%', textTopPct: 47.61 },
      { id: 'qetero', enName: 'Qetero', label: { en: 'Qetero', am: 'ቀጠሮ' }, row: 3, col: 2, cardTop: '40.2%', cardLeft: '67.0%', textTopPct: 47.61 },
      { id: 'ethio_sport', enName: 'Ethio Sport', label: { en: 'Ethio Sport', am: 'ኢትዮ ስፖርት' }, row: 4, col: 0, cardTop: '51.0%', cardLeft: '3.8%', textTopPct: 58.55 },
      { id: 'virtual_equb', enName: 'Virtual Equb', label: { en: 'Virtual Equb', am: 'ቨርቹዋል እቁብ' }, row: 4, col: 1, cardTop: '51.0%', cardLeft: '35.4%', textTopPct: 58.55 },
      { id: 'cbe_coop', enName: 'Cbe Employee Cooperative', label: { en: 'Cbe Employee Cooperati...', am: 'ሲቢኢ የሰራተኞች ማህበር' }, row: 4, col: 2, cardTop: '51.0%', cardLeft: '67.0%', textTopPct: 58.55 },
      { id: 'atrip', enName: 'A-Trip', label: { en: 'A-Trip', am: 'ኤ-ትሪፕ' }, row: 5, col: 0, cardTop: '61.8%', cardLeft: '3.8%', textTopPct: 69.55 },
      { id: 'adey', enName: 'Adey School System', label: { en: 'Adey School System', am: 'አደይ ትምህርት ቤት' }, row: 5, col: 1, cardTop: '61.8%', cardLeft: '35.4%', textTopPct: 69.55 },
      { id: 'moteregna', enName: 'Moteregna Delivery', label: { en: 'Moteregna Delivery', am: 'ሞተረኛ ዴሊቨሪ' }, row: 5, col: 2, cardTop: '61.8%', cardLeft: '67.0%', textTopPct: 69.55 },
      { id: 'aabte', enName: 'AABTE', label: { en: 'AABTE', am: 'ኤኤቢቲኢ (AABTE)' }, row: 6, col: 0, cardTop: '72.6%', cardLeft: '3.8%', textTopPct: 80.42 },
      { id: 'filmbet', enName: 'Filmbet', label: { en: 'Filmbet', am: 'ፊልም ቤት' }, row: 6, col: 1, cardTop: '72.6%', cardLeft: '35.4%', textTopPct: 80.42 },
    ] as MiniAppItem[],
  },
  others: {
    headerTitle: { en: 'Others', am: 'ሌሎች' },
    levelBadge: { en: 'Level 3', am: 'ደረጃ 3' },
    logOut: { en: 'Log Out', am: 'ውጣ' },
    menuRows: [
      { id: 'all_balances', en: 'All Balances', am: 'ሁሉም ቀሪ ሂሳቦች' },
      { id: 'exchange_rate', en: 'Exchange rate', am: 'የምንዛሪ ተመን' },
      { id: 'feedback', en: 'Feedback', am: 'አስተያየት' },
      { id: 'change_pin', en: 'Change PIN', am: 'ፒን ቀይር' },
      { id: 'biometrics', en: 'Biometrics', am: 'ባዮሜትሪክስ' },
      { id: 'manage_bill', en: 'Manage Bill Info', am: 'የቢል መረጃ አስተዳድር' },
      { id: 'invite_friend', en: 'Invite Friend', am: 'ጓደኛ ይጋብዙ' },
      { id: 'about_us', en: 'About Us', am: 'ስለ እኛ' },
      { id: 'chatbot', en: 'Chatbot', am: 'ቻትቦት' },
      { id: 'cbebeje_feedback', en: 'CBEBeje Feedback', am: 'የሲቢኢበጄ አስተያየት' },
      { id: 'faq', en: 'FAQ', am: 'ተደጋጋሚ ጥያቄዎች' },
      { id: 'contact_us', en: 'Contact Us', am: 'ያግኙን' },
      { id: 'unsubscribe', en: 'Unsubscribe', am: 'አገልግሎት አቋርጥ' },
    ],
  },
} as const;
