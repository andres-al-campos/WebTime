/**
 * The exported-backup payload.
 *
 * This is a file that outlives the extension that wrote it — someone opens it
 * years later, possibly without WebTime installed at all. So it carries its own
 * provenance (`app`, `exportedAt`) and the version of each store it contains,
 * rather than the bare histories: a file whose format you cannot identify is
 * not a backup.
 *
 * Kept pure and separate from the download itself, so the shape can be pinned
 * by tests without a browser.
 */

import type { TimeHistory } from '../types.js';
import type { SessionHistory, StoredSessionHistory } from './session-history.js';
import { toStored } from './session-history.js';
import { TRACKED_TIME_VERSION } from './time-history.js';

/** Bumped when the envelope itself changes, independently of the stores. */
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportPayload {
  app: 'WebTime';
  exportFormat: number;
  exportedAt: string;
  trackedTime: { version: number; timeHistory: TimeHistory };
  /** Exactly what is on disk under the session key — `toStored` already
   *  carries its own version, so this is not re-wrapped. */
  sessionHistory: StoredSessionHistory;
}

export function buildExport(
  timeHistory: TimeHistory,
  sessionHistory: SessionHistory,
  now: Date = new Date()
): ExportPayload {
  return {
    app: 'WebTime',
    exportFormat: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    trackedTime: { version: TRACKED_TIME_VERSION, timeHistory },
    // toStored, so the exported sessions are byte-for-byte what is on disk —
    // an export that re-derives the shape can drift from the real one.
    sessionHistory: toStored(sessionHistory),
  };
}

/** `webtime-backup-2026-09-19.json` — sorts chronologically in a file list. */
export function exportFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `webtime-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}
