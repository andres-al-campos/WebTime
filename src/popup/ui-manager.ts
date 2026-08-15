import { CONFIG, COLORS, ViewState } from './config.js';
import { AppState } from './state.js';
import {
  processGeneralViewData,
  processDetailViewData,
  calculateTodaysTotals,
  type GeneralViewData,
  type DetailViewData
} from './data-processor.js';
import {
  buildGeneralViewChart,
  buildDetailViewChart,
  buildPieChart,
  highlightBar,
  type DomainPieData
} from './chart-builder.js';
import { formatDuration, formatDurationHM, getLocalDateStr, formatDateWithDayOfWeek } from '../shared/utils.js';
import { renderSessionCard, renderSessionSettingsCard, stepper } from './session-card.js';
import { renderPastDayCards, backToTodayButton } from './past-day-cards.js';
import { sessionsFor } from '../shared/session-history.js';
import type { ChartInstance } from '../types.js';

declare const browser: typeof chrome;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Chart: new (ctx: CanvasRenderingContext2D, config: any) => ChartInstance;

interface ExtendedChart {
  totalTimeData?: GeneralViewData;
  _deadZoneHitbox?: HTMLDivElement;
  data?: { labels?: string[]; datasets?: unknown[] };
  options?: { scales?: { x?: Record<string, unknown> } };
  update(mode?: string): void;
  destroy(): void;
  chartArea?: { left: number; right: number; bottom: number };
}

/** Wire a click-to-capture keyboard shortcut input. */
function setupShortcutCapture(input: HTMLInputElement): void {
  if (input.dataset.captureSetup === 'true') return;
  input.dataset.captureSetup = 'true';

  let capturing = false;

  const stopCapture = (): void => {
    capturing = false;
    input.style.background = '';
    input.blur();
  };

  input.addEventListener('focus', () => {
    capturing = true;
    input.style.background = '#3a3a5a';
    input.value = 'Press a key combo…';
  });

  input.addEventListener('blur', () => {
    if (capturing) {
      // Aborted without pressing anything — restore previous
      capturing = false;
      input.style.background = '';
      // Leave the placeholder; if user blurred without pressing, fall back
      if (input.value === 'Press a key combo…') {
        input.value = 'Ctrl+E';
      }
    }
  });

  input.addEventListener('keydown', (e) => {
    if (!capturing) return;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Cmd');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    // Use e.code for letter/digit keys so Alt+E doesn't become Alt+´ on Mac
    let k: string;
    if (/^Key[A-Z]$/.test(e.code)) {
      k = e.code.slice(3); // "KeyE" -> "E"
    } else if (/^Digit\d$/.test(e.code)) {
      k = e.code.slice(5); // "Digit1" -> "1"
    } else {
      k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    }
    parts.push(k);
    input.value = parts.join('+');
    delete input.dataset.disabled;
    stopCapture();
  });
}

/** Open the right-half settings overlay (slides in from the right edge). */
export function openSettings(): void {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.classList.add('open');
  document.getElementById('settings-toggle-btn')?.classList.add('is-open');
  document.getElementById('settings-toggle-btn')?.setAttribute('aria-expanded', 'true');
  // Reflect the detail-view domain into the per-site limits header.
  const settingsDomainInline = document.getElementById('settings-domain-inline');
  if (settingsDomainInline) {
    settingsDomainInline.textContent = AppState.selectedDomain || '—';
  }
  loadSettings();
}

/** Close the settings overlay. */
export function closeSettings(): void {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.classList.remove('open');
  document.getElementById('settings-toggle-btn')?.classList.remove('is-open');
  document.getElementById('settings-toggle-btn')?.setAttribute('aria-expanded', 'false');
}

/** Toggle the settings overlay — the topbar menu button both opens and closes
 *  it (hamburger morphs to ✕), so there's no separate close control to reach. */
export function toggleSettings(): void {
  const overlay = document.getElementById('settings-overlay');
  if (overlay?.classList.contains('open')) closeSettings();
  else openSettings();
}

/** Update the merged topbar's nav label, site context, and hero numbers
 *  for the current view. The nav button toggles to the *other* view. */
function updateTopbar(): void {
  const isDetail = AppState.currentView === ViewState.DETAIL;

  const navBtn = document.getElementById('nav-toggle-btn');
  if (navBtn) navBtn.textContent = isDetail ? '◂  All sites' : 'This site  ▸';

  // Left context: site identity (detail) vs. "All sites" (general). On a
  // non-trackable page (no real domain) the detail view shows neither — the
  // header right stays blank, matching the "go to a real site" empty state.
  const hasDomain = isDetail && !!AppState.selectedDomain;
  const siteId = document.getElementById('topbar-site');
  const allId = document.getElementById('topbar-all');
  if (siteId) siteId.hidden = !hasDomain;
  if (allId) allId.hidden = isDetail;

  if (hasDomain) {
    const nameEl = document.getElementById('topbar-site-name');
    if (nameEl) nameEl.textContent = AppState.selectedDomain;
  }
}

