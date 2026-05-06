import { watch } from "chokidar";
import { statSync, readdirSync, openSync, readSync, closeSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const ACTIVE_THRESHOLD_MS = 600_000; // 10 minutes — Claude can think for 5+ min without writing
const POLL_INTERVAL_MS = 1000;

export interface WatchedFile {
  path: string;
  sessionId: string;
  projectName: string;
  offset: number;
  lineBuffer: string;
}

export class JsonlWatcher extends EventEmitter {
  private files = new Map<string, WatchedFile>();
  private watcher: ReturnType<typeof watch> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.scanForActiveFiles();

    this.watcher = watch(CLAUDE_PROJECTS_DIR, {
      ignoreInitial: true,
      depth: 3,
    });

    this.watcher.on("add", (filePath: string) => {
      if (filePath.endsWith(".jsonl")) {
        this.addFile(filePath);
      }
    });

    this.pollInterval = setInterval(() => this.pollFiles(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.watcher?.close();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  private scanForActiveFiles(): void {
    try {
      const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = join(CLAUDE_PROJECTS_DIR, dir.name);
        try {
          const files = readdirSync(dirPath);
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            const filePath = join(dirPath, f);
            const stat = statSync(filePath);
            if (Date.now() - stat.mtimeMs < ACTIVE_THRESHOLD_MS) {
              this.addFile(filePath);
            }
          }
        } catch {
          /* skip unreadable dirs */
        }
      }
    } catch {
      /* projects dir may not exist */
    }
  }

  private addFile(filePath: string): void {
    if (this.files.has(filePath)) return;

    const sessionId = basename(filePath, ".jsonl");
    // Try to discover the real project name by reading the cwd field from the
    // first few records. Fall back to a smart parse of the encoded folder name.
    const projectName = extractProjectName(filePath) ?? fallbackProjectName(filePath, sessionId);

    const file: WatchedFile = {
      path: filePath,
      sessionId,
      projectName,
      offset: 0,
      lineBuffer: "",
    };

    this.files.set(filePath, file);
    this.emit("fileAdded", file);

    // Read existing content to catch up
    this.readNewLines(file);
  }

  private pollFiles(): void {
    for (const [path, file] of this.files) {
      try {
        const stat = statSync(path);
        if (stat.size > file.offset) {
          this.readNewLines(file);
        }
        // Remove stale files
        if (Date.now() - stat.mtimeMs > ACTIVE_THRESHOLD_MS) {
          this.files.delete(path);
          this.emit("fileRemoved", file);
        }
      } catch {
        this.files.delete(path);
        this.emit("fileRemoved", file);
      }
    }
    // Chokidar's `add` event is unreliable for new jsonl files appearing
    // under existing subdirs of ~/.claude/projects on macOS. Rescan as a fallback.
    this.scanForActiveFiles();
  }

  private readNewLines(file: WatchedFile): void {
    try {
      const stat = statSync(file.path);
      if (stat.size <= file.offset) return;

      const buf = Buffer.alloc(stat.size - file.offset);
      const fd = openSync(file.path, "r");
      readSync(fd, buf, 0, buf.length, file.offset);
      closeSync(fd);

      file.offset = stat.size;
      const text = file.lineBuffer + buf.toString("utf-8");
      const lines = text.split("\n");

      // Last element is incomplete line (buffer it)
      file.lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.emit("line", file, line);
        }
      }
    } catch {
      /* file may have been deleted */
    }
  }

  getActiveFiles(): WatchedFile[] {
    return Array.from(this.files.values());
  }
}

const PROJECT_NAME_SCAN_BYTES = 512_000;

/** Read the head of a jsonl file and return the most common non-trivial cwd basename.
 *  Sessions are often launched from a home dir but most records carry the project dir cwd. */
function extractProjectName(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    const len = Math.min(stat.size, PROJECT_NAME_SCAN_BYTES);
    if (len === 0) return null;
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    closeSync(fd);
    const text = buf.toString("utf-8");
    const counts = new Map<string, number>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const cwd = typeof rec.cwd === "string" ? rec.cwd : null;
      if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    // Prefer the most common cwd that isn't a "shallow" dir like /Users/<name> or /home/<name>.
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cwd] of sorted) {
      if (!isShallowDir(cwd)) {
        const name = basename(cwd);
        if (name) return name;
      }
    }
    // All cwds were shallow — use the most common as-is.
    const name = basename(sorted[0][0]);
    return name || null;
  } catch {
    /* unreadable */
  }
  return null;
}

/** /Users/foo or /home/foo or / itself — too generic to be a project. */
function isShallowDir(p: string): boolean {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return true;
  return false;
}

/** Fallback project name from the encoded folder. Uses the deepest non-trivial segment. */
function fallbackProjectName(filePath: string, sessionId: string): string {
  const projectDirName = basename(dirname(filePath));
  // "-Users-alice-Code-myproject" -> ["Users","alice","Code","myproject"]
  const parts = projectDirName.split("-").filter(Boolean);
  // Skip generic noise from the front. Keep the last meaningful segment.
  const skip = new Set(["Users", "Documents", "Code", "src", "home"]);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!skip.has(parts[i])) return parts[i];
  }
  return parts[parts.length - 1] || sessionId.slice(0, 8);
}
