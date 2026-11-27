import { closeSync, constants } from "node:fs";

export const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface StagingEntry {
  dev: bigint;
  ino: bigint;
  mode: number;
  uid: number;
}

export interface StagingFiles {
  openAt(fd: number, name: string, flags: number, mode?: number): number;
  statAt(fd: number, name: string): StagingEntry | undefined;
  unlinkAt(fd: number, name: string, directory: boolean): void;
  names(fd: number): string[];
  publish(
    sourceDirFd: number,
    sourceName: string,
    destDirFd: number,
    destName: string,
    replace: boolean,
  ): void;
}

let bindings: StagingFiles | undefined;
export function darwinStagingFiles(): StagingFiles {
  return (bindings ??= loadBindings());
}

function loadBindings(): StagingFiles {
  const koffi = require("koffi") as typeof import("koffi");
  const libc = koffi.load(null);
  // Darwin x86_64 exposes the 64-bit inode ABI under suffixed libc symbols.
  const suffix = process.arch === "x64" ? "$INODE64" : "";
  const openat = libc.func("int openat(int, const char *, int, ...)");
  const fstatat = libc.func(`fstatat${suffix}`, "int", ["int", "str", "void *", "int"]);
  const unlinkat = libc.func("int unlinkat(int, const char *, int)");
  const renameatx = libc.func(
    "int renameatx_np(int, const char *, int, const char *, unsigned int)",
  );
  const fdopendir = libc.func(`fdopendir${suffix}`, "void *", ["int"]);
  const readdir = libc.func(`readdir${suffix}`, "void *", ["void *"]);
  const closedir = libc.func("int closedir(void *)");
  const O_CLOEXEC = 0x01000000;
  const AT_SYMLINK_NOFOLLOW = 0x0020;
  const AT_REMOVEDIR = 0x0080;
  const RENAME_SWAP = 2;
  const RENAME_EXCL = 4;

  function checked(result: number, operation: string) {
    if (result === -1) throw new Error(`${operation} failed (errno ${koffi.errno()})`);
    return result;
  }

  function openAt(fd: number, name: string, flags: number, mode = 0) {
    return checked(openat(fd, name, flags | O_CLOEXEC, "int", mode), `openat ${name}`);
  }

  return {
    openAt,
    statAt(fd, name) {
      // Darwin's 64-bit struct stat is 144 bytes on arm64 and x86_64.
      const stat = Buffer.alloc(144);
      if (fstatat(fd, name, stat, AT_SYMLINK_NOFOLLOW) === -1) {
        if (koffi.errno() === koffi.os.errno.ENOENT) return;
        checked(-1, `fstatat ${name}`);
      }
      return {
        dev: BigInt(stat.readUInt32LE(0)),
        mode: stat.readUInt16LE(4),
        ino: stat.readBigUInt64LE(8),
        uid: stat.readUInt32LE(16),
      };
    },
    unlinkAt(fd, name, directory) {
      checked(unlinkat(fd, name, directory ? AT_REMOVEDIR : 0), `unlinkat ${name}`);
    },
    names(fd) {
      // fdopendir owns its descriptor after success and shares its directory offset.
      const reader = openAt(fd, ".", directoryFlags);
      const stream = fdopendir(reader);
      if (!stream) {
        const errno = koffi.errno();
        closeSync(reader);
        throw new Error(`fdopendir failed (errno ${errno})`);
      }
      try {
        const names: string[] = [];
        const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        while (true) {
          koffi.errno(0);
          const entry = readdir(stream);
          if (!entry) {
            if (koffi.errno() !== 0) checked(-1, "readdir");
            return names;
          }
          // Darwin dirent64 stores d_namlen at byte 18 and d_name at byte 21.
          const length: number = koffi.decode(entry, 18, "uint16_t");
          const name = utf8.decode(koffi.decode(entry, 21, "uint8_t", length));
          if (name !== "." && name !== "..") names.push(name);
        }
      } finally {
        checked(closedir(stream), "closedir");
      }
    },
    publish(sourceDirFd, sourceName, destDirFd, destName, replace) {
      checked(
        renameatx(
          sourceDirFd,
          sourceName,
          destDirFd,
          destName,
          replace ? RENAME_SWAP : RENAME_EXCL,
        ),
        "renameatx_np",
      );
    },
  };
}
