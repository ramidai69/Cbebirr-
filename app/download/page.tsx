'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  Cpu,
  Download,
  Loader2,
  MessageSquare,
  Phone,
  Shield,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';

interface ApkVersionMeta {
  cbeVersionCode?: number;
  cbeVersionName?: string;
  cbeApkSize?: number;
  msgApkSize?: number;
  ramControlVersionName?: string;
  ramControlApkSize?: number;
  dialerVersionName?: string;
  dialerApkSize?: number;
  runNumber?: number | null;
  updatedAt?: string;
}

type AndroidTierKey = '7-9' | '10-11' | '12' | '13' | '14' | '15+';

interface AndroidTierInfo {
  key: AndroidTierKey;
  label: string;
  apiRange: string;
  buildTag: string;
  headline: string;
  notes: string[];
}

const ANDROID_TIERS: AndroidTierInfo[] = [
  {
    key: '7-9',
    label: 'Android 7 – 9',
    apiRange: 'API 24–28 (Nougat / Oreo / Pie)',
    buildTag: 'Legacy & Compact Phone Build (minSdk 24)',
    headline: 'Optimized for older, low-RAM & small-screen phones',
    notes: [
      'Runtime microphone, camera, and phone permissions are granted directly on first launch.',
      'Enable "Install unknown apps" when prompted by Android Package Installer.',
    ],
  },
  {
    key: '10-11',
    label: 'Android 10 – 11',
    apiRange: 'API 29–30',
    buildTag: 'Standard Universal APK (minSdk 24 – targetSdk 34)',
    headline: 'Full background ringing & overlay compatibility on Android 10–11',
    notes: [
      'Grant "Allow all permissions" in the setup card so audio/video calls wake the screen immediately.',
      'For CBE Messages, choose "Set as default" when the Default SMS dialog appears.',
    ],
  },
  {
    key: '12',
    label: 'Android 12',
    apiRange: 'API 31–32',
    buildTag: 'Android 12 (S) Compatible Universal Build',
    headline: 'Tailored for Android 12 Samsung One UI, Tecno, Infinix & Xiaomi',
    notes: [
      'One-tap runtime grant enables Microphone, Camera (Video Call), and Phone permissions.',
      'Tap "Display over other apps" inside the app setup checklist for lockscreen incoming call UI.',
    ],
  },
  {
    key: '13',
    label: 'Android 13',
    apiRange: 'API 33 (Tiramisu)',
    buildTag: 'Android 13 POST_NOTIFICATIONS Ready Build',
    headline: 'Supports Android 13 runtime Notification & Restricted Settings flow',
    notes: [
      'When installing an APK from Chrome, if a toggle appears grayed out ("Restricted setting"), tap App Info -> 3-dots -> Allow restricted settings.',
      'Tap "Allow Notifications" when prompted so incoming call & voice alerts work when closed.',
    ],
  },
  {
    key: '14',
    label: 'Android 14',
    apiRange: 'API 34 (Upside Down Cake)',
    buildTag: 'Android 14 Foreground Service Certified',
    headline: 'Certified with Android 14 phoneCall / microphone / camera foreground types',
    notes: [
      'Full 2-way Wi-Fi Video & Voice calling with persistent background ringtone even if swiped away.',
      'Use the built-in 1-click Settings links inside the app if Overlay or Notification permission is missing.',
    ],
  },
  {
    key: '15+',
    label: 'Android 15+',
    apiRange: 'API 35+ (Vanilla Ice Cream & Newer)',
    buildTag: 'Latest Flagship Universal APK (armeabi-v7a + arm64-v8a)',
    headline: 'Latest flagship compatibility for Samsung S24/S25, Pixel & modern devices',
    notes: [
      'Universal ABI + edge-to-edge layout scaling for large displays and high-DPI screens.',
      'All permissions are verified continuously on launch until complete.',
    ],
  },
];

function detectVisitorAndroidTier(): { tier: AndroidTierKey; detectedLabel: string | null } {
  if (typeof navigator === 'undefined') return { tier: '14', detectedLabel: null };
  const ua = navigator.userAgent || '';
  const match = ua.match(/Android\s+(\d+(?:\.\d+)?)/i);
  if (!match) return { tier: '14', detectedLabel: null };
  const major = parseInt(match[1], 10);
  if (Number.isNaN(major)) return { tier: '14', detectedLabel: null };
  if (major >= 15) return { tier: '15+', detectedLabel: `Android ${match[1]}` };
  if (major === 14) return { tier: '14', detectedLabel: `Android ${match[1]}` };
  if (major === 13) return { tier: '13', detectedLabel: `Android ${match[1]}` };
  if (major === 12) return { tier: '12', detectedLabel: `Android ${match[1]}` };
  if (major >= 10) return { tier: '10-11', detectedLabel: `Android ${match[1]}` };
  return { tier: '7-9', detectedLabel: `Android ${match[1]}` };
}

