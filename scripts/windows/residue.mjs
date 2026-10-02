/* -------------------------------------------------------------------------
 * What an uninstall is allowed to leave behind (PW-0503)
 *
 * ==========================================================================
 * A PURE JUDGEMENT OVER OBSERVED STATE, AND THAT SHAPE IS THE POINT
 * ==========================================================================
 *
 * The acceptance asks that uninstall "leaves no service, no scheduled task and
 * no orphaned node.exe, and states exactly what user data it keeps or
 * removes". Written as inline PowerShell inside a workflow, that becomes four
 * conditionals nobody can run, nobody can test, and nobody can reconstruct
 * after a red build. Written here it is a function from observations to a
 * verdict, with every rule named -- and `test-lifecycle.mjs` drives it on
 * Linux, where no Windows machine is needed to check the REASONING even though
 * one is needed to produce the observations.
 *
 * That split is the same one the player work keeps arriving at: the decision
 * is pure and tested, the measurement is real and happens where it must.
 *
 * ==========================================================================
 * THE ONE THING IT DOES NOT CALL A VIOLATION
 * ==========================================================================
 *
 * USER DATA SURVIVING IS CORRECT, and the harness reports it as KEPT rather
 * than as residue. The reason is mechanical rather than a preference: the MSI
 * never creates `%LOCALAPPDATA%\<identifier>` -- the application does, at
 * first launch, through Tauri's path API -- so there is nothing there for an
 * uninstall to have removed. A viewer who removes the application and puts it
 * back expects their profiles and progress to still be there, and an installer
 * that deleted them would be the surprising behaviour.
 *
 * What it must never do is leave that fact IMPLIED. `classifyResidue` returns
 * the kept paths explicitly so a report can state them, which is what the
 * acceptance means by "states exactly what user data it keeps or removes".
 * ---------------------------------------------------------------------- */

/** Case- and separator-insensitive "is this path inside that root". */
export function isUnder(path, root) {
  if (typeof path !== "string" || typeof root !== "string" || root === "") return false;
  const normalise = (value) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const p = normalise(path);
  const r = normalise(root);
  return p === r || p.startsWith(`${r}\\`);
}

/**
 * The observation shape this judges. Every field is what a Windows command
 * reported, never what this module assumed:
 *
 *   installRoot      { path, exists, entries: string[] }
 *   userDataRoot     { path, exists, entries: string[] }
 *   services         [{ name, displayName, binaryPath }]
 *   scheduledTasks   [{ name, action }]
 *   processes        [{ pid, name, executablePath }]
 *
 * An absent array is NOT read as "none found". It is read as "not observed",
 * which is a different thing and is reported as such -- a check that was never
 * run must not be able to pass.
 */
