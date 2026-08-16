#!/usr/bin/env node
/**
 * The only thing that crosses between trust domains.
 *
 * The worker used to be one job: the model edited, the gates ran, and the
 * finalizer pushed, all on the same runner. That collapses three different
 * trust levels into one, and GitHub makes the collapse concrete -- a step can
 * write $GITHUB_ENV and those variables apply to LATER steps in the same job.
 * So model-authored test code, executing during the gate step while entirely
 * inside its allowed paths, could rewrite $TRUSTED and point the credentialed
 * finalizer at scripts of its choosing. A one-time pre-gate check cannot
 * prevent that, because the check happens before the code runs.
 *
 * The jobs are now separate runners, and the ONLY artifact that travels between
 * them is a patch. A patch is inert: applying it writes files, it does not
 * execute anything. And because each job re-verifies the patch from its own
 * fresh checkout using this script, a later job never has to trust that an
 * earlier one behaved.
 *
 *   --export --task <id> --agent <id> --out <file>
 *       Verify the working tree is in scope, then emit a patch containing ONLY
 *       the selected task's allowedPaths.
 *
 *   --verify --task <id> --in <file>
 *       Check that a patch touches nothing outside those paths. Run in a fresh
 *       checkout BEFORE applying.
 *
 *   --apply --task <id> --in <file>
 *       Verify, then apply. Never applies unverified.
 *
 * Scope comes from control/tasks.json in the CHECKING job's own checkout, not
 * from anything the producing job asserted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

const TASK_ID = flag("--task");
if (!TASK_ID) {
  console.error("Usage: task-patch.mjs --export|--verify|--apply --task <id> [--agent <id>] [--out|--in <file>]");
  process.exit(1);
}

function git(...a) {
  return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function normalizePrefix(pattern) {
  return pattern.replace(/\\/g, "/").replace(/\*\*.*$/, "").replace(/\*.*$/, "").replace(/\/$/, "");
}
function underPrefix(rel, prefix) {
  return prefix && (rel === prefix || rel.startsWith(prefix + "/"));
}

const tasks = JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
const task = tasks.find((t) => t.id === TASK_ID);
if (!task) {
  console.error(`Unknown task ${TASK_ID} in this checkout's control plane.`);
  process.exit(1);
}

const prefixes = (task.allowedPaths ?? []).map(normalizePrefix).filter(Boolean);
if (!prefixes.length) {
  console.error(`${TASK_ID} declares no allowedPaths; refusing to move a patch with unbounded scope.`);
  process.exit(1);
}

/**
 * Paths a patch touches, according to GIT -- not according to a parser here.
 *
 * THE BUG THIS REPLACES. This function used to read `diff --git a/X b/X`
 * headers and deliberately ignore the `---`/`+++` lines. But git apply does not
 * take the target from the `diff --git` line. A patch can say:
 *
 *   diff --git a/apps/web/src/lib/looks-safe.ts b/apps/web/src/lib/looks-safe.ts
 *   --- a/scripts/cloud/run-gates.mjs
 *   +++ b/scripts/cloud/run-gates.mjs
 *
 * and the checker would report one in-scope path while git modified a different,
 * out-of-scope one. In the publisher -- which applies the "verified" patch and
 * then runs run-gates.mjs and the finalizer, holding a write token -- that is
 * patch data rewriting trusted code immediately before that code executes. The
 * whole fresh-job boundary was bypassable through it.
 *
 * The root error was implementing git's patch semantics by hand. So this no
 * longer does. The patch is applied inside a DISPOSABLE WORKTREE and git is
 * asked what changed; the answer is authoritative by construction, and it also
 * covers renames, copies and deletions without another custom parser. Nothing
 * is ever executed from the disposable worktree -- `git apply` writes files, it
 * does not run them -- and it is destroyed before the real checkout is touched.
 */
function pathsGitWouldChange(patchFile) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-patch-probe-"));
  const worktree = path.join(scratch, "wt");

  const cleanup = () => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
    } catch {
      /* removed below regardless */
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  };

  try {
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", worktree, "HEAD"], {
      cwd: root,
      stdio: "pipe"
    });
  } catch (error) {
    cleanup();
    console.error(`Could not create a disposable worktree to probe the patch: ${error.message}`);
    console.error("Refusing to verify by parsing the patch myself; that is the defect this replaces.");
    process.exit(1);
  }

  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", patchFile], { cwd: worktree, stdio: "pipe" });
  } catch (error) {
    cleanup();
    console.error(
      `Patch does not apply to a clean checkout of HEAD: ${error.stderr?.toString() || error.message}`
    );
    process.exit(1);
  }

  const changed = execFileSync(
    "git",
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    { cwd: worktree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  )
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(Boolean);

  cleanup();
  return changed;
}

