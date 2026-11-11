import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
  symlink,
  lstat,
  stat,
  unlink,
  lchown,
  readlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export interface HostFilesystemConfigPayload {
  enabled: boolean;
  connection: {
    host: string;
    port: number;
    username: string;
    privateKey: string;
  };
  mounts: Array<{
    name: string;
    remotePath: string;
    containerPath: string;
    aliases?: Array<{
      containerPath: string;
      relativePath: string;
    }>;
  }>;
  remoteAccess: {
    username: string;
    port: number;
    sshPublicKey: string;
  } | null;
}

interface PersistedConfig extends HostFilesystemConfigPayload {
  updatedAt: string;
}

export interface HostFilesystemMountStatus {
  name: string;
  remotePath: string;
  containerPath: string;
  mounted: boolean;
}

export interface HostFilesystemStatusPayload {
  configured: boolean;
  enabled: boolean;
  connection: {
    host: string;
    port: number;
    username: string;
  } | null;
  mounts: HostFilesystemMountStatus[];
  remoteAccess: {
    username: string;
    port: number;
  } | null;
  lastAppliedAt: string | null;
  lastError: string | null;
}

const STATE_DIR = join(homedir(), ".rome");
const CONFIG_PATH = join(STATE_DIR, "host-filesystem.json");
const HOSTFS_TARGETS_DIR = "/var/lib/rome-hostfs/targets";
const SSH_DIR = join(homedir(), ".ssh");
const PRIVATE_KEY_PATH = join(SSH_DIR, "host_mount_key");
const KNOWN_HOSTS_PATH = join(SSH_DIR, "host_mount_known_hosts");
const REMOTE_ACCESS_AUTHORIZED_KEYS_PATH = "/home/user/.ssh/authorized_keys";
const USER_HOME_PREFIX = "/home/user/";
const REMOTE_ACCESS_PROVISION_SCRIPT = "/app/scripts/docker/rome-hostfs-remote-access-provision.sh";

type MountConfig = HostFilesystemConfigPayload["mounts"][number];

export class HostFilesystemManager {
  private lastAppliedAt: string | null = null;
  private lastError: string | null = null;
  private currentConfig: PersistedConfig | null = null;

  async restore(): Promise<void> {
    if (!existsSync(CONFIG_PATH)) {
      return;
    }

    const raw = await readFile(CONFIG_PATH, "utf-8");
    const restoredConfig = JSON.parse(raw) as PersistedConfig;
    await this.applyConfig(null, restoredConfig);
    this.currentConfig = restoredConfig;
  }

  async configure(payload: HostFilesystemConfigPayload): Promise<HostFilesystemStatusPayload> {
    const previousConfig = this.currentConfig;
    const nextConfig: PersistedConfig = {
      ...payload,
      updatedAt: new Date().toISOString(),
    };

    await mkdir(STATE_DIR, { recursive: true });
    try {
      await this.applyConfig(previousConfig, nextConfig);
    } catch (error) {
      await this.rollbackConfig(previousConfig, nextConfig, error);
      throw error;
    }
    await writeFile(CONFIG_PATH, JSON.stringify(nextConfig, null, 2), "utf-8");
    this.currentConfig = nextConfig;
    return await this.getStatus();
  }

  async getStatus(): Promise<HostFilesystemStatusPayload> {
    const config = this.currentConfig;
    const mounts: HostFilesystemMountStatus[] = [];

    if (config) {
      for (const mount of config.mounts) {
        const effectiveMount = this.getEffectiveMount(mount);
        mounts.push({
          name: mount.name,
          remotePath: mount.remotePath,
          containerPath: mount.containerPath,
          mounted: await this.isMounted(effectiveMount.containerPath),
        });
      }
    }

    return {
      configured: config !== null,
      enabled: config?.enabled ?? false,
      connection: config
        ? {
            host: config.connection.host,
            port: config.connection.port,
            username: config.connection.username,
          }
        : null,
      mounts,
      remoteAccess:
        config?.remoteAccess &&
        typeof config.remoteAccess.username === "string" &&
        typeof config.remoteAccess.port === "number"
          ? {
              username: config.remoteAccess.username,
              port: config.remoteAccess.port,
            }
          : null,
      lastAppliedAt: this.lastAppliedAt,
      lastError: this.lastError,
    };
  }

