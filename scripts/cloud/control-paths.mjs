/**
 * Single source of truth for deterministic control-plane outputs.
 *
 * Two lists previously described the same set and drifted:
 * `stage-task-changes.mjs` would COMMIT `docs/MISSION_CONTROL.md` in control
 * mode, while `protect-state.mjs` did not RESTORE it. A model edit there
 * survived the restore and was then committed as deterministic state.
 *
 * The invariant is simple and must hold by construction, not by discipline:
 *
 *   everything control mode may commit == everything the guard restores
 *
 * Both modules import this array, so the sets cannot diverge again.
 */
export const CONTROL_OUTPUT_PATHS = [
  "control",
  "coordination/agent-bus",
  "coordination/PROJECT_STATUS.md",
  "coordination/TASKS.md",
  "docs/MISSION_CONTROL.md",
];