function assertInScope(patchFile, label) {
  const touched = pathsGitWouldChange(patchFile);
  if (!touched.length) {
    console.log(`${label}: patch is empty.`);
    return touched;
  }

  const outside = touched.filter((rel) => !prefixes.some((p) => underPrefix(rel, p)));
  if (outside.length) {
    console.error(`${label}: patch touches ${outside.length} path(s) outside ${TASK_ID}'s allowedPaths:`);
    for (const rel of outside) console.error(`  ! ${rel}`);
    console.error(`\nAllowed: ${prefixes.join(", ")}`);
    console.error(
      "Refusing. This is checked again in every job that receives the patch, from that job's own " +
      "control plane, so a producing job cannot widen its own scope by asserting that it did not."
    );
    process.exit(1);
  }

  console.log(`${label}: ${touched.length} path(s), all within ${TASK_ID}'s allowedPaths.`);
  return touched;
}

if (args.includes("--export")) {
  const out = flag("--out");
  if (!out) {
    console.error("--export requires --out <file>");
    process.exit(1);
  }

  /*
   * Only in-scope paths are asked for. `git diff -- <pathspec>` cannot emit
   * anything outside the pathspec, so out-of-scope model edits are excluded
   * here rather than merely reported -- and then assertInScope re-checks the
   * result, because "the command should not have done that" is not a check.
   *
   * `git diff` ignores untracked files entirely, and a new file is the most
   * common thing a task produces, so they are marked --intent-to-add first.
   *
   * That mutates the index, so it is undone afterwards, and only for the exact
   * paths this added. A blanket `git reset` would also unstage anything staged
   * beforehand. Leaving the entries in place is not harmless either: an
   * intent-to-add path is neither untracked nor committed, so a later
   * `git clean` will not remove it and a later `git checkout HEAD --` will not
   * restore it -- it simply persists, invisible to both.
   */
  const untrackedBefore = git("status", "--porcelain", "-z", "--untracked-files=all", "--", ...prefixes)
    .split("\0")
    .filter((entry) => entry.startsWith("??"))
    .map((entry) => entry.slice(3))
    .filter(Boolean);

  if (untrackedBefore.length) git("add", "--intent-to-add", "--", ...untrackedBefore);

  let patch;
  try {
    patch = git("diff", "--binary", "--", ...prefixes);
  } finally {
    // Restore the index even if the diff throws, so a failed export does not
    // leave the checkout in a state the next step cannot reason about.
    if (untrackedBefore.length) {
      try {
        git("reset", "--quiet", "--", ...untrackedBefore);
      } catch {
        // A repository with no commits yet has no HEAD to reset against. The
        // export still succeeded; say so rather than failing the run over it.
        console.error("Could not clear intent-to-add entries; the patch itself is unaffected.");
      }
    }
  }

  fs.writeFileSync(out, patch);
  assertInScope(out, "export");

  console.log(`Wrote ${Buffer.byteLength(patch)} byte(s) to ${out}.`);
  console.log("This patch is the ONLY thing that leaves this job. It is data, not code.");
  process.exit(0);
}

const inFile = flag("--in");
if (!inFile) {
  console.error("--verify and --apply require --in <file>");
  process.exit(1);
}
if (!fs.existsSync(inFile)) {
  console.error(`No patch at ${inFile}. Refusing to continue as though there were no changes.`);
  process.exit(1);
}
if (args.includes("--verify")) {
  assertInScope(inFile, "verify");
  process.exit(0);
}

if (args.includes("--apply")) {
  const touched = assertInScope(inFile, "apply");
  if (!touched.length) {
    console.log("Nothing to apply.");
    process.exit(0);
  }

  try {
    // --check first: a partially applied patch is a state nobody reasoned about.
    execFileSync("git", ["apply", "--check", "--whitespace=nowarn", inFile], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["apply", "--whitespace=nowarn", inFile], { cwd: root, stdio: "pipe" });
  } catch (error) {
    console.error(`Patch does not apply cleanly to this checkout: ${error.stderr?.toString() || error.message}`);
    console.error("Refusing to continue; nothing has been modified.");
    process.exit(1);
  }

  console.log(`Applied ${touched.length} in-scope path(s).`);
  process.exit(0);
}

console.error("Specify one of --export, --verify, --apply");
process.exit(1);
