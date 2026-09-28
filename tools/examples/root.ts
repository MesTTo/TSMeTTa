/**
 * Purpose: present the examples corpus to the lane's runner as a root of its
 *   own, whose examples/ is the workspace's MeTTa corpus: the one the Python
 *   and C seats' lanes hold their twins to, where the corpus pins a copy of it
 *   at examples/ for a reader who has the corpus alone.
 * Assumes: the corpus root holds the corpus's programs, dist/ and
 *   residue.json; the MeTTa corpus is a git working tree and git is on PATH.
 * Guarantees:
 *   - the root holds a link to every entry of the corpus root except examples
 *     and .git, so a path a program names relative to the corpus root, a
 *     chapter's fixture or ai-tmp/, reaches the corpus's own file, and a
 *     module imported through dist/ resolves as it does in the corpus
 *   - examples/ is a copy of the MeTTa corpus's working tree less what its
 *     repository ignores: each tracked file as it stands and each untracked
 *     one git would not ignore. An object the superproject's gate builds
 *     beside a chapter 19 original, which the corpus's own .gitignore names
 *     and no WebAssembly engine can open, never reaches the run, and what an
 *     original writes lands in the copy rather than in a checkout
 *   - the digest names every copied path, mode and byte, so a refusal verdict
 *     keyed on it is asked again when an original or a fixture changes,
 *     committed or not
 *   - a MeTTa corpus holding a symbolic link or a submodule is refused,
 *     naming the path, since neither is a file this copy could stand for
 *   [tested 2026-09-28T19:11:58+10:00: tools/examples/lane.test.ts, "presents the corpus
 *   with examples/ the given MeTTa corpus, less what its repository ignores"]
 * Fails when: a program compares a path it names through one of the root's
 *   links with what path-resolve answers for it, which follows every link on
 *   the way, so one file has two names. 19-file_lib.ts's original does this
 *   under its temp-dir!, and failed while TMP named ai-tmp/ through the link
 *   [measured 2026-09-28T16:35:58+10:00: tools/examples.mjs, 76 claims of 90
 *   owed], so run.ts names that directory by its real path.
 * Owns resources: nothing; the caller owns the root it names and removes it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { workspace } from "./full_width.ts";

/** The corpus-root entries the root does not link: the MeTTa corpus it replaces, and git's metadata. */
const REPLACED = new Set(["examples", ".git"]);

/** The workspace's MeTTa corpus, the examples/ the Python and C seats' lanes read. */
export function mettaCorpus(): string {
  return join(workspace(), "examples");
}

/** The paths git lists for a working tree, from NUL-separated output. */
function listed(tree: string, ...args: string[]): string[] {
  return execFileSync("git", ["-C", tree, "ls-files", "-z", ...args], { encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
}

/**
 * Every file of a MeTTa corpus's working tree that its repository does not
 * ignore, sorted: the tracked files still present and the untracked ones not
 * ignored. Refuses a tracked link or submodule and an untracked link.
 */
export function corpusFiles(tree: string): string[] {
  const refuse = (path: string, what: string): never => {
    throw new Error(
      `${join(tree, path)} is a ${what} in the MeTTa corpus, which the lane copies only files of`,
    );
  };
  // `--stage` lines read `<mode> <object> <stage>\t<path>`.
  for (const entry of listed(tree, "--stage")) {
    const path = entry.slice(entry.indexOf("\t") + 1);
    if (entry.startsWith("120000 ")) refuse(path, "symbolic link");
    if (entry.startsWith("160000 ")) refuse(path, "submodule");
  }
  return [...new Set(listed(tree, "--cached", "--others", "--exclude-standard"))]
    .flatMap((path) => {
      const found = lstatSync(join(tree, path), { throwIfNoEntry: false });
      // A tracked file deleted from the working tree is not in the tree as it stands.
      if (found === undefined) return [];
      if (found.isSymbolicLink()) refuse(path, "symbolic link");
      return [path];
    })
    .toSorted();
}

/**
 * Present CORPUS at ROOT with examples/ a copy of the MeTTa corpus ORIGINALS,
 * and answer the copy's digest. ROOT is created and must not hold anything.
 *
 * Time: one copy and one read of each of the n files the MeTTa corpus holds,
 * n = 429 at 59e14d1, plus one link per corpus-root entry.
 */
export function presentRoot(corpus: string, originals: string, root: string): string {
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0) throw new Error(`${root} already holds something`);
  for (const entry of readdirSync(corpus)) {
    if (!REPLACED.has(entry)) symlinkSync(resolve(corpus, entry), join(root, entry));
  }
  const digest = createHash("sha256");
  for (const path of corpusFiles(originals)) {
    const from = join(originals, path);
    const to = join(root, "examples", path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    const mode = lstatSync(from).mode & 0o777;
    digest.update(`${path}\0${mode.toString(8)}\0`);
    digest.update(readFileSync(from));
    digest.update("\0");
  }
  return `sha256-${digest.digest("base64")}`;
}
