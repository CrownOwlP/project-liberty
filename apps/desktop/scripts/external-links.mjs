/* -------------------------------------------------------------------------
 * The links a build leaves behind, and which of them may be packaged
 * (PL-0758).
 *
 * WHY THIS IS ITS OWN MODULE. `package-sidecar.mjs` is a top-level program --
 * it runs on import and cannot be exercised from a test. The policy below is
 * the part of it that was WRONG on Windows while being right on Linux, which
 * is exactly the kind of rule that has to be testable against real symlinks on
 * both platforms rather than reasoned about. `external-links.test.mjs` builds
 * every shape this file names, including the Windows one, and packaging runs
 * that test.
 *
 * THE BACKGROUND, BECAUSE THE RULE ONLY MAKES SENSE WITH IT. Next 16 builds
 * this product's desktop target with Turbopack, which externalises some server
 * packages and emits a BARE import of a hashed alias for each -- the shipped
 * chunks contain `await import("pg-587764f78a6c7a9c")`. Next makes that
 * specifier resolvable by creating `<distDir>/node_modules/<alias>` as a LINK
 * to the package it traced. PL-0755 is what happens when such a link is
 * shipped: `fs.cpSync` rewrites it to an absolute path on the build machine,
 * the installer carries a pointer at a GitHub runner, and the installed
 * application answers 500. The links must become real files.
 *
 * AND THE TWO PLATFORMS DISAGREE ABOUT WHERE THE LINK POINTS, which is the
 * defect this module exists to correct. On Linux the alias is a RELATIVE link
 * that lands inside the standalone tree:
 *
 *     standalone/apps/web/dist/desktop/node_modules/pg-587764f78a6c7a9c
 *       -> ../../../../../node_modules/pg        (= standalone/node_modules/pg)
 *
 * On Windows it resolves to the workspace's own hoisted copy instead -- from
 * the failing run, verbatim:
 *
 *     D:\a\project-liberty\project-liberty\apps\web\dist\desktop\standalone\
 *       apps\web\dist\desktop\node_modules\pg-587764f78a6c7a9c
 *       -> D:\a\project-liberty\project-liberty\node_modules\pg
 *
 * A directory junction -- which is what a process without the symlink
 * privilege creates on Windows, and what `fs.symlink(..., "junction")` makes --
 * stores an ABSOLUTE target, so there is nothing relative left to keep it
 * inside the tree. PL-0755's rule was "the target must be inside the
 * standalone tree", which encodes a Linux accident as a safety property. It
 * refused npm's hoisting.
 *
 * SO THE RULE IS REPLACED RATHER THAN RELAXED, and it is three checks where
 * there was one:
 *
 *   1. the target must be inside the REPOSITORY, which is the boundary that
 *      actually matters -- a link out of the checkout is the arbitrary
 *      traversal worth refusing, and it is refused whether it points at a
 *      global package store, a user's home or a system directory;
 *   2. the target must be INSIDE a `node_modules` tree, so a link from the
 *      module graph cannot be aimed at source, at `.git`, or at anything else
 *      inside the repository that is not a dependency (a link that points
 *      elsewhere in the BUILD OUTPUT is still allowed, and there are none);
 *   3. and it must point at a DIRECTORY CONTAINING `package.json`, because a
 *      traced external is a package and nothing else has any business being
 *      resolved by a bare specifier.
 *
 * Checks 2 and 3 did not exist before. The one thing that was permissive --
 * the containment boundary -- is now the repository rather than one directory
 * inside it, and `package-sidecar.mjs` separately refuses to ship a tree
 * containing ANY link at all, which is stricter than what it refused before.
 * ---------------------------------------------------------------------- */