/** A "NN% below/above your avg" delta phrase, colored by direction. Green when
 *  at/under the average (a win), grey — not red — when over (forgiving). Returns
 *  null when there's no average yet (first day of data). */
function deltaPhrase(delta: number | null): HTMLElement | null {
  if (delta === null) return null;
  const below = delta <= 0;
  const el = document.createElement('span');
  el.className = `usage-delta ${below ? 'good' : 'dim'}`;
  // Arrow carries direction (↓ under = good, ↑ over), so the words drop out.
  el.textContent = `${below ? '↓' : '↑'} ${Math.abs(delta)}% from avg`;
  return el;
}

/** A stat column: big value over a quiet caption, both left-aligned in the
 *  column so the caption sits directly under its number. */
function usageStat(value: string, caption: string): HTMLElement {
  const stat = document.createElement('div');
  stat.className = 'usage-stat';
  const val = document.createElement('span');
  val.className = 'usage-val';
  val.textContent = value;
  const cap = document.createElement('span');
  cap.className = 'usage-cap';
  cap.textContent = caption;
  stat.append(val, cap);
  return stat;
}

/** A headline row holding one or more stat columns. */
function usageHeadline(...stats: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'usage-headline';
  row.append(...stats);
  return row;
}

/** A slash separator between two stat columns, aligned to the value row. */
function usageSlash(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'usage-slash';
  s.textContent = '/';
  return s;
}

/** Detail page Usage card: this-site / all-sites side by side (value over its
 *  own caption), then how this site compares to THIS domain's 7-day average.
 *  Defaults to today; a past day passes its date and gets a back button. */
function updateDetailUsageCard(selectedDate?: string): void {
  const host = document.getElementById('detail-usage-card');
  if (!host) return;

  // No real domain (new-tab / settings / extension page) → no usage card at all;
  // the left panel's "go to a real site" message stands on its own.
  if (!AppState.selectedDomain || !AppState.allTimeHistory) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const today = getLocalDateStr(AppState.dayResetTime);
  const day = selectedDate || today;
  const domain = AppState.selectedDomain;
  const totals = calculateTodaysTotals(AppState.allTimeHistory, day, domain);

  const head = usageHeadline(
    usageStat(formatDurationHM(totals.domain), 'This site'),
    usageSlash(),
    usageStat(formatDurationHM(totals.total), 'All sites')
  );

  const out: HTMLElement[] = [eyebrow('Usage'), head];
  const delta = deltaPhrase(domainDayVsAverage(domain, day)?.delta ?? null);
  if (delta) {
    const sub = document.createElement('div');
    sub.className = 'usage-deltaline';
    const ctx = document.createElement('span');
    ctx.className = 'usage-deltactx';
    ctx.textContent = ' on this site';
    sub.append(delta, ctx);
    out.push(sub);
  }
  // The way back out of a past day. Unlocking re-renders the detail view, which
  // takes the today branch and restores the live cards.
  if (day !== today) {
    out.push(backToTodayButton(() => {
      // Select today rather than clearing the lock: a day is always selected in
      // this view, and the chart highlight has to follow the panel. Panel only —
      // rebuilding the chart would replay its entry animation.
      selectDetailDay(null);
    }));
  }
  host.replaceChildren(...out);
}

/** General page Usage-breakdown headline: all-sites total for the selected day +
 *  how it compares to the all-sites 7-day average. Sits atop the breakdown bars. */
function updateGeneralUsageHead(selectedDate?: string): void {
  const host = document.getElementById('usage-breakdown-head');
  if (!host || !AppState.allTimeHistory) return;

  const today = getLocalDateStr(AppState.dayResetTime);
  const day = selectedDate || today;
  const stats = dayVsAverage(day);
  const totals = calculateTodaysTotals(AppState.allTimeHistory, day, '');

  // Value + delta share a baseline row (so the delta sits at the big number's
  // bottom); the "all sites" caption hangs below the value.
  const stat = document.createElement('div');
  stat.className = 'usage-stat';
  const valRow = document.createElement('div');
  valRow.className = 'usage-valrow';
  const val = document.createElement('span');
  val.className = 'usage-val';
  val.textContent = formatDurationHM(totals.total);
  valRow.append(val);
  const delta = deltaPhrase(stats?.delta ?? null);
  if (delta) valRow.append(delta);
  const cap = document.createElement('span');
  cap.className = 'usage-cap';
  cap.textContent = 'All sites';
  stat.append(valRow, cap);

  const head = usageHeadline(stat);
  host.replaceChildren(eyebrow('Usage breakdown'), head);
}

/** A small uppercase section eyebrow (the shared .usage-eyebrow title style). */
function eyebrow(text: string): HTMLElement {
  const e = document.createElement('div');
  e.className = 'usage-eyebrow';
  e.textContent = text;
  return e;
}

/** The 7-day average (seconds) for a day and that day's % vs the average.
 *  `delta` is null when there's no average yet (e.g. the first day of data). */
