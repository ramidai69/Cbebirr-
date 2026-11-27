'use client';

import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Bluetooth,
  Grip,
  MessageSquare,
  Mic,
  MicOff,
  MoreVertical,
  Pause,
  Phone,
  PhoneOff,
  Plus,
  ShieldCheck,
  User,
  UserPlus,
  Volume2,
} from 'lucide-react';
import { InCallStyle, PhoneThemePreset } from '@/lib/phoneThemes';

export const OEM_CALL_KEYPAD_ITEMS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '' },
  { digit: '#', sub: '' },
];

export type OemAiDotState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface OemCallSurfaceProps {
  themePreset?: PhoneThemePreset;
  displayName: string;
  subLabel?: string;
  statusText: string;
  isIncoming: boolean;
  isHoldDisabled?: boolean;
  held: boolean;
  speakerOn: boolean;
  muted: boolean;
  bluetoothOn: boolean;
  keypadVisible: boolean;
  aiDotState?: OemAiDotState;
  menuOpen: boolean;
  onSetMenuOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  onSetKeypadVisible: (visible: boolean) => void;
  onToggleSpeaker: () => void;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onToggleBluetooth: () => void;
  onPressDigit: (digit: string) => void;
  onEndCall: () => void;
  onAnswerCall?: () => void;
  onOpenMessages?: () => void;
  onAddContact?: () => void;
}

const DEFAULT_FALLBACK_GRADIENT =
  'linear-gradient(175deg, #1b4f5a 0%, #2a5368 42%, #476e84 100%)';