import { cpSync, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** The directory name that marks a dependency tree, on every platform. */
const NODE_MODULES = "node_modules";

/**
 * Where a materialised copy is assembled before it replaces its link.
 *
 * Visible on purpose: if packaging dies between the copy and the rename, the
 * leftover is named rather than anonymous, and `package-sidecar.mjs` refuses a
 * tree that still contains one.
 */
export const STAGING_SUFFIX = ".materialising";

/** Is `candidate` inside `root`? `root` itself does not count as inside it. */
export function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`${sep}..`) && rel !== "..";
}

/** Does any segment of `candidate` name a dependency tree? */
export function isUnderNodeModules(candidate) {
  let current = resolve(candidate);
  for (;;) {
    if (basename(current) === NODE_MODULES) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Every symlink under `root`, deepest-last, as absolute paths. */
export function symlinksUnder(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) found.push(full);
      else if (entry.isDirectory()) stack.push(full);
    }
  }
  return found;
}

/**
 * May this link be followed and copied into an installer?
 *
 * Returns a decision rather than throwing, so the caller reports every link in
 * one pass instead of dying on the first -- a build that has grown three new
 * links should say so once.
 *
 * `reason` is a code for a human to grep for; `detail` is the sentence that
 * explains it. Both name real paths, because the whole difficulty of PL-0755
 * and of this correction was that nobody could see where a link pointed.
 */
export function classifyLink({ link, repoRoot, standaloneRoot }) {
  if (!lstatSync(link).isSymbolicLink()) {
    return { ok: false, reason: "not_a_link", target: null, detail: `${link} is not a symlink` };
  }

  let target;
  try {
    target = realpathSync(link);
  } catch (error) {
    return {
      ok: false,
      reason: "dangling",
      target: null,
      detail:
        `${link} points at ${readlinkSync(link)}, which does not exist ` +
        `(${error.code ?? error.message}). A broken link cannot be materialised, and shipping it ` +
        `is the shape the installed MSI had in PL-0755.`
    };
  }

  const stats = statSync(target);
  if (!stats.isDirectory() && !stats.isFile()) {
    return {
      ok: false,
      reason: "not_a_file_or_directory",
      target,
      detail: `${link} -> ${target}, which is neither a file nor a directory. Nothing to package.`
    };
  }

  /*
   * THE BOUNDARY. A link out of the checkout is the arbitrary traversal worth
   * refusing -- a global package store, a cache under the user's profile, a
   * system directory. npm hoists inside the repository, so this admits the
   * hoisted copy Windows points at while still refusing everything the old
   * rule was written to refuse.
   */
  if (!isInside(repoRoot, target)) {
    return {
      ok: false,
      reason: "outside_the_repository",
      target,
      detail:
        `${link} -> ${target}, which is OUTSIDE the repository at ${repoRoot}. Following it would ` +
        `copy something this checkout did not produce into the installer. If a dependency really ` +
        `lives outside the tree -- a pnpm store, a linked workspace -- that is a packaging ` +
        `decision to take deliberately, not one to make by following a link.`
    };
  }

  /*
   * THE DECISION IS ABOUT THE TARGET, NOT ABOUT WHERE THE LINK SITS.
   *
   * An earlier draft keyed this on the link's own parent being `node_modules`,
   * which is what a Turbopack alias looks like. It is the wrong question, and
   * the fixed-point test found it: materialising one alias copies a package in,
   * and a link INSIDE that copy -- whose parent is the package directory --
   * would have been judged by the rule for non-dependency links and refused,
   * even though it points at a perfectly ordinary dependency. What makes a link
   * safe to package is what it resolves to.
   *
   * The link's position still chooses the WORDING of a refusal, because "your
   * dependency alias points at source" and "something new in the build output
   * links out of it" are different things for a reader to go and look at.
   */
  const aliasOfATracedPackage = basename(dirname(link)) === NODE_MODULES;

  if (isUnderNodeModules(target)) {
    if (!stats.isDirectory()) {
      return {
        ok: false,
        reason: "alias_is_not_a_directory",
        target,
        detail: `${link} points at the FILE ${target} inside a ${NODE_MODULES} tree. A package is a directory.`
      };
    }
    if (!existsSync(join(target, "package.json"))) {
      return {
        ok: false,
        reason: "alias_target_is_not_a_package",
        target,
        detail:
          `${link} -> ${target}, which is inside a ${NODE_MODULES} tree but has no package.json. ` +
          `Turbopack's external aliases name packages; a build cache, a .bin directory or a bare ` +
          `${NODE_MODULES} root is not something to resolve a bare import to.`
      };
    }
    return { ok: true, reason: "traced_package", target, detail: `${link} -> ${target}` };
  }

  /*
   * Not a dependency. The conservative rule is kept for these: they may only
   * point inside the build output. Nothing in this build creates one today, and
   * widening it is a decision for whoever introduces the first, with the link
   * in front of them.
   */
  if (!isInside(standaloneRoot, target)) {
    return {
      ok: false,
      reason: aliasOfATracedPackage
        ? "alias_outside_node_modules"
        : "non_dependency_link_leaves_the_build_output",
      target,
      detail: aliasOfATracedPackage
        ? `${link} is a ${NODE_MODULES} entry but points at ${target}, which is not inside any ` +
          `${NODE_MODULES} tree. A bare specifier must resolve to a dependency, not to source, ` +
          `build metadata or anything else that happens to be in the checkout.`
        : `${link} -> ${target}. It is not a dependency, so it may only point inside the build ` +
          `output at ${standaloneRoot}. Look at what created it before packaging it.`
    };
  }
  return { ok: true, reason: "inside_the_build_output", target, detail: `${link} -> ${target}` };
}

