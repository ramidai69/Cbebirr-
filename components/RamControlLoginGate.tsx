'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Eye, EyeOff, Lock, ShieldCheck, Terminal } from 'lucide-react';
import { verifyOwnerGatePasskey } from '@/lib/owner-telemetry';

interface RamControlLoginGateProps {
  children: (controls: { lockSession: () => void }) => React.ReactNode;
}

const SESSION_UNLOCK_KEY = 'ram_control_unlocked_v1';

export default function RamControlLoginGate({ children }: RamControlLoginGateProps) {
  const [hydrated, setHydrated] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [passInput, setPassInput] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [shakeTick, setShakeTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = sessionStorage.getItem(SESSION_UNLOCK_KEY) === '1';
        setUnlocked(saved);
      } catch {
        setUnlocked(false);
      } finally {
        setHydrated(true);
      }
    });
  }, []);

  useEffect(() => {
    if (hydrated && !unlocked) {
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 80);
      return () => window.clearTimeout(t);
    }
  }, [hydrated, unlocked]);

  const lockSession = () => {
    try {
      sessionStorage.removeItem(SESSION_UNLOCK_KEY);
    } catch {}
    setPassInput('');
    setShowPass(false);
    setErrorMsg('');
    setUnlocked(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passInput.trim()) {
      setErrorMsg('AUTH KEY REQUIRED');
      setShakeTick((n) => n + 1);
      return;
    }
    if (!verifyOwnerGatePasskey(passInput.trim())) {
      setErrorMsg('ACCESS DENIED — INVALID KEY');
      setPassInput('');
      setShakeTick((n) => n + 1);
      inputRef.current?.focus();
      return;
    }
    try {
      sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
    } catch {}
    setErrorMsg('');
    setPassInput('');
    setUnlocked(true);
  };

  if (!hydrated) {
    return (
      <div className="relative w-full h-[100dvh] bg-[#030806] flex items-center justify-center overflow-hidden" />
    );
  }

  if (unlocked) {
    return <>{children({ lockSession })}</>;
  }

  return (
    <div
      className="relative w-full h-[100dvh] bg-[#030806] text-emerald-100 flex items-center justify-center p-4 overflow-hidden select-none"
      style={{
        backgroundImage:
          'radial-gradient(circle at 50% 35%, rgba(16, 185, 129, 0.14) 0%, rgba(3, 8, 6, 0.96) 58%, #020504 100%), linear-gradient(rgba(16, 185, 129, 0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(16, 185, 129, 0.055) 1px, transparent 1px)',
        backgroundSize: '100% 100%, 28px 28px, 28px 28px',
      }}
    >
      {/* Subtle Horizontal Scanline Sheen */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0) 2px, rgba(16, 185, 129, 0.07) 3px)',
        }}
      />

      {/* Compact Hacker Terminal Access Box */}
      <motion.div
        key={shakeTick}
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={
          shakeTick > 0
            ? { opacity: 1, y: 0, scale: 1, x: [0, -8, 8, -5, 5, 0] }
            : { opacity: 1, y: 0, scale: 1, x: 0 }
        }
        transition={{ duration: shakeTick > 0 ? 0.34 : 0.25 }}
        className="relative z-10 w-full max-w-[330px] rounded-2xl bg-[#07110d]/95 border border-emerald-500/35 shadow-[0_0_45px_rgba(16,185,129,0.16)] overflow-hidden backdrop-blur-md"
      >
        {/* Terminal Top Chrome */}
        <div className="px-3.5 py-2.5 bg-[#0a1812] border-b border-emerald-500/20 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="font-mono text-[11px] font-bold tracking-[0.14em] text-emerald-300 uppercase truncate">
              RAM CONTROL // SHELL
            </span>
          </div>
          <span className="font-mono text-[9.5px] text-emerald-500/80 tracking-widest uppercase">
            AES-256
          </span>
        </div>

        {/* Compact Access Body */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3.5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/12 border border-emerald-400/35 flex items-center justify-center text-emerald-400 shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="font-mono text-[14px] font-bold text-white tracking-wide leading-tight">
                ROOT ACCESS
              </h1>
              <p className="font-mono text-[10.5px] text-emerald-400/75 truncate">
                Enter operator cipher key
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div
              className={`flex items-center rounded-xl bg-[#030906] border transition-colors ${
                errorMsg
                  ? 'border-rose-500/75 focus-within:border-rose-400'
                  : 'border-emerald-500/35 focus-within:border-emerald-400'
              }`}
            >
              <div className="pl-3 pr-2 text-emerald-500/80 shrink-0">
                <Lock className="w-4 h-4" />
              </div>
              <input
                ref={inputRef}
                type={showPass ? 'text' : 'password'}
                value={passInput}
                onChange={(e) => {
                  setPassInput(e.target.value);
                  if (errorMsg) setErrorMsg('');
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="••••••••••••"
                aria-label="Operator cipher key"
                className="w-full py-3 pr-2 bg-transparent font-mono text-[14px] text-emerald-200 placeholder:text-emerald-700/80 outline-none tracking-wider"
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="w-11 h-11 flex items-center justify-center text-emerald-500/75 hover:text-emerald-300 cursor-pointer shrink-0"
                aria-label={showPass ? 'Hide cipher' : 'Show cipher'}
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {errorMsg && (
              <p className="font-mono text-[10.5px] font-bold text-rose-400 tracking-wider pl-1">
                &gt; {errorMsg}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-[#02120a] font-mono font-bold text-[12.5px] tracking-[0.12em] uppercase flex items-center justify-center gap-2 shadow-[0_0_24px_rgba(16,185,129,0.28)] cursor-pointer transition-colors"
          >
            <span>DECRYPT &amp; ENTER</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </motion.div>
    </div>
  );
}
