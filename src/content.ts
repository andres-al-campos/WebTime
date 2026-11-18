import { Constants } from './shared/constants.js';
import { MSG, STORAGE } from './shared/protocol.js';
import { extractDomain, formatClock, formatTimeCompact, log } from './shared/utils.js';
import { windDownProgress } from './shared/session-model.js';
import { sessionsAt, startable, nextSessionAt, nextStartAt, heldAt, spend, budgetRules, fullBudget, type Budget } from './shared/session-budget.js';
import type { ExtensionMessage, SessionStartStats, ShowGateMessage } from './types.js';

declare const browser: typeof chrome;

let timerText: HTMLDivElement | null = null;
let timerElement: HTMLDivElement | null = null;
// The session timer is the resting/home state on any site with an active
// session limit. Clicking the timer "peeks" at the daily total for a few
// seconds, then it snaps back to the session view; clicking again during the
// peek snaps back at once. peekingDaily is per-tab and
// momentary (never persisted or synced); updateTimerText() still falls back to
// daily on its own when no session exists for the current site.
const DAILY_PEEK_MS = 5000;
let peekingDaily = false;
let peekRevertTimer: ReturnType<typeof setTimeout> | null = null;
let lastDailyTime = 0;
let lastSessionTime: number | undefined;
let lastSessionLimitSeconds: number | undefined;

let lastSessionNum: number | undefined;
// Set while a nudge animates. The timer's text is rewritten every second by
// startLocalTick, and at 7x scale each rewrite re-rasterizes the enlarged text
// mid-transform — a visible stutter, landing on whichever second boundary falls
// during the animation. A 1000ms animation is guaranteed to cross one.
//
// Suspending the write costs at most one second of staleness on a number that
// is already being held still for the user to read.
let nudgeAnimating = false;

let blurOverlay: HTMLDivElement | null = null;
let averagePopupDialog: HTMLDivElement | null = null;
let averagePopupPausedMedia: HTMLMediaElement[] = [];
let gateDialog: HTMLDivElement | null = null;
let endSessionDialog: HTMLDivElement | null = null;
let windDownOverlay: HTMLDivElement | null = null;
let endSessionShortcut: string = 'Ctrl+E'; // default; overridden by settings

// --- Display state ---------------------------------------------------------
//
// The timer renders what the background last sent, and nothing else.
//
// It used to keep a local clock and extrapolate between updates, because the
// MV3 service worker died every ~30s and updates stopped arriving. That local
// clock and the background's clock then disagreed at the edges, which is what
// produced every display bug in this port: the number drifting above the truth,
// snapping back down, hiding on a schedule unrelated to any user setting.
//
// The keep-alive document (src/offscreen.ts) keeps the worker resident, so
// updates arrive every second and there is nothing left to paper over. One
// clock, in the background, which is also the only place that can see tab
// focus, idle state and the gate.
//
// If the worker does die anyway, the displayed number freezes at its last value
// until the worker returns — at which point the background credits the elapsed
// gap (see restore() in shared/time-clock.ts) and the timer corrects itself. A
// frozen number is visible and self-correcting; that was the deliberate choice
// over hiding the timer, which cost a disappearing UI for the same outcome.
let receivedAt = 0;

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

