import { Constants } from './shared/constants.js';
import { formatTimeCompact, log } from './shared/utils.js';
import { cooldownLength } from './shared/session-model.js';
import type { ExtensionMessage, SessionStartStats } from './types.js';

declare const browser: typeof chrome;

let timerText: HTMLDivElement | null = null;
let timerElement: HTMLDivElement | null = null;
let lastActivityTime = Date.now();
// The session timer is the resting/home state on any site with an active
// session limit. Clicking the timer "peeks" at the daily total for a few
// seconds, then it snaps back to the session view. peekingDaily is per-tab and
// momentary (never persisted or synced); updateTimerText() still falls back to
// daily on its own when no session exists for the current site.
const DAILY_PEEK_MS = 5000;
let peekingDaily = false;
let peekRevertTimer: ReturnType<typeof setTimeout> | null = null;
let lastDailyTime = 0;
let lastSessionTime: number | undefined;
let lastSessionLimitSeconds: number | undefined;
let lastSessionNum: number | undefined;
let lastCooldownIncrementSeconds: number | undefined;
let blurOverlay: HTMLDivElement | null = null;
let averagePopupDialog: HTMLDivElement | null = null;
let averagePopupPausedMedia: HTMLMediaElement[] = [];
let blockerDialog: HTMLDivElement | null = null;
let endSessionDialog: HTMLDivElement | null = null;
let windDownOverlay: HTMLDivElement | null = null;
let endSessionShortcut: string = 'Ctrl+E'; // default; overridden by settings

// CSS reset applied to all popup/dialog root elements to prevent site styles from bleeding in
const CSS_RESET = `
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
  font-size: 14px !important;
  font-weight: 400 !important;
  font-style: normal !important;
  line-height: 1.4 !important;
  letter-spacing: normal !important;
  text-transform: none !important;
  text-decoration: none !important;
  text-align: left !important;
  color: #eee !important;
  direction: ltr !important;
  -webkit-font-smoothing: antialiased !important;
  box-sizing: border-box !important;
`;

/**
 * Build an element via the DOM API instead of innerHTML. `style` is a static
 * style string (assigned through cssText, which is not an injection vector);
 * `text` is set as a text node, so any dynamic value is inert markup-wise.
 * Used for the overlay dialogs to keep them free of innerHTML.
 */
function makeEl(
  tag: string,
  opts: { className?: string; style?: string; text?: string; children?: HTMLElement[] } = {}
): HTMLElement {
  const el = document.createElement(tag);
  if (opts.className) el.className = opts.className;
  if (opts.style) el.style.cssText = opts.style;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.children) el.append(...opts.children);
  return el;
}

// Queue of popup-show functions — at most one mandatory popup visible at a time.
// When a popup is dismissed it calls dequeuePopup() to show the next waiting one.
const popupQueue: Array<() => void> = [];

function isAnyMandatoryPopupVisible(): boolean {
  return averagePopupDialog !== null;
}

function dequeuePopup(): void {
  const next = popupQueue.shift();
  if (next) next();
}

// Scroll blocking is handled by the blur overlay's wheel/touchmove event handlers
// when pointer-events is set to 'all'. No need to touch document.body.style.overflow,
// which can interfere with site layout and cause scroll/loading bugs.

/** Block keyboard events from reaching the page (e.g. space/k to play/pause on YT) */
function blockKeyboardHandler(e: KeyboardEvent): void {
  // Allow Tab for accessibility within our popup buttons
  if (e.key === 'Tab') return;
  e.stopPropagation();
  e.preventDefault();
}

let keyboardBlocked = false;

function blockKeyboard(block: boolean): void {
  if (block && !keyboardBlocked) {
    // Capture phase so we intercept before the page's handlers
    document.addEventListener('keydown', blockKeyboardHandler, true);
    document.addEventListener('keyup', blockKeyboardHandler, true);
    document.addEventListener('keypress', blockKeyboardHandler, true);
    keyboardBlocked = true;
  } else if (!block && keyboardBlocked) {
    document.removeEventListener('keydown', blockKeyboardHandler, true);
    document.removeEventListener('keyup', blockKeyboardHandler, true);
    document.removeEventListener('keypress', blockKeyboardHandler, true);
    keyboardBlocked = false;
  }
}

/** Pause every playing <video>/<audio> and return the ones that were paused,
 *  so callers that want to resume on close can. */
