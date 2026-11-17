import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXPORT_PATH_REFUSED } from '../fallbacks.js';
import type { ExportConfig } from './config.js';
import { MAX_EXPORT_TTL_MINUTES } from './config.js';

/** Name of a process subdirectory (mkdtemp suffix of six characters). */
const SUBDIR_PATTERN = /^dalux-export-[A-Za-z0-9_-]{6}$/;
const SUBDIR_PREFIX = 'dalux-export-';
/** Subdirectories of other processes older than this are removed (longest link lifetime plus a margin). */
export const STALE_SUBDIR_MS = (MAX_EXPORT_TTL_MINUTES + 60) * 60_000;
/** Free space kept on top of the archive cap. */
export const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/** Refusal of a new export because of a capacity limit (stored archives, disk space). */
export class ExportCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportCapacityError';
  }
}

export interface ExportReservation {
  /** Directory to write the archive in (this process's subdirectory). */
  dir: string;
  /** Effective archive cap: the per-archive cap, limited by what may still be stored. */
  maxBytes: number;
  /** Count the finished archive as stored and end the reservation. */
  commit(path: string, sizeBytes: number): void;
  /** End the reservation without an archive. */
  release(): void;
}

export interface WorkspaceOptions {
  now?: () => number;
  /**
   * The sink check of the instance that creates the workspace: a root or
   * subdirectory path it flags is never created (src/key-admission.ts).
   */
  refuses?: (path: string) => boolean;
  /** Injectable for tests. */
  freeBytes?: (dir: string) => Promise<number>;
}

/**
 * The export directory of this process: a private subdirectory (mkdtemp)
 * of DALUX_EXPORT_DIR. The parent must not be a symlink, must belong to the
 * user running the server and must not be writable by group or others
 * (POSIX). Only this subdirectory is written to and cleaned; other
 * processes' subdirectories are removed once they are older than the
 * longest link lifetime.
 *
 * Archives in the subdirectory count against DALUX_EXPORT_MAX_STORED_BYTES
 * and DALUX_EXPORT_MAX_STORED_ENTRIES until they are deleted or handed over
 * (moved out by a file delivery or taken by an embedding host). New exports
 * are refused while the limits are reached; live links are never evicted.
 */
export class ExportWorkspace {
  private readonly stored = new Map<string, number>();
  private reservedBytes = 0;
  private reservedCount = 0;
  /** Files whose deletion failed (e.g. EBUSY while still being read); retried later. */
  private readonly pendingDeletes = new Set<string>();

  private constructor(
    readonly root: string,
    readonly dir: string,
    private readonly freeBytes: (dir: string) => Promise<number>,
  ) {}