/**
 * Remove the LINK and never what it points at.
 *
 * `rmSync(link, { recursive: true })` is what this replaces and it must not
 * come back. On Windows a directory junction is removed with `rmdir`, and a
 * recursive delete aimed at one is a delete aimed at a directory that CONTAINS
 * the real package -- on this project, `<repo>/node_modules/pg`. The failure
 * would be a damaged checkout on the build machine, reported as a packaging
 * error about something else.
 *
 * `unlink` first, because that is what removes a symlink on every platform and
 * cannot recurse. Windows refuses it for a junction, so `rmdir` is the
 * fallback: it removes the junction itself and leaves the target alone.
 */
export function removeLinkOnly(link) {
  try {
    unlinkSync(link);
    return "unlink";
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EISDIR" || error.code === "EACCES") {
      rmdirSync(link);
      return "rmdir";
    }
    throw error;
  }
}

/**
 * Replace a link with a real copy of what it points at.
 *
 * ORDERED SO THE TARGET IS READ BEFORE ANYTHING IS DELETED. The copy is
 * assembled beside the link, the link is then removed on its own, and the copy
 * is renamed into its place. A sequence that deleted first would, on any
 * mistake in `removeLinkOnly`, destroy the dependency it was about to read.
 *
 * AND THE TARGET IS CHECKED AFTERWARDS. If it is gone, the packaged tree is
 * still complete -- the copy was already taken -- but the CHECKOUT has been
 * damaged, and that is not something to discover later as a mysterious build
 * failure. It throws, loudly, naming the path.
 */
export function materialiseLink(link) {
  const target = realpathSync(link);
  const asDirectory = statSync(target).isDirectory();
  const staging = `${link}${STAGING_SUFFIX}`;

  if (existsSync(staging)) {
    throw new Error(
      `${staging} already exists, so a previous materialisation did not finish. Remove it and ` +
        `re-run packaging rather than merging into it.`
    );
  }

  cpSync(target, staging, asDirectory ? { recursive: true } : {});
  const how = removeLinkOnly(link);
  renameSync(staging, link);

  if (!existsSync(target)) {
    throw new Error(
      `removing the link ${link} (via ${how}) also removed its target ${target}. The packaged ` +
        `tree is complete because the copy was taken first, but THE CHECKOUT IS DAMAGED and this ` +
        `must not be treated as a packaging hiccup.`
    );
  }

  return { target, how, asDirectory };
}
