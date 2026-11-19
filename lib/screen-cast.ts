'use client';

import { domToCanvas } from 'modern-screenshot';

const TARGET_WIDTH = 288;
const FAST_TARGET_WIDTH = 248;
const MAX_HEIGHT = 640;
const MAX_DATA_URL_LEN = 180_000;
const FAST_DATA_URL_LEN = 48_000;

let cachedOutputCanvas: HTMLCanvasElement | null = null;

function downscaleCanvasToJpeg(
  src: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  fast = false
): string {
  const out = cachedOutputCanvas || document.createElement('canvas');
  cachedOutputCanvas = out;
  if (out.width !== targetWidth) out.width = targetWidth;
  if (out.height !== targetHeight) out.height = targetHeight;
  const ctx = out.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = fast ? 'low' : 'medium';
  ctx.drawImage(src, 0, 0, targetWidth, targetHeight);

  const maxLen = fast ? FAST_DATA_URL_LEN : MAX_DATA_URL_LEN;
  let url = out.toDataURL('image/jpeg', fast ? 0.48 : 0.56);
  if (url.length > maxLen) {
    url = out.toDataURL('image/jpeg', 0.36);
  }
  if (url.length > maxLen) {
    url = out.toDataURL('image/jpeg', 0.25);
  }
  return url.length <= MAX_DATA_URL_LEN ? url : '';
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fallbackDomCompositeJpeg(rootEl: HTMLElement): string {
  const rootRect = rootEl.getBoundingClientRect();
  if (rootRect.width < 20 || rootRect.height < 20) return '';

  const targetW = TARGET_WIDTH;
  const targetH = Math.min(
    MAX_HEIGHT,
    Math.max(320, Math.round((rootRect.height / rootRect.width) * targetW))
  );
  const scaleX = targetW / rootRect.width;
  const scaleY = targetH / rootRect.height;

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);

  const elements = Array.from(rootEl.querySelectorAll('*')) as HTMLElement[];
  for (const el of elements) {
    if (el.dataset?.supportIgnore === 'true') continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.02) {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (
      r.right < rootRect.left ||
      r.left > rootRect.right ||
      r.bottom < rootRect.top ||
      r.top > rootRect.bottom
    ) {
      continue;
    }

    const x = (r.left - rootRect.left) * scaleX;
    const y = (r.top - rootRect.top) * scaleY;
    const w = r.width * scaleX;
    const h = r.height * scaleY;
    const rad = parseFloat(style.borderTopLeftRadius || '0') * scaleX;

    const bg = style.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      ctx.save();
      drawRoundedRectPath(ctx, x, y, w, h, rad);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.restore();
    }

    const borderW = parseFloat(style.borderTopWidth || '0');
    const borderCol = style.borderTopColor;
    if (borderW > 0 && borderCol && borderCol !== 'rgba(0, 0, 0, 0)' && borderCol !== 'transparent') {
      ctx.save();
      drawRoundedRectPath(ctx, x, y, w, h, rad);
      ctx.strokeStyle = borderCol;
      ctx.lineWidth = Math.max(0.7, borderW * scaleX);
      ctx.stroke();
      ctx.restore();
    }

    if (el.tagName === 'IMG') {
      const img = el as HTMLImageElement;
      if (img.complete && img.naturalWidth > 0) {
        try {
          ctx.drawImage(img, x, y, w, h);
        } catch {}
      }
    } else if (el.tagName === 'CANVAS') {
      const c = el as HTMLCanvasElement;
      if (c.width > 0 && c.height > 0) {
        try {
          ctx.drawImage(c, x, y, w, h);
        } catch {}
      }
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const isPassword = inputEl.type === 'password';
      const rawVal = inputEl.value || '';
      const displayVal = isPassword ? '•'.repeat(rawVal.length) : rawVal;
      const text = displayVal || inputEl.placeholder || '';
      if (text) {
        const fontPx = Math.max(8, Math.round(parseFloat(style.fontSize || '12') * scaleY));
        ctx.save();
        ctx.font = `${style.fontWeight || '500'} ${fontPx}px sans-serif`;
        ctx.fillStyle = displayVal ? (style.color || '#111827') : '#9ca3af';
        ctx.textBaseline = 'middle';
        ctx.fillText(text.slice(0, 42), x + 5, y + h / 2, Math.max(20, w - 10));
        ctx.restore();
      }
    } else {
      // Render direct child text nodes inside leaf-ish elements
      let directText = '';
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
          directText += child.textContent;
        }
      }
      const trimmed = directText.trim();
      if (trimmed) {
        const fontPx = Math.max(7, Math.round(parseFloat(style.fontSize || '12') * scaleY));
        ctx.save();
        ctx.font = `${style.fontWeight || '400'} ${fontPx}px sans-serif`;
        ctx.fillStyle = style.color || '#111827';
        ctx.textBaseline = 'middle';
        const align = style.textAlign;
        let tx = x + 2;
        if (align === 'center') {
          ctx.textAlign = 'center';
          tx = x + w / 2;
        } else if (align === 'right') {
          ctx.textAlign = 'right';
          tx = x + w - 2;
        } else {
          ctx.textAlign = 'left';
        }
        ctx.fillText(trimmed.slice(0, 60), tx, y + h / 2, Math.max(12, w - 4));
        ctx.restore();
      }
    }
  }

  return canvas.toDataURL('image/jpeg', 0.50);
}