  static async create(root: string, options: WorkspaceOptions = {}): Promise<ExportWorkspace> {
    const refuses = options.refuses ?? (() => false);
    // Checked before anything is created: the root as given and as resolved.
    if (refuses(root) || refuses(resolve(root))) {
      throw new Error(EXPORT_PATH_REFUSED);
    }
    // The subdirectory name is chosen here, not by mkdtemp, so its full path is checked before it exists.
    const candidates: string[] = [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = join(root, `${SUBDIR_PREFIX}${randomBytes(6).toString('base64url').slice(0, 6)}`);
      if (!refuses(candidate) && !refuses(resolve(candidate))) candidates.push(candidate);
    }
    if (candidates.length === 0) {
      throw new Error(EXPORT_PATH_REFUSED);
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(root);
    await removeStaleSubdirs(root, (options.now ?? Date.now)());
    let dir: string | undefined;
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { mode: 0o700 });
        dir = candidate;
        break;
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      }
    }
    if (dir === undefined) {
      throw new Error('Could not create an export subdirectory.');
    }
    await assertSafeDirectory(dir);
    return new ExportWorkspace(root, dir, options.freeBytes ?? defaultFreeBytes);
  }

  get storedBytes(): number {
    let total = 0;
    for (const size of this.stored.values()) {
      total += size;
    }
    return total;
  }

  get storedCount(): number {
    return this.stored.size;
  }

  /** Reserve room for one archive, or throw ExportCapacityError. */
  async reserve(config: Pick<ExportConfig, 'maxTotalBytes' | 'maxStoredBytes' | 'maxStoredEntries'>): Promise<ExportReservation> {
    await this.retryDeletes();
    if (this.stored.size + this.reservedCount >= config.maxStoredEntries) {
      throw new ExportCapacityError(
        `The server already holds ${config.maxStoredEntries} export archive(s) (DALUX_EXPORT_MAX_STORED_ENTRIES). Try again when earlier download links have expired or been used.`,
      );
    }
    const room = config.maxStoredBytes - this.storedBytes - this.reservedBytes;
    const maxBytes = Math.min(config.maxTotalBytes, room);
    if (maxBytes < 1024 * 1024) {
      throw new ExportCapacityError(
        'The export storage of this server is full (DALUX_EXPORT_MAX_STORED_BYTES). Try again when earlier download links have expired or been used.',
      );
    }
    const free = await this.freeBytes(this.dir);
    if (free < maxBytes + FREE_SPACE_MARGIN_BYTES) {
      throw new ExportCapacityError(
        `Not enough free disk space for an export: ${Math.floor(free / (1024 * 1024))} MB free, ${Math.ceil((maxBytes + FREE_SPACE_MARGIN_BYTES) / (1024 * 1024))} MB needed (archive cap plus margin).`,
      );
    }

    this.reservedBytes += maxBytes;
    this.reservedCount += 1;
    let open = true;
    const end = () => {
      if (open) {
        open = false;
        this.reservedBytes -= maxBytes;
        this.reservedCount -= 1;
      }
    };
    return {
      dir: this.dir,
      maxBytes,
      commit: (path, sizeBytes) => {
        if (open) {
          this.stored.set(path, sizeBytes);
        }
        end();
      },
      release: end,
    };
  }

  /** The archive left this directory (moved or taken over): stop counting it. */
  forget(path: string): void {
    this.stored.delete(path);
  }

  /** Delete an archive; a failed deletion (e.g. EBUSY) is retried later and keeps counting until it succeeds. */
  async remove(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
      this.stored.delete(path);
      this.pendingDeletes.delete(path);
    } catch {
      this.pendingDeletes.add(path);
    }
  }

  /** Retry deletions that failed earlier. */
  async retryDeletes(): Promise<void> {
    for (const path of [...this.pendingDeletes]) {
      await this.remove(path);
    }
  }

  get pendingDeleteCount(): number {
    return this.pendingDeletes.size;
  }

  /** Remove this process's subdirectory (shutdown). */
  async close(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.stored.clear();
    this.pendingDeletes.clear();
  }
}

/** Not a symlink, a directory, owned by this user, not writable by group or others (POSIX only). */
async function assertSafeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('DALUX_EXPORT_DIR must be a real directory, not a symbolic link or a file.');
  }
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    return;
  }
  if (info.uid !== process.getuid()) {
    throw new Error('DALUX_EXPORT_DIR must be owned by the user running the server.');
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error('DALUX_EXPORT_DIR must not be writable by group or others (use chmod 700).');
  }
}

/** Remove other processes' subdirectories older than STALE_SUBDIR_MS. Nothing else is touched. */
async function removeStaleSubdirs(root: string, now: number): Promise<void> {
  for (const name of await readdir(root)) {
    if (!SUBDIR_PATTERN.test(name)) {
      continue;
    }
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink() && now - info.mtimeMs > STALE_SUBDIR_MS) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // Gone or busy: try again next time.
    }
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

/** One workspace per export directory and process. */
const workspaces = new Map<string, Promise<ExportWorkspace>>();

export function exportWorkspace(root: string, options?: WorkspaceOptions): Promise<ExportWorkspace> {
  let workspace = workspaces.get(root);
  if (!workspace) {
    workspace = ExportWorkspace.create(root, options);
    workspaces.set(root, workspace);
    workspace.catch(() => workspaces.delete(root));
  }
  return workspace;
}
