#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Run a command with `LIBERTY_BUILD_TARGET=desktop` (PW-0104).
 *
 * WHAT THIS REPLACES, AND THE DEFECT THAT MADE IT WORTH REPLACING.
 *
 * `apps/web/package.json` used to carry the same five-line `node -e` program
 * three times, once per `*:desktop` script, and that program did two things:
 * set the variable, and SNAPSHOT-AND-RESTORE `apps/web/next-env.d.ts` around
 * the child. The restore ran after `spawnSync` returned -- that is, only on a
 * normal exit.
 *
 * Next regenerates `next-env.d.ts` on every `build` and `dev`, and the content
 * names the active `distDir`: `import "./.next/types/routes.d.ts"` for the web
 * target, `import "./dist/desktop/dev/types/routes.d.ts"` for a desktop dev
 * server. The file was TRACKED. Playwright signal-kills `next dev` when its
 * harness finishes, so in round 81 the rewrite survived, was picked up by a
 * routine `git add -A`, and was committed. It typechecked locally only because
 * `dist/desktop/dev` happened to exist in that working tree; on a fresh clone
 * it would not have.
 *
 * ==========================================================================
 * THE FIX IS THAT THERE IS NOTHING TO RESTORE
 * ==========================================================================
 *
 * gpt-architect's acceptance is explicit that a second cleanup hook is not an
 * answer: "A second `process.on('exit')` handler is the same mechanism that
 * already failed and would fail the same way under SIGKILL; the implementer
 * must choose a design that is correct when no cleanup runs at all."
 *
 * So the restore is GONE rather than made more careful. `next-env.d.ts` is now
 * untracked and ignored -- which is what `create-next-app` has shipped in its
 * own `.gitignore` for years, and what the file's own generated footer implies
 * by telling you not to edit it. A file git does not track cannot be left
 * dirty by anything, under any termination, because there is no "clean" state
 * for it to differ from. The property holds with the process killed at any
 * instant, including between the write and a hook that will never run.
 *
 * WHAT A FRESH CLONE LOSES: nothing that was measured. `tsc --noEmit -p
 * apps/web/tsconfig.json` exits 0 with both `next-env.d.ts` and `.next/`
 * absent. `tsconfig.json` lists the file under `include`, and an `include`
 * entry that matches nothing is not an error (only `files` is). The first
 * `next dev` or `next build` writes it back.
 *
 * WHAT THIS PROGRAM STILL DOES, and why it is a file rather than three copies
 * of a one-liner:
 *
 *   - It sets the variable in the CHILD'S ENVIRONMENT rather than with a
 *     `VAR=value command` prefix, because that prefix is shell syntax that
 *     Windows `cmd.exe` -- npm's default script shell there -- does not
 *     understand. This repository takes Windows seriously enough that
 *     `scripts/with-root-env.mjs` exists for a closely related reason.
 *   - Being a file, it can be TESTED. `scripts/test-desktop-target.mjs` starts
 *     a real desktop dev server through it, kills it four ways including
 *     SIGKILL of the whole process group, and asserts the working tree is
 *     clean afterwards -- and asserts, as its own non-vacuity check, that the
 *     rewrite DID happen and simply stopped mattering.
 *
 * It deliberately does NOT check whether `next-env.d.ts` is tracked. That
 * assertion belongs in the test, which runs once in CI, not on the front of
 * every developer's dev server.
 * ---------------------------------------------------------------------- */
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error(
    "desktop-target: usage: node scripts/desktop-target.mjs <command> [args...]\n" +
      "  Runs <command> with LIBERTY_BUILD_TARGET=desktop."
  );
  process.exit(2);
}

const [command, ...args] = argv;

const result = spawnSync(command, args, {
  stdio: "inherit",
  /* `shell` ONLY on Windows, and only because npm installs `.cmd` shims there
   * that `CreateProcess` cannot execute directly. On POSIX a shell would add a
   * layer that swallows signals, which is the opposite of what this file is
   * for. */
  shell: process.platform === "win32",
  env: { ...process.env, LIBERTY_BUILD_TARGET: "desktop" }
});

if (result.error) {
  console.error(`desktop-target: could not run ${command}: ${result.error.message}`);
  process.exit(1);
}

/*
 * A CHILD KILLED BY A SIGNAL HAS A NULL STATUS. Reporting 1 is the
 * conventional shell answer and it keeps a signalled dev server from looking
 * like a clean exit to npm, turbo or a CI step.
 */
process.exit(result.status ?? 1);
