import {
  MEMORY_HOLD_FRACTION,
  type MemoryHeadroomReader,
  readMemoryHeadroom,
} from "../actions/memory-headroom.js";
import { DISK_LOW_FRACTION, type DiskUsage, readDiskUsage } from "./disk-usage.js";

/** The instance's memory and disk, as the system diagnosis card shows them. A
 * null reading means the host offers none (a bare macOS process has no memory
 * reading), and the card leaves that row out rather than showing a wrong number. */
export interface ResourceReadings {
  memory: {
    limitBytes: number;
    availableBytes: number;
    /** True while the memory gate would hold queued work. */
    short: boolean;
  } | null;
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    low: boolean;
  } | null;
}

export interface ResourceProbes {
  memory: MemoryHeadroomReader;
  disk: () => DiskUsage | null;
}

const defaultProbes: ResourceProbes = {
  memory: () => readMemoryHeadroom(),
  disk: () => readDiskUsage(),
};

/** Reads memory and disk once and marks each against its one line, so every
 * surface paints "short" and "low" the same way the engine judges them. */
export function readResourceReadings(probes: ResourceProbes = defaultProbes): ResourceReadings {
  const memory = probes.memory();
  const disk = probes.disk();
  return {
    memory:
      memory && memory.limitBytes > 0
        ? {
            limitBytes: memory.limitBytes,
            availableBytes: memory.availableBytes,
            short: memory.availableBytes / memory.limitBytes < MEMORY_HOLD_FRACTION,
          }
        : null,
    disk: disk
      ? {
          path: disk.path,
          totalBytes: disk.totalBytes,
          freeBytes: disk.freeBytes,
          low: disk.freeBytes / disk.totalBytes < DISK_LOW_FRACTION,
        }
      : null,
  };
}
