/**
 * The storage banner and the settings "Your data" row.
 *
 * Both read the same measurement, so the number in settings and the decision
 * to show the banner cannot disagree. The size is computed from what the popup
 * already holds in AppState rather than asked of the background: the popup has
 * both stores in memory, and a round trip would only add a way for the two to
 * drift.
 */

import { AppState } from './state.js';
import { buildExport, exportFilename } from '../shared/data-export.js';
import { formatBytes, levelFor, percentFull, storedSize } from '../shared/storage-health.js';
import { dayCount } from '../shared/time-history.js';

declare const browser: typeof chrome;

function measure(): { bytes: number; days: number } {
  const history = AppState.allTimeHistory || {};
  // Both stores count toward the quota, so both count here. Measuring only
  // timeHistory would under-report for anyone using session limits.
  return {
    bytes: storedSize(history) + storedSize(AppState.sessionHistory),
    days: dayCount(history),
  };
}

/** Serialize and hand the browser a download. */
function downloadExport(): void {
  // Belt to render()'s braces: never export stand-in empties as a backup.
  if (AppState.storedByNewerVersion) return;
  const payload = buildExport(AppState.allTimeHistory || {}, AppState.sessionHistory);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename();
  a.click();
  // The popup can close the moment the download starts, which would revoke the
  // url mid-read; a tick of delay is enough for the browser to take it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const StoragePanel = {
  /** Fill the settings row and show the banner only when near the quota. */
  render(): void {
    // In this state the histories in memory are empty stand-ins. Measuring them
    // would report "0 B", and exporting them would hand over an empty backup
    // that looks like a real one — the worst outcome for a backup.
    if (AppState.storedByNewerVersion) {
      const summary = document.getElementById('storage-summary');
      if (summary) summary.textContent = 'Saved by a newer version. Update WebTime to export it.';
      const btn = document.getElementById('export-data-btn') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      const banner = document.getElementById('storage-banner');
      if (banner) banner.hidden = true;
      return;
    }

    const { bytes, days } = measure();

    const summary = document.getElementById('storage-summary');
    if (summary) {
      summary.textContent = `${formatBytes(bytes)} · ${days} ${days === 1 ? 'day' : 'days'}`;
    }

    const banner = document.getElementById('storage-banner');
    const warn = levelFor(bytes) !== 'ok';
    if (banner) banner.hidden = !warn;

    // Says where the export lives, because someone can fill ten years of
    // storage without ever opening settings — this banner may be the first
    // time they learn there is an export at all.
    // TODO: "Oldest days will start being overwritten" isn't true: nothing
    // prunes tracked time, so at the quota storage.local writes would fail
    // instead. Either prune oldest days or reword the warning.
    const text = document.getElementById('storage-banner-text');
    if (text && warn) {
      text.textContent =
        `Stored data is ${percentFull(bytes)}% full. Oldest days will start being ` +
        `overwritten. You can export your data here or in settings.`;
    }
  },

  attach(): void {
    document.getElementById('export-data-btn')?.addEventListener('click', downloadExport);
    document.getElementById('storage-banner-export')?.addEventListener('click', downloadExport);
  },
};

export default StoragePanel;