function pauseAllMedia(): HTMLMediaElement[] {
  const paused: HTMLMediaElement[] = [];
  document.querySelectorAll('video, audio').forEach(el => {
    const media = el as HTMLMediaElement;
    if (!media.paused) {
      media.pause();
      paused.push(media);
    }
  });
  return paused;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function createTimerElement(): void {
  const timer = document.createElement("div");
  timer.className = "web-time-timer";

  timerText = document.createElement("div");
  timerText.textContent = "00:00:00";
  timerText.style.cssText = "color: #f7f7f7 !important; transition: opacity 0.12s ease !important;";

  timer.appendChild(timerText);

  // Click to peek at the daily total; it reverts to the session view after a
  // few seconds. Only meaningful where a session exists (otherwise daily is
  // already what's shown).
  timer.addEventListener('click', peekDaily);
  timer.style.cursor = 'pointer';

  // The blur overlay lives in the browser top layer, which paints above all
  // normal DOM — so a body-child timer would sit UNDER the blur and get blurred
  // too. Make the timer a top-layer popover as well; showBlurOverlay re-asserts
  // it afterward so it always paints above the blur (top-layer order is by
  // show-time, not z-index).
  timer.setAttribute('popover', 'manual');
  document.body.appendChild(timer);
  try { timer.showPopover(); } catch { /* unsupported: stays a normal fixed element */ }
  timerElement = timer;

  log("Timer element created and added to page.");
}

/** Adaptive time format: MM:SS when < 1h, H:MM:SS when >= 1h */
function formatTimeAdaptive(timeInSeconds: number): string {
  timeInSeconds = Math.max(0, Math.floor(timeInSeconds));
  const hours = Math.floor(timeInSeconds / 3600);
  const minutes = Math.floor((timeInSeconds % 3600) / 60);
  const seconds = timeInSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Whether the current site has an active session to display. */
function hasSession(): boolean {
  return lastSessionTime !== undefined && !!lastSessionLimitSeconds && lastSessionLimitSeconds > 0;
}

// 'session' = countdown view, 'daily' = total view. Tracked so we can fade only
// when the VIEW flips (peek in / revert out), not on every per-second tick.
let lastTimerMode: 'session' | 'daily' | null = null;

function updateTimerText(): void {
  if (!timerText) return;
  let text: string;
  let mode: 'session' | 'daily';
  // Session is the default view; daily only while peeking, or when there is no
  // session for this site at all.
  if (hasSession() && !peekingDaily) {
    const remaining = Math.max(0, lastSessionLimitSeconds! - lastSessionTime!);
    text = `⏱ ${formatTimeAdaptive(remaining)}`;
    mode = 'session';
  } else {
    text = formatTimeAdaptive(lastDailyTime);
    mode = 'daily';
  }

  if (timerText.textContent === text) return;

  // Same view, just the seconds advancing — swap instantly so the clock doesn't
  // flicker every tick. Only a view flip (session ⇄ daily) gets the fade.
  if (mode === lastTimerMode || lastTimerMode === null) {
    lastTimerMode = mode;
    timerText.textContent = text;
    return;
  }

  lastTimerMode = mode;
  const node = timerText;
  node.style.opacity = '0';
  setTimeout(() => {
    node.textContent = text;
    node.style.opacity = '1';
  }, 120);
}

/**
 * Show the daily total for a moment, then snap back to the session view.
 * No-op where there's no session (daily is already shown). Each click restarts
 * the revert countdown so repeated clicks keep the peek open.
 */
function peekDaily(): void {
  if (!hasSession()) return;
  peekingDaily = true;
  updateTimerText();
  if (peekRevertTimer) clearTimeout(peekRevertTimer);
  peekRevertTimer = setTimeout(() => {
    peekingDaily = false;
    peekRevertTimer = null;
    updateTimerText();
  }, DAILY_PEEK_MS);
}

function createBlurOverlay(): void {
  const overlay = document.createElement('div');
  overlay.className = 'web-time-blur-overlay';
  // Promote into the browser TOP LAYER via the Popover API. z-index only orders
  // within a stacking context, so a site's high-z-index media layer (e.g. X's
  // inline video/GIF player) can out-paint a fixed overlay no matter how big its
  // z-index. A top-layer popover renders above ALL normal DOM, so the blur
  // actually covers those players. The UA popover styles also force a centered
  // auto-margin box, so we override inset/margin/max-* to stay full-bleed.
  overlay.setAttribute('popover', 'manual');
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: none;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    background: transparent;
    z-index: 999999;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s ease;
    overflow: hidden;
    visibility: hidden;
  `;

  overlay.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });
  overlay.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });

  document.body.appendChild(overlay);
  blurOverlay = overlay;
}

// Pending "flip to hidden after the fade-out" handler, so a re-show mid-fade can
// cancel it and the overlay never gets stuck hidden with opacity still animating.
let blurHideEnd: ((e: TransitionEvent) => void) | null = null;

function clearPendingBlurHide(): void {
  if (blurOverlay && blurHideEnd) {
    blurOverlay.removeEventListener('transitionend', blurHideEnd);
  }
  blurHideEnd = null;
}

// Only the session-cooldown blocker exits fullscreen, and not because of
// layering — promoteToTopLayer lets any overlay paint over a fullscreen video.
// It exits because the session is actually over: leaving the video is part of
// the cooldown. Softer surfaces (nudge, average, end-session confirm) stay in
// fullscreen. The end-session confirm especially — it's a question the user may
// answer "no" to, and they should land back on a still-fullscreen video.
function exitFullscreenIfActive(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => { /* denied or already exiting */ });
  }
}

// Enter, or re-enter, the browser TOP LAYER. Re-entering matters: the top layer
// is ordered by show-time, not z-index, so an element that entered before a
// fullscreen video paints UNDER it. Re-showing moves it back to the front. This
// is why the timer needs re-promoting whenever fullscreen changes — its one
// showPopover() at creation always predates the user hitting fullscreen.
function promoteToTopLayer(el: HTMLElement | null): void {
  if (!el || !el.hasAttribute('popover')) return;
  try { el.hidePopover(); } catch { /* not open */ }
  try { el.showPopover(); } catch { /* unsupported */ }
}

// A playing <video> is composited on its own GPU layer, which the overlay's
// backdrop-filter never samples — so the page blurs but the video stays sharp.
// Blur each video element DIRECTLY (in its own layer) so the whole page appears
// blurred. We stash the element's prior inline filter to restore it exactly.
const BLURRED_VIDEO_ATTR = 'data-web-time-prev-filter';

function blurPageVideos(): void {
  document.querySelectorAll('video').forEach(el => {
    const v = el as HTMLVideoElement;
    if (v.hasAttribute(BLURRED_VIDEO_ATTR)) return; // already blurred by us
    v.setAttribute(BLURRED_VIDEO_ATTR, v.style.filter || '');
    v.style.filter = `${v.style.filter ? v.style.filter + ' ' : ''}blur(10px)`;
    v.style.transition = 'filter 0.3s ease';
  });
}

function unblurPageVideos(): void {
  document.querySelectorAll(`video[${BLURRED_VIDEO_ATTR}]`).forEach(el => {
    const v = el as HTMLVideoElement;
    v.style.filter = v.getAttribute(BLURRED_VIDEO_ATTR) || '';
    v.removeAttribute(BLURRED_VIDEO_ATTR);
  });
}

function showBlurOverlay(): HTMLDivElement {
  if (!blurOverlay) createBlurOverlay();
  clearPendingBlurHide();
  // Enter the top layer so the blur paints above high-z-index site players.
  // Guard: showPopover throws if already open or unsupported; the fixed-position
  // fallback still covers most content in that case.
  try { blurOverlay!.showPopover(); } catch { /* already open or unsupported */ }
  blurOverlay!.style.visibility = 'visible';
  blurPageVideos();
  // Re-assert the timer's top-layer spot so it paints ABOVE the blur we just
  // showed (top-layer order is by most-recent showPopover).
  promoteToTopLayer(timerElement);
  return blurOverlay!;
}

function hideBlurOverlay(): void {
  if (!blurOverlay) return;
  clearPendingBlurHide();
  blurOverlay.style.pointerEvents = 'none';
  // Already faded out (or never shown): no opacity transition will fire, so flip
  // visibility now rather than waiting for a transitionend that won't come.
  const wasVisible = getComputedStyle(blurOverlay).opacity !== '0';
  blurOverlay.style.opacity = '0';
  unblurPageVideos();
  if (!wasVisible) {
    blurOverlay.style.visibility = 'hidden';
    try { blurOverlay.hidePopover(); } catch { /* not open or unsupported */ }
    // Leaving the top layer drops the timer back under any fullscreen video, so
    // re-promote it. Otherwise a nudge in fullscreen ends with the badge gone.
    promoteToTopLayer(timerElement);
    return;
  }
  // Keep the element visible until the opacity fade finishes, THEN flip
  // visibility and leave the top layer so the backdrop-filter stops compositing
  // without cutting the fade-out short. Guard on opacity in case a re-show
  // interrupted us.
  blurHideEnd = (e: TransitionEvent) => {
    if (e.propertyName !== 'opacity') return;
    if (blurOverlay && blurOverlay.style.opacity === '0') {
      blurOverlay.style.visibility = 'hidden';
      try { blurOverlay.hidePopover(); } catch { /* not open or unsupported */ }
      promoteToTopLayer(timerElement);
    }
    clearPendingBlurHide();
  };
  blurOverlay.addEventListener('transitionend', blurHideEnd);
}

function buildBarChart(days: SessionStartStats['days']): HTMLElement[] {
  const maxSeconds = Math.max(...days.map(d => d.seconds), 1);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return days.map(({ date, seconds }) => {
    const [y, m, d] = date.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d, 12, 0, 0);
    const dayName = dayNames[dateObj.getDay()];
    const dayOfMonth = dateObj.getDate();
    const barWidth = Math.round((seconds / maxSeconds) * 100);
    const label = seconds > 0 ? formatTimeCompact(seconds) : '—';

    const dayLabel = makeEl('div', {
      style: 'width: 56px; font-size: 12px; color: #888; text-align: right; flex-shrink: 0; white-space: nowrap;',
      text: `${dayName} ${dayOfMonth}`,
    });

    const trackChildren: HTMLElement[] = [];
    if (seconds > 0) {
      const fill = makeEl('div', {
        style: 'height: 100%; background: rgba(69, 113, 231, 0.7); border-radius: 3px;',
      });
      fill.style.width = `${barWidth}%`;
      trackChildren.push(fill);
    }
    const track = makeEl('div', {
      style: 'flex: 1; height: 10px; background: #333; border-radius: 3px; overflow: hidden;',
      children: trackChildren,
    });

    const value = makeEl('div', {
      style: 'width: 44px; font-size: 12px; color: #aaa; flex-shrink: 0;',
      text: label,
    });

    return makeEl('div', {
      style: 'display: flex; align-items: center; gap: 8px; margin-bottom: 4px;',
      children: [dayLabel, track, value],
    });
  });
}

function createAveragePopupOverlay(minutesLeft: number, averageMinutes: number, stats: SessionStartStats): HTMLDivElement {
  if (averagePopupDialog) return averagePopupDialog;

  const el = document.createElement('div');
  el.className = 'web-time-average-popup-overlay';
  el.style.cssText = `
    ${CSS_RESET}
    position: fixed !important;
    top: 42% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    background: #2a2a2a !important;
    padding: 24px !important;
    border-radius: 8px !important;
    box-shadow: 0 6px 32px rgba(0, 0, 0, 0.5) !important;
    z-index: 1000001 !important;
    pointer-events: auto !important;
    width: 350px !important;
    opacity: 0 !important;
    transition: opacity 0.3s ease !important;
  `;

  const avg = formatTimeCompact(averageMinutes * 60);
  // Primary line = the actionable status; the average value gets its own
  // sub-line so it can never wrap awkwardly regardless of how large the numbers
  // get. Each line is nowrap so it stays intact on one row.
  const primaryLine = minutesLeft > 0
    ? `${minutesLeft} min until your 7-day average`
    : `You've reached your 7-day average`;

  const primary = makeEl('div', {
    style: 'font-size: 16px; color: #ccc; margin-bottom: 4px; text-align: center !important; font-weight: 600; white-space: nowrap !important;',
    text: primaryLine,
  });
  const avgLine = makeEl('div', {
    style: 'font-size: 13px; color: #999; margin-bottom: 14px; text-align: center !important; white-space: nowrap !important;',
    text: `(${avg})`,
  });
  const chart = makeEl('div', {
    style: 'margin-bottom: 12px;',
    children: buildBarChart(stats.days),
  });
  const continueBtn = makeEl('button', {
    className: 'web-time-avg-continue-btn',
    style: 'width: 100%; background: #3a3a3a; border: none; color: #eee; padding: 7px; border-radius: 6px; cursor: pointer; font-size: 13px; text-align: center !important; transition: background 0.2s, opacity 0.3s;',
    text: 'Continue',
  }) as HTMLButtonElement;

  el.replaceChildren(primary, avgLine, chart, continueBtn);

  continueBtn.addEventListener('mouseenter', () => { continueBtn.style.background = '#4a4a4a'; });
  continueBtn.addEventListener('mouseleave', () => { continueBtn.style.background = '#3a3a3a'; });
  continueBtn.addEventListener('click', () => hideAveragePopup());

  blurOverlay!.appendChild(el);
  averagePopupDialog = el;
  return el;
}

function showNudge(): void {
  const overlay = showBlurOverlay();
  overlay.style.pointerEvents = 'all';
  overlay.style.opacity = '1';

  const playingMedia: HTMLMediaElement[] = [];
  document.querySelectorAll('video, audio').forEach(el => {
    const media = el as HTMLMediaElement;
    if (!media.paused) {
      media.pause();
      playingMedia.push(media);
    }
  });

  const timer = document.querySelector('.web-time-timer') as HTMLElement | null;
  if (timer) {
    timer.style.transformOrigin = 'top right';
    timer.style.transition = `transform ${Constants.OVERLAY_DURATIONS.NUDGE_MS / 2}ms ease-in-out`;
    requestAnimationFrame(() => {
      timer.style.transform = 'scale(4.20)';

      setTimeout(() => {
        timer.style.transform = 'scale(1)';
      }, Constants.OVERLAY_DURATIONS.NUDGE_MS / 2);
    });
  }

  setTimeout(() => {
    hideBlurOverlay();
    playingMedia.forEach(m => m.play().catch(() => {}));
  }, Constants.OVERLAY_DURATIONS.NUDGE_MS);
}

function showAveragePopup(minutesLeft: number, averageMinutes: number, stats: SessionStartStats): void {
  if (isAnyMandatoryPopupVisible()) {
    popupQueue.push(() => showAveragePopup(minutesLeft, averageMinutes, stats));
    return;
  }

  const blurBg = showBlurOverlay();
  const el = createAveragePopupOverlay(minutesLeft, averageMinutes, stats);

  blurBg.style.pointerEvents = 'all';
  blurBg.style.opacity = '1';

  blockKeyboard(true);
  averagePopupPausedMedia = pauseAllMedia();

  // Freeze the daily clock while the popup blocks the page, mirroring the
  // end-session confirmation popup.
  browser.runtime.sendMessage({ type: 'AVERAGE_POPUP_OPEN' }).catch(() => {});

  setTimeout(() => { el.style.opacity = '1'; }, 100);
}

function hideAveragePopup(): void {
  hideBlurOverlay();

  browser.runtime.sendMessage({ type: 'AVERAGE_POPUP_CLOSE' }).catch(() => {});

  blockKeyboard(false);
  averagePopupPausedMedia.forEach(m => m.play().catch(() => {}));
  averagePopupPausedMedia = [];
  if (averagePopupDialog) {
    averagePopupDialog.style.opacity = '0';
    setTimeout(() => {
      averagePopupDialog?.parentNode?.removeChild(averagePopupDialog);
      averagePopupDialog = null;
      dequeuePopup();
    }, 300);
  }
}

/** Format a cooldown duration as "Xm", "Ys", or "Xm Ys" — keeps sub-minute parts. */
function formatCooldownDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Set the cooldown bar's width. Normal per-second ticks move it by a small
 * amount and should animate smoothly (transition: width 1s). But a *re-sync* —
 * e.g. refocusing a tab that was hidden, where the content script's bar froze
 * at a stale high % while the real cooldown kept draining — produces a large
 * jump. Animating that jump is the "stray slide" the user sees. So: snap
 * instantly when the step is bigger than one tick could account for, animate
 * otherwise. We snap by disabling the transition, setting the width, forcing a
 * reflow, then restoring it.
 */
function setProgressWidth(el: HTMLElement, pct: number): void {
  const prev = parseFloat(el.style.width) || 0;
  // One tick ≈ 1s of cooldown. Anything beyond a few % of jump in a single
  // update is a re-sync, not a tick — snap it.
  const isResync = Math.abs(pct - prev) > 5;
  if (isResync) {
    const saved = el.style.transition;
    el.style.transition = 'none';
    el.style.width = `${pct}%`;
    void el.offsetWidth; // force reflow so the no-transition width commits
    el.style.transition = saved;
  } else {
    el.style.width = `${pct}%`;
  }
}

function showBlocker(remainingSeconds: number, totalCooldownSeconds: number, cooldownCount: number, cooldownIncrementSeconds: number): void {
  pauseAllMedia();
  exitFullscreenIfActive();

  const blurBg = showBlurOverlay();
  blurBg.style.pointerEvents = 'all';
  blurBg.style.opacity = '1';

  blockKeyboard(true);

  if (blockerDialog) {
    // Update existing blocker countdown
    const countdownEl = blockerDialog.querySelector('.web-time-blocker-countdown');
    if (countdownEl) {
      countdownEl.textContent = formatCountdown(remainingSeconds);
    }
    const progressEl = blockerDialog.querySelector('.web-time-blocker-progress-fill') as HTMLElement | null;
    if (progressEl && totalCooldownSeconds > 0) {
      // Bar shrinks from 100% to 0% (same direction as reminder)
      const pct = Math.max(0, (remainingSeconds / totalCooldownSeconds) * 100);
      setProgressWidth(progressEl, pct);
    }
    return;
  }

  // Build the cooldown explanation line. Increments may be sub-minute
  // (e.g. 3m30s), so format with seconds rather than rounding to whole minutes.
  const total = formatCooldownDuration(totalCooldownSeconds);
  const increment = formatCooldownDuration(cooldownIncrementSeconds);
  // Heading says which session ended; the sub-line shows the breakdown. When
  // the cooldown grows with each session (count × increment), show the math so
  // the rising duration reads as intentional — but compactly: "3 × 3m = 9m".
  // Otherwise just the total.
  let cooldownExplanation: string;
  if (cooldownCount > 1 && cooldownIncrementSeconds > 0) {
    cooldownExplanation = `${cooldownCount} × ${increment} = ${total} cooldown`;
  } else {
    cooldownExplanation = `${total} cooldown`;
  }

  const el = document.createElement('div');
  el.className = 'web-time-blocker-overlay';
  el.style.cssText = `
    ${CSS_RESET}
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    background: #2a2a2a !important;
    /* Vertical padding is tuned so this box matches the height of the
       end-session confirm in its usual two-body-line form (~177px). The confirm
       often precedes this dialog directly, and a height jump between them reads
       as a layout shift. */
    padding: 37px 24px !important;
    border-radius: 8px !important;
    box-shadow: 0 6px 32px rgba(0, 0, 0, 0.5) !important;
    z-index: 1000001 !important;
    pointer-events: auto !important;
    width: 350px !important;
    text-align: center !important;
    opacity: 0 !important;
    transition: opacity 0.3s ease !important;
    overflow: hidden !important;
  `;

  // Initial fill width = the ACTUAL remaining fraction, not 100%. When a tab
  // joins mid-cooldown the bar must appear already at the right position;
  // hardcoding 100% here let the first ticker update animate it from full down
  // to the real value (transition: width 1s), which read as a stray slide.
  const initialPct = totalCooldownSeconds > 0
    ? Math.max(0, Math.min(100, (remainingSeconds / totalCooldownSeconds) * 100))
    : 100;

  // Same title treatment as the end-session confirm (18px/600/#fff, 16px gap) —
  // the two dialogs sit in the same flow and should read as siblings.
  const heading = makeEl('div', {
    style: 'font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 16px; line-height: 1.3;',
    text: cooldownCount > 0 ? `Session ${cooldownCount} Ended` : 'Session Ended',
  });
  // The countdown sits between the heading and the explanation so the number —
  // the thing the user is actually waiting on — lands in the box's vertical
  // middle. That's what lets the dialog center honestly at top: 50%; it used to
  // be lifted to 42% to compensate for the countdown hanging low.
  const countdown = makeEl('div', {
    className: 'web-time-blocker-countdown',
    style: 'font-size: 24px; font-weight: 500; color: #fff; margin-bottom: 12px; font-variant-numeric: tabular-nums; line-height: 1.1;',
    text: formatCountdown(remainingSeconds),
  });
  // Stays at #eee rather than a dimmer footnote: this line explains WHY the wait
  // is this long and growing, which is the part worth reading.
  const explanation = makeEl('div', {
    style: 'font-size: 14px; color: #eee; margin-bottom: 8px;',
    text: cooldownExplanation,
  });
  const progressFill = makeEl('div', {
    className: 'web-time-blocker-progress-fill',
    style: 'height: 100%; background: #4a9eff; transition: width 1s linear;',
  });
  progressFill.style.width = `${initialPct}%`;
  const progressTrack = makeEl('div', {
    style: 'position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: rgba(255, 255, 255, 0.1);',
    children: [progressFill],
  });

  el.replaceChildren(heading, countdown, explanation, progressTrack);

  blurOverlay!.appendChild(el);
  blockerDialog = el;
  setTimeout(() => { el.style.opacity = '1'; }, 50);
}

function hideBlocker(): void {
  hideBlurOverlay();

  blockKeyboard(false);
  if (blockerDialog) {
    blockerDialog.style.opacity = '0';
    setTimeout(() => {
      blockerDialog?.parentNode?.removeChild(blockerDialog);
      blockerDialog = null;
    }, 300);
  }
}

// ============================================================================
// Wind-Down Overlay — progressive darkening before session end
// ============================================================================

function createWindDownOverlay(): void {
  const overlay = document.createElement('div');
  overlay.className = 'web-time-wind-down-overlay';
  // Top-layer popover for the same reason as the blur overlay: a fullscreen
  // video would otherwise paint over this entirely. pointer-events:none still
  // passes clicks through in the top layer, so video controls stay usable.
  // The UA popover styles force a centered auto-margin box, so override the
  // inset/margin/max-* to stay full-bleed.
  overlay.setAttribute('popover', 'manual');
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    z-index: 999998;
    pointer-events: none;
    transition: background 1s linear;
    visibility: hidden;
  `;

  const barTrack = document.createElement('div');
  barTrack.className = 'web-time-wind-down-bar-track';
  barTrack.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 4px;
    background: rgba(255, 255, 255, 0.08);
  `;
  const barFill = document.createElement('div');
  barFill.className = 'web-time-wind-down-bar-fill';
  barFill.style.cssText = `
    height: 100%;
    margin: 0 auto;
    width: 100%;
    transition: width 1s linear;
    background: #4a9eff;
  `;
  barTrack.appendChild(barFill);
  overlay.appendChild(barTrack);
  document.body.appendChild(overlay);
  windDownOverlay = overlay;
}

function showWindDown(progress: number, _remainingSeconds: number): void {
  if (!windDownOverlay) return;

  // Promote only on the transition into visible, NOT on every progress tick.
  // SHOW_WIND_DOWN arrives every second, and re-promoting would keep moving the
  // darkening to the front of the top layer — above a blur overlay (and its
  // popup dialogs) that opened mid-wind-down. Entering fullscreen later is
  // handled by the fullscreenchange listener, which re-promotes in back-to-front
  // order.
  const wasHidden = windDownOverlay.style.visibility !== 'visible';
  windDownOverlay.style.visibility = 'visible';
  if (wasHidden) promoteToTopLayer(windDownOverlay);
  const opacity = 0.3 * progress;
  windDownOverlay.style.background = `rgba(0, 0, 0, ${opacity})`;

  const barFill = windDownOverlay.querySelector('.web-time-wind-down-bar-fill') as HTMLElement | null;
  if (barFill) {
    const widthPct = Math.max(0, (1 - progress) * 100);
    barFill.style.width = `${widthPct}%`;
  }
}

function hideWindDown(): void {
  if (!windDownOverlay) return;
  windDownOverlay.style.visibility = 'hidden';
  try { windDownOverlay.hidePopover(); } catch { /* not open or unsupported */ }
  windDownOverlay.style.background = 'rgba(0, 0, 0, 0)';
  const barFill = windDownOverlay.querySelector('.web-time-wind-down-bar-fill') as HTMLElement | null;
  if (barFill) {
    barFill.style.width = '100%';
  }
}


// ============================================================================
// End Session Early — keyboard shortcut + confirmation popup
// ============================================================================

/** Convert a KeyboardEvent into the canonical "Ctrl+Shift+E" style string. */
function keyEventToShortcut(e: KeyboardEvent): string | null {
  // Ignore pure modifier keypresses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Use e.code for letter/digit keys so Alt+E doesn't become Alt+´ on Mac
  let k: string;
  if (/^Key[A-Z]$/.test(e.code)) {
    k = e.code.slice(3);
  } else if (/^Digit\d$/.test(e.code)) {
    k = e.code.slice(5);
  } else {
    k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  parts.push(k);
  return parts.join('+');
}

function isEndSessionShortcutMatch(e: KeyboardEvent): boolean {
  if (!endSessionShortcut) return false;
  const pressed = keyEventToShortcut(e);
  if (!pressed) return false;
  // Treat Ctrl and Cmd as interchangeable for cross-platform comfort
  const normalize = (s: string) => s.replace(/\bCmd\b/g, 'Ctrl');
  return normalize(pressed) === normalize(endSessionShortcut);
}

function isAnyInterventionVisible(): boolean {
  return averagePopupDialog !== null
    || blockerDialog !== null
    || endSessionDialog !== null
;
}

function isInTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function showEndSessionConfirm(): void {
  if (endSessionDialog) return;
  // Need an active session to end
  if (lastSessionTime === undefined || !lastSessionLimitSeconds || lastSessionLimitSeconds <= 0) return;

  const remaining = Math.max(0, lastSessionLimitSeconds - lastSessionTime);
  if (remaining <= 0) return; // already at boundary

  // Pause playing media and track them for resume on cancel
  const playingMedia: HTMLMediaElement[] = [];
  document.querySelectorAll('video, audio').forEach(el => {
    const media = el as HTMLMediaElement;
    if (!media.paused) {
      media.pause();
      playingMedia.push(media);
    }
  });

  const blurBg = showBlurOverlay();
  blurBg.style.pointerEvents = 'all';
  blurBg.style.opacity = '1';

  blockKeyboard(true);

  const el = document.createElement('div');
  el.className = 'web-time-end-session-overlay';
  el.style.cssText = `
    ${CSS_RESET}
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    background: #2a2a2a !important;
    padding: 24px !important;
    border-radius: 8px !important;
    box-shadow: 0 6px 32px rgba(0, 0, 0, 0.5) !important;
    z-index: 1000002 !important;
    pointer-events: auto !important;
    width: 350px !important;
    text-align: center !important;
    opacity: 0 !important;
    transition: opacity 0.3s ease !important;
  `;
  const carryover = formatTimeAdaptive(Math.floor(remaining * 1.1));
  // Title, then the two consequences as body copy. The gap under the title is
  // what makes it read as a heading rather than the first of three equal lines.
  const title = makeEl('div', {
    style: 'font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 16px; line-height: 1.3;',
    text: `End session ${lastSessionNum ?? ''}?`,
  });

  // Name the cooldown this would trigger — the cost side of the trade, which the
  // user otherwise only discovers after committing. Same source of truth as the
  // blocker (sessionNum × increment), so the two can't drift.
  const cooldownSeconds = cooldownLength(lastSessionNum ?? 1, lastCooldownIncrementSeconds ?? 0);
  const body = makeEl('div', {
    style: 'font-size: 14px; color: #ccc; margin-bottom: 16px; line-height: 1.5;',
  });
  if (cooldownSeconds > 0) {
    body.append(
      `Site will go on a ${formatCooldownDuration(cooldownSeconds)} cooldown`,
      document.createElement('br'),
    );
  }
  body.append(`${carryover} will be added to next session`);

  const buttonStyle = 'flex: 1; border: none; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px;';
  const cancelBtn = makeEl('button', {
    className: 'web-time-end-cancel',
    style: `${buttonStyle} background: #3a3a3a; color: #eee;`,
    text: 'Cancel',
  });
  const okBtn = makeEl('button', {
    className: 'web-time-end-ok',
    style: `${buttonStyle} background: #4571e7; color: #fff;`,
    text: 'OK',
  });
  const buttonRow = makeEl('div', {
    style: 'display: flex; gap: 8px;',
    children: [cancelBtn, okBtn],
  });

  el.replaceChildren(title, body, buttonRow);
  blurOverlay!.appendChild(el);
  endSessionDialog = el;
  setTimeout(() => { el.style.opacity = '1'; }, 50);
  // Tell background to freeze the timer while the user decides.
  browser.runtime.sendMessage({ type: 'END_SESSION_CONFIRM_OPEN' }).catch(() => {});

  const confirmAndClose = (): void => {
    browser.runtime.sendMessage({ type: 'END_SESSION_EARLY' }).catch(() => {});
    close(false);
  };

  const close = (resumeMedia: boolean = true): void => {
    if (!endSessionDialog) return;
    document.removeEventListener('keydown', keyHandler, true);
    endSessionDialog.style.opacity = '0';
    hideBlurOverlay();
  
    blockKeyboard(false);
    if (resumeMedia) {
      playingMedia.forEach(m => m.play().catch(() => {}));
    }
    browser.runtime.sendMessage({ type: 'END_SESSION_CONFIRM_CLOSE' }).catch(() => {});
    setTimeout(() => {
      endSessionDialog?.parentNode?.removeChild(endSessionDialog);
      endSessionDialog = null;
    }, 300);
  };

  const keyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirmAndClose(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  };
  document.addEventListener('keydown', keyHandler, true);

  el.querySelector('.web-time-end-cancel')?.addEventListener('click', () => close(true));
  el.querySelector('.web-time-end-ok')?.addEventListener('click', confirmAndClose);
}

// When this tab becomes visible (after being backgrounded/discarded), ask
// background for the current blocker state. If the message fails, it means the
// extension was updated and this content script is orphaned — reload the tab
// so it picks up the new version instead of running stale code.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    browser.runtime.sendMessage({ type: 'REQUEST_BLOCKER_STATE' }).catch(() => {
      console.warn('WebTime: extension context invalidated, reloading tab');
      location.reload();
    });
  }
});