export function classifyResidue(observed, identity) {
  const violations = [];
  const kept = [];
  const notObserved = [];

  const install = observed.installRoot;
  if (!install) {
    notObserved.push("the install root was not inspected");
  } else if (install.exists) {
    /*
     * AN EMPTY DIRECTORY IS NOT A FAILURE. MSI commonly leaves the product
     * folder behind when it is empty, and an empty folder costs a viewer
     * nothing. Files in it are another matter: those are the ones that make a
     * reinstall pick up stale state, which is exactly what F4 is about.
     */
    const leftovers = install.entries ?? [];
    if (leftovers.length > 0) {
      violations.push({
        rule: "install-root-not-emptied",
        detail:
          `${install.path} still holds ${leftovers.length} entr${leftovers.length === 1 ? "y" : "ies"} ` +
          `after the uninstall: ${leftovers.slice(0, 10).join(", ")}`
      });
    } else {
      kept.push({
        what: "an empty product directory",
        path: install.path,
        why: "MSI leaves the folder when it has nothing in it; it costs the viewer nothing"
      });
    }
  }

  for (const service of observedList(observed.services, notObserved, "services")) {
    if (
      isUnder(service.binaryPath ?? "", install?.path ?? "") ||
      namesTheProduct(service.name, identity) ||
      namesTheProduct(service.displayName, identity)
    ) {
      violations.push({
        rule: "service-left-behind",
        detail: `service ${service.name} (${service.binaryPath ?? "no binary path reported"})`
      });
    }
  }

  for (const task of observedList(observed.scheduledTasks, notObserved, "scheduled tasks")) {
    if (
      isUnder(task.action ?? "", install?.path ?? "") ||
      namesTheProduct(task.name, identity)
    ) {
      violations.push({
        rule: "scheduled-task-left-behind",
        detail: `scheduled task ${task.name} (${task.action ?? "no action reported"})`
      });
    }
  }

  for (const process of observedList(observed.processes, notObserved, "processes")) {
    /*
     * THE ORPHANED `node.exe` THE ACCEPTANCE NAMES. It is matched by PATH and
     * not by name, deliberately: a runner and a developer machine both have
     * other `node.exe` processes, and a harness that killed the build's own
     * Node because it shared a filename would be worse than one that checked
     * nothing. PW-0102's Job Object is what should make this impossible; this
     * is the check that says whether it did.
     */
    if (isUnder(process.executablePath ?? "", install?.path ?? "")) {
      violations.push({
        rule: "process-still-running-from-the-install-root",
        detail: `pid ${process.pid} ${process.name} at ${process.executablePath}`
      });
    }
  }

  const data = observed.userDataRoot;
  if (!data) {
    notObserved.push("the user-data root was not inspected");
  } else if (data.exists) {
    kept.push({
      what: "every byte of user data",
      path: data.path,
      why:
        "the installer never created it -- the application does, at first launch -- so an " +
        "uninstall has nothing there to remove. Profiles, progress and the local store survive, " +
        "which is what a viewer who reinstalls expects"
    });
  } else {
    /*
     * REPORTED, NOT FAILED. There was no user data because nothing had
     * launched; on a runner that is the normal case, and calling it a failure
     * would make F3 unpassable in the one place it can be automated.
     */
    kept.push({
      what: "nothing -- no user data existed to keep",
      path: data.path,
      why: "the application had never launched on this machine, so it had never written anything"
    });
  }

  return {
    clean: violations.length === 0 && notObserved.length === 0,
    violations,
    kept,
    notObserved
  };
}

/**
 * An observed list, or nothing plus a note that nobody looked.
 *
 * THE DISTINCTION THIS KEEPS IS THE WHOLE RELIABILITY OF THE VERDICT. An
 * absent array and an empty array mean opposite things -- "not inspected" and
 * "inspected, found none" -- and collapsing them is how a check that never ran
 * reports a clean machine. `classifyResidue` refuses to call anything clean
 * while `notObserved` is non-empty.
 */
function observedList(value, sink, what) {
  if (Array.isArray(value)) return value;
  sink.push(`${what} were not inspected`);
  return [];
}

/**
 * Whether a name is the product's, with no substring guessing.
 *
 * "liberty" ALONE IS NOT A MATCH. A machine can perfectly well run something
 * else with that word in its name, and a harness that declared an unrelated
 * service to be our residue would send somebody deleting it. The comparison is
 * against the two names this product actually registers under, both derived
 * from the Tauri configuration.
 */
export function namesTheProduct(name, identity) {
  if (typeof name !== "string" || name === "") return false;
  const candidate = name.trim().toLowerCase();
  return (
    candidate === identity.productName.toLowerCase() ||
    candidate === identity.identifier.toLowerCase() ||
    candidate === identity.executable.toLowerCase()
  );
}

/**
 * Did an upgrade preserve what was there before it?
 *
 * COMPARED BY CONTENT, NOT BY EXISTENCE. A directory that still exists and has
 * been emptied is the failure F2 is actually about -- "user data preserved" is
 * about the viewer's profiles and progress, not about an inode. The marker
 * file the runner writes before the upgrade is read back afterwards, and its
 * CONTENT must match: a file recreated empty by a fresh first launch would
 * pass an existence check and fail a person.
 */
export function upgradePreservedUserData(before, after) {
  const missing = [];
  const altered = [];
  for (const [path, content] of Object.entries(before)) {
    if (!Object.hasOwn(after, path)) missing.push(path);
    else if (after[path] !== content) altered.push(path);
  }
  return {
    preserved: missing.length === 0 && altered.length === 0,
    missing,
    altered,
    /* Extra files are expected: the upgraded application writes its own. */
    added: Object.keys(after).filter((path) => !Object.hasOwn(before, path))
  };
}