function dayVsAverage(dateString: string): { avgSec: number | null; delta: number | null } | null {
  if (!AppState.allTimeHistory) return null;
  const data = processGeneralViewData(AppState.allTimeHistory);
  const idx = data.dailyData.findIndex(d => d.date === dateString);
  if (idx < 0) return null;
  const avg = data.movingAverageData[idx]?.averageSeconds || 0;
  if (avg <= 0) return { avgSec: null, delta: null };
  const daySec = data.dailyData[idx].totalSeconds;
  return { avgSec: avg, delta: Math.round(((daySec - avg) / avg) * 100) };
}

/** As dayVsAverage, but for a single domain: today's time on `domain` vs that
 *  domain's own 7-day moving average. */
function domainDayVsAverage(domain: string, dateString: string): { avgSec: number | null; delta: number | null } | null {
  if (!AppState.allTimeHistory || !domain) return null;
  const data = processDetailViewData(AppState.allTimeHistory, domain);
  const idx = data.dailyData.findIndex(d => d.date === dateString);
  if (idx < 0) return null;
  const avg = data.movingAverageData[idx]?.averageSeconds || 0;
  if (avg <= 0) return { avgSec: null, delta: null };
  const daySec = data.dailyData[idx].domainSeconds;
  return { avgSec: avg, delta: Math.round(((daySec - avg) / avg) * 100) };
}

export function showGeneralView(): void {
  AppState.setView(ViewState.GENERAL);
  const container = document.querySelector('.pages-container');
  if (container) {
    container.className = 'pages-container show-general';
  }

  updateTopbar();
  updateGeneralUsageHead();

  if (!AppState.generalChartCreated) {
    renderGeneralView();
    AppState.markGeneralChartCreated();
  }
}

export function showDetailView(): void {
  AppState.setView(ViewState.DETAIL);
  const container = document.querySelector('.pages-container');
  if (container) {
    container.className = 'pages-container show-detail';
  }

  updateTopbar();
  updateDetailUsageCard();
}

// Live handles for the global-settings steppers, so repeated loadSettings calls
// update the displayed value instead of stacking duplicate controls.
const settingsSteppers: Record<string, { setValue: (v: number) => void }> = {};

/** Mount (once) a styled stepper into `mountId` that mirrors its value into the
 *  hidden number `input` (the save/load data store). On later calls it just
 *  pushes the new value into the existing stepper. */
function mountSettingsStepper(
  mountId: string,
  input: HTMLInputElement | null,
  label: string,
  unit: string,
  opts: { value: number; min: number; max: number; step: number },
): void {
  const mount = document.getElementById(mountId);
  if (!mount || !input) return;
  const existing = settingsSteppers[mountId];
  if (existing) { existing.setValue(opts.value); return; }
  const s = stepper({
    label, unit, value: opts.value, min: opts.min, max: opts.max, step: opts.step,
    onChange: v => { input.value = String(v); },
  });
  mount.replaceChildren(s.el);
  settingsSteppers[mountId] = s;
}

// Live handles for the custom settings dropdowns, so repeated loadSettings calls
// just re-sync the selection instead of stacking duplicate controls.
const settingsDropdowns: Record<string, { setValue: (v: string) => void }> = {};

/** Mount (once) a custom dropdown into `mountId` mirroring the hidden `select`
 *  (the save/load data store). Built ourselves so it opens DOWNWARD and spans
 *  the full field width — the native <select> list flipped upward inside the
 *  transformed settings sheet. On later calls it just re-syncs the value. */
function mountSettingsDropdown(mountId: string, select: HTMLSelectElement | null): void {
  const mount = document.getElementById(mountId);
  if (!mount || !select) return;

  const opts = Array.from(select.options).map(o => ({ value: o.value, label: o.text }));
  const labelFor = (v: string) => opts.find(o => o.value === v)?.label ?? '';

  const existing = settingsDropdowns[mountId];
  if (existing) { existing.setValue(select.value); return; }

  const root = document.createElement('div');
  root.className = 'dd';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dd-button';
  const labelEl = document.createElement('span');
  labelEl.className = 'dd-label';
  const caret = document.createElement('span');
  caret.className = 'dd-caret';
  caret.textContent = '▾';
  button.append(labelEl, caret);
  const panel = document.createElement('div');
  panel.className = 'dd-panel';

  const setValue = (v: string) => {
    select.value = v;
    labelEl.textContent = labelFor(v);
    panel.querySelectorAll('.dd-option').forEach(el => {
      el.classList.toggle('is-selected', (el as HTMLElement).dataset.value === v);
    });
  };

  for (const o of opts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dd-option';
    item.dataset.value = o.value;
    item.textContent = o.label;
    item.addEventListener('click', () => {
      setValue(o.value);
      select.dispatchEvent(new Event('change', { bubbles: true })); // keep any listeners live
      close();
    });
    panel.append(item);
  }

  const open = () => { root.classList.add('open'); button.setAttribute('aria-expanded', 'true'); };
  const close = () => { root.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); };
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root.classList.contains('open')) close(); else open();
  });
  // Click anywhere else closes it.
  document.addEventListener('click', () => close());

  root.append(button, panel);
  mount.replaceChildren(root);
  setValue(select.value);
  settingsDropdowns[mountId] = { setValue };
}

