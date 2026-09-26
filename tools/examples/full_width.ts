/**
 * Purpose: decide this runner's width by the workspace's rule and hold the
 *   machine by it, as tests/checks/full_width.py does for a Python runner.
 *   W is the processes the runner runs at once, the smaller of its workers and
 *   its items; tools/full_width.sh decides W at least one lane's share, or a
 *   measurement, full-width, and a full-width run claims the machine until
 *   this process exits.
 *
 *   The claim is the shell library's: this module opens the lock file and
 *   hands the descriptor to `sh tools/full_width.sh adopt` as its standard
 *   input, and adopt takes the lock on that open file description with the
 *   record naming this process. A descriptor Node opens is closed on exec, so
 *   nothing this process starts later inherits the lock.
 * Assumes: the workspace, the nearest ancestor of this file holding engine/
 *   and lib/, which is where the corpus is mounted and the lane compiled.
 * Guarantees:
 *   - invocation(W) answers "light" holding nothing below the share, "held"
 *     holding the lock from it up, "nested" inside a run that holds it, and a
 *     refused one exits this process 125 after the library has named the
 *     holder on stderr.
 * Owns resources: one descriptor on the lock file while "held", kept until the
 *   process exits.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The workspace, derived as the Python seat's _workspace.py derives it. */
function workspace(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!(existsSync(join(directory, "engine")) && existsSync(join(directory, "lib")))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `no workspace, a directory holding engine/ and lib/, above ${import.meta.url}`,
      );
    }
    directory = parent;
  }
  return directory;
}

/** The descriptor this process holds the machine on, once it does. */
let held: number | undefined;

export function invocation(width: number | "measures"): "light" | "held" | "nested" {
  if (held !== undefined) return "held";
  const library = join(workspace(), "tools", "full_width.sh");
  const located = spawnSync("sh", [library, "path"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (located.status !== 0) process.exit(located.status ?? 2);
  const lock = located.stdout.trim();
  mkdirSync(dirname(lock), { recursive: true });
  const descriptor = openSync(lock, constants.O_RDWR | constants.O_CREAT, 0o644);
  const decided = spawnSync("sh", [library, "adopt", "0", String(width)], {
    encoding: "utf8",
    stdio: [descriptor, "pipe", "inherit"],
  });
  if (decided.status !== 0) {
    closeSync(descriptor);
    process.exit(decided.status ?? 2);
  }
  const outcome = decided.stdout.trim();
  if (outcome === "held") {
    held = descriptor;
    return outcome;
  }
  closeSync(descriptor);
  if (outcome === "light" || outcome === "nested") return outcome;
  throw new Error(`tools/full_width.sh adopt answered ${outcome}`);
}
