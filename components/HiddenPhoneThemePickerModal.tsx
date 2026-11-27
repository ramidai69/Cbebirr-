'use client';

import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Check,
  Grip,
  MicOff,
  Pause,
  Phone,
  PhoneOff,
  Plus,
  Search,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react';
import {
  BRAND_TAB_ORDER,
  DeviceThemeInfo,
  PHONE_THEME_CATALOG,
  PhoneThemePreset,
} from '@/lib/phoneThemes';

interface HiddenPhoneThemePickerModalProps {
  open: boolean;
  activePreset: PhoneThemePreset;
  selectionMode: 'auto' | 'manual';
  deviceInfo: DeviceThemeInfo | null;
  onSelectAuto: () => void;
  onSelectPreset: (preset: PhoneThemePreset) => void;
  onClose: () => void;
}

function MiniCallScreenPreview({ preset }: { preset: PhoneThemePreset }) {
  const style = preset.inCallStyle;
  const isCardTextDark = preset.cardDarkText;

  return (
    <div
      className="relative w-[78%] h-[92%] mx-auto rounded-[10px] overflow-hidden shadow-lg flex flex-col justify-between text-white select-none"
      style={{ background: preset.bgGradient }}
    >
      {/* Tiny Android/iOS Status Bar */}
      <div
        className={`flex items-center justify-between px-2 pt-1 text-[7px] font-semibold tracking-tight ${
          preset.darkMode || style === 'xiaomi_miui_blue' || style === 'infinix_teal' || style === 'vivo_funtouch' || style === 'huawei_emui' || style === 'samsung_legacy_slider'
            ? 'text-white/80'
            : 'text-black/70'
        }`}
      >
        <span>12:30</span>
        <span>4G 85%</span>
      </div>

      {/* Top Contact / Number Info */}
      <div className="px-2 pt-2 text-center flex flex-col items-center">
        {(style === 'xiaomi_hyper' ||
          style === 'oppo_coloros' ||
          style === 'pixel_material' ||
          style === 'xiaomi_miui_pastel' ||
          style === 'xiaomi_miui_blue' ||
          style === 'huawei_emui' ||
          style === 'vivo_funtouch' ||
          style === 'iphone_ios') && (
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white mb-1 shadow-xs"
            style={{ backgroundColor: preset.avatarBg }}
          >
            A
          </div>
        )}
        <div
          className={`text-[11px] font-bold leading-tight truncate max-w-full ${
            !preset.darkMode &&
            (style === 'pixel_material' ||
              style === 'xiaomi_hyper' ||
              style === 'oppo_coloros' ||
              style === 'lg_card' ||
              style === 'htc_sense' ||
              style === 'xiaomi_miui_pastel')
              ? 'text-[#15181c]'
              : 'text-white'
          }`}
        >
          Abebe
        </div>
        <div
          className={`text-[7.5px] tabular-nums mt-0.5 ${
            !preset.darkMode &&
            (style === 'pixel_material' ||
              style === 'xiaomi_hyper' ||
              style === 'oppo_coloros' ||
              style === 'lg_card' ||
              style === 'htc_sense' ||
              style === 'xiaomi_miui_pastel')
              ? 'text-black/60'
              : 'text-white/70'
          }`}
        >
          00:18
        </div>
      </div>

      {/* OEM Specific Bottom Call Controls Preview */}
      {style === 'samsung_card' && (
        <div className="px-2 pb-5">
          {preset.hasCallAssistChip && (
            <div className="mx-auto w-fit px-2 py-0.5 mb-1.5 rounded-full bg-white/15 text-[6.5px] font-semibold">
              Call assist
            </div>
          )}
          <div
            className="rounded-[12px] p-2 shadow-sm"
            style={{
              backgroundColor:
                preset.cardBg === 'transparent'
                  ? 'rgba(0,0,0,0.22)'
                  : preset.cardBg,
              color: isCardTextDark ? '#1c1c1c' : '#f4f6f8',
            }}
          >
            <div className="grid grid-cols-3 gap-1.5 mb-2 justify-items-center opacity-85">
              <Plus className="w-2.5 h-2.5" />
              <Pause className="w-2.5 h-2.5" />
              <Volume2 className="w-2.5 h-2.5" />
              <MicOff className="w-2.5 h-2.5" />
              <Grip className="w-2.5 h-2.5" />
              <Phone className="w-2.5 h-2.5" />
            </div>
            <div className="flex justify-center">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-white"
                style={{ backgroundColor: preset.endBtnColor }}
              >
                <PhoneOff className="w-2.5 h-2.5" />
              </div>
            </div>
          </div>
        </div>
      )}

      {style === 'samsung_legacy_slider' && (
        <div className="px-2 pb-5 space-y-2">
          <div className="grid grid-cols-3 gap-1.5 justify-items-center text-white/90">
            <Plus className="w-2.5 h-2.5" />
            <Pause className="w-2.5 h-2.5" />
            <Volume2 className="w-2.5 h-2.5" />
            <MicOff className="w-2.5 h-2.5" />
            <Grip className="w-2.5 h-2.5" />
            <Phone className="w-2.5 h-2.5" />
          </div>
          <div className="flex justify-center">
            <div className="w-5 h-5 rounded-full bg-[#e53935] flex items-center justify-center">
              <PhoneOff className="w-2.5 h-2.5 text-white" />
            </div>
          </div>
        </div>
      )}

      {style === 'samsung_touchwiz' && (
        <div className="bg-white text-[#222] px-2 pt-2 pb-5">
          <div className="grid grid-cols-3 gap-1.5 justify-items-center mb-2 opacity-80">
            <Plus className="w-2.5 h-2.5" />
            <Pause className="w-2.5 h-2.5" />
            <Volume2 className="w-2.5 h-2.5" />
          </div>
          <div className="h-4 w-full rounded bg-[#e53935] flex items-center justify-center">
            <PhoneOff className="w-2.5 h-2.5 text-white" />
          </div>
        </div>
      )}

      {(style === 'xiaomi_hyper' || style === 'oppo_coloros' || style === 'pixel_material') && (
        <div className="px-2 pb-5 space-y-2">
          <div
            className="rounded-xl p-1.5 flex items-center justify-around"
            style={{
              backgroundColor:
                preset.cardBg === 'transparent'
                  ? 'rgba(255,255,255,0.14)'
                  : preset.cardBg,
              color: isCardTextDark ? '#1b1d22' : '#ffffff',
            }}
          >
            <MicOff className="w-2.5 h-2.5" />
            <Grip className="w-2.5 h-2.5" />
            <Volume2 className="w-2.5 h-2.5" />
            <Pause className="w-2.5 h-2.5" />
          </div>
          <div className="flex justify-center">
            <div className="w-6 h-5 rounded-full bg-[#e53935] flex items-center justify-center">
              <PhoneOff className="w-2.5 h-2.5 text-white" />
            </div>
          </div>
        </div>
      )}

      {(style === 'xiaomi_miui_pastel' ||
        style === 'xiaomi_miui_blue' ||
        style === 'tecno_hios' ||
        style === 'infinix_teal' ||
        style === 'vivo_funtouch' ||
        style === 'huawei_emui' ||
        style === 'lg_card' ||
        style === 'sony_xperia' ||
        style === 'htc_sense' ||
        style === 'iphone_ios') && (
        <div className="px-2 pb-5 space-y-2">
          <div
            className={`grid grid-cols-3 gap-1.5 justify-items-center ${
              !preset.darkMode && (style === 'htc_sense' || style === 'lg_card')
                ? 'text-[#222]'
                : 'text-white/90'
            }`}
          >
            <div className="w-4 h-4 rounded-full bg-white/15 flex items-center justify-center">
              <MicOff className="w-2 h-2" />
            </div>
            <div className="w-4 h-4 rounded-full bg-white/15 flex items-center justify-center">
              <Grip className="w-2 h-2" />
            </div>
            <div className="w-4 h-4 rounded-full bg-white/15 flex items-center justify-center">
              <Volume2 className="w-2 h-2" />
            </div>
          </div>
          <div className="flex justify-center">
            <div
              className={`${
                style === 'xiaomi_miui_blue' || style === 'vivo_funtouch'
                  ? 'w-11 h-4 rounded-full'
                  : 'w-5 h-5 rounded-full'
              } bg-[#e53935] flex items-center justify-center`}
            >
              <PhoneOff className="w-2.5 h-2.5 text-white" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HiddenPhoneThemePickerModal({
  open,
  activePreset,
  selectionMode,
  deviceInfo,
  onSelectAuto,
  onSelectPreset,
  onClose,
}: HiddenPhoneThemePickerModalProps) {
  const [selectedBrandTab, setSelectedBrandTab] = useState<string>(
    activePreset?.brandTab || 'SAMSUNG'
  );
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [modelFilter, setModelFilter] = useState<string>('');

  const groupedByBrand = useMemo(() => {
    const map = new Map<string, PhoneThemePreset[]>();
    for (const tab of BRAND_TAB_ORDER) {
      map.set(tab, []);
    }
    for (const item of PHONE_THEME_CATALOG) {
      const list = map.get(item.brandTab);
      if (list) {
        list.push(item);
      } else {
        map.get('OTHERS')?.push(item);
      }
    }
    return map;
  }, []);

  const visiblePresets = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (q) {
      return PHONE_THEME_CATALOG.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.brandTab.toLowerCase().includes(q) ||
          p.oemFamily.toLowerCase().includes(q)
      );
    }
    return groupedByBrand.get(selectedBrandTab) || [];
  }, [groupedByBrand, modelFilter, selectedBrandTab]);

  if (!open) return null;

  const detectedLabel = deviceInfo?.model
    ? `${deviceInfo.manufacturer ? `${deviceInfo.manufacturer} ` : ''}${deviceInfo.model}`
    : 'Auto-detected device';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className="fixed inset-0 z-[90] bg-white text-[#111111] flex flex-col select-none"
    >
      {/* Top App Bar matching screenshots */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2 shrink-0 bg-white">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-5 h-5 text-[#111111]" />
          </button>
          <h1 className="text-[18.5px] font-bold tracking-tight text-[#111111] truncate">
            Select theme for phone
          </h1>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onSelectAuto}
            className={`px-2.5 py-1 rounded-xl text-[11.5px] font-bold flex items-center gap-1 border transition-colors cursor-pointer ${
              selectionMode === 'auto'
                ? 'bg-[#e6f8f0] border-[#00bfa5] text-[#009b72]'
                : 'bg-slate-100 border-slate-200 text-[#555]'
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>Auto</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v);
              if (searchOpen) setModelFilter('');
            }}
            aria-label="Search model"
            className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/5 text-[#00a878] cursor-pointer"
          >
            {searchOpen ? <X className="w-5 h-5" /> : <Search className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Optional Model Filter Search Input */}
      {searchOpen && (
        <div className="px-4 pb-2 shrink-0">
          <input
            type="text"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            placeholder="Search phone model (e.g. A13, Redmi, Tecno, Pixel)..."
            autoFocus
            className="w-full bg-slate-100 rounded-2xl px-3.5 py-2 text-[13px] text-[#111111] outline-none border border-slate-200 focus:border-[#00bfa5]"
          />
        </div>
      )}

      {/* Horizontal Scrollable Brand Tabs with Counts (matching screenshots) */}
      <div className="border-b border-slate-200 shrink-0 bg-white">
        <div className="flex items-center overflow-x-auto no-scrollbar px-2">
          {BRAND_TAB_ORDER.map((brand) => {
            const count = groupedByBrand.get(brand)?.length || 0;
            if (count === 0) return null;
            const isActive = !modelFilter.trim() && selectedBrandTab === brand;
            return (
              <button
                key={brand}
                type="button"
                onClick={() => {
                  setModelFilter('');
                  setSelectedBrandTab(brand);
                }}
                className={`relative px-3.5 py-2.5 text-[12.5px] font-bold tracking-wide whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  isActive ? 'text-[#00a878]' : 'text-[#8e9299]'
                }`}
              >
                <span>
                  {brand}({count})
                </span>
                {isActive && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-[#00bfa5] rounded-t-full" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Auto-Detect / Selected Device Strip */}
      <div className="px-4 py-1.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between text-[11px] text-slate-600 shrink-0">
        <span className="truncate">
          {selectionMode === 'auto'
            ? `Auto active: ${detectedLabel} -> ${activePreset.name}`
            : `Locked theme: ${activePreset.name} (${activePreset.brandTab})`}
        </span>
        <span className="font-semibold text-[#00a878] shrink-0 ml-2">
          Call + Messages
        </span>
      </div>

      {/* 2-Column Theme Preview Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 bg-white">
        {visiblePresets.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">
            No matching phone models found
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 pb-6">
            {visiblePresets.map((preset) => {
              const isSelected = activePreset.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onSelectPreset(preset)}
                  className={`relative aspect-[10/11.5] rounded-[4px] overflow-hidden text-left shadow-sm border transition-transform active:scale-[0.98] cursor-pointer ${
                    isSelected
                      ? 'border-[#ff8a00] ring-2 ring-[#ff8a00]/40'
                      : 'border-black/10'
                  }`}
                  style={{
                    background:
                      'linear-gradient(135deg, #27323f 0%, #5b5247 50%, #1c222a 100%)',
                  }}
                >
                  {/* Blurred moody outer stage around centered mini preview */}
                  <div className="absolute inset-0 flex items-center justify-center pt-1.5 pb-1">
                    <MiniCallScreenPreview preset={preset} />
                  </div>

                  {/* Orange Checkmark Badge (top-right, matches screenshot) */}
                  {isSelected && (
                    <div className="absolute top-1.5 right-1.5 w-6 h-6 rounded-[6px] bg-[#ff8a00] text-white flex items-center justify-center shadow-md z-10">
                      <Check className="w-4 h-4 stroke-[3]" />
                    </div>
                  )}

                  {/* Dark translucent bottom label strip matching screenshots */}
                  <div className="absolute inset-x-0 bottom-0 bg-black/72 px-2 py-1.5 text-center z-10">
                    <span className="block text-[11.5px] font-bold text-white leading-tight truncate">
                      {preset.name}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}