export async function loadSettings(): Promise<void> {
  try {
    const data = await browser.storage.local.get('webTimeSettings');
    const settings = data.webTimeSettings || { global: {}, domains: {} };

    const global = settings.global || {};
    const dayResetTimeEl = document.getElementById('day-reset-time') as HTMLSelectElement | null;

    if (dayResetTimeEl) dayResetTimeEl.value = String(global.dayResetTime || 0);
    // Mount (or re-sync) the custom dropdown that mirrors the hidden select.
    mountSettingsDropdown('day-reset-dropdown', dayResetTimeEl);

    const inactivityEl = document.getElementById('inactivity-timeout') as HTMLInputElement | null;
    const chartScalingEl = document.getElementById('chart-scaling') as HTMLInputElement | null;
    const inactivityVal = global.inactivityTimeoutS ?? 30;
    const scalingVal = global.scalingPower ?? 1.0;
    if (inactivityEl) inactivityEl.value = String(inactivityVal);
    if (chartScalingEl) chartScalingEl.value = String(scalingVal);
    // Mount (or refresh) the styled steppers that mirror the hidden inputs, so
    // the global settings use the same control as the per-site Session rules.
    mountSettingsStepper('inactivity-stepper', inactivityEl, 'Inactivity', 's',
      { value: inactivityVal, min: 1, max: 600, step: 1 });
    mountSettingsStepper('chart-scaling-stepper', chartScalingEl, 'Chart scale', '',
      { value: scalingVal, min: 0.3, max: 1.0, step: 0.05 });

    // End-session shortcut: undefined = default Ctrl+E, null = disabled, string = custom
    const endSessionShortcutEl = document.getElementById('end-session-shortcut') as HTMLInputElement | null;
    if (endSessionShortcutEl) {
      const sc = global.endSessionShortcut;
      endSessionShortcutEl.value = sc === null ? '(disabled)' : (sc || 'Ctrl+E');
      setupShortcutCapture(endSessionShortcutEl);
    }
    const endSessionShortcutClearEl = document.getElementById('end-session-shortcut-clear');
    if (endSessionShortcutClearEl && endSessionShortcutEl) {
      endSessionShortcutClearEl.addEventListener('click', () => {
        endSessionShortcutEl.value = '(disabled)';
        endSessionShortcutEl.dataset.disabled = 'true';
      });
    }
    // Per-site session limits moved to the in-panel "Session rules" card
    // (session-card.ts). The settings overlay is now global-only.

  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

export async function saveSettings(): Promise<void> {
  try {
    const data = await browser.storage.local.get('webTimeSettings');
    const settings = data.webTimeSettings || { global: {}, domains: {} };

    const dayResetTimeEl = document.getElementById('day-reset-time') as HTMLInputElement | null;
    const inactivityTimeoutEl = document.getElementById('inactivity-timeout') as HTMLInputElement | null;
    const chartScalingEl = document.getElementById('chart-scaling') as HTMLInputElement | null;

    const scalingPower = parseFloat(chartScalingEl?.value || '1.0') || 1.0;

    const endSessionShortcutEl = document.getElementById('end-session-shortcut') as HTMLInputElement | null;
    let endSessionShortcut: string | null | undefined;
    if (endSessionShortcutEl?.dataset.disabled === 'true') {
      endSessionShortcut = null;
    } else if (endSessionShortcutEl?.value && endSessionShortcutEl.value !== '(disabled)') {
      endSessionShortcut = endSessionShortcutEl.value;
    } else {
      endSessionShortcut = undefined; // use default
    }

    const clampedScaling = Math.max(0.3, Math.min(1.0, scalingPower));
    settings.global = {
      dayResetTime: parseInt(dayResetTimeEl?.value || '0'),
      inactivityTimeoutS: parseInt(inactivityTimeoutEl?.value || '30') || 30,
      scalingPower: clampedScaling,
      endSessionShortcut
    };
    // Apply the new scale to the live chart config so the currently open chart
    // reflects it immediately — otherwise it only took effect on the NEXT popup
    // open (popup-init sets CONFIG.scalingPower on load), making the setting look
    // like it did nothing. The caller re-renders the active view after saving.
    CONFIG.scalingPower = clampedScaling;
    // Per-site limits are persisted by the in-panel "Session rules" card
    // (session-card.ts) on each change, so saveSettings only writes globals
    // and preserves whatever domains map already exists.
    if (!settings.domains) settings.domains = {};

    await browser.storage.local.set({ webTimeSettings: settings });
    browser.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
    // No success flash — the panel closing (see the save handler) is the
    // confirmation that the save went through.
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

export function renderGeneralView(): void {
  try {
    if (!AppState.allTimeHistory) return;

    const totalTimeData = processGeneralViewData(AppState.allTimeHistory);

    if (totalTimeData.dailyData.length === 0) {
      displayMessage('#general-page .page-content', 'No time data available.');
      return;
    }

    const chartConfig = buildGeneralViewChart(totalTimeData);
    const canvasElement = document.getElementById('total-time-chart') as HTMLCanvasElement | null;

    if (!canvasElement) {
      console.error('Canvas element not found!');
      return;
    }

    const ctx = canvasElement.getContext('2d');
    if (!ctx) return;

    const chart = new Chart(ctx, chartConfig) as ExtendedChart;
    chart.totalTimeData = totalTimeData;

    AppState.setChartInstance(chart);

    const todayIndex = totalTimeData.dailyData.length - 1;
    AppState.lockDay(todayIndex);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    highlightBar(chart as any, todayIndex);
    updateDailyBreakdown(totalTimeData, todayIndex);
    updatePieChart(totalTimeData, todayIndex);

    setupScrollHandling(canvasElement, totalTimeData);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDeadZoneHitbox(canvasElement, chart as any);

    canvasElement.addEventListener('mouseleave', () => {
      // When locked, do nothing on mouse leave
    });

  } catch (error) {
    console.error('Error creating general view chart:', error);
    displayMessage('#general-page .page-content',
      `Error creating chart: ${(error as Error).message}`, 'error');
  }
}

/** The locked bar's date, or null when the panel should show today.
 *
 *  Today locked is the same as nothing locked: the live cards are what today
 *  wants, so there is no past-day panel to enter. Out-of-range indices (the
 *  general view has a different day count) fall back to today rather than
 *  rendering someone else's day. */
function lockedDetailDate(domain: string): string | null {
  const idx = AppState.lockedDayIndex;
  if (idx === null || !AppState.allTimeHistory) return null;
  const days = processDetailViewData(AppState.allTimeHistory, domain).dailyData;
  const day = days[idx];
  if (!day) return null;
  return day.date === getLocalDateStr(AppState.dayResetTime) ? null : day.date;
}

/** The live detail chart. AppState.chartInstance is the general view's; keeping
 *  this one separate stops a highlight meant for one landing on the other. */
let detailChart: ExtendedChart | null = null;

/** Select a day in the detail view: move the lock, repaint the chart highlight,
 *  and swap the panel. `null` means today (the last bar).
 *
 *  Every selection goes through here — the bar click, the back button — so the
 *  lock, the highlight and the panel can't drift apart. This view has had two
 *  bugs from exactly that shape: two callers each doing half the update. */
export function selectDetailDay(dayIndex: number | null): void {
  const domain = AppState.selectedDomain;
  if (!domain || !AppState.allTimeHistory) return;
  const days = processDetailViewData(AppState.allTimeHistory, domain).dailyData;
  if (days.length === 0) return;

  AppState.lockDay(dayIndex ?? days.length - 1);
  // AppState.chartInstance holds the GENERAL chart, so the detail chart is kept
  // here instead — highlighting through AppState would paint the wrong canvas.
  if (detailChart) highlightBar(detailChart as any, AppState.lockedDayIndex!);
  updateDetailPanel(domain);
}

/** Swap the detail right panel between today's live cards and a past day's
 *  finished ones, per the lock. This is the ONLY thing a bar click needs to
 *  redo — the chart itself is unchanged, and rebuilding it would replay the
 *  grow-from-zero animation on every click (the general view has always
 *  updated just its panel for the same reason). */
export function updateDetailPanel(domain: string): void {
  // A locked bar means the panel shows that day instead of today. The lock is
  // shared with the general view, so entering detail with a day already locked
  // lands on that day.
  const selectedDate = lockedDetailDate(domain);
  updateDetailHeader(domain, selectedDate);

  const settingsHost = document.getElementById('session-settings-card');
  const sessionHost = document.getElementById('session-card');
  const pastHost = document.getElementById('past-day-cards');

  if (selectedDate) {
    // A past day is finished: no live session card, and no session-rules card —
    // stored rules are today's, and asserting they were the rules then is a
    // claim the data can't support. The per-session figures already say it.
    settingsHost?.replaceChildren();
    sessionHost?.replaceChildren();
    if (pastHost) {
      pastHost.replaceChildren(
        ...renderPastDayCards(sessionsFor(AppState.sessionHistory, selectedDate, domain))
      );
    }
  } else {
    pastHost?.replaceChildren();
    // Render the per-site limits card + the live session card in the detail
    // right panel (fire-and-forget; both read their own state from storage).
    renderSessionSettingsCard(domain, AppState.dayResetTime).catch(err =>
      console.error('Error rendering session settings card:', err));
    renderSessionCard(domain, AppState.dayResetTime).catch(err =>
      console.error('Error rendering session card:', err));
  }
}

export function renderDetailView(domain: string | null): void {
  if (!domain) {
    displayMessage('#detail-page .left-panel',
      "No site to show here. Open a website (any http or https page), then reopen this popup to see its stats.");
    // Also clear the right-panel cards so nothing bogus lingers beside the message.
    updateDetailUsageCard();
    renderSessionSettingsCard(null, AppState.dayResetTime).catch(() => {});
    renderSessionCard(null, AppState.dayResetTime).catch(() => {});
    return;
  }

  // Default the selection to today (the last bar) before anything reads the
  // lock, so the panel and the highlight can't disagree on first paint.
  if (AppState.lockedDayIndex === null && AppState.allTimeHistory) {
    const days = processDetailViewData(AppState.allTimeHistory, domain).dailyData;
    if (days.length > 0) AppState.lockDay(days.length - 1);
  }

  updateDetailPanel(domain);

  const leftPanel = document.querySelector('#detail-page .left-panel');
  if (leftPanel) {
    const canvas = document.createElement('canvas');
    canvas.id = 'time-chart';
    leftPanel.replaceChildren(canvas);
  }

  if (!AppState.allTimeHistory) return;

  const processedData = processDetailViewData(AppState.allTimeHistory, domain);
  const chartConfig = buildDetailViewChart(processedData);

  const canvasElement = document.getElementById('time-chart') as HTMLCanvasElement | null;
  if (!canvasElement) return;

  const ctx = canvasElement.getContext('2d');
  if (!ctx) return;

  const chart = new Chart(ctx, chartConfig);
  detailChart = chart as unknown as ExtendedChart;

  // A day is always selected (defaulted to today above), and a fresh Chart
  // starts with no highlight — so paint it after building.
  if (AppState.lockedDayIndex !== null) {
    highlightBar(chart as any, AppState.lockedDayIndex);
  }

  if (processedData.dailyData.length > CONFIG.daysToDisplay) {
    setupDetailViewScrolling(canvasElement, chart, processedData);
  }
}

export function updateDetailHeader(_domain: string, selectedDate?: string | null): void {
  if (!AppState.allTimeHistory) return;
  // The detail view's site name + the selected day's numbers live in the merged
  // topbar; refresh those instead of the old per-page .header-text/.time-summary.
  if (AppState.currentView === ViewState.DETAIL) {
    updateTopbar();
    const day = selectedDate || getLocalDateStr(AppState.dayResetTime);
    updateDetailUsageCard(selectedDate || undefined);
    // setTopbarDate labels today as "<date> · Today" and a past day as its date.
    setTopbarDate(day);
  }
}

/** The shared "No data for this day" empty-state element. */
function noDataMessage(): HTMLElement {
  const div = document.createElement('div');
  div.style.cssText = 'color: #888; font-style: italic;';
  div.textContent = 'No data for this day';
  return div;
}

export function displayMessage(selector: string, message: string, type: string = ''): void {
  const element = document.querySelector(selector);
  if (!element) return;

  const cssClass = type ? `message ${type}` : 'message';
  const p = document.createElement('p');
  p.className = cssClass;
  p.textContent = message; // text node — can't inject markup
  element.replaceChildren(p);
}

export function updatePieChart(totalTimeData: GeneralViewData, dataIndex: number): void {
  const dayData = totalTimeData.dailyData[dataIndex];
  const pieCanvas = document.getElementById('breakdown-pie-chart') as HTMLCanvasElement | null;

  if (!pieCanvas || !AppState.allTimeHistory) return;

  const dateString = dayData.date;
  const rawDayData = AppState.allTimeHistory[dateString];

  if (!rawDayData) {
    if (AppState.pieChartInstance) {
      AppState.pieChartInstance.destroy();
      AppState.pieChartInstance = null;
    }
    return;
  }

  const domainData = calculateDomainBreakdown(rawDayData);

  if (AppState.pieChartInstance) {
    const pieConfig = buildPieChart(domainData);
    AppState.pieChartInstance.data = pieConfig.data!;
    AppState.pieChartInstance.options = pieConfig.options!;
    AppState.pieChartInstance.update('none');
  } else {
    const ctx = pieCanvas.getContext('2d');
    if (!ctx) return;

    const pieConfig = buildPieChart(domainData);
    AppState.pieChartInstance = new Chart(ctx, pieConfig);
  }
}

export function updateDailyBreakdown(totalTimeData: GeneralViewData, dataIndex: number): void {
  const dayData = totalTimeData.dailyData[dataIndex];
  const breakdownTitle = document.querySelector('.breakdown-title');
  const breakdownBars = document.querySelector('.breakdown-bars');

  if (!breakdownTitle || !breakdownBars || !AppState.allTimeHistory) return;

  (breakdownTitle as HTMLElement).style.display = 'none';

  const dateString = dayData.date;
  const rawDayData = AppState.allTimeHistory[dateString];

  if (!rawDayData) {
    breakdownBars.replaceChildren(noDataMessage());
    return;
  }

  const domainData = calculateDomainBreakdown(rawDayData);
  renderBreakdownBars(breakdownBars as HTMLElement, domainData);

  updateGeneralViewHeader(dateString);
  updateGeneralUsageHead(dateString);   // delta + total track the selected day
}

export function updateGeneralViewHeader(dateString: string): void {
  setTopbarDate(dateString);
}

/** Shared topbar date label for both views: "<date> · Today" when it's today,
 *  otherwise just the date. (Date first, "Today" suffix — same in both views.) */
function setTopbarDate(dateString: string): void {
  const dateLabel = document.getElementById('topbar-date-label');
  if (!dateLabel) return;
  const today = getLocalDateStr(AppState.dayResetTime);
  const formattedDate = formatDateWithDayOfWeek(dateString);
  dateLabel.textContent = dateString === today ? `${formattedDate} · Today` : formattedDate;
}

export function calculateDomainBreakdown(rawDayData: Record<string, number>): DomainPieData[] {
  const domainData: DomainPieData[] = [];
  let totalSeconds = 0;

  Object.keys(rawDayData).forEach(domain => {
    totalSeconds += rawDayData[domain] || 0;
  });

  Object.keys(rawDayData).forEach(domain => {
    const seconds = rawDayData[domain] || 0;

    if (seconds > 0) {
      domainData.push({
        domain,
        seconds,
        percentage: Math.round((seconds / totalSeconds) * 100),
        color: ''
      });
    }
  });

  const sorted = domainData.sort((a, b) => b.seconds - a.seconds);

  sorted.forEach((item, index) => {
    if (index < CONFIG.topDomainsLimit) {
      item.color = COLORS.domains[index % COLORS.domains.length];
    } else {
      item.color = COLORS.others;
    }
  });

  return sorted;
}

export function renderBreakdownBars(container: HTMLElement, domainData: DomainPieData[]): void {
  if (domainData.length === 0) {
    container.replaceChildren(noDataMessage());
    return;
  }

  const maxSeconds = domainData[0].seconds;

  // Built with the DOM API (not innerHTML): domain names are untrusted, and
  // textContent makes markup injection impossible without manual escaping.
  const rows = domainData.map(item => {
    const widthPercent = Math.max((item.seconds / maxSeconds) * 100, 2);

    const bar = document.createElement('div');
    bar.className = 'breakdown-bar';
    bar.dataset.domain = item.domain;

    const color = document.createElement('div');
    color.className = 'breakdown-color';
    color.style.background = item.color;
    // Monogram: the domain's first alphanumeric char (per the design's tiles).
    const initial = (item.domain.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
    color.textContent = item.domain === 'Others' ? '⋯' : initial;

    const label = document.createElement('div');
    label.className = 'breakdown-label';
    label.title = item.domain;
    label.textContent = item.domain;

    const fill = document.createElement('div');
    fill.className = 'breakdown-fill';
    const fillInner = document.createElement('div');
    fillInner.className = 'breakdown-fill-inner';
    fillInner.style.background = item.color;
    fillInner.style.width = `${widthPercent}%`;
    fill.appendChild(fillInner);

    const time = document.createElement('div');
    time.className = 'breakdown-time';
    // Every row here has real usage (calculateDomainBreakdown drops zeros), so a
    // sub-minute site reads "<1m" rather than a confusing "0m" that still shows up.
    const durationLabel = item.seconds < 60 ? '<1m' : formatDuration(item.seconds);
    time.textContent = `${durationLabel} (${item.percentage}%)`;

    bar.append(color, label, fill, time);
    return bar;
  });
  container.replaceChildren(...rows);

  container.onclick = (e: MouseEvent) => {
    const bar = (e.target as HTMLElement).closest('.breakdown-bar') as HTMLElement | null;
    if (bar) {
      const domain = bar.dataset.domain;
      if (domain) {
        AppState.setSelectedDomain(domain);
        renderDetailView(domain);
        showDetailView();
      }
    }
  };
}

export function setupScrollHandling(canvasElement: HTMLCanvasElement, totalTimeData: GeneralViewData): void {
  const totalDays = totalTimeData.dailyData.length;
  const windowSize = CONFIG.daysToDisplay;

  if (totalDays <= windowSize) {
    return;
  }

  canvasElement.addEventListener('wheel', (event: WheelEvent) => {
    event.preventDefault();

    const scrollDelta = Math.sign(event.deltaY) * -3;
    const newPosition = AppState.updateScrollPosition(scrollDelta);
    updateChartViewport(totalDays, windowSize, newPosition);
  });

  canvasElement.addEventListener('keydown', (event: KeyboardEvent) => {
    let scrollDelta = 0;

    switch (event.key) {
      case 'ArrowLeft':
        scrollDelta = 5;
        break;
      case 'ArrowRight':
        scrollDelta = -5;
        break;
      default:
        return;
    }

    event.preventDefault();
    const newPosition = AppState.updateScrollPosition(scrollDelta);
    updateChartViewport(totalDays, windowSize, newPosition);
  });

  canvasElement.tabIndex = 0;
}

export function updateChartViewport(totalDays: number, windowSize: number, scrollPosition: number): void {
  const chart = AppState.chartInstance as ExtendedChart | null;
  if (!chart) return;

  const maxIndex = totalDays - 1 - scrollPosition;
  const minIndex = Math.max(0, maxIndex - windowSize + 1);

  if (chart.options?.scales?.x) {
    (chart.options.scales.x as Record<string, unknown>).min = minIndex;
    (chart.options.scales.x as Record<string, unknown>).max = maxIndex;
  }

  chart.update('none');

  if (AppState.isLocked() && AppState.lockedDayIndex !== null &&
      AppState.lockedDayIndex >= minIndex && AppState.lockedDayIndex <= maxIndex) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    highlightBar(chart as any, AppState.lockedDayIndex);
  }

  const visibleIndex = AppState.isLocked() && AppState.lockedDayIndex !== null
    ? AppState.lockedDayIndex
    : maxIndex;

  if (chart.totalTimeData) {
    updateDailyBreakdown(chart.totalTimeData, visibleIndex);
    updatePieChart(chart.totalTimeData, visibleIndex);
  }
}

export function createDeadZoneHitbox(canvasElement: HTMLCanvasElement, chart: ExtendedChart): void {
  const hitbox = document.createElement('div');
  hitbox.style.position = 'absolute';
  hitbox.style.pointerEvents = 'auto';
  hitbox.style.backgroundColor = 'transparent';
  hitbox.style.zIndex = '10';

  const updateHitboxPosition = (): void => {
    const chartArea = (chart as unknown as { chartArea: { left: number; right: number; bottom: number } }).chartArea;
    const rect = canvasElement.getBoundingClientRect();

    hitbox.style.left = `${chartArea.left}px`;
    hitbox.style.top = `${chartArea.bottom}px`;
    hitbox.style.width = `${chartArea.right - chartArea.left}px`;
    hitbox.style.height = `${rect.height - chartArea.bottom}px`;
  };

  hitbox.addEventListener('mouseenter', () => {
    // When locked, do nothing
  });

  updateHitboxPosition();

  const container = canvasElement.parentElement;
  if (container) {
    container.style.position = 'relative';
    container.appendChild(hitbox);
  }

  chart._deadZoneHitbox = hitbox;
}

export function setupDetailViewScrolling(
  canvasElement: HTMLCanvasElement,
  chart: ExtendedChart,
  processedData: DetailViewData
): void {
  const totalDays = processedData.dailyData.length;
  const windowSize = CONFIG.daysToDisplay;

  let detailScrollPosition = 0;

  canvasElement.addEventListener('wheel', (event: WheelEvent) => {
    event.preventDefault();

    const scrollDelta = Math.sign(event.deltaY) * -3;
    const maxScroll = Math.max(0, totalDays - windowSize);
    detailScrollPosition = Math.max(0, Math.min(maxScroll, detailScrollPosition + scrollDelta));

    const maxIndex = totalDays - 1 - detailScrollPosition;
    const minIndex = Math.max(0, maxIndex - windowSize + 1);

    if (chart.options?.scales?.x) {
      (chart.options.scales.x as Record<string, unknown>).min = minIndex;
      (chart.options.scales.x as Record<string, unknown>).max = maxIndex;
    }
    chart.update('none');
  });

  canvasElement.addEventListener('keydown', (event: KeyboardEvent) => {
    let scrollDelta = 0;

    switch (event.key) {
      case 'ArrowLeft':
        scrollDelta = 5;
        break;
      case 'ArrowRight':
        scrollDelta = -5;
        break;
      default:
        return;
    }

    event.preventDefault();
    const maxScroll = Math.max(0, totalDays - windowSize);
    detailScrollPosition = Math.max(0, Math.min(maxScroll, detailScrollPosition + scrollDelta));

    const maxIndex = totalDays - 1 - detailScrollPosition;
    const minIndex = Math.max(0, maxIndex - windowSize + 1);

    if (chart.options?.scales?.x) {
      (chart.options.scales.x as Record<string, unknown>).min = minIndex;
      (chart.options.scales.x as Record<string, unknown>).max = maxIndex;
    }
    chart.update('none');
  });

  canvasElement.tabIndex = 0;
}

export const UIManager = {
  showGeneralView,
  showDetailView,
  openSettings,
  closeSettings,
  toggleSettings,
  loadSettings,
  saveSettings,
  renderGeneralView,
  renderDetailView,
  updateDetailPanel,
  selectDetailDay,
  updateDetailHeader,
  displayMessage,
  updatePieChart,
  updateDailyBreakdown,
  updateGeneralViewHeader,
  calculateDomainBreakdown,
  renderBreakdownBars,
  setupScrollHandling,
  updateChartViewport,
  createDeadZoneHitbox,
  setupDetailViewScrolling
};

export default UIManager;