  private async applyConfig(
    previousConfig: PersistedConfig | null,
    config: PersistedConfig,
  ): Promise<void> {
    try {
      await this.applyMountPlan(previousConfig, config);
      this.lastAppliedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async rollbackConfig(
    previousConfig: PersistedConfig | null,
    attemptedConfig: PersistedConfig,
    error: unknown,
  ): Promise<void> {
    const originalMessage = error instanceof Error ? error.message : String(error);

    try {
      if (previousConfig) {
        await this.applyMountPlan(attemptedConfig, previousConfig);
        this.lastAppliedAt = new Date().toISOString();
      } else {
        await this.cleanupPreviousMounts(attemptedConfig);
      }
      this.lastError = originalMessage;
    } catch (rollbackError) {
      const rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      this.lastError = `${originalMessage}; rollback failed: ${rollbackMessage}`;
    }
  }

  private async applyMountPlan(
    previousConfig: PersistedConfig | null,
    config: PersistedConfig,
  ): Promise<void> {
    if (config.enabled) {
      await this.ensureSshFiles(config.connection.privateKey);
    }
    await this.cleanupPreviousMounts(previousConfig, config);

    if (config.enabled) {
      for (const mount of config.mounts) {
        await this.mountTarget(config, this.getEffectiveMount(mount));
      }
    }

    await this.applyRemoteAccessConfig(config);
  }

  private async ensureSshFiles(privateKey: string): Promise<void> {
    await mkdir(SSH_DIR, { recursive: true });
    await writeFile(PRIVATE_KEY_PATH, privateKey, "utf-8");
    await this.safeChmod(PRIVATE_KEY_PATH, 0o600);

    if (!existsSync(KNOWN_HOSTS_PATH)) {
      await writeFile(KNOWN_HOSTS_PATH, "", "utf-8");
      await this.safeChmod(KNOWN_HOSTS_PATH, 0o600);
    }
  }

  private async cleanupPreviousMounts(
    previousConfig: PersistedConfig | null,
    nextConfig: PersistedConfig | null = null,
  ): Promise<void> {
    const previous = previousConfig?.mounts ?? [];
    const retainedAliasPaths = new Set(
      (nextConfig?.mounts ?? []).flatMap((mount) =>
        (this.getEffectiveMount(mount).aliases ?? []).map((alias) => alias.containerPath),
      ),
    );

    for (const previousMount of previous) {
      const mount = this.getEffectiveMount(previousMount);
      await this.unmount(mount.containerPath);
      for (const alias of mount.aliases ?? []) {
        if (retainedAliasPaths.has(alias.containerPath)) {
          continue;
        }
        await this.removePath(alias.containerPath);
      }
    }
  }

  private async mountTarget(config: PersistedConfig, mount: MountConfig): Promise<void> {
    if (await this.isMounted(mount.containerPath)) {
      await this.unmount(mount.containerPath);
    }

    await mkdir(dirname(mount.containerPath), { recursive: true });
    await mkdir(mount.containerPath, { recursive: true });
    const owner = await this.getMountOwner();

    const args = [
      `${config.connection.username}@${config.connection.host}:${mount.remotePath}`,
      mount.containerPath,
      "-p",
      String(config.connection.port),
      "-o",
      `IdentityFile=${PRIVATE_KEY_PATH}`,
      "-o",
      `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "reconnect",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "allow_other",
      "-o",
      `uid=${owner.uid}`,
      "-o",
      `gid=${owner.gid}`,
      "-o",
      "umask=007",
    ];

    await this.runCommand("sshfs", args);

    for (const alias of mount.aliases ?? []) {
      const aliasTarget = join(mount.containerPath, alias.relativePath);
      await this.ensureAliasLink(alias.containerPath, aliasTarget, owner);
    }
  }

  private async applyRemoteAccessConfig(config: PersistedConfig): Promise<void> {
    if (
      !config.enabled ||
      !config.remoteAccess ||
      typeof config.remoteAccess.sshPublicKey !== "string" ||
      config.remoteAccess.sshPublicKey.trim().length === 0
    ) {
      return;
    }

    await this.runCommand("sudo", [
      "-n",
      "/bin/sh",
      REMOTE_ACCESS_PROVISION_SCRIPT,
      config.remoteAccess.username,
      REMOTE_ACCESS_AUTHORIZED_KEYS_PATH,
      config.remoteAccess.sshPublicKey.trim(),
    ]);
  }

  private getEffectiveMount(mount: MountConfig): MountConfig {
    if (!this.shouldUseInternalMountTarget(mount.containerPath)) {
      return mount;
    }

    return {
      ...mount,
      containerPath: join(HOSTFS_TARGETS_DIR, mount.containerPath.replace(/^\/+/, "")),
      aliases: [
        { containerPath: mount.containerPath, relativePath: "." },
        ...(mount.aliases ?? []),
      ],
    };
  }

  private shouldUseInternalMountTarget(containerPath: string): boolean {
    return containerPath === "/home/user" || containerPath.startsWith(USER_HOME_PREFIX);
  }

  private async unmount(containerPath: string): Promise<void> {
    if (!(await this.isMounted(containerPath))) {
      return;
    }

    try {
      await this.runCommand("fusermount3", ["-u", containerPath]);
      return;
    } catch {
      // Fall through to legacy binaries.
    }

    try {
      await this.runCommand("fusermount", ["-u", containerPath]);
      return;
    } catch {
      // Fall through to umount.
    }

    await this.runCommand("umount", ["-l", containerPath]);
  }

  private async isMounted(containerPath: string): Promise<boolean> {
    if (!existsSync("/proc/mounts")) {
      return false;
    }

    const mounts = await readFile("/proc/mounts", "utf-8");
    return mounts.split("\n").some((line) => line.split(" ")[1] === containerPath);
  }

  private async safeChmod(path: string, mode: number): Promise<void> {
    try {
      await chmod(path, mode);
    } catch {
      // Ignore on filesystems that do not support chmod.
    }
  }

  private async safeLchown(path: string, uid: number, gid: number): Promise<void> {
    try {
      await lchown(path, uid, gid);
    } catch {
      // Ignore on filesystems that do not support ownership changes on symlinks.
    }
  }

  private async getMountOwner(): Promise<{ uid: number; gid: number }> {
    const userHome = await stat("/home/user");
    return {
      uid: process.getuid?.() ?? userHome.uid,
      gid: userHome.gid,
    };
  }

  private async ensureAliasLink(
    aliasPath: string,
    aliasTarget: string,
    owner: { uid: number; gid: number },
  ): Promise<void> {
    await mkdir(dirname(aliasPath), { recursive: true });

    if (await this.isMatchingSymlink(aliasPath, aliasTarget)) {
      await this.safeLchown(aliasPath, owner.uid, owner.gid);
      return;
    }

    await this.removePath(aliasPath);
    await symlink(aliasTarget, aliasPath);
    await this.safeLchown(aliasPath, owner.uid, owner.gid);
  }

  private async isMatchingSymlink(path: string, expectedTarget: string): Promise<boolean> {
    try {
      const pathStat = await lstat(path);
      if (!pathStat.isSymbolicLink()) {
        return false;
      }
      return (await readlink(path)) === expectedTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async removePath(path: string): Promise<void> {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.isFile()) {
        await unlink(path);
        return;
      }
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async runCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      });
    });
  }
}