function createTimerElement(): void {
  const timer = document.createElement("div");
  timer.className = "web-time-timer";

  timerText = document.createElement("div");
  timerText.textContent = "00:00:00";
  timerText.style.cssText = "color: #f7f7f7 !important; transition: opacity 0.12s ease !important;";

  timer.appendChild(timerText);

  // Click to peek at the daily total; it reverts to the session view after a
  // few seconds, or on the next click. Only meaningful where a session exists (otherwise daily is
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

/**
 * Show or hide the timer by sliding it off the top edge.
 *
 * Called on every render, so it must be cheap and idempotent — classList
 * toggle with a matching value is a no-op and won't restart the transition.
 */
function setTimerVisible(visible: boolean): void {
  if (!timerElement) return;
  timerElement.classList.toggle('web-time-timer-hidden', !visible);
}

/**
 * Local render tick.
 *
 * The timer text is driven by TIME_UPDATE, so this no longer advances it — it
 * re-renders the same value, which is a no-op once the text matches.
 */
function startLocalTick(): void {
  setInterval(updateTimerText, 1000);
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

/** How long a session started at the gate right now would run; null if none can start. */
function offeredSeconds(state: ShowGateMessage, now: number): number | null {
  const offer = startable(state.budget, state.rules, now, state.minFraction);
  return offer > 0 ? Math.round(offer * state.sessionLengthSeconds) + (state.extraSeconds || 0) : null;
}

/**
 * The seconds the session view counts: what's left of the running session or,
 * at the gate, the length the next one would have. Null shows the daily total.
 * The last update's session numbers are stale behind the gate, so it decides first.
 */
function sessionViewSeconds(): number | null {
  if (gateState) return offeredSeconds(gateState, Date.now());
  return hasSession() ? Math.max(0, lastSessionLimitSeconds! - lastSessionTime!) : null;
}

// 'session' = countdown view, 'daily' = total view. Tracked so we can fade only
// when the VIEW flips (peek in / revert out), not on every per-second tick.
let lastTimerMode: 'session' | 'daily' | null = null;

function updateTimerText(): void {
  if (!timerText) return;

  // Orphaned by an extension reload: this script's bridge is dead, so no update
  // can ever arrive and the number would freeze permanently with nothing to
  // correct it. That's the one case that still hides — unlike a dead worker,
  // which comes back and fixes the display itself.
  if (orphaned) {
    setTimerVisible(false);
    return;
  }

  const sessionSeconds = sessionViewSeconds();

  // Nothing received yet: no number to show.
  if (receivedAt === 0 && sessionSeconds === null) {
    setTimerVisible(false);
    return;
  }

  setTimerVisible(true);

  let text: string;
  let mode: 'session' | 'daily';
  // Session is the default view; daily only while peeking, or when there is no
  // session to show for this site at all.
  if (sessionSeconds !== null && !peekingDaily) {
    text = `⏱ ${formatTimeAdaptive(sessionSeconds)}`;
    mode = 'session';
  } else {
    text = formatTimeAdaptive(lastDailyTime);
    mode = 'daily';
  }

  if (timerText.textContent === text) return;
  // Mid-nudge: the element is scaled up and transforming. Writing text now
  // forces a re-raster of the enlarged glyphs and stutters the animation. The
  // next tick after the nudge picks the value back up.
  if (nudgeAnimating) return;

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
 * A click toggles: show the daily total for a moment, or, while it shows,
 * go back to the session view at once. No-op where there's no session (daily
 * is already shown).
 */
function peekDaily(): void {
  if (sessionViewSeconds() === null) return;
  if (peekRevertTimer) clearTimeout(peekRevertTimer);
  peekRevertTimer = null;
  peekingDaily = !peekingDaily;
  if (peekingDaily) {
    peekRevertTimer = setTimeout(() => {
      peekingDaily = false;
      peekRevertTimer = null;
      updateTimerText();
    }, DAILY_PEEK_MS);
  }
  updateTimerText();
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

// Only the gate exits fullscreen, and not because of layering —
// promoteToTopLayer lets any overlay paint over a fullscreen video. It exits
// because no session is running: leaving the video is part of stopping. Softer surfaces (nudge, average, end-session confirm) stay in
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

// Whatever starts playing while the blur is up is paused on the spot. Each
// dialog pauses what is already playing when it opens, but a page behind the
// gate at load starts its video a moment later, and a playlist moves on by
// itself. Held here so the rule has one home for every dialog that blurs.
const blurPausedMedia = new Set<HTMLMediaElement>();
let blurPlayGuard: ((e: Event) => void) | null = null;

function guardPlaybackWhileBlurred(): void {
  if (blurPlayGuard) return;
  blurPlayGuard = (e: Event) => {
    const media = e.target;
    if (!(media instanceof HTMLMediaElement)) return;
    media.pause();
    blurPausedMedia.add(media);
  };
  // 'play' doesn't bubble; capture is the only way to hear it from here.
  document.addEventListener('play', blurPlayGuard, true);
}

function releasePlaybackGuard(resume: boolean): void {
  if (blurPlayGuard) document.removeEventListener('play', blurPlayGuard, true);
  blurPlayGuard = null;
  if (resume) blurPausedMedia.forEach(m => m.play().catch(() => {}));
  blurPausedMedia.clear();
}

function showBlurOverlay(): HTMLDivElement {
  if (!blurOverlay) createBlurOverlay();
  clearPendingBlurHide();
  guardPlaybackWhileBlurred();
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

function hideBlurOverlay(resumeMedia: boolean = true): void {
  if (!blurOverlay) return;
  clearPendingBlurHide();
  releasePlaybackGuard(resumeMedia);
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
    top: 45% !important;
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
    ? `${minutesLeft}m Until Your 7-Day Average`
    : `You Reached Your 7-Day Average`;

  // 18px/600/#eee and Title Case — the same heading treatment as the blocker
  // and the confirm. At this size the longest primaryLine ("You Reached Your
  // 7-Day Average") measures 280px against the 302px of usable width inside the
  // 350px box, so nowrap still holds. Capitals are wide: "You've Reached Your
  // 7-Day Average" measured 304px and did not fit. Any longer wording here
  // needs re-measuring, not eyeballing.
  const primary = makeEl('div', {
    style: 'font-size: 18px; color: #eee; margin-bottom: 4px; text-align: center !important; font-weight: 600; white-space: nowrap !important;',
    text: primaryLine,
  });
  const avgLine = makeEl('div', {
    style: 'font-size: 14px; color: #ccc; margin-bottom: 14px; text-align: center !important; white-space: nowrap !important;',
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

/** Scale the timer reaches at the peak of a nudge.
 *
 * The timer sits in the top-right corner and grows from that corner (see
 * transformOrigin below), so it never travels toward the user's gaze — at 5x it
 * was still small enough to miss from the far side of the screen. Size is the
 * only lever available without moving it, which would break the flow more than
 * the nudge is worth. 8x overshot and covered too much of the page. */
const NUDGE_SCALE = 7;

function showNudge(): void {
  // Re-entry would stack the shrink timeouts and leave nudgeAnimating stuck on,
  // freezing the timer text for good. The catch-up path in nextNudgeToFire can
  // hand us a backlog, so this is not merely a timing question.
  if (nudgeAnimating) return;

  const { NUDGE_GROW_MS, NUDGE_SHRINK_MS } = Constants.OVERLAY_DURATIONS;
  const overlay = showBlurOverlay();
  overlay.style.pointerEvents = 'all';
  overlay.style.opacity = '1';

  const playingMedia = pauseAllMedia();

  const timer = document.querySelector('.web-time-timer') as HTMLElement | null;
  if (timer) {
    nudgeAnimating = true;
    timer.style.transformOrigin = 'top right';
    // Promote to its own compositor layer for the duration. Without this the
    // scaled text is re-rasterized against the backdrop-filtered page on every
    // frame; with it, the transform is a GPU operation on a finished texture.
    timer.style.willChange = 'transform';
    timer.style.backfaceVisibility = 'hidden';
    timer.style.transition = `transform ${NUDGE_GROW_MS}ms ease-in-out`;
    requestAnimationFrame(() => {
      timer.style.transform = `scale(${NUDGE_SCALE})`;

      setTimeout(() => {
        timer.style.transition = `transform ${NUDGE_SHRINK_MS}ms ease-in-out`;
        timer.style.transform = 'scale(1)';

        // Drop the layer hint and resume ticking only once the timer is back at
        // 1x — willChange left on permanently keeps a layer alive for nothing.
        setTimeout(() => {
          timer.style.willChange = '';
          timer.style.backfaceVisibility = '';
          nudgeAnimating = false;
          updateTimerText();
        }, NUDGE_SHRINK_MS);
      }, NUDGE_GROW_MS);
    });
  }

  // Blur and playback end together at the peak, not after the shrink: they are
  // one interruption, and it is over once the number has been shown. Letting
  // either run into the shrink leaves the blur outlasting what it pointed at.
  setTimeout(() => {
    hideBlurOverlay();
    playingMedia.forEach(m => m.play().catch(() => {}));
  }, NUDGE_GROW_MS);
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
  sendToBackground({ type: MSG.AVERAGE_POPUP_OPEN });

  setTimeout(() => { el.style.opacity = '1'; }, 100);
}

function hideAveragePopup(): void {
  hideBlurOverlay();

  sendToBackground({ type: MSG.AVERAGE_POPUP_CLOSE });

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

// ============================================================================
// The gate — a site with session rules on and no session running
// ============================================================================
//
// One dialog with three faces. `gate`: the row of sessions and OK / Cancel.
// `starting`: after OK, the session drains from the row and the countdown runs
// inside the Cancel button; at zero the background is asked to start. And the
// wait, which is the gate face when nothing can start yet: a clock counting to
// the moment something can.
//
// The page draws all of it from the budget the background sent, so the row
// regenerates on screen and the wait ends on its own without a message a
// second. shared/session-budget.ts is the one arithmetic for both sides.

type GateView = 'gate' | 'starting';

let gateState: ShowGateMessage | null = null;
let gateView: GateView = 'gate';
let gateTicker: ReturnType<typeof setInterval> | null = null;
// Which screen the gate's text is showing, and the fade between two of them.
// Only a change of screen fades: the countdowns tick inside one screen, and a
// fade every second would pull the eye to numbers that are meant to run quietly.
const GATE_TEXT_OUT_MS = 100;
let gateScreen: 'ready' | 'starting' | 'waiting' | null = null;
let gateFadeTimer: ReturnType<typeof setTimeout> | null = null;
let gateCountdownEndsAt = 0;
let gateStartSentAt = 0;
let gatePausedMedia: HTMLMediaElement[] = [];
let gateKeyHandler: ((e: KeyboardEvent) => void) | null = null;

const GATE_BLUE = '#4571e7';
const GATE_BLUE_HALF = 'rgba(69, 113, 231, 0.5)';
// More sessions than this and the row would outgrow the 350px box.
const GATE_MAX_DOTS = 10;
// How long to wait for the background to answer a start before offering the
// gate again. It answers with HIDE_GATE or SHOW_GATE; silence means the worker
// was restarting.
const GATE_START_TIMEOUT_MS = 4000;

// The dot's fill is a conic-gradient up to --wt-gate-fill. A custom property
// only transitions once it is registered with a type, which is what makes a
// session visibly drain when it is used instead of blinking out. Where the
// registration isn't supported the dot changes at once.
try {
  (CSS as unknown as { registerProperty(d: object): void }).registerProperty({
    name: '--wt-gate-fill', syntax: '<percentage>', inherits: false, initialValue: '0%',
  });
} catch { /* already registered by an earlier injection, or unsupported */ }

function showGate(state: ShowGateMessage): void {
  gateState = state;
  // A SHOW_GATE while a start is in flight is the background declining it.
  if (gateStartSentAt) {
    gateStartSentAt = 0;
    gateView = 'gate';
  }

  gatePausedMedia.push(...pauseAllMedia());
  exitFullscreenIfActive();

  const blurBg = showBlurOverlay();
  blurBg.style.pointerEvents = 'all';
  blurBg.style.opacity = '1';
  blockKeyboard(true);

  if (!gateDialog) buildGateDialog();
  renderGate();
}

function buildGateDialog(): void {
  const el = document.createElement('div');
  el.className = 'web-time-gate-overlay';
  el.style.cssText = `
    ${CSS_RESET}
    position: fixed !important;
    top: 45% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    background: #2a2a2a !important;
    padding: 24px !important;
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

  const title = makeEl('div', {
    className: 'web-time-gate-title',
    style: 'font-size: 18px; font-weight: 600; color: #eee; margin-bottom: 21px; line-height: 1.3;',
  });
  const dots = makeEl('div', {
    className: 'web-time-gate-dots',
    style: 'display: flex; justify-content: center; gap: 10px; margin-bottom: 20px;',
  });
  // A line tall whatever it says, so the box keeps its height when the text
  // changes after the click. A dialog that resizes under the cursor draws the
  // eye to the frame.
  const body = makeEl('div', {
    className: 'web-time-gate-body',
    style: 'font-size: 14px; color: #ccc; line-height: 1.5; min-height: 21px; display: flex; flex-direction: column; justify-content: center; font-variant-numeric: tabular-nums;',
  });
  const buttonStyle = 'width: 104px; border: none; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px; font-variant-numeric: tabular-nums;';
  const cancelBtn = makeEl('button', {
    className: 'web-time-gate-cancel',
    style: `${buttonStyle} background: #3a3a3a; color: #eee;`,
    text: 'Cancel',
  });
  const okBtn = makeEl('button', {
    className: 'web-time-gate-ok',
    style: `${buttonStyle} width: auto; min-width: 104px; padding: 8px 16px; background: ${GATE_BLUE}; color: #fff;`,
  });
  const buttonRow = makeEl('div', {
    className: 'web-time-gate-buttons',
    style: 'display: flex; gap: 8px; justify-content: center; margin-top: 20px;',
    children: [cancelBtn, okBtn],
  });
  const barFill = makeEl('div', {
    className: 'web-time-gate-bar-fill',
    style: `height: 100%; background: ${GATE_BLUE}; width: 0%;`,
  });
  const bar = makeEl('div', {
    className: 'web-time-gate-bar',
    style: 'position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: rgba(255, 255, 255, 0.1);',
    children: [barFill],
  });

  el.replaceChildren(title, dots, body, buttonRow, bar);
  blurOverlay!.appendChild(el);
  gateDialog = el;
  setTimeout(() => { el.style.opacity = '1'; }, 50);

  okBtn.addEventListener('click', gateOk);
  cancelBtn.addEventListener('click', gateCancel);

  gateKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && gateView === 'gate') { e.preventDefault(); e.stopPropagation(); gateOk(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); gateCancel(); }
  };
  document.addEventListener('keydown', gateKeyHandler, true);

  gateTicker = setInterval(renderGate, 250);
}

function gateOk(): void {
  if (!gateState || gateView !== 'gate') return;
  const now = Date.now();
  if (startable(gateState.budget, gateState.rules, now, gateState.minFraction) <= 0) return;
  gateView = 'starting';
  gateCountdownEndsAt = now + gateState.countdownSeconds * 1000;
  renderGate();
}

function gateCancel(): void {
  // Only the countdown can be cancelled. The gate itself stays up: a site
  // with rules on is either in a session or behind it.
  if (gateView !== 'starting') return;
  // Nothing was spent yet: the session is only used when the countdown ends.
  gateView = 'gate';
  gateStartSentAt = 0;
  renderGate();
}

function renderGate(): void {
  if (!gateDialog || !gateState) return;
  const { budget, rules, minFraction } = gateState;
  const now = Date.now();
  const held = sessionsAt(budget, rules, now);
  const offer = startable(budget, rules, now, minFraction);

  if (gateView === 'starting') {
    if (gateStartSentAt && now - gateStartSentAt > GATE_START_TIMEOUT_MS) {
      gateStartSentAt = 0;
      gateView = 'gate';
    } else if (!gateStartSentAt && now >= gateCountdownEndsAt) {
      gateStartSentAt = now;
      if (!sendToBackground({ type: MSG.START_SESSION })) recoverFromOrphan();
    }
  }

  const q = (c: string) => gateDialog!.querySelector(`.web-time-gate-${c}`) as HTMLElement;
  const starting = gateView === 'starting';
  const waiting = !starting && offer <= 0;

  updateTimerText();

  // While starting, the row already shows the session as used.
  // Only a day's worth: the bank is the popup's to show.
  const after = starting ? spend(budget, rules, now, minFraction)?.budget ?? budget : budget;
  renderGateDots(q('dots'), heldAt(after, rules, now).daily, rules.sessionsPerDay);

  // Old text out fast, new text in slower, written while nothing is visible.
  const screen = starting ? 'starting' : waiting ? 'waiting' : 'ready';
  gateScreen ??= screen;
  if (screen !== gateScreen) {
    if (gateFadeTimer === null) {
      const parts = [q('title'), q('body'), q('buttons')];
      parts.forEach((p) => { p.style.transition = `opacity ${GATE_TEXT_OUT_MS}ms ease-in`; p.style.opacity = '0'; });
      gateFadeTimer = setTimeout(() => {
        gateFadeTimer = null;
        gateScreen = null;
        renderGate();
        parts.forEach((p) => { p.style.transition = 'opacity 180ms cubic-bezier(.2,.8,.2,1)'; p.style.opacity = '1'; });
      }, GATE_TEXT_OUT_MS);
    }
    return;
  }

  q('title').textContent = starting ? 'Starting Session'
    : waiting ? 'Next Session Refills In'
    : 'Session Ended';

  const body = q('body');
  if (starting) {
    body.textContent = 'Are you sure?';
    body.style.fontSize = '14px';
    body.style.color = '#ccc';
  } else if (waiting) {
    const at = nextStartAt(budget, rules, now, minFraction);
    body.textContent = at === null ? 'No sessions regenerate' : formatClock(Math.ceil((at - now) / 1000));
    body.style.fontSize = at === null ? '14px' : '28px';
    body.style.color = '#eee';
  } else {
    const next = nextSessionAt(budget, rules, now);
    // The button carries the length, so this line only says when more arrives.
    body.textContent = next === null ? '' : `Next session refills in ${formatClock(Math.ceil((next - now) / 1000))}`;
    body.style.fontSize = '14px';
    body.style.color = '#ccc';
  }

  const left = Math.max(0, Math.ceil((gateCountdownEndsAt - now) / 1000));
  q('cancel').textContent = starting && left > 0 ? `Cancel (${left})` : 'Cancel';
  q('cancel').style.display = starting ? '' : 'none';
  q('ok').style.display = starting || waiting ? 'none' : '';
  q('ok').textContent = `Start ${formatClock(offeredSeconds(gateState, now) ?? 0)} Session`;
  q('buttons').style.display = waiting ? 'none' : 'flex';

  // The wait's bar fills toward the least the gate will offer.
  q('bar').style.display = waiting ? 'block' : 'none';
  if (waiting) q('bar-fill').style.width = `${Math.min(100, (held / Math.max(minFraction, 1e-6)) * 100)}%`;
}

/** One dot per session the site can hold; `held` of them filled, the last in part. */
function renderGateDots(row: HTMLElement, held: number, sessionsPerDay: number): void {
  const count = Math.max(1, Math.min(GATE_MAX_DOTS, Math.ceil(sessionsPerDay)));
  while (row.children.length < count) {
    row.appendChild(makeEl('span', {
      style: `width: 22px; height: 22px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid rgba(255,255,255,.22); background: conic-gradient(var(--wt-gate-pie) var(--wt-gate-fill), transparent 0) padding-box no-repeat; transition: --wt-gate-fill .7s cubic-bezier(.2,.8,.2,1);`,
    }));
  }
  while (row.children.length > count) row.lastElementChild!.remove();
  for (let i = 0; i < count; i++) {
    const dot = row.children[i] as HTMLElement;
    const fill = Math.min(1, Math.max(0, held - i));
    const whole = fill > 0.999;
    dot.style.setProperty('--wt-gate-fill', `${(whole ? 1 : fill) * 100}%`);
    // Every dot keeps the same ring; the one regenerating fills at half
    // strength so it reads as not yet there.
    dot.style.setProperty('--wt-gate-pie', fill > 0 && !whole ? GATE_BLUE_HALF : GATE_BLUE);
  }
}

function hideGate(): void {
  if (gateTicker) { clearInterval(gateTicker); gateTicker = null; }
  if (gateFadeTimer) { clearTimeout(gateFadeTimer); gateFadeTimer = null; }
  gateScreen = null;
  if (gateKeyHandler) { document.removeEventListener('keydown', gateKeyHandler, true); gateKeyHandler = null; }
  const wasShown = gateDialog !== null;
  gateState = null;
  gateView = 'gate';
  gateStartSentAt = 0;
  if (!wasShown) return;

  hideBlurOverlay();
  blockKeyboard(false);
  // What the gate paused plays again: the session the user just chose to start
  // is the reason to be here.
  gatePausedMedia.forEach(m => m.play().catch(() => {}));
  gatePausedMedia = [];
  const el = gateDialog!;
  gateDialog = null;
  el.style.opacity = '0';
  setTimeout(() => { el.parentNode?.removeChild(el); }, 300);
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
    opacity: 1;
    transition: background 1s linear, opacity ${WIND_DOWN_FADE_MS}ms ease-out;
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
    background: #4571e7;
  `;
  barTrack.appendChild(barFill);
  overlay.appendChild(barTrack);
  document.body.appendChild(overlay);
  windDownOverlay = overlay;
}

// Set by the background's SHOW/HIDE: whether wind-down applies to this site at
// all (not at the gate, not on another domain's updates). How far along
// it is comes from the timer's own numbers, so the two never disagree. The bar
// once ran on a local deadline and kept draining while the clock was paused.
let windDownEnabled = false;

// Leaving fades rather than vanishes: time added mid-wind-down shouldn't make
// the page snap back to full brightness. Set while that fade runs.
const WIND_DOWN_FADE_MS = 400;
let windDownFadeTimer: ReturnType<typeof setTimeout> | null = null;

/** Paint the bar from the values the timer is showing, or hide it. */
function syncWindDownToTimer(): void {
  if (!windDownOverlay) return;
  const progress = windDownEnabled && hasSession()
    ? windDownProgress(lastSessionTime!, lastSessionLimitSeconds!)
    : null;
  if (progress === null) {
    if (windDownOverlay.style.visibility === 'visible' && !windDownFadeTimer) hideWindDownOverlay();
    return;
  }
  renderWindDownVisible(progress);
}

function showWindDown(): void {
  windDownEnabled = true;
  syncWindDownToTimer();
}

function renderWindDownVisible(progress: number): void {
  if (!windDownOverlay) return;

  // Promote only on the transition into visible, NOT on every progress tick.
  // SHOW_WIND_DOWN arrives every second, and re-promoting would keep moving the
  // darkening to the front of the top layer — above a blur overlay (and its
  // popup dialogs) that opened mid-wind-down. Entering fullscreen later is
  // handled by the fullscreenchange listener, which re-promotes in back-to-front
  // order.
  // Back into the final minute mid-fade: cancel the fade and stay up. It never
  // left the top layer, so it isn't re-promoted.
  if (windDownFadeTimer) {
    clearTimeout(windDownFadeTimer);
    windDownFadeTimer = null;
  }
  windDownOverlay.style.opacity = '1';
  const wasHidden = windDownOverlay.style.visibility !== 'visible';
  windDownOverlay.style.visibility = 'visible';
  if (wasHidden) promoteToTopLayer(windDownOverlay);
  renderWindDown(progress);
}

/**
 * Paint the darkening and bar for a given progress. Split out from the show
 * path so the local tick can advance the bar without re-promoting the overlay
 * in the top layer — re-promoting every second would push the darkening above
 * a blur overlay that opened mid-wind-down.
 */
function renderWindDown(progress: number): void {
  if (!windDownOverlay) return;
  const opacity = 0.3 * progress;
  windDownOverlay.style.background = `rgba(0, 0, 0, ${opacity})`;

  const barFill = windDownOverlay.querySelector('.web-time-wind-down-bar-fill') as HTMLElement | null;
  if (barFill) {
    const widthPct = Math.max(0, (1 - progress) * 100);
    barFill.style.width = `${widthPct}%`;
  }
}

function hideWindDown(): void {
  windDownEnabled = false;
  hideWindDownOverlay();
}

function hideWindDownOverlay(): void {
  const overlay = windDownOverlay;
  if (!overlay || overlay.style.visibility !== 'visible' || windDownFadeTimer) return;
  overlay.style.opacity = '0';
  windDownFadeTimer = setTimeout(() => {
    windDownFadeTimer = null;
    overlay.style.visibility = 'hidden';
    try { overlay.hidePopover(); } catch { /* not open or unsupported */ }
    // Reset with transitions off, so the next show starts from a full bar
    // instead of animating up to it.
    const barFill = overlay.querySelector('.web-time-wind-down-bar-fill') as HTMLElement | null;
    const overlayTransition = overlay.style.transition;
    const barTransition = barFill?.style.transition ?? '';
    overlay.style.transition = 'none';
    if (barFill) barFill.style.transition = 'none';
    overlay.style.background = 'rgba(0, 0, 0, 0)';
    overlay.style.opacity = '1';
    if (barFill) barFill.style.width = '100%';
    void overlay.offsetWidth;
    overlay.style.transition = overlayTransition;
    if (barFill) barFill.style.transition = barTransition;
  }, WIND_DOWN_FADE_MS);
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
    || gateDialog !== null
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
    top: 45% !important;
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
  // Title, then what happens to the unused time. The gap under the title is
  // what makes it read as a heading rather than the first of three equal lines.
  const title = makeEl('div', {
    style: 'font-size: 18px; font-weight: 600; color: #eee; margin-bottom: 21px; line-height: 1.3;',
    text: `End Session ${lastSessionNum ?? ''}?`,
  });

  // The day's sessions, as the gate shows them, so ending one is weighed
  // against what's left. The row's height is held while storage is read, so
  // the dialog doesn't grow under the cursor.
  const dots = makeEl('div', {
    className: 'web-time-end-dots',
    style: 'display: flex; justify-content: center; gap: 10px; height: 22px; margin-bottom: 20px;',
  });
  const domain = extractDomain(location.href);
  if (domain) {
    browser.storage.local.get([STORAGE.SESSION_BUDGET, STORAGE.SETTINGS]).then((data) => {
      const rules = budgetRules(data[STORAGE.SETTINGS]?.domains?.[domain]);
      const budget: Budget = data[STORAGE.SESSION_BUDGET]?.[domain] ?? fullBudget(rules, Date.now());
      renderGateDots(dots, heldAt(budget, rules, Date.now()).daily, rules.sessionsPerDay);
    }).catch(() => {});
  }

  // #ccc, same as the gate's body line: these two dialogs sit in the same flow
  // and their body copy should not step. Clock-style, same formatClock as the
  // timer the number is read against.
  const body = makeEl('div', {
    style: 'font-size: 14px; color: #ccc; margin-bottom: 20px; line-height: 1.5;',
    text: `${formatClock(remaining)} unused is added to your next session`,
  });

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
    style: 'display: flex; gap: 12px;',
    children: [cancelBtn, okBtn],
  });

  el.replaceChildren(title, dots, body, buttonRow);
  blurOverlay!.appendChild(el);
  endSessionDialog = el;
  setTimeout(() => { el.style.opacity = '1'; }, 50);
  // Tell background to freeze the timer while the user decides.
  sendToBackground({ type: MSG.END_SESSION_CONFIRM_OPEN });

  const confirmAndClose = (): void => {
    sendToBackground({ type: MSG.END_SESSION_EARLY });
    close(false);
  };

  const close = (resumeMedia: boolean = true): void => {
    if (!endSessionDialog) return;
    document.removeEventListener('keydown', keyHandler, true);
    endSessionDialog.style.opacity = '0';
    hideBlurOverlay(resumeMedia);
  
    blockKeyboard(false);
    if (resumeMedia) {
      playingMedia.forEach(m => m.play().catch(() => {}));
    }
    sendToBackground({ type: MSG.END_SESSION_CONFIRM_CLOSE });
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
// background whether this site is at the gate. If the message fails, it means the
// extension was updated and this content script is orphaned — reload the tab
// so it picks up the new version instead of running stale code.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Reaching for the background is also the orphan check. The synchronous
  // throw is the usual signal after an extension reload, so both paths
  // (throw and rejection) have to lead to the same recovery.
  if (!sendToBackground({ type: MSG.REQUEST_GATE_STATE })) {
    recoverFromOrphan();
  }
});

/**
 * This content script belongs to an extension version that no longer exists.
 *
 * We do NOT reload the tab. Reloading looks like the repair — a fresh script
 * gets a live bridge — but the new page's script can be orphaned just as
 * easily (extension disabled, still reloading, being removed), and then it
 * reloads again. Across every open tab simultaneously that is an infinite
 * reload loop, which is enough to hang or crash the browser.
 *
 * So we degrade quietly instead: take the timer down, stop talking to a
 * background that isn't there. The tab recovers on the user's own next reload,
 * which costs them one keystroke and can't run away.
 *
 * Logged through log() rather than console.warn deliberately. Chrome collects
 * anything a content script writes to warn/error and shows it as "Errors" on the
 * extension card — so reloading the extension lit up the card with one entry per
 * open tab, all of them describing the reload the user had just performed. This
 * is an expected consequence of reloading, not a fault, and it must not look
 * like one.
 */
function recoverFromOrphan(): void {
  if (orphaned) return;   // report once, not on every visibilitychange
  orphaned = true;
  setTimerVisible(false);
  log('Extension was reloaded or updated; this tab is orphaned until it reloads.');
}

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
  if (message.type === MSG.TIME_UPDATE) {
    lastDailyTime = message.time;
    lastSessionTime = message.sessionTime;
    lastSessionLimitSeconds = message.sessionLimitSeconds;
    lastSessionNum = message.sessionNum;
    // Marks that a real value has arrived, which is what lets the timer show at
    // all. Not used for arithmetic any more — the background sends the number.
    receivedAt = Date.now();
    // Note: don't touch peekingDaily here — a peek is a deliberate, time-boxed
    // user action. updateTimerText() falls back to daily on its own when session
    // data is unavailable for this tab (e.g. domain has no session limit, or
    // another domain is currently active so background sends shared updates).
    syncWindDownToTimer();
    if (timerText) {
      updateTimerText();
    } else {
      console.error("Timer text element not found when trying to update time!");
    }
  } else if (message.type === MSG.SHOW_END_SESSION_CONFIRM) {
    // Popup's "End session early" button routes here (via background) so an
    // accidental click shows the same recoverable confirmation as the shortcut.
    showEndSessionConfirm();
  } else if (message.type === MSG.NUDGE) {
    showNudge();
  } else if (message.type === MSG.SHOW_AVERAGE_POPUP) {
    showAveragePopup(message.minutesLeft, message.averageMinutes, message.stats);
  } else if (message.type === MSG.SHOW_GATE) {
    showGate(message);
  } else if (message.type === MSG.HIDE_GATE) {
    hideGate();
  } else if (message.type === MSG.SHOW_WIND_DOWN) {
    showWindDown();
  } else if (message.type === MSG.HIDE_WIND_DOWN) {
    hideWindDown();
  }
}

// Minimum gap between USER_ACTIVE messages. mousemove alone fires hundreds of
// times a second, and every message is work for the background.
//
// The background only compares the timestamp against its inactivity threshold
// (30s by default), so once every 5s carries the same information at a fraction
// of the traffic.
const ACTIVITY_PING_INTERVAL_MS = 5000;
let lastActivityPing = 0;

// Set once the extension context is known to be dead. The local tick checks it
// so an orphaned script stops rendering a number it can no longer verify,
// rather than freezing a stale one on screen forever.
let orphaned = false;

/**
 * Send to the background, tolerating an orphaned content script.
 *
 * After the extension reloads or updates, scripts injected by the OLD version
 * keep running in already-open tabs with a dead browser.* bridge. Calls then
 * fail with "Extension context invalidated" — and crucially they throw
 * SYNCHRONOUSLY, before any promise exists, so a trailing .catch() never runs.
 * That's what surfaced as uncaught errors on the extension card.
 *
 * Returns false when the context is gone, so callers can skip follow-up work.
 */
function sendToBackground(message: object): boolean {
  try {
    const p = browser.runtime.sendMessage(message);
    // Firefox returns a promise; Chrome may too. Swallow async failures the
    // same way — a dead background is not something a page can act on.
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  } catch {
    recoverFromOrphan();
    return false;
  }
}

function updateActivityState(): void {
  const now = Date.now();
  if (now - lastActivityPing < ACTIVITY_PING_INTERVAL_MS) return;
  lastActivityPing = now;
  sendToBackground({ type: MSG.USER_ACTIVE });
}

// passive: these never preventDefault, and saying so keeps scroll off the
// main thread on the sites where it matters most.
document.addEventListener("scroll", updateActivityState, { passive: true });
document.addEventListener("keydown", updateActivityState, { passive: true });
document.addEventListener("mousemove", updateActivityState, { passive: true });

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
  // Registering listeners touches the same bridge, so it throws too when a
  // previous-version script is re-running against a dead context.
  try {
    browser.runtime.onMessage.addListener(handleIncomingMessage);

    // React to settings changes (currently just the end-session shortcut).
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE.SETTINGS]) {
        const newSettings = changes[STORAGE.SETTINGS].newValue;
        const sc = newSettings?.global?.endSessionShortcut;
        // null = explicitly disabled, undefined = use default
        endSessionShortcut = sc === null ? '' : (sc || 'Ctrl+E');
      }
    });
  } catch {
    recoverFromOrphan();
  }

  // Start hidden: nothing has been received yet, so there is no number we can
  // stand behind. The first TIME_UPDATE slides it in.
  setTimerVisible(false);
  startLocalTick();

  // Load the end-session shortcut from settings. Wrapped because storage is
  // part of the same bridge that dies with an orphaned context; the default
  // shortcut is a fine fallback.
  try {
    browser.storage.local.get(STORAGE.SETTINGS).then(data => {
      const sc = data[STORAGE.SETTINGS]?.global?.endSessionShortcut;
      endSessionShortcut = sc === null ? '' : (sc || 'Ctrl+E');
    }).catch(() => {});
  } catch {
    recoverFromOrphan();
  }

  if (sendToBackground({ type: MSG.CONTENT_SCRIPT_READY })) {
    log("Sent CONTENT_SCRIPT_READY message to background.");
  }
}

init();
