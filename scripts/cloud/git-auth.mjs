/**
 * Command-scoped GitHub authentication for the deterministic push steps.
 *
 * The workflow used to do this before every privileged step:
 *
 *   git config --local url."https://x-access-token:${GH_TOKEN}@github.com/"
 *     .insteadOf "https://github.com/"
 *
 * That writes a reusable repository write credential into `.git/config` inside
 * the workspace -- and the model runs later in that same workspace, with Read.
 * The workflow simultaneously claimed "no push credential is exposed to the
 * model", which was false from the first publish step onward. `checkout` with
 * `persist-credentials: false` was doing its job; these lines undid it.
 *
 * Two properties are required instead:
 *
 *   1. The credential exists only for the duration of one git invocation.
 *      `-c` applies configuration to a single command and writes nothing to
 *      disk. The helper below reads GH_TOKEN from the environment when git asks
 *      for it, so the token never appears in argv either -- process arguments
 *      are world-readable via /proc on the runner, and they end up in any
 *      command trace or error message that echoes the failing invocation.
 *
 *   2. After a privileged step there is zero reusable credential material left
 *      in the workspace. `assertNoPersistedCredential` is the check, and it runs
 *      BEFORE the push as well: if something already wrote a credential into the
 *      config, that is the condition we are trying to prevent and pushing anyway
 *      would leave it there.
 *
 * The leading empty `credential.helper=` is load-bearing. Git ACCUMULATES
 * helpers rather than replacing them, so without clearing first, an inherited
 * helper (a runner-level config, a manager left behind by another action) could
 * answer before ours and authenticate as something we did not choose.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Config keys that mean "a credential may be recoverable from this repository".
 * `insteadOf` is included because that is precisely how the old rewrite smuggled
 * a token in without any key literally named like a credential.
 */
const CREDENTIAL_MARKERS = [
  "x-access-token",
  "insteadof",
  "extraheader",
  "credential.helper",
  "[credential"
];

const HELPER =
  '!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f';

/**
 * Git arguments that authenticate exactly one command.
 * Usage: execFileSync("git", [...authArgs(), "push", "origin", "HEAD:main"])
 */
export function authArgs() {
  if (!process.env.GH_TOKEN) {
    throw new Error(
      "GH_TOKEN is not set. Refusing to attempt an authenticated git operation without it, " +
      "rather than falling back to whatever ambient credential the runner may hold."
    );
  }
  return ["-c", "credential.helper=", "-c", `credential.helper=${HELPER}`];
}

/**
 * Fails closed if the repository holds recoverable credential material.
 *
 * Reads the raw config file rather than `git config --list`, because the point
 * is what is PERSISTED on disk for the model to read -- not what git resolves
 * for this process after `-c` overrides and includes.
 */
export function assertNoPersistedCredential(root = process.cwd(), when = "before pushing") {
  /*
   * Ask git where the config lives rather than assuming `<root>/.git/config`.
   *
   * In a linked worktree `.git` is a FILE pointing elsewhere, so the assumed
   * path does not exist -- and a check that returns clean because it could not
   * find the file is indistinguishable from one that found nothing wrong. That
   * is the same "unverifiable falls through to permissive" shape that has
   * produced three defects in this system already, so it resolves properly or
   * it does not claim anything.
   */
  let gitDir;
  try {
    /*
     * --git-common-dir, not --absolute-git-dir.
     *
     * In a linked worktree those differ: --absolute-git-dir points at the
     * worktree-specific directory, while the repository config that actually
     * carries credentials lives in the SHARED common directory. Checking the
     * worktree directory would look at a location where `config` normally does
     * not exist -- so the check would have failed closed rather than passed
     * silently, which is safe, but it would have been failing for the wrong
     * reason while claiming linked-worktree support it did not have.
     */
    gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    // Not a repository at all: there is no persisted git credential because
    // there is no git config. This is a real answer, not an unverifiable one.
    return;
  }

  const configPath = path.join(gitDir, "config");
  if (!fs.existsSync(configPath)) {
    console.error(
      `Refusing to continue ${when}: git reports its directory as ${gitDir} but there is no ` +
      "config file there. The workspace cannot be certified credential-free, and an " +
      "uncertifiable workspace is treated as a failed check, not a passed one."
    );
    process.exit(1);
  }

  const config = fs.readFileSync(configPath, "utf8");
  const found = CREDENTIAL_MARKERS.filter((marker) => config.toLowerCase().includes(marker));
  if (!found.length) return;

  console.error(
    `Refusing to continue ${when}: .git/config contains credential material (${found.join(", ")}).\n` +
    "The workspace is readable by the model step, so a persisted token is a durable escalation " +
    "path. Authenticate per-command via authArgs() instead of writing credentials into config."
  );
  process.exit(1);
}