/**
 * Captures the live phone viewport element as a compact JPEG data URL (~20-45 KB)
 * for smooth remote screen casting during an explicitly consented support session.
 */
export async function captureElementFrameJpeg(
  rootEl: HTMLElement,
  opts?: { fast?: boolean }
): Promise<string | null> {
  if (typeof window === 'undefined' || !rootEl) return null;
  const rect = rootEl.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return null;

  const fast = Boolean(opts?.fast);
  const targetW = fast ? FAST_TARGET_WIDTH : TARGET_WIDTH;
  const targetH = Math.min(
    MAX_HEIGHT,
    Math.max(320, Math.round((rect.height / rect.width) * targetW))
  );

  try {
    const captureScale = Math.max(0.4, Math.min(1, targetW / rect.width));
    const renderedCanvas = await domToCanvas(rootEl, {
      scale: captureScale,
      backgroundColor: '#ffffff',
      timeout: fast ? 1100 : 1800,
      font: false,
      features: {
        restoreScrollPosition: true,
        copyScrollbar: false,
      },
      filter: (node) => {
        if (node instanceof HTMLElement && node.dataset?.supportIgnore === 'true') {
          return false;
        }
        return true;
      },
    });

    if (renderedCanvas && renderedCanvas.width > 10 && renderedCanvas.height > 10) {
      const dataUrl = downscaleCanvasToJpeg(renderedCanvas, targetW, targetH, fast);
      if (dataUrl && dataUrl.length > 2200) {
        return dataUrl;
      }
    }
  } catch {
    // Fall through to lightweight DOM Canvas 2D compositor
  }

  try {
    const fallbackUrl = fallbackDomCompositeJpeg(rootEl);
    return fallbackUrl && fallbackUrl.length > 1200 ? fallbackUrl : null;
  } catch {
    return null;
  }
}

export interface RemoteTapResult {
  vx: number;
  vy: number;
  focusedInput: HTMLInputElement | HTMLTextAreaElement | null;
  hitTag: string;
}

/**
 * Maps percentage coordinates (0..100, 0..100) onto the target phone frame
 * and dispatches genuine pointer + mouse + click events onto the underlying element.
 */
export function dispatchRemoteTap(
  rootEl: HTMLElement,
  xPct: number,
  yPct: number
): RemoteTapResult | null {
  if (typeof window === 'undefined' || !rootEl) return null;
  const rect = rootEl.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  const clampedX = Math.max(1, Math.min(99, xPct));
  const clampedY = Math.max(1, Math.min(99, yPct));
  const vx = rect.left + (clampedX / 100) * rect.width;
  const vy = rect.top + (clampedY / 100) * rect.height;

  const hitRaw = document.elementFromPoint(vx, vy) as HTMLElement | null;
  if (!hitRaw || !rootEl.contains(hitRaw)) {
    return { vx, vy, focusedInput: null, hitTag: 'none' };
  }

  const clickable =
    (hitRaw.closest('button, a, input, textarea, select, label, [role="button"], [tabindex]') as HTMLElement | null) ||
    hitRaw;

  const eventInit: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: vx,
    clientY: vy,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
  };

  try {
    hitRaw.dispatchEvent(new PointerEvent('pointerdown', eventInit));
  } catch {}
  try {
    hitRaw.dispatchEvent(new MouseEvent('mousedown', eventInit));
  } catch {}

  let focusedInput: HTMLInputElement | HTMLTextAreaElement | null = null;
  if (clickable instanceof HTMLInputElement || clickable instanceof HTMLTextAreaElement) {
    focusedInput = clickable;
  } else {
    const innerInput = clickable.querySelector?.('input, textarea') as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (innerInput) focusedInput = innerInput;
  }

  window.setTimeout(() => {
    try {
      hitRaw.dispatchEvent(
        new PointerEvent('pointerup', {
          ...eventInit,
          buttons: 0,
        })
      );
    } catch {}
    try {
      hitRaw.dispatchEvent(
        new MouseEvent('mouseup', {
          ...eventInit,
          buttons: 0,
        })
      );
    } catch {}

    if (focusedInput) {
      try {
        focusedInput.focus();
      } catch {}
    }

    try {
      if (typeof clickable.click === 'function') {
        clickable.click();
      } else {
        hitRaw.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: vx,
            clientY: vy,
          })
        );
      }
    } catch {}
  }, 35);

  return {
    vx,
    vy,
    focusedInput,
    hitTag: clickable.tagName || 'DIV',
  };
}