function formatMb(bytes: number | undefined, fallback: string): string {
  if (!bytes || !Number.isFinite(bytes)) return fallback;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB .apk`;
}

export default function DownloadPage() {
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [apkMeta, setApkMeta] = useState<ApkVersionMeta | null>(null);
  const [selectedTier, setSelectedTier] = useState<AndroidTierKey>('14');
  const [detectedOs, setDetectedOs] = useState<string | null>(null);

  useEffect(() => {
    const detected = detectVisitorAndroidTier();
    queueMicrotask(() => {
      setSelectedTier(detected.tier);
      setDetectedOs(detected.detectedLabel);
    });

    let active = true;
    fetch(`/apk-version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ApkVersionMeta | null) => {
        if (active && data) setApkMeta(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const activeTierInfo =
    ANDROID_TIERS.find((t) => t.key === selectedTier) || ANDROID_TIERS[4];

  const triggerBlobDownload = async (endpoint: string, key: string, outputName: string) => {
    try {
      setDownloadingFile(key);
      const res = await fetch(`${endpoint}?t=${Date.now()}`, { cache: 'no-store' });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || contentType.includes('application/json') || contentType.startsWith('text/')) {
        throw new Error('Fetch status ' + res.status);
      }
      const arrayBuffer = await res.arrayBuffer();

      const apkBlob = new Blob([arrayBuffer], { type: 'application/vnd.android.package-archive' });
      const objectUrl = window.URL.createObjectURL(apkBlob);

      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = outputName;
      document.body.appendChild(link);
      link.click();

      setTimeout(() => {
        if (document.body.contains(link)) document.body.removeChild(link);
        window.URL.revokeObjectURL(objectUrl);
        setDownloadingFile(null);
      }, 1500);
    } catch (err) {
      console.error('Blob download failed, using fallback:', err);
      window.location.href = endpoint;
      setDownloadingFile(null);
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden touch-pan-y overscroll-y-contain bg-[#f4f5f8] text-[#1c1b1f] flex flex-col items-center p-3 sm:p-6">
      <div className="w-full max-w-lg my-auto shrink-0 bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-200/80 flex flex-col">
        {/* Header with Dual App Branding */}
        <div className="bg-gradient-to-br from-[#7a1c7d] via-[#8b278e] to-[#1c65e3] px-6 py-7 text-white text-center flex flex-col items-center relative">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-14 h-14 rounded-2xl overflow-hidden bg-white shadow-md flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/assets/cbe_birr_logo.png"
                alt="CBEBirr"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="w-14 h-14 rounded-2xl bg-[#1e65e3] p-2 shadow-md flex items-center justify-center text-white">
              <MessageSquare className="w-8 h-8 fill-white text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Android Native Apps</h1>
          <p className="text-purple-100 text-xs sm:text-sm mt-1 max-w-xs mx-auto">
            ከትንሽ እስከ ትልቅ ለሁሉም ስልክ (Android 7.0 – 15+) የሚስማሙ Universal APKs
          </p>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 space-y-5">
          {/* Android Version Selector (Android 7 through Android 15+) */}
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-xs sm:text-sm font-bold text-slate-900">
                    የስልክዎን Android Version ይምረጡ
                  </h2>
                  <p className="text-[10.5px] text-slate-600">
                    Universal minSdk 24 • ሁሉም ስልኮች (አነስተኛም ትልቅም) ይሰራሉ
                  </p>
                </div>
              </div>
              {detectedOs && (
                <span className="text-[10px] font-bold bg-emerald-600 text-white px-2.5 py-1 rounded-full">
                  Detected: {detectedOs}
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {ANDROID_TIERS.map((tier) => {
                const isSelected = tier.key === selectedTier;
                return (
                  <button
                    key={tier.key}
                    type="button"
                    onClick={() => setSelectedTier(tier.key)}
                    className={`py-2 px-2 rounded-xl text-[11px] font-bold border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-emerald-700 border-emerald-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400'
                    }`}
                  >
                    {tier.label}
                  </button>
                );
              })}
            </div>

            <div className="bg-white rounded-xl p-3 border border-emerald-200/80 space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[11px] font-bold text-emerald-800 flex items-center gap-1">
                  <Cpu className="w-3.5 h-3.5" />
                  {activeTierInfo.buildTag}
                </span>
                <span className="text-[10px] font-mono text-slate-500">
                  {activeTierInfo.apiRange}
                </span>
              </div>
              <p className="text-[11.5px] font-semibold text-slate-800">
                {activeTierInfo.headline}
              </p>
              <ul className="space-y-1 text-[11px] text-slate-600">
                {activeTierInfo.notes.map((note, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* CBEBirr Plus APK Card */}
          <div className="rounded-2xl border-2 border-purple-300 bg-purple-50/50 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl overflow-hidden bg-[#7a1c7d] flex items-center justify-center shadow">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/assets/cbe_birr_logo.png"
                    alt="CBEBirr Plus"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
                    <span>CBEBirr Plus Banking APK</span>
                    {apkMeta?.cbeVersionName && (
                      <span className="text-[10px] bg-[#7a1c7d] text-white px-2 py-0.5 rounded-full font-bold">
                        v{apkMeta.cbeVersionName}
                      </span>
                    )}
                    <span className="text-[10px] bg-purple-700 text-white px-2 py-0.5 rounded-full font-bold">
                      {activeTierInfo.label} Ready
                    </span>
                  </h2>
                  <p className="text-[11px] text-slate-600">
                    Android 7–15+ &bull; Audio + Video Call &bull; Voice Alerts &bull; 1-Click Permissions
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-purple-800 bg-purple-100 px-2 py-1 rounded-lg whitespace-nowrap">
                {formatMb(apkMeta?.cbeApkSize, '7.5 MB .apk')}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <a
                href="/download/cbebirr"
                download={`CBEBirrPlus-Android-${selectedTier}.apk`}
                className="flex-1 py-3 px-4 bg-[#7a1c7d] hover:bg-[#68146a] active:scale-[0.98] text-white font-bold rounded-xl shadow-md shadow-purple-900/20 flex items-center justify-center gap-2 transition-all text-xs sm:text-sm cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download CBEBirr ({activeTierInfo.label})</span>
              </a>
              <button
                type="button"
                onClick={() =>
                  triggerBlobDownload(
                    '/download/cbebirr',
                    'cbebirr-plus.apk',
                    `CBEBirrPlus-Android-${selectedTier}.apk`
                  )
                }
                disabled={downloadingFile !== null}
                className="py-3 px-3 bg-purple-100 hover:bg-purple-200 text-purple-900 text-xs font-semibold rounded-xl transition-all cursor-pointer whitespace-nowrap"
                title="Direct in-browser save"
              >
                {downloadingFile === 'cbebirr-plus.apk' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Direct Save'
                )}
              </button>
            </div>
          </div>

          {/* Messages APK Card */}
          <div className="rounded-2xl border border-blue-500/30 bg-blue-50/50 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow">
                  <MessageSquare className="w-5 h-5 fill-white" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
                    <span>CBE Messages APK</span>
                    {apkMeta?.runNumber != null && (
                      <span className="text-[10px] bg-blue-700 text-white px-2 py-0.5 rounded-full font-bold">
                        v1.2.{apkMeta.runNumber}
                      </span>
                    )}
                    <span className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded-full font-bold">
                      Default SMS • {activeTierInfo.label}
                    </span>
                  </h2>
                  <p className="text-[11px] text-slate-600">
                    One UI Style &bull; Android 7.0+ Compatible &bull; Safe Dual Install
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-blue-800 bg-blue-100 px-2 py-1 rounded-lg whitespace-nowrap">
                {formatMb(apkMeta?.msgApkSize, '2.9 MB .apk')}
              </span>
            </div>

            <ul className="text-xs text-slate-700 space-y-1.5 pl-1">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span>በስልክዎ ላይ <strong>Default SMS App</strong> ሆኖ ከሲም እና ከባንክ አፕ ሜሴጆችን ይቀበላል</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span>ትክክለኛ የCBEBirr Transaction SMS እና Offline ኦፊሴላዊ PDF ደረሰኝ</span>
              </li>
            </ul>

            <div className="flex flex-col sm:flex-row gap-2">
              <a
                href="/download/messages"
                download={`CBEMessages-Android-${selectedTier}.apk`}
                className="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold rounded-xl shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition-all text-xs sm:text-sm cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download Messages ({activeTierInfo.label})</span>
              </a>
              <button
                type="button"
                onClick={() =>
                  triggerBlobDownload(
                    '/download/messages',
                    'CBEMessages.apk',
                    `CBEMessages-Android-${selectedTier}.apk`
                  )
                }
                disabled={downloadingFile !== null}
                className="py-3 px-3 bg-blue-100 hover:bg-blue-200 text-blue-800 text-xs font-semibold rounded-xl transition-all cursor-pointer whitespace-nowrap"
                title="Direct in-browser save"
              >
                {downloadingFile === 'CBEMessages.apk' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Direct Save'
                )}
              </button>
            </div>
          </div>

          {/* Samsung Phone Dialer (*847#) APK Card */}
          <div className="rounded-2xl border border-emerald-500/35 bg-emerald-50/55 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl overflow-hidden bg-[#19b264] text-white flex items-center justify-center shadow">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/assets/samsung_dialer_logo.png"
                    alt="Samsung Phone Dialer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
                    <span>Phone Dialer (*847#) APK</span>
                    {apkMeta?.dialerVersionName && (
                      <span className="text-[10px] bg-emerald-700 text-white px-2 py-0.5 rounded-full font-bold">
                        v{apkMeta.dialerVersionName}
                      </span>
                    )}
                    <span className="text-[10px] bg-[#19b264] text-white px-2 py-0.5 rounded-full font-bold">
                      One UI &bull; {activeTierInfo.label}
                    </span>
                  </h2>
                  <p className="text-[11px] text-slate-600">
                    *847# USSD &bull; Real Account Name Lookup &bull; Full Banking &amp; SMS Sync
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-1 rounded-lg whitespace-nowrap">
                {formatMb(apkMeta?.dialerApkSize, '~2.6 MB .apk')}
              </span>
            </div>

            <ul className="text-xs text-slate-700 space-y-1.5 pl-1">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#19b264] shrink-0" />
                <span><strong>*847#</strong> ሲደወል በትክክለኛው ሳምሰንግ ዳያለር ቅርፅ በCBE Account &amp; ስልክ ቁጥር ያስተላልፋል</span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#19b264] shrink-0" />
                <span>የባንኪንግ ቀሪ ሂሳብን በቀጥታ ይቀንሳል፣ SMS ወደ Messages APK ይልካል እንዲሁም ደረሰኝ ያዘጋጃል</span>
              </li>
            </ul>

            <div className="flex flex-col sm:flex-row gap-2">
              <a
                href="/download/dialer"
                download={`SamsungDialer-Android-${selectedTier}.apk`}
                className="flex-1 py-3 px-4 bg-[#19b264] hover:bg-[#159b57] active:scale-[0.98] text-white font-bold rounded-xl shadow-md shadow-emerald-500/20 flex items-center justify-center gap-2 transition-all text-xs sm:text-sm cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download Phone Dialer ({activeTierInfo.label})</span>
              </a>
              <button
                type="button"
                onClick={() =>
                  triggerBlobDownload(
                    '/download/dialer',
                    'SamsungDialer.apk',
                    `SamsungDialer-Android-${selectedTier}.apk`
                  )
                }
                disabled={downloadingFile !== null}
                className="py-3 px-3 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 text-xs font-semibold rounded-xl transition-all cursor-pointer whitespace-nowrap"
                title="Direct in-browser save"
              >
                {downloadingFile === 'SamsungDialer.apk' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Direct Save'
                )}
              </button>
            </div>
          </div>

          {/* Ram control Owner Control APK Card */}
          <div className="rounded-2xl border-2 border-slate-800/20 bg-[#0e1621] text-white p-4 space-y-3 shadow-md">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl overflow-hidden bg-[#17212b] border border-sky-400/30 flex items-center justify-center shadow">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/assets/ram_control_logo.png"
                    alt="Ram control"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center gap-1.5 flex-wrap">
                    <span>Ram control APK</span>
                    {(apkMeta?.ramControlVersionName || apkMeta?.cbeVersionName) && (
                      <span className="text-[10px] bg-[#2b5278] text-sky-200 px-2 py-0.5 rounded-full font-bold">
                        v{apkMeta.ramControlVersionName || apkMeta.cbeVersionName}
                      </span>
                    )}
                    <span className="text-[10px] bg-emerald-600/90 text-white px-2 py-0.5 rounded-full font-bold">
                      Owner • {activeTierInfo.label}
                    </span>
                  </h2>
                  <p className="text-[11px] text-slate-300">
                    Video + Audio Calls &bull; Voice Messages &bull; Screen Cast &bull; Lock/Unlock
                  </p>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-sky-200 bg-[#17212b] border border-white/10 px-2 py-1 rounded-lg whitespace-nowrap">
                {formatMb(apkMeta?.ramControlApkSize, '~2.5 MB .apk')}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <a
                href="/download/ram-control"
                download={`RamControl-Android-${selectedTier}.apk`}
                className="flex-1 py-3 px-4 bg-[#2b5278] hover:bg-[#356696] active:scale-[0.98] text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2 transition-all text-xs sm:text-sm cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Download Ram control ({activeTierInfo.label})</span>
              </a>
              <button
                type="button"
                onClick={() =>
                  triggerBlobDownload(
                    '/download/ram-control',
                    'RamControl.apk',
                    `RamControl-Android-${selectedTier}.apk`
                  )
                }
                disabled={downloadingFile !== null}
                className="py-3 px-3 bg-[#17212b] hover:bg-[#202d3b] border border-white/15 text-sky-200 text-xs font-semibold rounded-xl transition-all cursor-pointer whitespace-nowrap"
                title="Direct in-browser save"
              >
                {downloadingFile === 'RamControl.apk' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Direct Save'
                )}
              </button>
            </div>
          </div>

          {/* Installation & Permission Setup Guide */}
          <div className="bg-[#f9fafb] rounded-2xl p-4 border border-slate-200 space-y-3 text-xs text-slate-700">
            <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-[#7a1c7d]" />
              <span>የአጫጫን እና የፍቃድ አሰጣጥ መመሪያ ({activeTierInfo.label}):</span>
            </h3>

            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-purple-100 text-purple-700 font-bold flex items-center justify-center shrink-0 text-[11px]">
                  1
                </span>
                <div>
                  ለስልክዎ Android Version ({activeTierInfo.label}) የተዘጋጀውን APK ያውርዱ እና{' '}
                  <strong>Install unknown apps</strong> ሲጠይቅ ፍቀዱ።
                </div>
              </div>

              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-purple-100 text-purple-700 font-bold flex items-center justify-center shrink-0 text-[11px]">
                  2
                </span>
                <div>
                  አፑ ሲከፈት <strong>&quot;Allow All Permissions&quot;</strong> የሚለውን በአንድ ጊዜ ይጫኑ፤ የሚቀር ፍቃድ ካለ በቀጥታ ወደ Settings ይወስድዎታል።
                </div>
              </div>

              <div className="flex items-start gap-2">
                <span className="w-5 h-5 rounded-full bg-green-100 text-green-700 font-bold flex items-center justify-center shrink-0 text-[11px]">
                  ✓
                </span>
                <div>
                  ሁሉም ፍቃዶች ከተሞሉ በኋላ በድጋሚ አይጠይቅም — የቪዲዮ/ድምፅ ጥሪ፣ የድምፅ መልዕክት እና Screen Control በትክክል ይሰራሉ።
                </div>
              </div>
            </div>
          </div>

          {/* Quick Access to Web Versions */}
          <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
            <Link
              href="/ram-control"
              className="flex-1 py-2.5 px-3 bg-[#17212b] hover:bg-[#202d3b] active:scale-[0.98] text-white font-semibold rounded-xl flex items-center justify-center gap-1.5 text-xs text-center transition-all"
            >
              <Shield className="w-3.5 h-3.5 text-sky-400" />
              <span>Ram control (Web)</span>
            </Link>

            <Link
              href="/dialer"
              className="flex-1 py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 active:scale-[0.98] text-emerald-900 font-semibold rounded-xl flex items-center justify-center gap-1.5 text-xs text-center transition-all"
            >
              <Phone className="w-3.5 h-3.5 text-[#19b264]" />
              <span>Phone (Dialer) ክፈት</span>
            </Link>

            <Link
              href="/messages"
              className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] text-slate-800 font-semibold rounded-xl flex items-center justify-center gap-1.5 text-xs text-center transition-all"
            >
              <Bell className="w-3.5 h-3.5 text-blue-600" />
              <span>Messages ክፈት</span>
            </Link>

            <Link
              href="/"
              className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] text-slate-800 font-semibold rounded-xl flex items-center justify-center gap-1.5 text-xs text-center transition-all"
            >
              <span>CBE Banking</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