/**
 * Fetches `main` from the authenticated remote WITHOUT creating a local
 * remote-tracking ref, leaving the result in FETCH_HEAD.
 *
 * Callers compare against FETCH_HEAD rather than `origin/main` deliberately:
 * `origin/main` is whatever the last fetch happened to leave behind and the
 * model can rewrite refs in the workspace, so it is not a trustworthy statement
 * about the remote at push time.
 */
export function fetchMain(root = process.cwd()) {
  // Checked BEFORE the credential is supplied, not after. This was the first
  // authenticated network call in every run and it used to be the unchecked one.
  assertNoPersistedCredential(root, "before fetching");
  assertRemoteIsExpected(root);
  execFileSync("git", [...authArgs(), "fetch", trustedRemoteUrl(), "main"], {
    cwd: root,
    stdio: "inherit"
  });
}

/** True when the remote main just fetched is already an ancestor of HEAD. */
export function remoteIsAncestorOfHead(root = process.cwd()) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], {
      cwd: root,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The remote a credential may be sent to.
 *
 * Protecting how the token is STORED says nothing about who RECEIVES it.
 * `origin` is read from workspace Git configuration, which deterministic steps
 * do restore -- but the correct property is not "the config was restored", it
 * is "this token only ever goes to the repository this workflow belongs to".
 * GITHUB_REPOSITORY comes from the workflow context, not from the workspace, so
 * it is the authority here.
 *
 * Both github.com forms are accepted because actions/checkout may configure
 * either; anything else, including a host that merely contains "github.com"
 * as a substring, is refused.
 */
/**
 * The URL every authenticated operation uses, built from workflow context.
 *
 * `origin` is NOT used. Validating it and then using it was still wrong in a
 * subtle way: `fetchMain` authenticated first and `pushHeadToMain` validated
 * second, so the first credentialed network call in every run went to whatever
 * workspace Git configuration said -- exactly the property the validation was
 * supposed to establish. Ordering fixes are fragile; removing the mutable input
 * is not. GITHUB_REPOSITORY comes from the runner's workflow context, which
 * nothing in the checkout can rewrite, so a poisoned `origin` has nowhere to
 * send a credential.
 */
export function trustedRemoteUrl() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      "GITHUB_REPOSITORY is unset. Refusing to construct an authenticated remote from workspace " +
      "configuration; outside a workflow there is no trusted source for the destination."
    );
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error(`GITHUB_REPOSITORY is not a plain owner/repo value: ${repository}`);
  }
  return `https://github.com/${repository}.git`;
}

/**
 * Retained as a secondary check on the workspace's own remote.
 *
 * Not load-bearing any more -- the credential goes to trustedRemoteUrl()
 * regardless -- but a rewritten `origin` is still a signal that something
 * tampered with the checkout, and noticing it is worth more than ignoring it.
 */
export function assertRemoteIsExpected(root = process.cwd()) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    // Local invocation, no workflow context to check against. Say so rather
    // than pretending the destination was verified.
    console.log("GITHUB_REPOSITORY is unset; skipping remote verification (not a workflow run).");
    return;
  }

  let url;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    console.error("origin has no URL. Refusing to authenticate against an unknown destination.");
    process.exit(1);
  }

  const expected = [
    `https://github.com/${repository}`,
    `https://github.com/${repository}.git`,
    `git@github.com:${repository}`,
    `git@github.com:${repository}.git`
  ];

  if (!expected.includes(url)) {
    console.error(
      `origin is ${url}, which is not this workflow's repository (${repository}).\n` +
      "Refusing to supply a credential to it. The token's destination is read from workspace Git " +
      "configuration, so verifying it against the workflow context is what keeps a rewritten " +
      "remote from receiving a valid repository write token."
    );
    process.exit(1);
  }
}

/** Fast-forward push of HEAD onto main. Never force, never rebase. */
export function pushHeadToMain(root = process.cwd()) {
  assertNoPersistedCredential(root, "before pushing");
  assertRemoteIsExpected(root);
  execFileSync("git", [...authArgs(), "push", trustedRemoteUrl(), "HEAD:main"], {
    cwd: root,
    stdio: "inherit"
  });
  // A push can leave a helper-populated credential cache behind if something
  // configured one; re-check rather than assume the invocation was clean.
  assertNoPersistedCredential(root, "after pushing");
}
