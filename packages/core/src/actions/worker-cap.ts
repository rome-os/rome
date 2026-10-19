/** The cap used when the instance's memory is unknown: the historical fixed default. */
export const FALLBACK_WORKER_CAP = 8;
const MIN_WORKER_CAP = 4;
const MAX_WORKER_CAP = 16;
/** Live workers the default allows per GiB of instance memory. A worker is a
 * Node process of some tens of MB, but what runs under it (an agent turn, a
 * build, a test run) is what the budget has to leave room for. */
const WORKERS_PER_GIB = 1.5;

/**
 * The default action-worker cap for an instance with `totalBytes` of memory:
 * about 6 on 4 GiB, 12 on 8 GiB, and 16 from 11 GiB up. Below 4 the reserved
 * slots would leave queued roots nothing, so 4 is the floor. An unknown total
 * keeps the fixed cap the config used before.
 */
export function defaultWorkerCap(totalBytes: number | null | undefined): number {
  if (totalBytes === null || totalBytes === undefined || !(totalBytes > 0)) {
    return FALLBACK_WORKER_CAP;
  }
  const gib = totalBytes / 1024 ** 3;
  return Math.min(MAX_WORKER_CAP, Math.max(MIN_WORKER_CAP, Math.round(gib * WORKERS_PER_GIB)));
}