export default function OemCallSurface({
  themePreset,
  displayName,
  subLabel,
  statusText,
  isIncoming,
  isHoldDisabled,
  held,
  speakerOn,
  muted,
  bluetoothOn,
  keypadVisible,
  aiDotState,
  menuOpen,
  onSetMenuOpen,
  onSetKeypadVisible,
  onToggleSpeaker,
  onToggleMute,
  onToggleHold,
  onToggleBluetooth,
  onPressDigit,
  onEndCall,
  onAnswerCall,
  onOpenMessages,
  onAddContact,
}: OemCallSurfaceProps) {
  const style: InCallStyle = themePreset?.inCallStyle || 'samsung_card';
  const bgGradient = themePreset?.bgGradient || DEFAULT_FALLBACK_GRADIENT;
  const isLightBody =
    !themePreset?.darkMode &&
    (style === 'pixel_material' ||
      style === 'xiaomi_hyper' ||
      style === 'oppo_coloros' ||
      style === 'lg_card' ||
      style === 'htc_sense' ||
      style === 'xiaomi_miui_pastel');

  const isSamsungCard = style === 'samsung_card';
  const isTouchWiz = style === 'samsung_touchwiz' || style === 'htc_sense';
  const isPillFourBar =
    style === 'pixel_material' || style === 'xiaomi_hyper' || style === 'oppo_coloros';

  const cardBg =
    themePreset?.cardBg && themePreset.cardBg !== 'transparent'
      ? themePreset.cardBg
      : isLightBody
        ? 'rgba(241, 244, 249, 0.96)'
        : 'rgba(26, 30, 38, 0.84)';

  const cardDarkText =
    themePreset?.cardDarkText !== undefined
      ? themePreset.cardDarkText
      : isLightBody;

  const panelTextClass = cardDarkText ? 'text-[#1c1c1c]' : 'text-white';
  const panelMutedClass = cardDarkText ? 'text-[#525860]' : 'text-white/75';
  const topTextClass = isLightBody ? 'text-[#16181d]' : 'text-white';
  const topSubClass = isLightBody ? 'text-[#5c6370]' : 'text-white/75';
  const activeColor = themePreset?.accentColor || '#1976d2';
  const endColor = themePreset?.endBtnColor || '#e53935';
  const answerColor = themePreset?.answerBtnColor || '#19b264';
  const initialLetter = (displayName || 'C').trim().slice(0, 1).toUpperCase();

  const renderDtmfPad = (darkSurface: boolean) => (
    <div className="grid grid-cols-3 gap-y-2 gap-x-3 pb-4">
      {OEM_CALL_KEYPAD_ITEMS.map((item) => (
        <button
          key={item.digit}
          type="button"
          onClick={() => onPressDigit(item.digit)}
          className={`h-[50px] rounded-2xl flex flex-col items-center justify-center transition-colors cursor-pointer ${
            darkSurface ? 'active:bg-white/10 text-white' : 'active:bg-black/10 text-[#1c1c1c]'
          }`}
        >
          <span className="text-[27px] font-semibold leading-none">{item.digit}</span>
          {item.sub ? (
            <span
              className={`text-[10px] font-bold tracking-[0.14em] mt-0.5 ${
                darkSurface ? 'text-white/60' : 'text-[#454b4f]'
              }`}
            >
              {item.sub}
            </span>
          ) : (
            <span className="h-[11px]" />
          )}
        </button>
      ))}
    </div>
  );

  const renderOverflowMenu = () => (
    <AnimatePresence>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => onSetMenuOpen(false)} />
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -4 }}
            className="absolute right-4 top-12 z-20 w-52 bg-white text-[#111111] rounded-[24px] shadow-2xl py-2 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => onSetMenuOpen(false)}
              className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
            >
              Add call
            </button>
            <button
              type="button"
              disabled={isHoldDisabled}
              onClick={() => {
                onToggleHold();
                onSetMenuOpen(false);
              }}
              className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] disabled:opacity-40 cursor-pointer"
            >
              {held ? 'Resume call' : 'Hold call'}
            </button>
            <button
              type="button"
              onClick={() => {
                onSetMenuOpen(false);
                onAddContact?.();
              }}
              className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
            >
              Add to Contacts
            </button>
            <button
              type="button"
              onClick={() => {
                onSetMenuOpen(false);
                onOpenMessages?.();
              }}
              className="w-full px-5 py-3 text-left text-[15px] font-medium hover:bg-black/[0.04] cursor-pointer"
            >
              Send message
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  const renderAiDot = () => {
    if (!aiDotState || aiDotState === 'idle' || held) return null;
    return (
      <div className="mt-2 flex justify-center">
        <span
          aria-hidden="true"
          className={`inline-block w-2 h-2 rounded-full transition-colors ${
            aiDotState === 'listening'
              ? 'bg-emerald-400 animate-pulse'
              : aiDotState === 'thinking'
                ? 'bg-amber-400 animate-pulse'
                : aiDotState === 'speaking'
                  ? 'bg-sky-400'
                  : 'bg-rose-500'
          }`}
        />
      </div>
    );
  };

  // ==================== INCOMING CALL CONTROLS ====================
  const renderIncomingControls = () => (
    <div className="px-8 pb-14 shrink-0 w-full max-w-[390px] mx-auto">
      {style === 'iphone_ios' && (
        <div className="flex items-center justify-around mb-10 text-white/85">
          <button
            type="button"
            onClick={() => onOpenMessages?.()}
            className="flex flex-col items-center gap-1.5 cursor-pointer"
          >
            <div className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center">
              <MessageSquare className="w-4 h-4" />
            </div>
            <span className="text-[11px] font-medium">Message</span>
          </button>
        </div>
      )}
      <div className="flex items-center justify-between px-4">
        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={onAnswerCall}
            aria-label="Answer"
            style={{ backgroundColor: answerColor }}
            className="w-[70px] h-[70px] rounded-full active:scale-95 text-white flex items-center justify-center shadow-lg transition-transform animate-pulse cursor-pointer"
          >
            <Phone className="w-8 h-8 fill-white stroke-white" />
          </button>
          <span className={`text-[13px] font-medium ${topTextClass}`}>Answer</span>
        </div>

        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={onEndCall}
            aria-label="Decline"
            style={{ backgroundColor: endColor }}
            className="w-[70px] h-[70px] rounded-full active:scale-95 text-white flex items-center justify-center shadow-lg transition-transform cursor-pointer"
          >
            <PhoneOff className="w-8 h-8 fill-white stroke-white" />
          </button>
          <span className={`text-[13px] font-medium ${topTextClass}`}>Decline</span>
        </div>
      </div>
    </div>
  );

  // ==================== CLASSIC TOUCHWIZ / HTC SENSE ====================
  if (isTouchWiz) {
    const hdrBg =
      style === 'htc_sense'
        ? themePreset?.accentColor || '#1565c0'
        : themePreset?.accentColor === '#00acc1'
          ? '#00acc1'
          : '#6fa33a';
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[70] flex flex-col justify-between select-none bg-white text-[#1c1c1c]"
      >
        <div
          className="pt-8 pb-6 px-5 text-white relative shrink-0"
          style={{ backgroundColor: hdrBg }}
        >
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold tabular-nums opacity-95">
              {statusText}
            </div>
            {!isIncoming && (
              <button
                type="button"
                onClick={() => onSetMenuOpen((v) => !v)}
                className="w-8 h-8 rounded-full flex items-center justify-center active:bg-white/15 cursor-pointer"
              >
                <MoreVertical className="w-5 h-5 text-white" />
              </button>
            )}
          </div>
          {renderOverflowMenu()}
          <div className="mt-4">
            <div className="text-[32px] font-bold leading-tight truncate">{displayName}</div>
            {subLabel && <div className="text-[14px] text-white/85 mt-0.5">{subLabel}</div>}
            {renderAiDot()}
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center bg-[#f1f5f7]">
          <div className="w-28 h-28 rounded-full bg-slate-300/80 flex items-center justify-center text-slate-600">
            <User className="w-16 h-16" />
          </div>
        </div>

        {isIncoming ? (
          <div className="bg-white py-6">{renderIncomingControls()}</div>
        ) : (
          <div className="bg-white px-5 pt-4 pb-7 border-t border-slate-200 shrink-0 max-w-[410px] w-full mx-auto">
            {keypadVisible ? (
              <>
                {renderDtmfPad(false)}
                <div className="grid grid-cols-3 gap-2 pb-4">
                  <button
                    type="button"
                    onClick={onToggleSpeaker}
                    className="flex flex-col items-center gap-1 py-2 rounded-xl active:bg-black/5 cursor-pointer"
                  >
                    <Volume2 className={`w-6 h-6 ${speakerOn ? 'text-[#0b57d0]' : 'text-[#222]'}`} />
                    <span className="text-[11.5px] font-medium">Speaker</span>
                  </button>
                  <button
                    type="button"
                    onClick={onToggleMute}
                    className="flex flex-col items-center gap-1 py-2 rounded-xl active:bg-black/5 cursor-pointer"
                  >
                    {muted ? <Mic className="w-6 h-6 text-[#d93829]" /> : <MicOff className="w-6 h-6 text-[#222]" />}
                    <span className="text-[11.5px] font-medium">Mute</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetKeypadVisible(false)}
                    className="flex flex-col items-center gap-1 py-2 rounded-xl active:bg-black/5 cursor-pointer"
                  >
                    <Grip className="w-6 h-6 text-[#19b264]" />
                    <span className="text-[11.5px] font-medium">Hide</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-3 gap-3 pb-4">
                {[
                  { label: 'Add call', icon: Plus, active: false, action: () => {} },
                  { label: 'Hold', icon: Pause, active: held, action: onToggleHold, disabled: isHoldDisabled },
                  { label: 'Bluetooth', icon: Bluetooth, active: bluetoothOn, action: onToggleBluetooth },
                  { label: 'Speaker', icon: Volume2, active: speakerOn, action: onToggleSpeaker },
                  { label: 'Mute', icon: muted ? Mic : MicOff, active: muted, action: onToggleMute },
                  { label: 'Keypad', icon: Grip, active: false, action: () => onSetKeypadVisible(true) },
                ].map((btn) => {
                  const Icon = btn.icon;
                  return (
                    <button
                      key={btn.label}
                      type="button"
                      disabled={btn.disabled}
                      onClick={btn.action}
                      className={`py-2.5 rounded-xl border flex flex-col items-center gap-1 text-xs font-medium cursor-pointer ${
                        btn.active
                          ? 'bg-emerald-50 border-emerald-400 text-emerald-700'
                          : 'bg-slate-50 border-slate-200 text-[#222]'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <span>{btn.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              onClick={onEndCall}
              className="w-full h-12 rounded-2xl bg-[#e53935] text-white font-bold flex items-center justify-center gap-2 shadow-md active:scale-[0.99] cursor-pointer"
            >
              <PhoneOff className="w-5 h-5 fill-white stroke-white" />
              <span>End</span>
            </button>
          </div>
        )}
      </motion.div>
    );
  }

  // ==================== PILL 4-BAR LAYOUT (PIXEL / HYPEROS / COLOROS) ====================
  if (isPillFourBar) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className={`fixed inset-0 z-[70] flex flex-col justify-between select-none ${topTextClass}`}
        style={{ background: bgGradient }}
      >
        <div className="relative pt-7 px-5 flex items-center justify-between shrink-0">
          <div className={`text-[13px] font-semibold tracking-wide tabular-nums ${topSubClass}`}>
            {themePreset?.oemFamily === 'xiaomi' ? 'SIM 1 · ' : ''}
            {statusText}
          </div>
          {!isIncoming && (
            <button
              type="button"
              onClick={() => onSetMenuOpen((v) => !v)}
              aria-label="In-call menu"
              className="w-9 h-9 rounded-full flex items-center justify-center active:bg-black/10 cursor-pointer"
            >
              <MoreVertical className="w-5 h-5" />
            </button>
          )}
          {renderOverflowMenu()}
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center pb-8">
          <div
            className="w-24 h-24 rounded-full flex items-center justify-center text-[38px] font-bold text-white shadow-lg mb-5"
            style={{ backgroundColor: themePreset?.avatarBg || activeColor }}
          >
            {initialLetter}
          </div>
          <div className="text-[32px] font-bold tracking-tight leading-tight break-all">
            {displayName}
          </div>
          {subLabel && (
            <div className={`text-[14px] mt-1 ${topSubClass}`}>{subLabel}</div>
          )}
          {renderAiDot()}
          {held && (
            <div className="mt-2 px-3 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-500">
              On hold
            </div>
          )}
        </div>

        {isIncoming ? (
          renderIncomingControls()
        ) : (
          <div className="px-5 pb-9 shrink-0 w-full max-w-[390px] mx-auto space-y-5">
            {keypadVisible ? (
              <div
                className={`rounded-[30px] p-4 shadow-xl backdrop-blur-md ${panelTextClass}`}
                style={{ backgroundColor: cardBg }}
              >
                {renderDtmfPad(!cardDarkText)}
                <button
                  type="button"
                  onClick={() => onSetKeypadVisible(false)}
                  className="w-full py-2 text-xs font-bold opacity-80 cursor-pointer"
                >
                  Hide keypad
                </button>
              </div>
            ) : (
              <div
                className={`rounded-[32px] px-3 py-3.5 shadow-lg backdrop-blur-md flex items-center justify-around ${panelTextClass}`}
                style={{ backgroundColor: cardBg }}
              >
                <button
                  type="button"
                  onClick={onToggleMute}
                  className="flex flex-col items-center gap-1 px-2 py-1 rounded-2xl cursor-pointer"
                >
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center ${
                      muted
                        ? 'bg-[#d93829] text-white'
                        : cardDarkText
                          ? 'bg-black/[0.06]'
                          : 'bg-white/12'
                    }`}
                  >
                    {muted ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                  </div>
                  <span className="text-[11px] font-medium">Mute</span>
                </button>

                <button
                  type="button"
                  onClick={() => onSetKeypadVisible(true)}
                  className="flex flex-col items-center gap-1 px-2 py-1 rounded-2xl cursor-pointer"
                >
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center ${
                      cardDarkText ? 'bg-black/[0.06]' : 'bg-white/12'
                    }`}
                  >
                    <Grip className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-medium">Keypad</span>
                </button>

                <button
                  type="button"
                  onClick={onToggleSpeaker}
                  className="flex flex-col items-center gap-1 px-2 py-1 rounded-2xl cursor-pointer"
                >
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center ${
                      speakerOn
                        ? 'text-white'
                        : cardDarkText
                          ? 'bg-black/[0.06]'
                          : 'bg-white/12'
                    }`}
                    style={speakerOn ? { backgroundColor: activeColor } : undefined}
                  >
                    <Volume2 className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-medium">Speaker</span>
                </button>

                <button
                  type="button"
                  disabled={isHoldDisabled}
                  onClick={onToggleHold}
                  className={`flex flex-col items-center gap-1 px-2 py-1 rounded-2xl ${
                    isHoldDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                  }`}
                >
                  <div
                    className={`w-11 h-11 rounded-full flex items-center justify-center ${
                      held
                        ? 'text-white'
                        : cardDarkText
                          ? 'bg-black/[0.06]'
                          : 'bg-white/12'
                    }`}
                    style={held ? { backgroundColor: activeColor } : undefined}
                  >
                    <Pause className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-medium">Hold</span>
                </button>
              </div>
            )}

            <div className="flex justify-center">
              <button
                type="button"
                onClick={onEndCall}
                aria-label="End Call"
                style={{ backgroundColor: endColor }}
                className="w-[68px] h-[64px] rounded-full text-white flex items-center justify-center shadow-xl active:scale-95 transition-transform cursor-pointer"
              >
                <PhoneOff className="w-7 h-7 fill-white stroke-white" />
              </button>
            </div>
          </div>
        )}
      </motion.div>
    );
  }

  // ==================== SAMSUNG ONE UI / UNIVERSAL OEM FROSTED & TRANSLUCENT STYLES ====================
  const useCardBox = isSamsungCard && themePreset?.cardBg !== 'transparent';
  const useWideEndCapsule =
    style === 'xiaomi_miui_blue' || style === 'vivo_funtouch';
  const isIosStyle = style === 'iphone_ios';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`fixed inset-0 z-[70] flex flex-col justify-between select-none ${topTextClass}`}
      style={{ background: bgGradient }}
    >
      {/* Top Status & Overflow Menu */}
      <div className="relative pt-7 px-5 flex items-center justify-center shrink-0">
        <div
          className={`flex items-center gap-1.5 text-[15px] font-semibold tracking-wide tabular-nums ${topTextClass}`}
        >
          <Phone className="w-3.5 h-3.5 fill-current" />
          <span>{statusText}</span>
        </div>

        {!isIncoming && (
          <button
            type="button"
            onClick={() => onSetMenuOpen((v) => !v)}
            aria-label="In-call menu"
            className="absolute right-4 top-6 w-9 h-9 rounded-full flex items-center justify-center active:bg-white/10 cursor-pointer"
          >
            <MoreVertical className="w-5 h-5" />
          </button>
        )}
        {renderOverflowMenu()}
      </div>

      {/* Main Caller Identity */}
      <div className="flex-1 min-h-0 flex flex-col items-center px-5 pt-6 overflow-hidden">
        {(style === 'xiaomi_miui_pastel' ||
          style === 'xiaomi_miui_blue' ||
          style === 'tecno_hios' ||
          style === 'infinix_teal' ||
          style === 'vivo_funtouch' ||
          style === 'huawei_emui' ||
          style === 'sony_xperia' ||
          style === 'lg_card') && (
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-[32px] font-bold text-white shadow-lg mb-4"
            style={{ backgroundColor: themePreset?.avatarBg || activeColor }}
          >
            {initialLetter}
          </div>
        )}

        <div className="text-center shrink-0">
          <div className="text-[36px] font-bold tracking-tight leading-tight break-all">
            {displayName}
          </div>
          {subLabel && (
            <div className={`text-[14px] font-medium mt-1 ${topSubClass}`}>
              {subLabel}
            </div>
          )}
          {renderAiDot()}
          {held && (
            <div className={`text-[14px] font-normal mt-1.5 ${topSubClass}`}>
              On hold
            </div>
          )}
        </div>
      </div>

      {/* Bottom Controls */}
      {isIncoming ? (
        renderIncomingControls()
      ) : (
        <div className="px-5 pb-7 shrink-0 w-full max-w-[390px] mx-auto">
          {themePreset?.hasCallAssistChip && !keypadVisible && (
            <div className="flex justify-center mb-3">
              <div className="px-4 py-1.5 rounded-full bg-white/15 backdrop-blur-md text-xs font-semibold text-white flex items-center gap-1.5 shadow-sm">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Call assist</span>
              </div>
            </div>
          )}

          <div
            className={`${
              useCardBox
                ? `backdrop-blur-md rounded-[34px] px-5 pt-6 pb-6 shadow-2xl ${panelTextClass}`
                : `px-3 pt-3 pb-4 ${topTextClass}`
            }`}
            style={useCardBox ? { backgroundColor: cardBg } : undefined}
          >
            {keypadVisible ? (
              <>
                {renderDtmfPad(useCardBox ? !cardDarkText : !isLightBody)}
                <div className="grid grid-cols-3 gap-2 pt-1 pb-5">
                  <button
                    type="button"
                    onClick={onToggleSpeaker}
                    className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl active:bg-white/10 cursor-pointer"
                  >
                    <Volume2
                      className="w-6 h-6"
                      style={speakerOn ? { color: activeColor } : undefined}
                    />
                    <span className="text-[12px] font-medium">Speaker</span>
                  </button>

                  <button
                    type="button"
                    onClick={onToggleMute}
                    className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl active:bg-white/10 cursor-pointer"
                  >
                    {muted ? (
                      <Mic className="w-6 h-6 text-[#d93829]" />
                    ) : (
                      <MicOff className="w-6 h-6" />
                    )}
                    <span className={`text-[12px] font-medium ${muted ? 'text-[#d93829]' : ''}`}>
                      Mute
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onSetKeypadVisible(false)}
                    className="flex flex-col items-center gap-1.5 py-1.5 rounded-2xl active:bg-white/10 cursor-pointer"
                  >
                    <Grip className="w-6 h-6 text-[#19b264]" />
                    <span className="text-[12px] font-medium">Hide</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-3 gap-y-5 gap-x-2 pb-6">
                {[
                  {
                    label: 'Add call',
                    icon: isIosStyle ? UserPlus : Plus,
                    active: false,
                    onClick: () => {},
                  },
                  {
                    label: 'Hold call',
                    icon: Pause,
                    active: held,
                    disabled: isHoldDisabled,
                    onClick: onToggleHold,
                  },
                  {
                    label: 'Bluetooth',
                    icon: Bluetooth,
                    active: bluetoothOn,
                    onClick: onToggleBluetooth,
                  },
                  {
                    label: 'Speaker',
                    icon: Volume2,
                    active: speakerOn,
                    onClick: onToggleSpeaker,
                  },
                  {
                    label: 'Mute',
                    icon: muted ? Mic : MicOff,
                    active: muted,
                    danger: muted,
                    onClick: onToggleMute,
                  },
                  {
                    label: 'Keypad',
                    icon: Grip,
                    active: false,
                    onClick: () => onSetKeypadVisible(true),
                  },
                ].map((btn) => {
                  const Icon = btn.icon;
                  return (
                    <button
                      key={btn.label}
                      type="button"
                      disabled={btn.disabled}
                      onClick={btn.onClick}
                      className={`flex flex-col items-center gap-1.5 py-1 rounded-2xl ${
                        btn.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                      }`}
                    >
                      <div
                        className={
                          isIosStyle || !useCardBox
                            ? `w-13 h-13 rounded-full flex items-center justify-center transition-colors ${
                                btn.active
                                  ? 'bg-white text-[#111]'
                                  : isLightBody
                                    ? 'bg-black/10'
                                    : 'bg-white/15'
                              }`
                            : 'flex items-center justify-center'
                        }
                      >
                        <Icon
                          className={`w-6 h-6 ${btn.danger ? 'text-[#d93829]' : ''}`}
                          style={
                            btn.active && !btn.danger && useCardBox
                              ? { color: activeColor }
                              : undefined
                          }
                        />
                      </div>
                      <span
                        className={`text-[12px] font-medium ${
                          btn.danger
                            ? 'text-[#d93829]'
                            : !useCardBox
                              ? topTextClass
                              : panelMutedClass
                        }`}
                      >
                        {btn.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex justify-center">
              <button
                type="button"
                onClick={onEndCall}
                aria-label="End Call"
                style={{ backgroundColor: endColor }}
                className={`${
                  useWideEndCapsule
                    ? 'w-52 h-[54px] rounded-full'
                    : 'w-[62px] h-[62px] rounded-full'
                } text-white flex items-center justify-center shadow-lg active:scale-95 transition-transform cursor-pointer`}
              >
                <PhoneOff className="w-7 h-7 fill-white stroke-white" />
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
