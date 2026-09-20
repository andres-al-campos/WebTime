/**
 * How full storage is, and what to say about it.
 *
 * Measured in BYTES, not days. A retention cap in days is a proxy for the thing
 * that actually fails, and it is wrong in both directions: a light user loses
 * history they had room for, while a heavy user with many tracked domains still
 * reaches the ceiling early. Serializing what we are about to store answers the
 * real question directly.
 *
 * Computing the size ourselves also sidesteps `storage.local.getBytesInUse`,
 * which Chrome has and Firefox has historically not. One number, both browsers,
 * no feature detection.
 */

/**
 * Chrome's storage.local ceiling without the `unlimitedStorage` permission.
 *
 * Firefox's limit is effectively unbounded, so this is stricter than that
 * browser needs. That is deliberate: a Firefox user who exports at the same
 * point loses nothing, and one quota shared by both builds means one code path
 * and one set of tests rather than a branch that only ever runs on one of them.
 */
export const QUOTA_BYTES = 10 * 1024 * 1024;

/** Fraction of the quota at which the banner appears. */
export const WARN_AT = 0.9;

export type StorageLevel = 'ok' | 'warn';

/**
 * Bytes a value occupies once stored.
 *
 * `storage.local` persists JSON, so its serialization is the size that counts —
 * not the in-memory footprint of the object, which is several times larger and
 * has nothing to do with the quota.
 *
 * Counted in UTF-8 bytes rather than string length. Domain names can carry
 * non-ASCII (an IDN such as `münchen.de` is stored decoded), and those cost
 * more than one byte each; `.length` would quietly under-report them.
 */
export function storedSize(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  return new TextEncoder().encode(json).length;
}

/** Whether a total has reached the point worth telling the user about. */
export function levelFor(bytes: number, quota: number = QUOTA_BYTES): StorageLevel {
  return bytes >= quota * WARN_AT ? 'warn' : 'ok';
}

/**
 * How full storage is, as a whole percent: `90` for 90%.
 *
 * Rounded DOWN, not to nearest. The banner appears at exactly WARN_AT, so
 * rounding up would let it say "90% full" while sitting at 89.6% — a number
 * that contradicts the threshold that produced it. Down is also the honest
 * direction for a warning: it never overstates how little room is left.
 *
 * Clamped to 100, since a store can exceed the quota we chose for Firefox.
 */
export function percentFull(bytes: number, quota: number = QUOTA_BYTES): number {
  return Math.min(100, Math.floor((bytes / quota) * 100));
}

/**
 * A size for humans: "1.2 MB", "640 KB".
 *
 * One decimal for MB and none below it — at KB scale the extra digit is noise,
 * and this is read as a rough magnitude, not a measurement.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