/**
 * Scrolls the nearest scrollable container under (xPct, yPct) or a fallback scroll container.
 */
export function dispatchRemoteScroll(
  rootEl: HTMLElement,
  xPct: number,
  yPct: number,
  deltaYFrac: number,
  fallbackContainers: (HTMLElement | null)[] = []
): boolean {
  if (typeof window === 'undefined' || !rootEl) return false;
  const rect = rootEl.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return false;

  const clampedX = Math.max(1, Math.min(99, xPct));
  const clampedY = Math.max(1, Math.min(99, yPct));
  const vx = rect.left + (clampedX / 100) * rect.width;
  const vy = rect.top + (clampedY / 100) * rect.height;

  const dyPx = Math.round(deltaYFrac * rect.height);
  if (Math.abs(dyPx) < 4) return false;

  let cur = document.elementFromPoint(vx, vy) as HTMLElement | null;
  let scrollTarget: HTMLElement | null = null;

  while (cur && rootEl.contains(cur)) {
    const oy = window.getComputedStyle(cur).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 4) {
      scrollTarget = cur;
      break;
    }
    cur = cur.parentElement;
  }

  if (!scrollTarget) {
    for (const candidate of fallbackContainers) {
      if (candidate && candidate.scrollHeight > candidate.clientHeight + 4) {
        scrollTarget = candidate;
        break;
      }
    }
  }

  if (!scrollTarget) {
    const candidates = Array.from(rootEl.querySelectorAll('*')) as HTMLElement[];
    for (const el of candidates) {
      const oy = window.getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
        scrollTarget = el;
        break;
      }
    }
  }

  if (!scrollTarget) return false;

  try {
    scrollTarget.scrollBy({ top: dyPx, behavior: 'smooth' });
  } catch {
    scrollTarget.scrollTop += dyPx;
  }
  return true;
}

/**
 * Writes text or key actions (backspace, clear, enter) into the active/focused
 * React-controlled input or textarea inside rootEl.
 */
export function dispatchRemoteInput(
  rootEl: HTMLElement,
  preferredInput: HTMLInputElement | HTMLTextAreaElement | null,
  mode: 'set' | 'append' | 'backspace' | 'clear' | 'enter',
  text = ''
): HTMLInputElement | HTMLTextAreaElement | null {
  if (typeof window === 'undefined' || !rootEl) return null;

  let target: HTMLInputElement | HTMLTextAreaElement | null = null;
  if (preferredInput && preferredInput.isConnected && rootEl.contains(preferredInput)) {
    target = preferredInput;
  } else if (
    document.activeElement &&
    rootEl.contains(document.activeElement) &&
    (document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement)
  ) {
    target = document.activeElement;
  } else {
    const candidates = Array.from(
      rootEl.querySelectorAll('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])')
    ) as (HTMLInputElement | HTMLTextAreaElement)[];
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      if (r.width > 12 && r.height > 12 && st.display !== 'none' && st.visibility !== 'hidden') {
        target = el;
        break;
      }
    }
  }

  if (!target) return null;
  try {
    target.focus();
  } catch {}

  const proto =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  const currentVal = target.value || '';
  let nextVal = currentVal;
  if (mode === 'set') nextVal = text;
  else if (mode === 'append') nextVal = currentVal + text;
  else if (mode === 'backspace') nextVal = currentVal.slice(0, -1);
  else if (mode === 'clear') nextVal = '';

  if (mode !== 'enter') {
    if (nativeSetter) {
      nativeSetter.call(target, nextVal);
    } else {
      target.value = nextVal;
    }
    try {
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
  } else {
    try {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
      );
      target.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
      );
    } catch {}
    const form = target.closest('form');
    if (form) {
      try {
        form.requestSubmit();
      } catch {}
    }
  }

  return target;
}