// Entering fullscreen puts the video at the FRONT of the top layer, above
// anything we promoted earlier — including the timer, whose only showPopover()
// happens at page load. Re-promote what's currently up, back-to-front, so the
// layering ends up the same as it is outside fullscreen.
document.addEventListener('fullscreenchange', () => {
  if (windDownOverlay && windDownOverlay.style.visibility === 'visible') {
    promoteToTopLayer(windDownOverlay);
  }
  if (blurOverlay && blurOverlay.style.visibility === 'visible') {
    promoteToTopLayer(blurOverlay);
    // The fullscreen element may be a different <video> than the one we blurred,
    // or the site's player may have reset our inline filter on transition.
    blurPageVideos();
  }
  // Always last: the timer sits above everything, and is the surface that's
  // otherwise missing for the whole fullscreen session.
  promoteToTopLayer(timerElement);
});

document.addEventListener('keydown', (e) => {
  if (!isEndSessionShortcutMatch(e)) return;
  // Don't fire while another intervention is up
  if (isAnyInterventionVisible()) return;
  // Don't fire while typing in a text input — too many in-app shortcut conflicts
  if (isInTextInput(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  showEndSessionConfirm();
}, true);

function handleIncomingMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void
): void {
  if (message.type === "TIME_UPDATE") {
    lastDailyTime = message.time;
    lastSessionTime = message.sessionTime;
    lastSessionLimitSeconds = message.sessionLimitSeconds;
    lastSessionNum = message.sessionNum;
    lastCooldownIncrementSeconds = message.cooldownIncrementSeconds;
    // Note: don't touch peekingDaily here — a peek is a deliberate, time-boxed
    // user action. updateTimerText() falls back to daily on its own when session
    // data is unavailable for this tab (e.g. domain has no session limit, or
    // another domain is currently active so background sends shared updates).
    if (timerText) {
      updateTimerText();
    } else {
      console.error("Timer text element not found when trying to update time!");
    }
  } else if (message.type === "SHOW_END_SESSION_CONFIRM") {
    // Popup's "End session early" button routes here (via background) so an
    // accidental click shows the same recoverable confirmation as the shortcut.
    showEndSessionConfirm();
  } else if (message.type === "NUDGE") {
    showNudge();
  } else if (message.type === "SHOW_AVERAGE_POPUP") {
    showAveragePopup(message.minutesLeft, message.averageMinutes, message.stats);
  } else if (message.type === "SHOW_BLOCKER") {
    showBlocker(message.cooldownRemainingSeconds, message.totalCooldownSeconds, message.cooldownCount, message.cooldownIncrementSeconds);
  } else if (message.type === "HIDE_BLOCKER") {
    hideBlocker();
  } else if (message.type === "SHOW_WIND_DOWN") {
    showWindDown(message.progress, message.remainingSeconds);
  } else if (message.type === "HIDE_WIND_DOWN") {
    hideWindDown();
  }
}

function updateActivityState(): void {
  lastActivityTime = Date.now();
  browser.runtime.sendMessage({ type: "USER_ACTIVE" });
}

// Exported for testing but also needed to prevent unused variable warning
export { lastActivityTime };

document.addEventListener("scroll", updateActivityState);
document.addEventListener("keydown", updateActivityState);
document.addEventListener("mousemove", updateActivityState);

function init(): void {
  log("initTimer()");

  // Clear out any UI left behind by a previous content-script instance. On an
  // extension upgrade/reinstall the new script is injected into already-open
  // tabs while the old script's nodes are still in the DOM — without this we'd
  // append duplicates (e.g. two timers stacked top-right).
  document
    .querySelectorAll('.web-time-timer, .web-time-blur-overlay, .web-time-wind-down-overlay')
    .forEach(el => el.remove());

  createTimerElement();
  createBlurOverlay();
  createWindDownOverlay();
  browser.runtime.onMessage.addListener(handleIncomingMessage);

  // React to settings changes (currently just the end-session shortcut).
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.webTimeSettings) {
      const newSettings = changes.webTimeSettings.newValue;
      const sc = newSettings?.global?.endSessionShortcut;
      // null = explicitly disabled, undefined = use default
      endSessionShortcut = sc === null ? '' : (sc || 'Ctrl+E');
    }
  });

  // Load the end-session shortcut from settings
  browser.storage.local.get('webTimeSettings').then(data => {
    const sc = data.webTimeSettings?.global?.endSessionShortcut;
    endSessionShortcut = sc === null ? '' : (sc || 'Ctrl+E');
  });

  try {
    const readyMessage = { type: "CONTENT_SCRIPT_READY" };
    browser.runtime.sendMessage(readyMessage);
  } catch (error) {
    console.error("Error sending CONTENT_SCRIPT_READY message:", error);
  }
  log("Sent CONTENT_SCRIPT_READY message to background.");
}

init();
