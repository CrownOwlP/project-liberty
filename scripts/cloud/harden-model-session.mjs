#!/usr/bin/env node
/**
 * Removes every executable project configuration before the model session.
 *
 * THE ESCAPE THIS CLOSES.
 *
 * Removing Bash from the model's tool set was believed to end command
 * execution in the worker job. It did not. This repository ships:
 *
 *   .claude/settings.json
 *     "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{
 *        "type": "command",
 *        "command": "node \"${CLAUDE_PROJECT_DIR}/scripts/validate-repo.mjs\" ..." }]}]
 *
 * Hooks are shell commands fired automatically around tool use. They are not
 * governed by the Bash tool permission system, so an allowlist of zero commands
 * does not disable them. And the command they run points INTO the workspace:
 *
 *   model writes scripts/validate-repo.mjs
 *     -> the Write itself fires PostToolUse
 *       -> shell runs node scripts/validate-repo.mjs
 *         -> the file the model just wrote executes
 *
 * One Write is sufficient. The model does not even need to edit the hook
 * definition, though it could do that too -- settings are re-read by a file
 * watcher while the session is running.
 *
 * WHY THIS IS A FILESYSTEM STEP AND NOT A CLI FLAG.
 *
 * There are flags that ought to cover this (`--setting-sources`,
 * `--strict-mcp-config`, `disableAllHooks`). Some of them are the right thing
 * to add. But their exact spelling and semantics depend on the installed
 * Claude Code / action version, this worker has never executed once, and a flag
 * that is silently ignored -- or that errors on an unknown argument -- fails in
 * a direction nobody notices. The same reasoning produced the trusted runtime:
 * if the file is not there, it cannot execute, regardless of what any
 * configuration layer decides to honour.
 *
 * So the configuration is physically removed and its absence is asserted.
 * Version-specific flags belong on top of this as defence in depth, added once
 * they can be verified against a real run rather than guessed.
 *
 *   node scripts/cloud/harden-model-session.mjs --strip
 *   node scripts/cloud/harden-model-session.mjs --assert
 *
 * Restoration is not this script's job: `.claude` and `.mcp.json` are listed in
 * TRUSTED_RUNTIME_PATHS, so `protect-state.mjs --restore` puts them back from
 * HEAD after the model step, from the trusted copy.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);

/**
 * Anything here can cause code to run, or can cause other code to be trusted,
 * without the model invoking a tool that looks like execution.
 *
 * `.claude/` is removed WHOLESALE rather than surgically. It holds hooks,
 * subagent definitions, permission settings and plugin configuration, and a
 * list of "the dangerous parts of .claude" is precisely the kind of enumeration
 * that goes stale the next time the directory grows a feature. The model is
 * given its instructions through the workflow prompt and the generated
 * briefing; it needs nothing from this directory.
 */
export const EXECUTABLE_PROJECT_CONFIG = [
  ".claude",
  ".mcp.json",
  ".claude-plugin"
];

/*
 * Every path stripped here MUST also be in TRUSTED_RUNTIME_PATHS, or the
 * "strip -> trusted copy -> restore from HEAD" invariant is false for it and
 * the strip becomes a permanent deletion. Asserted at module load rather than
 * documented, because the two lists previously disagreed about `.claude-plugin`
 * and nothing noticed.
 */
import { TRUSTED_RUNTIME_PATHS } from "./trusted-runtime.mjs";
const unrestorable = EXECUTABLE_PROJECT_CONFIG.filter((p) => !TRUSTED_RUNTIME_PATHS.includes(p));
if (unrestorable.length) {
  console.error(
    `${unrestorable.join(", ")} would be stripped but never restored: absent from ` +
    "TRUSTED_RUNTIME_PATHS in trusted-runtime.mjs."
  );
  process.exit(1);
}

function present() {
  return EXECUTABLE_PROJECT_CONFIG.filter((rel) => fs.existsSync(path.join(root, rel)));
}

if (args.includes("--strip")) {
  const removed = [];
  for (const rel of present()) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
    removed.push(rel);
  }

  // Assert rather than assume. rmSync can no-op against a permission error on
  // some platforms, and "I tried to delete it" is not the property we need.
  const remaining = present();
  if (remaining.length) {
    console.error(
      `Failed to remove executable project configuration: ${remaining.join(", ")}. ` +
      "Refusing to continue: the model session would run with hooks able to execute " +
      "workspace code on every Write."
    );
    process.exit(1);
  }

  console.log(
    removed.length
      ? `Stripped executable project configuration for the model session: ${removed.join(", ")}.`
      : "No executable project configuration present; nothing to strip."
  );
  console.log("These are restored from HEAD by protect-state.mjs --restore after the model step.");
  process.exit(0);
}

/**
 * Managed settings files, which load REGARDLESS of --setting-sources.
 *
 * Anthropic documents managed policy as the highest-precedence level, above
 * command line arguments, and documents (for the SDK's equivalent option) that
 * it loads from the host irrespective of the setting-sources selection. So if
 * one is present on the runner it can reintroduce hooks after every other
 * control has been applied.
 *
 * We do not expect one on a GitHub-hosted runner. That is exactly why its
 * appearance should stop the job: the claim being made downstream is "no
 * hook-driven execution", and silently assuming there is no managed source is
 * the same shape of assumption that produced the hook escape in the first
 * place. MDM plists and registry policies are not checkable from here; that
 * limitation is stated rather than papered over.
 */
const MANAGED_SETTINGS_PATHS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
  "C:\\ProgramData\\ClaudeCode\\managed-settings.json"
];

if (args.includes("--preflight")) {
  const found = MANAGED_SETTINGS_PATHS.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (found.length) {
    console.error(
      `Managed Claude settings present on this runner: ${found.join(", ")}.\n` +
      "Managed policy outranks command line arguments and is not excluded by --setting-sources, " +
      "so it could reintroduce hooks. Halting rather than asserting a boundary we cannot see into."
    );
    process.exit(1);
  }

  /*
   * A fresh, empty user configuration directory.
   *
   * CLAUDE_CONFIG_DIR relocates the user-level configuration (settings, session
   * history, plugins). Pointing it at an empty directory makes the `user`
   * source empty, which is what lets `--setting-sources user` be a meaningful
   * selection rather than "load whatever the runner image happens to have".
   */
  const configDir = path.join(
    process.env.RUNNER_TEMP || process.env.TMPDIR || "/tmp",
    "liberty-claude-config"
  );
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });

  if (fs.readdirSync(configDir).length) {
    console.error(`${configDir} is not empty after creation; refusing to continue.`);
    process.exit(1);
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `config_dir=${configDir}\n`);
  }

  console.log(`No managed Claude settings on this runner.`);
  console.log(`Isolated, empty CLAUDE_CONFIG_DIR prepared at ${configDir}.`);
  process.exit(0);
}

if (args.includes("--assert")) {
  const remaining = present();
  if (remaining.length) {
    console.error(
      `Executable project configuration is still present: ${remaining.join(", ")}.\n` +
      "A PostToolUse hook is a shell command fired by Write/Edit, outside the Bash tool " +
      "permission system, and it targets paths inside the writable workspace. Starting the " +
      "model session in this state would hand it command execution."
    );
    process.exit(1);
  }
  console.log("No executable project configuration in the workspace; safe to start the model.");
  process.exit(0);
}

console.error("Usage: harden-model-session.mjs --preflight | --strip | --assert");
process.exit(1);
