/**
 * AI control-plane regression suite.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE KEEPS RE-LEARNING
 * ---------------------------------------------------------------------------
 * Scenarios that assert planner or command BEHAVIOUR plan over FIXTURES --
 * `fixtureTask`, `addFixtureTasks`, `useFixtureTaskSet`, `waveFixtureTasks` --
 * and never over whatever `control/tasks.json` happens to contain today. Only
 * the designated live-state guards read the real task list: scenario 0, which
 * proves the runtime reset actually neutralises live progress, and scenario 11,
 * which proves the run never wrote to the live repository. Those two exist in
 * order to observe live state. Everything else merely borrowed it because it
 * was lying around.
 *
 * That lesson has now arrived three times, each as a real red build:
 *
 *   - scenario 7 asserted the exact dispatch wave the live backlog produced,
 *     and authoring one more READY P0 task moved the tie-break;
 *   - scenario 1 asserted `M0 ... 1/4 (25%)`, which adding a fifth task to M0
 *     would have broken while the rollup arithmetic stayed correct;
 *   - scenario 9n assumed PL-0003 had never been started, so `--base auto`
 *     could resolve nothing -- true right up until PL-0003 was implemented,
 *     reviewed, and completed, at which point it carried a real
 *     implementationBaseSha and the command the scenario expected to fail
 *     succeeded.
 *
 * Each was a statement about that day's data wearing the costume of an
 * invariant. A previous audit even wrote the assumption down -- "relies on
 * PL-0003 existing and never having been started (in a reset repo, always
 * true)". "Always true in a reset repo" is not an invariant; it is a
 * screenshot, and the project is supposed to move.
 *
 * SO: when a scenario fails because the project made progress, move it onto a
 * fixture. Do NOT update the expectation to match the new live data. Updating
 * an expected value to match reality is byte-for-byte indistinguishable from
 * updating it to match a regression: the diff looks identical, the commit
 * message reads identically, and the reviewer has no signal to tell the two
 * apart. That is how a genuine defect eventually lands disguised as routine
 * churn -- the suite goes red, someone "refreshes" the expectation, and the
 * assertion that existed to catch the bug is now asserting the bug.
 *
 * Where live coupling is deliberate, it is stated in the scenario's own comment
 * along with the reason it cannot be a fixture (the bus/orchestrator scenarios
 * pin PL-AI-0001 and PL-AI-0002 because scripts/cloud/orchestrator-gate.mjs
 * hard-codes that pair as its activation contract; a fixture there would test a
 * different contract than the one production reads).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Run a script and return stdout AND stderr combined.
 *
 * `run()` returns stdout only, so assertions about warnings -- which belong on
 * stderr -- would silently never match.
 */
function runCombined(cwd, script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const source = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-control-plane-"));
const CLI = "scripts/ai-control-plane.mjs";
let repoSeq = 0;

function run(cwd, script, args = [], env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}
function runFail(cwd, args, matcher, env = {}) {
  let failed = false;
  let output = "";
  try {
    run(cwd, CLI, args, env);
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failed, `expected "${args.join(" ")}" to fail but it succeeded`);
  if (matcher)
    assert.match(
      output,
      matcher,
      `unexpected failure output for "${args.join(" ")}":\n${output}`,
    );
  return output;
}
/**
 * Types that cannot be published without an explicit review range.
 * Mirrors BASE_REQUIRED_TYPES in agent-bus.mjs.
 */
const BASE_REQUIRED = [
  "implementation_ready",
  "review_request",
  "review_approved",
  "changes_requested",
];

/**
 * A range base for scenarios that are not about the range contract.
 *
 * Distinct from every --sha value used in this suite, so it can never collapse
 * into an empty range. Scenarios that DO test the range contract (9m, 9n, 9o,
 * 9p) pass --base explicitly and are unaffected by this default.
 */
const DEFAULT_TEST_BASE = "0".repeat(39) + "1";

/** Publish a handoff message and return its id, parsed from CLI output. */
function publish(repo, args, env = {}) {
  const typeIndex = args.indexOf("--type");
  const type = typeIndex >= 0 ? args[typeIndex + 1] : null;
  const withBase =
    BASE_REQUIRED.includes(type) && !args.includes("--base")
      ? [...args, "--base", DEFAULT_TEST_BASE]
      : args;

  const out = run(repo, CLI, ["handoff", ...withBase], env);
  const match = out.match(/Published (MSG-\S+)/);
  assert.ok(match, `could not parse message id from:\n${out}`);
  return match[1];
}
function busFile(repo, ...parts) {
  return path.join(repo, "coordination", "agent-bus", ...parts);
}
/**
 * Reset the *copied* control/tasks.json to a clean runtime state.
 *
 * Task definitions and routing (id, lane, priority, dependencies, allowedPaths,
 * preferredAgent, reviewAgent, qualityGates, acceptance) are preserved exactly
 * as authored. Only runtime state is cleared, so scenarios never depend on how
 * far the real project has progressed.
 *
 * This only ever touches the temp copy; the live control/tasks.json is not read
 * for mutation and never written.
 */
function resetRuntimeState(repo) {
  const file = path.join(repo, "control", "tasks.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const task of doc.tasks) {
    task.owner = null;
    task.gateResults = {};
    delete task.implementationAgent;
    delete task.updatedAt;
    delete task.completedAt;
    delete task.review;
    delete task.reviewHistory;

    // The commit implementation began from. This is the field that leaked, and
    // it is worth naming precisely: `start` writes it, so it is runtime state,
    // but it was not being cleared here. Once a real task carried one, a
    // "fresh" repo was no longer baseless -- `--base auto` resolved happily and
    // scenario 9n's fail-closed assertion started passing the wrong way.
    //
    // The second, quieter hazard: `start` deliberately never overwrites an
    // existing base, so an inherited value would also have defeated scenario
    // 9m's `implementationBaseSha === START` assertion the moment PL-AI-0001
    // was re-implemented through the CLI.
    delete task.implementationBaseSha;

    // Written alongside the base by `start --reconcile-existing`, and cleared
    // alongside it for the same reason. `validate` refuses a provenance record
    // whose baseSha does not match implementationBaseSha, so leaving this behind
    // after clearing the base would make every copied repo fail validation --
    // the same leak as above, arriving as a red build instead of a silent one.
    delete task.implementationBaseProvenance;

    // Externally BLOCKED tasks are a definition, not runtime drift: a blocked
    // task carries an explicit blocker reason and must stay blocked.
    if (task.status === "BLOCKED" || task.status === "CANCELED") continue;

    task.status = (task.dependencies ?? []).length === 0 ? "READY" : "BACKLOG";
  }

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

function freshRepo() {
  const repo = path.join(temp, `repo-${++repoSeq}`);
  fs.cpSync(source, repo, {
    recursive: true,
    // Both an `includes` and an `endsWith` check per directory: without the
    // `endsWith`, cpSync recurses into the directory itself and walks the whole
    // subtree before filtering each entry.
    filter: (src) =>
      !src.includes(`${path.sep}.git${path.sep}`) &&
      !src.endsWith(`${path.sep}.git`) &&
      !src.includes(`${path.sep}node_modules${path.sep}`) &&
      !src.endsWith(`${path.sep}node_modules`),
  });
  resetRuntimeState(repo);
  resetBusState(repo);
  resetEventLog(repo);
  return repo;
}

/**
 * Truncate the copied audit log.
 *
 * `control/events.jsonl` is append-only runtime history, so a copy inherits
 * every real event the project has ever recorded -- including genuine
 * `task.review_recorded` entries from completed work. Scenarios that assert on
 * event COUNTS would then be measuring project history rather than the
 * behaviour under test.
 */
function resetEventLog(repo) {
  fs.writeFileSync(path.join(repo, "control", "events.jsonl"), "");
}

/**
 * Clear inherited handoff traffic from the copy.
 *
 * Without this, every scenario would inherit whatever real messages happen to be
 * committed at the time -- which is guaranteed to happen once the bus is in
 * actual use -- and inbox/process assertions would start failing for reasons
 * that have nothing to do with the code under test.
 */
function resetBusState(repo) {
  for (const lane of [
    "gpt-to-claude",
    "claude-to-gpt",
    "acknowledgements",
    "rejections",
    "journal",
  ]) {
    const dir = path.join(repo, "coordination", "agent-bus", lane);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".json")) fs.rmSync(path.join(dir, name));
    }
  }
}

function journalOf(repo, messageId) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "journal",
    `${messageId}.json`,
  );
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function ackOf(repo, messageId) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "acknowledgements",
    `${messageId}.json`,
  );
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function rejectionOf(repo, messageId) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "rejections",
    `${messageId}.json`,
  );
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
/** Copy a repo to simulate a second checkout observing shared bus state. */
function cloneRepo(repo) {
  const clone = path.join(temp, `clone-${++repoSeq}`);
  fs.cpSync(repo, clone, { recursive: true });
  // The journal is local-only state; a real clone would not carry it.
  const journal = path.join(clone, "coordination", "agent-bus", "journal");
  if (fs.existsSync(journal)) {
    for (const name of fs.readdirSync(journal)) {
      if (name.endsWith(".json")) fs.rmSync(path.join(journal, name));
    }
  }
  return clone;
}
function eventsOf(repo) {
  return fs
    .readFileSync(path.join(repo, "control", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
/** Simulate a crash by writing a journal state directly, as a killed run would leave it. */
function simulateCrash(repo, messageId, state, extra = {}) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "journal",
    `${messageId}.json`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { messageId, state, claimedBy: "claude-lead", ...extra },
      null,
      2,
    ) + "\n",
  );
}
function tasksOf(repo) {
  return JSON.parse(
    fs.readFileSync(path.join(repo, "control", "tasks.json"), "utf8"),
  ).tasks;
}
function taskOf(repo, id) {
  return tasksOf(repo).find((t) => t.id === id);
}

/**
 * Append tasks to the COPIED control/tasks.json.
 *
 * `reviewDependencies` is a schema addition and no authored task carries one
 * yet. The fixtures live here rather than in control/tasks.json on purpose: the
 * data change is a separate task, so a review of the CODE must not be able to
 * pass or fail because of task data a later commit is expected to rewrite.
 *
 * The second use is subtler and just as important. Several scenarios need "a
 * task that exists", "a task that is not in REVIEW", or "a task with no review
 * base" -- properties any task can supply. Borrowing a real one silently turns
 * the scenario into a bet that that particular task will stay in that
 * particular state, which is a bet the project is actively trying to lose.
 * Appending a fixture states the requirement instead of assuming it.
 */
function addFixtureTasks(repo, ...fixtures) {
  const file = path.join(repo, "control", "tasks.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.tasks.push(...fixtures);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

/**
 * REPLACE the copied task set with a frozen fixture, rather than appending to it.
 *
 * `addFixtureTasks` is right for scenarios that only need two extra lanes beside
 * the real ones. It is wrong for anything asserting an EXACT dispatch wave,
 * because the planner solves over every candidate at once: adding a single READY
 * P0 task to control/tasks.json can move the optimum and break a planner
 * assertion even though the planner's behaviour has not changed at all.
 *
 * That is exactly what happened. PL-AI-0004 was authored (P0, Coordination,
 * READY, allowedPaths scripts/ai-control-plane.mjs + scripts/test-ai-control-plane.mjs).
 * It does not collide with PL-0002's `control/**`, so PL-0002 became schedulable
 * alongside it -- and PL-0002 owns `docs/**`, which swallows PL-0201's
 * `docs/ARCHITECTURE.md`. The wave stayed size 4 and stayed conflict-free; only
 * WHICH maximum set won the lexicographic tie-break moved. Rewriting the
 * expectation to name the new set would leave the same trap armed for the next
 * P0 task, so the scenarios plan over frozen data instead.
 *
 * Milestones go with the task set: `validate` errors on a milestone naming a
 * task id that no longer exists, and the milestone index is project data rather
 * than planner behaviour.
 */
function useFixtureTaskSet(repo, ...fixtures) {
  const file = path.join(repo, "control", "tasks.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.tasks = [...fixtures];
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");

  const milestoneFile = path.join(repo, "control", "milestones.json");
  if (fs.existsSync(milestoneFile)) {
    const milestoneDoc = JSON.parse(fs.readFileSync(milestoneFile, "utf8"));
    milestoneDoc.milestones = [];
    fs.writeFileSync(
      milestoneFile,
      JSON.stringify(milestoneDoc, null, 2) + "\n",
    );
  }
}

/**
 * A minimal task the control plane accepts.
 *
 * Everything lives under `fixtures/**`, which no authored task owns, so these
 * scenarios cannot collide with real work and do not have to be revisited every
 * time the project's own allowedPaths move. No quality gates, so what is being
 * measured is the surface under test and nothing else.
 *
 * Shared by the reviewDependencies scenarios, the dispatch-planning ones, the
 * handoff-bus ones and the review-base ones; the defaults below are what each of
 * them overrides from.
 */
function fixtureTask(id, overrides = {}) {
  return {
    id,
    priority: "P2",
    lane: "Frontend",
    status: "READY",
    title: `${id} review-dependency fixture`,
    dependencies: [],
    allowedPaths: [],
    preferredAgent: "claude-frontend",
    reviewAgent: "gpt-architect",
    qualityGates: [],
    acceptance: "fixture task used by the reviewDependencies regressions",
    owner: null,
    gateResults: {},
    ...overrides,
  };
}

/**
 * The frozen candidate set the dispatch-planning scenarios (7 and 8) plan over.
 *
 * Built so that every property those scenarios exist to prove has a task whose
 * only job is to break that property if the planner regresses:
 *
 *   PL-WV-0001  the GREEDY TRAP. Sorts first (P0, lowest id) and its
 *               allowedPaths cover every other fixture path, so a
 *               priority-ordered first-fit scan takes it and dispatches a wave
 *               of ONE. A maximum-feasible search must leave it behind.
 *   PL-WV-0002  Media, and only claude-media advertises Media.
 *   PL-WV-0003  Infra, and only claude-infra advertises Infra.
 *   PL-WV-0004  dependency-gated. Nothing about paths, capability or capacity
 *               stops it; only its unfinished dependency does.
 *   PL-WV-0005  three mutually disjoint Coordination tasks. claude-lead is the
 *   PL-WV-0006  only locally executable agent advertising Coordination and its
 *   PL-WV-0007  maxParallel is 2, so exactly two may go out.
 *   PL-WV-0008  reserved for gpt-architect, and deliberately given the SAME
 *               broad paths as the trap: an external reservation must consume
 *               neither path ownership nor capacity from the local wave.
 *   PL-WV-0009  BLOCKED, so blocked lanes are reported rather than dropped.
 *   PL-WV-0010  no preferredAgent, in a lane no locally executable agent
 *               advertises -- the other route into READY_BUT_EXTERNAL.
 *
 * Three conflict-free waves of size 4 exist -- {PL-WV-0002, PL-WV-0003} plus any
 * two of the three Coordination tasks -- and all three carry the same priority
 * sum, so betterWave()'s lexicographic tie-break decides between them and picks
 * PL-WV-0005 and PL-WV-0006. That is deterministic here BECAUSE the candidate
 * set is frozen; it is exactly the tie-break that moved when the live backlog
 * grew. The comparison that matters is against greedy first-fit, which would
 * emit a single task.
 */
function waveFixtureTasks() {
  const wave = (id, overrides = {}) =>
    fixtureTask(id, {
      priority: "P0",
      title: `${id} dispatch fixture`,
      acceptance: "fixture task used by the dispatch-planning scenarios",
      ...overrides,
    });
  return [
    wave("PL-WV-0001", {
      lane: "Frontend",
      preferredAgent: "claude-frontend",
      allowedPaths: ["fixtures/wave/**"],
      title: "PL-WV-0001 broad-scope greedy trap",
    }),
    wave("PL-WV-0002", {
      lane: "Media",
      preferredAgent: "claude-media",
      allowedPaths: ["fixtures/wave/media/**"],
    }),
    wave("PL-WV-0003", {
      lane: "Infra",
      preferredAgent: "claude-infra",
      allowedPaths: ["fixtures/wave/infra/**"],
    }),
    wave("PL-WV-0004", {
      status: "BACKLOG",
      lane: "Backend",
      preferredAgent: "claude-backend",
      dependencies: ["PL-WV-0009"],
      allowedPaths: ["fixtures/wave/backend/**"],
    }),
    wave("PL-WV-0005", {
      lane: "Coordination",
      preferredAgent: "claude-lead",
      allowedPaths: ["fixtures/wave/coord/a/**"],
    }),
    wave("PL-WV-0006", {
      lane: "Coordination",
      preferredAgent: "claude-lead",
      allowedPaths: ["fixtures/wave/coord/b/**"],
    }),
    wave("PL-WV-0007", {
      lane: "Coordination",
      preferredAgent: "claude-lead",
      allowedPaths: ["fixtures/wave/coord/c/**"],
    }),
    wave("PL-WV-0008", {
      lane: "Architecture",
      preferredAgent: "gpt-architect",
      reviewAgent: "claude-lead",
      allowedPaths: ["fixtures/wave/**"],
    }),
    wave("PL-WV-0009", {
      status: "BLOCKED",
      lane: "Provider",
      preferredAgent: "claude-backend",
      allowedPaths: ["fixtures/wave/blocked/**"],
      blocker: "awaiting an external licensing decision",
    }),
    wave("PL-WV-0010", {
      priority: "P1",
      lane: "Recommendations",
      preferredAgent: null,
      allowedPaths: ["fixtures/wave/recs/**"],
    }),
  ];
}

/**
 * Pairwise write-path disjointness, recomputed from the fixture data.
 *
 * A deliberate SECOND implementation of the overlap rule, so a wave is not
 * declared conflict-free merely because the planner's own predicate said so --
 * which is precisely what a broken predicate would also say.
 */
function assertWaveIsConflictFree(ids, fixtures) {
  const pathsOf = (id) => fixtures.find((t) => t.id === id)?.allowedPaths ?? [];
  const prefix = (p) => p.replace(/\/?\*+.*$/, "");
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      for (const pa of pathsOf(a)) {
        for (const pb of pathsOf(b)) {
          const na = prefix(pa);
          const nb = prefix(pb);
          assert.ok(
            na !== nb && !na.startsWith(nb + "/") && !nb.startsWith(na + "/"),
            `dispatched ${a} and ${b} both claim a write path (${pa} vs ${pb})`,
          );
        }
      }
    }
  }
}

function writeFixtureFile(repo, rel, body) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

/**
 * Turn a fixture repo into a git repository and hand back the three operations
 * every history-shaped scenario needs.
 *
 * The provenance-reconciliation scenarios all have to build REAL history --
 * their entire subject is what git can and cannot settle about a claimed base --
 * and the alternative to a helper is the same fifteen lines of identity
 * plumbing repeated in each one. The two scenarios written before this helper
 * existed (9at, 9au) keep their inline copies: they pass, and rewriting a
 * passing test to use a new helper is a change with no failure it could catch.
 */
function gitFixture(repo) {
  const env = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (...a) =>
    execFileSync("git", a, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
  const head = () => git("rev-parse", "HEAD").trim();
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return head();
  };
  git("init", "-q", "-b", "main");
  return { git, head, commit };
}

/**
 * Recompute a worktree fingerprint independently of the implementation.
 *
 * This is a deliberate SECOND implementation of the byte format -- sorted
 * relative path, NUL, file bytes, NUL -- so that changing how a fingerprint is
 * constructed fails loudly here instead of silently moving every approval ever
 * recorded. It is only ever pointed at fixture directories, which contain none
 * of the generated control-plane bookkeeping the real hash excludes, so the
 * exclusion rules deliberately are not mirrored.
 */
function expectedWorktreeHash(repo, prefixes) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isFile()) {
      files.push(rel);
      return;
    }
    for (const entry of fs.readdirSync(abs)) walk(`${rel}/${entry}`);
  };
  for (const prefix of prefixes) walk(prefix);

  const hash = createHash("sha256");
  for (const rel of [...new Set(files)].sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(repo, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The fingerprint the control plane currently computes for a task. */
function currentTreeHash(repo, id) {
  return JSON.parse(run(repo, CLI, ["review-status", id])).currentTreeHash;
}

/** Two disjoint modules that share one vocabulary -- the case the split exists for. */
function seedSharedVocabulary(repo) {
  writeFixtureFile(
    repo,
    "fixtures/rd/shared/rights.ts",
    "export type RightsBasis = 'licensed' | 'owned' | 'public-domain';\n",
  );
  writeFixtureFile(repo, "fixtures/rd/a/search.ts", "export const searchContract = 1;\n");
  writeFixtureFile(repo, "fixtures/rd/b/title.ts", "export const titleContract = 1;\n");
  addFixtureTasks(
    repo,
    fixtureTask("PL-RD-A", {
      allowedPaths: ["fixtures/rd/a/**"],
      reviewDependencies: ["fixtures/rd/shared/**"],
    }),
    fixtureTask("PL-RD-B", {
      lane: "Backend",
      preferredAgent: "claude-backend",
      allowedPaths: ["fixtures/rd/b/**"],
      reviewDependencies: ["fixtures/rd/shared/**"],
    }),
  );
}

/**
 * Drive PL-AI-0001 from READY through its implementation gates.
 *
 * The gate names are READ from the task definition rather than written here.
 * Naming "repo-validate" and "architecture-review" made every scenario built on
 * this helper depend on PL-AI-0001's authored gate list, so adding one gate to
 * that task would have reddened a dozen scenarios that are not about gates at
 * all -- and the tempting fix would have been to type the new gate name in,
 * which is how expectations drift towards whatever the data currently says.
 */
function implementToInProgress(repo) {
  const implementer = "claude-lead";
  run(repo, CLI, ["claim", "PL-AI-0001", implementer]);
  run(repo, CLI, ["start", "PL-AI-0001", implementer]);
  for (const gate of taskOf(repo, "PL-AI-0001").qualityGates ?? []) {
    run(repo, CLI, ["gate", "PL-AI-0001", gate, "pass", "automated smoke"]);
  }
}
/** Drive PL-AI-0001 from READY up to (but not including) DONE. */
function implementToReview(repo) {
  implementToInProgress(repo);
  run(repo, CLI, ["review", "PL-AI-0001"]);
}

const liveTasksPath = path.join(source, "control", "tasks.json");
const liveTasksBefore = fs.readFileSync(liveTasksPath, "utf8");

/**
 * Hash every file the control plane can write, so a scenario that forgets
 * freshRepo() and runs against the real repository fails loudly instead of
 * silently corrupting the live event log, queues, or status views.
 */
function snapshotLiveState() {
  const snapshot = new Map();
  for (const dir of ["control", "coordination"]) {
    const abs = path.join(source, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [dir];
    while (stack.length) {
      const rel = stack.pop();
      for (const entry of fs.readdirSync(path.join(source, rel), {
        withFileTypes: true,
      })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) stack.push(childRel);
        else if (entry.isFile()) {
          snapshot.set(
            childRel,
            createHash("sha256")
              .update(fs.readFileSync(path.join(source, childRel)))
              .digest("hex"),
          );
        }
      }
    }
  }
  return snapshot;
}
const liveStateBefore = snapshotLiveState();

try {
  /* ---------------------------------------------------------------------
   * 0. Test isolation: scenarios must not depend on live runtime state,
   *    and must never mutate the real control/tasks.json.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const tasks = tasksOf(repo);
    const live = JSON.parse(liveTasksBefore).tasks;
    const liveById = new Map(live.map((t) => [t.id, t]));

    for (const task of tasks) {
      assert.equal(
        task.owner,
        null,
        `${task.id} should have no owner in a fresh scenario`,
      );
      assert.deepEqual(
        task.gateResults,
        {},
        `${task.id} should have no gate results`,
      );
      assert.equal(
        task.review,
        undefined,
        `${task.id} should have no review record`,
      );
      assert.equal(
        task.reviewHistory,
        undefined,
        `${task.id} should have no review history`,
      );
      assert.equal(
        task.implementationAgent,
        undefined,
        `${task.id} should have no implementation agent`,
      );
      assert.equal(
        task.updatedAt,
        undefined,
        `${task.id} should have no updatedAt timestamp`,
      );
      assert.equal(
        task.completedAt,
        undefined,
        `${task.id} should have no completedAt timestamp`,
      );
      // The leak that broke 9n. A base inherited from real completed work makes
      // a "fresh" repo silently non-fresh for every range-contract scenario, and
      // the symptom surfaces far away from the cause -- so it is asserted here,
      // where the reset itself is under test.
      assert.equal(
        task.implementationBaseSha,
        undefined,
        `${task.id} should have no implementation base sha`,
      );
      // Its explanation goes with it. The two are validated as a pair, so a
      // surviving record would turn every scenario red at `validate`.
      assert.equal(
        task.implementationBaseProvenance,
        undefined,
        `${task.id} should have no implementation base provenance`,
      );

      // Definitions and routing survive the reset untouched.
      const source_ = liveById.get(task.id);
      assert.equal(
        task.preferredAgent,
        source_.preferredAgent,
        `${task.id} preferredAgent must be preserved`,
      );
      assert.equal(
        task.reviewAgent,
        source_.reviewAgent,
        `${task.id} reviewAgent must be preserved`,
      );
      assert.deepEqual(
        task.dependencies,
        source_.dependencies,
        `${task.id} dependencies must be preserved`,
      );
      assert.deepEqual(
        task.allowedPaths,
        source_.allowedPaths,
        `${task.id} allowedPaths must be preserved`,
      );

      if (source_.status === "BLOCKED") {
        assert.equal(task.status, "BLOCKED", `${task.id} must stay BLOCKED`);
        assert.equal(
          task.blocker,
          source_.blocker,
          `${task.id} blocker reason must be preserved`,
        );
      } else if (source_.status !== "CANCELED") {
        const expected =
          (task.dependencies ?? []).length === 0 ? "READY" : "BACKLOG";
        assert.equal(
          task.status,
          expected,
          `${task.id} should reset to ${expected}`,
        );
      }
    }

    /*
     * Isolation holds even though the live project has genuinely progressed.
     *
     * Derived from the live file rather than naming ids. Earlier this spot-check
     * read "PL-AI-0001 is READY, PL-0302 is BLOCKED", which is the same species
     * of assumption that broke 9n: PL-0302 will not stay blocked forever, and a
     * scenario about the RESET should not fail because a blocker was cleared.
     * Deriving the ids also makes the check total rather than illustrative --
     * every advanced task must be neutralised, not just the one that was
     * advanced on the day this was written.
     */
    const liveAdvanced = live.filter(
      (t) => !["READY", "BACKLOG", "BLOCKED", "CANCELED"].includes(t.status),
    );
    assert.ok(
      liveAdvanced.length > 0,
      "the live control plane should have progressed past a pristine backlog; " +
        "if it truly has not, this guard is no longer proving anything",
    );
    for (const advanced of liveAdvanced) {
      assert.ok(
        ["READY", "BACKLOG"].includes(taskOf(repo, advanced.id).status),
        `${advanced.id} is ${advanced.status} live and must reset to READY or BACKLOG`,
      );
    }
    for (const blocked of live.filter((t) => t.status === "BLOCKED")) {
      assert.equal(
        taskOf(repo, blocked.id).status,
        "BLOCKED",
        `${blocked.id} is blocked by an external reason and must stay BLOCKED`,
      );
    }
    run(repo, CLI, ["validate"]);
  }

  /* ---------------------------------------------------------------------
   * 1. Happy path: independent approval by the designated reviewer.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    run(repo, CLI, ["validate"]);
    implementToReview(repo);

    // Gates alone must not be enough.
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);

    run(repo, CLI, [
      "approve",
      "PL-AI-0001",
      "gpt-architect",
      "architecture review recorded via shared repository",
    ]);
    run(repo, CLI, ["done", "PL-AI-0001"]);
    run(repo, CLI, ["validate"]);

    const done = taskOf(repo, "PL-AI-0001");
    assert.equal(done.status, "DONE");
    assert.equal(done.review.outcome, "APPROVED");
    assert.equal(done.review.reviewerAgent, "gpt-architect");
    assert.equal(done.review.implementationAgent, "claude-lead");
    assert.equal(done.review.reviewerProvider, "openai");
    for (const field of [
      "taskId",
      "reviewerClass",
      "reviewedCommitSha",
      "reviewedTreeHash",
      "reviewedAt",
      "evidence",
    ]) {
      assert.ok(done.review[field], `review record should carry ${field}`);
    }
    assert.equal(
      taskOf(repo, "PL-AI-0002").status,
      "READY",
      "dependent task should unlock after DONE",
    );

    // Milestone rollup: exactly one of M0's tasks is now DONE.
    //
    // The denominator is READ from the milestone index rather than written into
    // the pattern. Hard-coding "1/4 (25%)" made this assertion break the moment
    // a task was added to M0 -- project data moving, not the rollup arithmetic
    // regressing -- which is the same trap scenario 7 had.
    const m0 = JSON.parse(
      fs.readFileSync(path.join(repo, "control", "milestones.json"), "utf8"),
    ).milestones.find((m) => m.id === "M0");
    assert.ok(m0?.tasks?.includes("PL-AI-0001"), "M0 must contain PL-AI-0001");
    const expectedPct = Math.round((1 / m0.tasks.length) * 100);
    const status = run(repo, CLI, ["status"]);
    assert.match(
      status,
      new RegExp(
        `M0 .*IN_PROGRESS, 1/${m0.tasks.length} \\(${expectedPct}%\\)`,
      ),
      `M0 should report exactly one completed task:\n${status}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 2. Self-approval must fail.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    runFail(
      repo,
      ["approve", "PL-AI-0001", "claude-lead", "looks good to me"],
      /self-approval is prohibited/,
    );
    assert.equal(
      taskOf(repo, "PL-AI-0001").review,
      undefined,
      "rejected self-approval must not be recorded",
    );
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "REVIEW");
  }

  /* ---------------------------------------------------------------------
   * 3. Automatic reviewer substitution must fail.
   *    A different Claude agent may not stand in for gpt-architect.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    runFail(
      repo,
      [
        "approve",
        "PL-AI-0001",
        "claude-security",
        "substituting for unavailable gpt lane",
      ],
      /requires independent review by gpt-architect/,
    );
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);
  }

  /* ---------------------------------------------------------------------
   * 4. Stale approval must fail: code changed after the review.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    run(repo, CLI, [
      "approve",
      "PL-AI-0001",
      "gpt-architect",
      "approved at review time",
    ]);

    const approvedHash = taskOf(repo, "PL-AI-0001").review.reviewedTreeHash;

    // Mutate a file inside the task's allowedPaths after approval.
    const touched = path.join(repo, "AGENTS.md");
    fs.appendFileSync(touched, "\n<!-- post-approval edit -->\n");

    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /stale review: implementation under allowedPaths changed after approval/,
    );
    assert.equal(
      taskOf(repo, "PL-AI-0001").status,
      "REVIEW",
      "stale review must not complete the task",
    );

    // A fresh approval against the new content restores completability.
    run(repo, CLI, [
      "approve",
      "PL-AI-0001",
      "gpt-architect",
      "re-reviewed after post-approval edit",
    ]);
    const rehash = taskOf(repo, "PL-AI-0001").review.reviewedTreeHash;
    assert.notEqual(
      rehash,
      approvedHash,
      "fingerprint must change when implementation changes",
    );
    run(repo, CLI, ["done", "PL-AI-0001"]);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "DONE");

    const history = taskOf(repo, "PL-AI-0001").reviewHistory;
    assert.equal(history.length, 2, "every review decision should be retained");
  }

  /* ---------------------------------------------------------------------
   * 5. CHANGES_REQUESTED must block DONE and return the task to IN_PROGRESS.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    run(repo, CLI, [
      "request-changes",
      "PL-AI-0001",
      "gpt-architect",
      "dispatcher still starves executable lanes",
    ]);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "IN_PROGRESS");
    assert.equal(
      taskOf(repo, "PL-AI-0001").review.outcome,
      "CHANGES_REQUESTED",
    );

    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /review outcome is CHANGES_REQUESTED/,
    );
  }

  /* ---------------------------------------------------------------------
   * 6. Gate evidence remains mandatory (no silent bypass).
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"]);

    // Gate names come from the task definition, not from this file. What is
    // under test is "an unrecorded gate blocks completion", which is true of
    // whichever gates the task declares; the previous version named
    // architecture-review and would have failed if that gate were ever renamed
    // or reordered, for reasons having nothing to do with gate enforcement.
    const gates = taskOf(repo, "PL-AI-0001").qualityGates ?? [];
    assert.ok(
      gates.length >= 2,
      "this scenario needs a task declaring at least two gates, so one can be left unrecorded",
    );
    const withheld = gates[gates.length - 1];

    runFail(
      repo,
      ["gate", "PL-AI-0001", gates[0], "pass"],
      /Gate evidence is required/,
    );
    for (const gate of gates.slice(0, -1)) {
      run(repo, CLI, [
        "gate",
        "PL-AI-0001",
        gate,
        "pass",
        `npm run ${gate} exit 0`,
      ]);
    }
    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(
      repo,
      ["done", "PL-AI-0001"],
      new RegExp(`gates not passed: ${withheld}`),
    );
  }

  /* ---------------------------------------------------------------------
   * 7. Dispatch planning: a maximum conflict-free wave, and an external lane
   *    that does not shrink it.
   *
   *    Planned over a FROZEN fixture set (see waveFixtureTasks) rather than the
   *    live backlog. This scenario used to assert the wave the real
   *    control/tasks.json happened to produce, and authoring one new READY P0
   *    task -- PL-AI-0004 -- moved the tie-break and broke it while the planner
   *    behaved identically. A scenario about the planner must not be a hostage
   *    to the project's task list.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const fixtures = waveFixtureTasks();
    useFixtureTaskSet(repo, ...fixtures);

    const out = run(repo, CLI, ["dispatch"]);
    const executableBlock = out.split("--- deferred")[0];
    const deferredBlock = (out.split("--- deferred")[1] ?? "").split(
      "=== READY_BUT_EXTERNAL",
    )[0];
    // Split off BLOCKED too: without it the "external" slice would also carry
    // the blocked section, and an assertion about external reservation could be
    // satisfied by a line printed under a different heading entirely.
    const externalBlock = (out.split("=== READY_BUT_EXTERNAL")[1] ?? "").split(
      "=== BLOCKED",
    )[0];

    // Capability routing: each of these lanes is advertised by exactly one
    // locally executable agent, so the assignment is not a tie-break.
    for (const [taskId, agentId] of [
      ["PL-WV-0002", "claude-media"],
      ["PL-WV-0003", "claude-infra"],
      ["PL-WV-0005", "claude-lead"],
      ["PL-WV-0006", "claude-lead"],
    ]) {
      assert.match(
        executableBlock,
        new RegExp(`${taskId} -> ${agentId}`),
        `${taskId} should dispatch to ${agentId}:\n${out}`,
      );
    }

    const dispatched = [...executableBlock.matchAll(/^(PL-WV-\d+) -> /gm)].map(
      (m) => m[1],
    );
    assert.equal(
      dispatched.length,
      4,
      `expected a 4-task executable wave, got ${dispatched.length}:\n${out}`,
    );
    assertWaveIsConflictFree(dispatched, fixtures);

    // MAXIMUM, not greedy first-fit. PL-WV-0001 sorts first and overlaps every
    // other fixture path, so a priority-ordered scan that took it would emit a
    // wave of one. Taking it is the regression; deferring it is the behaviour.
    assert.doesNotMatch(
      executableBlock,
      /PL-WV-0001 ->/,
      `a broad-scope task must not be allowed to starve three lanes:\n${out}`,
    );
    assert.match(
      deferredBlock,
      /PL-WV-0001 .*allowedPaths overlap dispatched PL-WV-000\d/,
      `the trap must be deferred with a path reason:\n${out}`,
    );

    // maxParallel: claude-lead advertises Coordination and caps at 2, so the
    // third disjoint Coordination task waits for capacity rather than paths.
    assert.equal(
      (executableBlock.match(/-> claude-lead/g) ?? []).length,
      2,
      `claude-lead's maxParallel is 2:\n${out}`,
    );
    assert.match(
      deferredBlock,
      /PL-WV-0007 .*no locally executable agent has capacity/,
      `the third Coordination task must be deferred for capacity, not paths:\n${out}`,
    );

    // Dependencies: PL-WV-0004 is otherwise perfectly dispatchable.
    assert.doesNotMatch(
      out,
      /PL-WV-0004 ->/,
      "a task whose dependency is unfinished must not be dispatched",
    );

    // An external reservation consumes neither capacity nor path ownership:
    // PL-WV-0008 claims the same broad paths as the trap and still takes
    // nothing from the local wave.
    assert.doesNotMatch(
      executableBlock,
      /PL-WV-0008 ->/,
      "a task reserved for gpt-architect must not be dispatched to a local agent",
    );
    assert.match(externalBlock, /PL-WV-0008 \[gpt-architect\]/);
    assert.match(
      externalBlock,
      /PL-WV-0010 \[unassigned\].*no locally executable agent advertises lane Recommendations/,
      `a lane with no local agent must be reported as external:\n${out}`,
    );

    // Blocked lanes are reported separately, with their reason, not dropped.
    assert.match(out, /=== BLOCKED ===/);
    assert.match(out, /PL-WV-0009 .*awaiting an external licensing decision/);

    const ready = run(repo, CLI, ["ready"]);
    assert.match(ready, /READY_AND_EXECUTABLE\tPL-WV-0002/);
    assert.match(ready, /READY_BUT_EXTERNAL\tPL-WV-0008/);
    assert.match(ready, /BLOCKED\tPL-WV-0009/);
    assert.doesNotMatch(
      ready,
      /READY_AND_EXECUTABLE\tPL-WV-0004/,
      "a task waiting on an unfinished dependency is not ready for anyone",
    );
  }

  /* ---------------------------------------------------------------------
   * 8. --apply claims exactly the planned executable wave, and nothing else.
   *
   *    Same frozen fixture set as scenario 7, so the claim side and the plan
   *    side cannot disagree about what "the wave" was.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    useFixtureTaskSet(repo, ...waveFixtureTasks());

    run(repo, CLI, ["dispatch", "--apply"]);
    const claimed = tasksOf(repo)
      .filter((t) => t.status === "CLAIMED")
      .map((t) => `${t.id}:${t.owner}`)
      .sort();
    assert.deepEqual(claimed, [
      "PL-WV-0002:claude-media",
      "PL-WV-0003:claude-infra",
      "PL-WV-0005:claude-lead",
      "PL-WV-0006:claude-lead",
    ]);

    assert.equal(
      taskOf(repo, "PL-WV-0008").status,
      "READY",
      "external task must remain queued, not claimed",
    );
    assert.equal(taskOf(repo, "PL-WV-0008").owner, null);
    assert.equal(
      taskOf(repo, "PL-WV-0004").status,
      "BACKLOG",
      "a dependency-gated task must not be claimed by --apply",
    );
    assert.equal(taskOf(repo, "PL-WV-0009").status, "BLOCKED");
    assert.equal(
      taskOf(repo, "PL-WV-0001").status,
      "READY",
      "the deferred trap must stay available for a later wave",
    );
    run(repo, CLI, ["validate"]);
  }

  /* ---------------------------------------------------------------------
   * 9. Handoff bus: GPT <-> Claude with no human in the loop.
   * ------------------------------------------------------------------- */
  {
    const SHA = "a".repeat(40);
    const repo = freshRepo();

    // A second addressable task, so the "some OTHER task" half of this scenario
    // does not borrow a real one. It needs to exist and to not be PL-AI-0001;
    // nothing else about it matters, which is exactly why a fixture is right.
    addFixtureTasks(
      repo,
      fixtureTask("PL-BUS-0001", {
        title: "PL-BUS-0001 second addressable task",
        allowedPaths: ["fixtures/bus/a/**"],
        acceptance: "fixture task addressed by the handoff-bus scenarios",
      }),
    );
    implementToInProgress(repo);

    // --- Real Claude -> GPT review submission ---
    const requestId = publish(
      repo,
      [
        "--from",
        "claude-lead",
        "--to",
        "gpt-architect",
        "--type",
        "review_request",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "PL-AI-0001 ready for independent review",
        "--evidence",
        "required implementation gates green",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.equal(taskOf(repo, "PL-AI-0001").status, "IN_PROGRESS");

    run(repo, CLI, ["process", "gpt-architect"], { LIBERTY_COMMIT_SHA: SHA });
    const submitted = taskOf(repo, "PL-AI-0001");
    assert.equal(
      submitted.status,
      "REVIEW",
      "processing review_request must enter REVIEW",
    );
    assert.equal(ackOf(repo, requestId)?.acknowledgedBy, "gpt-architect");
    assert.equal(journalOf(repo, requestId)?.claimedBy, "gpt-architect");
    assert.equal(
      eventsOf(repo).filter((event) => event.type === "task.review_requested")
        .length,
      1,
      "the bus transition must be audited exactly once",
    );

    // --- GPT -> Claude delivery ---
    const approvalId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "control plane reviewed against pushed SHA",
        "--evidence",
        "https://github.com/CrownOwlP/project-liberty/commit/" + SHA,
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    assert.ok(
      fs.existsSync(busFile(repo, "gpt-to-claude", `${approvalId}.json`)),
      "message must land in the gpt-to-claude lane",
    );

    const inbox = run(repo, CLI, ["inbox", "claude-lead"]);
    assert.match(inbox, new RegExp(approvalId));
    assert.match(inbox, /review_approved/);
    assert.match(inbox, /status=open/);

    // --- processing applies the decision through the enforced path ---
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const reviewed = taskOf(repo, "PL-AI-0001");
    assert.equal(reviewed.review.outcome, "APPROVED");
    assert.equal(reviewed.review.reviewerAgent, "gpt-architect");
    assert.equal(reviewed.review.implementationAgent, "claude-lead");
    assert.equal(
      reviewed.review.reviewedCommitSha,
      SHA,
      "the recorded SHA must be the reviewed one, not HEAD-at-apply-time",
    );

    // --- acknowledgement is explicit and durable ---
    assert.ok(
      fs.existsSync(busFile(repo, "acknowledgements", `${approvalId}.json`)),
    );
    const ack = JSON.parse(
      fs.readFileSync(
        busFile(repo, "acknowledgements", `${approvalId}.json`),
        "utf8",
      ),
    );
    assert.equal(ack.acknowledgedBy, "claude-lead");
    assert.equal(ack.outcome, "processed");

    // --- duplicate processing prevention ---
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
    assert.match(
      run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA }),
      /No unacknowledged messages/,
    );
    runFail(repo, ["ack", approvalId], /already acknowledged/);
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      1,
      "re-processing must not duplicate the review",
    );

    // The bus-delivered approval satisfies the real completion rules.
    run(repo, CLI, ["done", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });
    assert.equal(taskOf(repo, "PL-AI-0001").status, "DONE");

    // --- Claude -> GPT review request ---
    const catalogRequestId = publish(
      repo,
      [
        "--from",
        "claude-lead",
        "--to",
        "gpt-architect",
        "--type",
        "review_request",
        "--task",
        "PL-BUS-0001",
        "--sha",
        SHA,
        "--summary",
        "PL-BUS-0001 ready for review",
        "--evidence",
        "npm run check green",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.ok(
      fs.existsSync(busFile(repo, "claude-to-gpt", `${catalogRequestId}.json`)),
      "outbound message must land in the claude-to-gpt lane",
    );
    assert.match(run(repo, CLI, ["inbox", "gpt-architect"]), /review_request/);

    // --- wrong recipient rejection ---
    assert.doesNotMatch(
      run(repo, CLI, ["inbox", "claude-lead"]),
      new RegExp(catalogRequestId),
    );
    runFail(
      repo,
      ["ack", catalogRequestId, "--agent", "claude-lead"],
      /addressed to gpt-architect, not claude-lead/,
    );

    // --- missing SHA on a review request ---
    runFail(
      repo,
      [
        "handoff",
        "--from",
        "claude-lead",
        "--to",
        "gpt-architect",
        "--type",
        "review_request",
        "--task",
        "PL-BUS-0001",
        "--summary",
        "no sha",
      ],
      /review_request requires commitSha/,
    );

    // --- unknown message type ---
    runFail(
      repo,
      [
        "handoff",
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "gossip",
        "--summary",
        "hello",
      ],
      /Unknown message type/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9b. Stale decisions and reviewer substitution cannot cross the bus.
   * ------------------------------------------------------------------- */
  {
    const OLD = "b".repeat(40);
    const MOVED = "c".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const staleId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        OLD,
        "--summary",
        "approved at an older commit",
      ],
      { LIBERTY_COMMIT_SHA: OLD },
    );

    // HEAD has moved since GPT reviewed: applying now would stamp unreviewed
    // code as approved, so it must be refused.
    runFail(repo, ["process", "claude-lead"], /stale handoff/, {
      LIBERTY_COMMIT_SHA: MOVED,
    });
    assert.equal(
      taskOf(repo, "PL-AI-0001").review,
      undefined,
      "a stale decision must not be recorded",
    );
    assert.ok(
      !fs.existsSync(busFile(repo, "acknowledgements", `${staleId}.json`)),
      "a rejected message must stay unacknowledged so it can be retried",
    );
    assert.equal(taskOf(repo, "PL-AI-0001").status, "REVIEW");

    // Fail closed: with no resolvable HEAD the decision cannot be verified, so
    // it must be refused rather than accepted on trust.
    runFail(repo, ["process", "claude-lead"], /cannot resolve HEAD/);
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);

    // A ref name or abbreviated sha is rejected at publish time.
    runFail(
      repo,
      [
        "handoff",
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        "HEAD",
        "--summary",
        "approving whatever main points at",
      ],
      /commitSha must be a full 40-character hex sha/,
    );

    // Message ids are path-constrained: a peer cannot steer the acknowledgement
    // write outside the bus directory.
    runFail(
      repo,
      ["ack", "../../../scripts/agent-bus"],
      /unsafe or malformed message id/,
    );

    // Reviewer substitution is still refused even when it arrives over the bus.
    publish(
      repo,
      [
        "--from",
        "claude-security",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        MOVED,
        "--summary",
        "standing in for the gpt lane",
      ],
      { LIBERTY_COMMIT_SHA: MOVED },
    );
    runFail(
      repo,
      ["process", "claude-lead"],
      /requires independent review by gpt-architect/,
      { LIBERTY_COMMIT_SHA: MOVED },
    );
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);
  }

  /* ---------------------------------------------------------------------
   * 9c. changes_requested and out-of-state decisions.
   * ------------------------------------------------------------------- */
  {
    const SHA = "d".repeat(40);
    const repo = freshRepo();

    // The "never submitted" half of this scenario needs a task that is NOT in
    // REVIEW. Any READY task satisfies that, so it is a fixture: borrowing a
    // real one would make the scenario quietly depend on that task never being
    // submitted for review, which is a promise the project cannot keep.
    addFixtureTasks(
      repo,
      fixtureTask("PL-BUS-0002", {
        title: "PL-BUS-0002 never-submitted task",
        allowedPaths: ["fixtures/bus/b/**"],
        acceptance: "fixture task addressed by the handoff-bus scenarios",
      }),
    );
    implementToReview(repo);

    publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "changes_requested",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "dispatcher still starves executable lanes",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const task = taskOf(repo, "PL-AI-0001");
    assert.equal(
      task.status,
      "IN_PROGRESS",
      "changes_requested must return the task to IN_PROGRESS",
    );
    assert.equal(task.review.outcome, "CHANGES_REQUESTED");

    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /review outcome is CHANGES_REQUESTED/,
    );

    // A decision aimed at a task that is not in REVIEW is refused rather than
    // silently applied.
    publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-BUS-0002",
        "--sha",
        SHA,
        "--summary",
        "approving something that was never submitted",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    const earlyId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-BUS-0002",
        "--sha",
        SHA,
        "--summary",
        "approving something that was never submitted",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    runFail(
      repo,
      ["process", "claude-lead"],
      /only applies to a task in REVIEW/,
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // Arriving early is a property of repository state, not of the message, so
    // it must be retried rather than permanently quarantined.
    assert.equal(
      rejectionOf(repo, earlyId),
      null,
      "a transient failure must not be quarantined",
    );
    assert.equal(ackOf(repo, earlyId), null);
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      new RegExp(earlyId),
      "it must stay in the inbox for retry",
    );
  }

  /* ---------------------------------------------------------------------
   * 9d. Informational traffic is acknowledged without moving task state.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();

    // The decision below has to name a task that exists, and nothing else about
    // that task is load-bearing. A fixture says so; a real id would imply the
    // scenario cared which task it was.
    addFixtureTasks(
      repo,
      fixtureTask("PL-BUS-0003", {
        title: "PL-BUS-0003 informational-traffic subject",
        allowedPaths: ["fixtures/bus/c/**"],
        acceptance: "fixture task addressed by the handoff-bus scenarios",
      }),
    );
    const before = JSON.stringify(tasksOf(repo));

    publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "prioritise the GitHub bridge over product work",
    ]);
    publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "architecture_decision",
      "--task",
      "PL-BUS-0003",
      "--summary",
      "better-auth pulls zod 4; contracts stay on zod 3 behind a nominal boundary",
    ]);

    run(repo, CLI, ["process", "claude-lead"]);
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      before,
      "informational messages must not move task state",
    );
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9e. Audit events are emitted only after the durable commit.
   * ------------------------------------------------------------------- */
  {
    const SHA = "e".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    // A message that will fail during validation must leave NO audit trace.
    const badId = publish(
      repo,
      [
        "--from",
        "claude-security",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "not the designated reviewer",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    runFail(repo, ["process", "claude-lead"], /requires independent review/, {
      LIBERTY_COMMIT_SHA: SHA,
    });

    const afterFailure = eventsOf(repo);
    assert.equal(
      afterFailure.filter((e) => e.type === "task.review_recorded").length,
      0,
      "a rejected review must not appear in the audit log",
    );
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);

    // It was quarantined on first detection, so it no longer blocks later runs.
    assert.ok(
      rejectionOf(repo, badId),
      "a permanently-invalid message must be quarantined",
    );
    assert.equal(
      ackOf(repo, badId),
      null,
      "quarantine must not create a success acknowledgement",
    );

    // A successful message emits exactly one review event, and only after the
    // task state and acknowledgement are durable.
    const okId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const events = eventsOf(repo);
    const reviewEvents = events.filter(
      (e) => e.type === "task.review_recorded",
    );
    assert.equal(reviewEvents.length, 1);
    assert.equal(reviewEvents[0]?.reviewedCommitSha, SHA);
    assert.equal(journalOf(repo, okId)?.state, "ACKNOWLEDGED");
    assert.ok(ackOf(repo, okId));

    // Ordering: the review event must come after the task state was written,
    // which is observable as the processed event following it in the log.
    const reviewIndex = events.findIndex(
      (e) => e.type === "task.review_recorded",
    );
    const processedIndex = events.findIndex(
      (e) => e.type === "bus.message_processed",
    );
    assert.ok(
      reviewIndex >= 0 && processedIndex > reviewIndex,
      "processed event must follow the review event",
    );
  }

  /* ---------------------------------------------------------------------
   * 9f. Crash AFTER claim, BEFORE task save -> redo, losing nothing.
   * ------------------------------------------------------------------- */
  {
    const SHA = "f".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const id = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved before the crash",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // The run died holding the claim, before task state was persisted.
    simulateCrash(repo, id, "APPLYING");
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);

    // Recovery releases the claim; the same run then reprocesses it cleanly.
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const task = taskOf(repo, "PL-AI-0001");
    assert.equal(
      task.review.outcome,
      "APPROVED",
      "an interrupted claim must not lose the transition",
    );
    assert.equal(
      task.reviewHistory.length,
      1,
      "recovery must not duplicate the review",
    );
    assert.equal(journalOf(repo, id)?.state, "ACKNOWLEDGED");
    assert.equal(
      eventsOf(repo).filter((e) => e.type === "task.review_recorded").length,
      1,
      "recovery must not duplicate the audit event",
    );
  }

  /* ---------------------------------------------------------------------
   * 9g. Crash AFTER task save, BEFORE acknowledgement -> finish, never redo.
   * ------------------------------------------------------------------- */
  {
    const SHA = "1".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const id = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved, crash before ack",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const historyLength = taskOf(repo, "PL-AI-0001").reviewHistory.length;
    assert.equal(historyLength, 1);

    // Rewind to the exact crash window: task state persisted, journal APPLIED,
    // acknowledgement not yet written.
    fs.rmSync(
      path.join(
        repo,
        "coordination",
        "agent-bus",
        "acknowledgements",
        `${id}.json`,
      ),
    );
    simulateCrash(repo, id, "APPLIED", {
      applied: "APPROVED recorded on PL-AI-0001 by gpt-architect",
    });

    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    assert.ok(ackOf(repo, id), "recovery must finalize the acknowledgement");
    assert.equal(journalOf(repo, id)?.state, "ACKNOWLEDGED");
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      historyLength,
      "recovery of an APPLIED message must NOT re-apply the review",
    );

    // Repeated recovery is idempotent.
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      historyLength,
    );
    assert.match(
      run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA }),
      /No unacknowledged messages/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9h. Recovery is isolated by journal owner AND message recipient.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const ownedByClaude = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "Claude-owned interrupted work",
    ]);
    const addressedToClaude = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "architecture_decision",
      "--summary",
      "Recipient must recover this",
    ]);

    simulateCrash(repo, ownedByClaude, "APPLIED", {
      claimedBy: "claude-lead",
      applied: "Claude transaction applied",
      audit: [
        { type: "task.review_recorded", details: { taskId: "PL-AI-0001" } },
      ],
    });
    simulateCrash(repo, addressedToClaude, "ACKNOWLEDGED", {
      claimedBy: "gpt-architect",
      applied: "recipient-mismatched transaction",
      eventsEmitted: false,
      audit: [
        { type: "task.review_recorded", details: { taskId: "PL-AI-0001" } },
      ],
    });
    resetEventLog(repo);

    const ownerJournalBefore = fs.readFileSync(
      busFile(repo, "journal", `${ownedByClaude}.json`),
      "utf8",
    );
    const recipientJournalBefore = fs.readFileSync(
      busFile(repo, "journal", `${addressedToClaude}.json`),
      "utf8",
    );

    const processOut = run(repo, CLI, ["process", "gpt-architect"]);
    assert.match(processOut, /SKIP FOREIGN/);
    const recoverOut = run(repo, CLI, ["recover", "gpt-architect"]);
    assert.match(recoverOut, /skipped 2 foreign transaction/);

    assert.equal(
      ackOf(repo, ownedByClaude),
      null,
      "another agent's journal must not be acknowledged",
    );
    assert.equal(
      ackOf(repo, addressedToClaude),
      null,
      "recipient mismatch must not be acknowledged",
    );
    assert.equal(
      fs.readFileSync(
        busFile(repo, "journal", `${ownedByClaude}.json`),
        "utf8",
      ),
      ownerJournalBefore,
      "foreign ownership must leave the journal untouched",
    );
    assert.equal(
      fs.readFileSync(
        busFile(repo, "journal", `${addressedToClaude}.json`),
        "utf8",
      ),
      recipientJournalBefore,
      "foreign recipient must leave the journal untouched",
    );
    assert.deepEqual(
      eventsOf(repo),
      [],
      "foreign recovery must emit no audit or processed records",
    );
  }

  /* ---------------------------------------------------------------------
   * 9i. Malformed peer messages are isolated, not fatal.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const lane = path.join(repo, "coordination", "agent-bus", "gpt-to-claude");

    // Unparseable, structurally invalid, and filename/id mismatch respectively.
    fs.writeFileSync(
      path.join(lane, "MSG-20260815T000000000Z-blocker-deadbeef.json"),
      "{ not json",
    );
    fs.writeFileSync(
      path.join(lane, "MSG-20260815T000000001Z-blocker-deadbeee.json"),
      JSON.stringify({
        id: "MSG-20260815T000000001Z-blocker-deadbeee",
        fromAgent: "gpt-architect",
      }),
    );
    fs.writeFileSync(
      path.join(lane, "MSG-20260815T000000002Z-blocker-deadbeef.json"),
      JSON.stringify({
        id: "MSG-20260815T000000009Z-blocker-cafebabe",
        fromAgent: "gpt-architect",
        toAgent: "claude-lead",
        type: "blocker",
        summary: "id does not match filename",
        createdAt: "2026-08-15T00:00:00.002Z",
        status: "open",
      }),
    );

    // A good message still gets through despite the malformed neighbours.
    const goodId = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "still deliverable",
    ]);

    const inbox = run(repo, CLI, ["inbox", "claude-lead"]);
    assert.match(inbox, new RegExp(goodId));
    assert.doesNotMatch(
      inbox,
      /cafebabe/,
      "a filename/id mismatch must be ignored",
    );

    const rejectionDir = path.join(repo, "coordination", "agent-bus", "rejections");
    const stateBefore = JSON.stringify(tasksOf(repo));

    // FIRST RUN: three NEW permanent rejections are discovered, so the run must
    // report failure. Quarantining is not a silent success.
    const first = runFail(repo, ["process", "claude-lead"], /REJECT/);
    assert.match(
      first,
      /3 newly rejected/,
      `expected three new rejections, got:\n${first}`,
    );

    // The valid message queued behind them was still processed.
    assert.ok(
      ackOf(repo, goodId),
      "a valid message must not be blocked behind malformed ones",
    );

    // Every malformed file has a durable rejection record and no acknowledgement.
    const records = fs
      .readdirSync(rejectionDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) =>
        JSON.parse(fs.readFileSync(path.join(rejectionDir, n), "utf8")),
      );
    assert.equal(
      records.length,
      3,
      `expected 3 quarantine records, got ${records.length}`,
    );
    for (const record of records) {
      assert.ok(record.reason, "every rejection must carry a reason");
      assert.ok(record.rejectedAt, "every rejection must carry a timestamp");
      assert.equal(
        ackOf(repo, record.messageId),
        null,
        "quarantine must never create a success acknowledgement",
      );
    }

    // Malformed input never moves task state.
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      stateBefore,
      "malformed files must not mutate task state",
    );

    const eventsAfterFirst = eventsOf(repo);

    // SECOND RUN: the same immutable files must not fail the run again.
    const second = run(repo, CLI, ["process", "claude-lead"]);
    assert.doesNotMatch(
      second,
      /REJECT/,
      "already-quarantined files must not be re-reported",
    );
    assert.match(second, /No unacknowledged messages/);

    // Nothing duplicated: no extra rejection, event, ack or task transition.
    assert.equal(
      fs.readdirSync(rejectionDir).filter((n) => n.endsWith(".json")).length,
      3,
      "no duplicate rejection records",
    );
    assert.equal(
      eventsOf(repo).length,
      eventsAfterFirst.length,
      "a no-op run must not append events",
    );
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      stateBefore,
      "no task transition on the second run",
    );

    // The inbox is not wedged.
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9i. Quarantine: a permanently-invalid message is rejected once, never
   *     acknowledged, never blocks valid traffic, and never wedges the queue.
   * ------------------------------------------------------------------- */
  {
    const SHA = "2".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);
    const stateBefore = JSON.stringify(tasksOf(repo));

    // Permanently invalid: wrong reviewer for this task. The message is
    // immutable, so this can never become valid.
    const badId = publish(
      repo,
      [
        "--from",
        "claude-security",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "not the designated reviewer",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // A valid message queued behind it must still get through.
    const goodId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "genuine independent approval",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // First detection reports failure...
    const firstRun = runFail(repo, ["process", "claude-lead"], /REJECT/, {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.match(firstRun, /newly rejected/);

    // ...but the valid message behind it was still applied.
    assert.equal(
      taskOf(repo, "PL-AI-0001").review?.reviewerAgent,
      "gpt-architect",
    );
    assert.ok(ackOf(repo, goodId));

    // The rejection is durable, shared, and carries a reason.
    const rejection = rejectionOf(repo, badId);
    assert.ok(rejection, "rejection record must be written");
    assert.equal(rejection.messageId, badId);
    assert.equal(rejection.rejectedBy, "claude-lead");
    assert.match(
      rejection.reason,
      /requires independent review by gpt-architect/,
    );
    assert.ok(rejection.rejectedAt);
    assert.equal(rejection.fromAgent, "claude-security");

    // A rejection is NOT an acknowledgement, and the two must stay disjoint:
    // acking a quarantined message would report it as successfully processed.
    assert.equal(
      ackOf(repo, badId),
      null,
      "rejection must not create a success acknowledgement",
    );
    runFail(
      repo,
      ["ack", badId, "--agent", "claude-lead"],
      /a rejection is not an acknowledgement/,
    );
    assert.equal(ackOf(repo, badId), null);

    // The rejected message never touched task state: the only change is the
    // review that the VALID message applied.
    const afterState = JSON.parse(JSON.stringify(tasksOf(repo)));
    const beforeState = JSON.parse(stateBefore);
    for (const task of afterState) {
      if (task.id === "PL-AI-0001") continue;
      assert.deepEqual(
        task,
        beforeState.find((t) => t.id === task.id),
        `${task.id} must be untouched`,
      );
    }
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      1,
      "only the valid review may be recorded",
    );

    // A second run does NOT fail again on the same immutable rejection.
    const secondRun = run(repo, CLI, ["process", "claude-lead"], {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.match(secondRun, /previously rejected|No unacknowledged messages/);

    // A rejected message is hidden from the working inbox but visible with --all.
    assert.doesNotMatch(
      run(repo, CLI, ["inbox", "claude-lead"]),
      new RegExp(badId),
    );
    const full = run(repo, CLI, ["inbox", "claude-lead", "--all"]);
    assert.match(full, new RegExp(badId));
    assert.match(full, /rejected: /);

    // Another checkout observes the SHARED rejection and does not re-trigger it.
    const other = cloneRepo(repo);
    assert.ok(
      rejectionOf(other, badId),
      "rejection must travel with the repository",
    );
    const otherRun = run(other, CLI, ["process", "claude-lead"], {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.doesNotMatch(
      otherRun,
      /REJECT/,
      "a second checkout must not re-reject a known-bad message",
    );
  }

  /* ---------------------------------------------------------------------
   * 9j. Audit exactly-once across the emit -> crash -> recover window.
   * ------------------------------------------------------------------- */
  {
    const SHA = "3".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const id = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const baseline = eventsOf(repo);
    const reviewEvents = baseline.filter(
      (e) => e.type === "task.review_recorded",
    );
    const processedEvents = baseline.filter(
      (e) => e.type === "bus.message_processed",
    );
    assert.equal(reviewEvents.length, 1);
    assert.equal(processedEvents.length, 1);
    assert.ok(
      reviewEvents[0]?.eventId,
      "bus audit records must carry a deterministic id",
    );

    // Rewind to the precise gap GPT identified: the events were written, then
    // the run died before the journal recorded that they had been.
    simulateCrash(repo, id, "ACKNOWLEDGED", {
      applied:
        taskOf(repo, "PL-AI-0001").review.outcome +
        " recorded on PL-AI-0001 by gpt-architect",
      eventsEmitted: false,
      audit: [
        {
          type: "task.review_recorded",
          details: { taskId: "PL-AI-0001", reviewerAgent: "gpt-architect" },
        },
      ],
    });

    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const after = eventsOf(repo);
    assert.equal(
      after.filter((e) => e.type === "task.review_recorded").length,
      1,
      "recovery must not write a second physical copy of an already-emitted audit record",
    );
    assert.equal(
      after.filter((e) => e.type === "bus.message_processed").length,
      1,
      "recovery must not duplicate the processed record either",
    );
    assert.equal(journalOf(repo, id)?.eventsEmitted, true);

    // Repeated recovery stays exactly-once.
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const finalEvents = eventsOf(repo);
    assert.equal(
      finalEvents.filter((e) => e.type === "task.review_recorded").length,
      1,
    );
    assert.equal(
      finalEvents.filter((e) => e.type === "bus.message_processed").length,
      1,
    );
    assert.equal(taskOf(repo, "PL-AI-0001").reviewHistory.length, 1);
  }

  /* ---------------------------------------------------------------------
   * 9k. Malformed peer files are quarantined, not silently dropped.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const lane = path.join(repo, "coordination", "agent-bus", "gpt-to-claude");

    const invalidJson = "MSG-20260815T000000000Z-blocker-aaaaaaaa.json";
    const structurallyInvalid = "MSG-20260815T000000001Z-blocker-bbbbbbbb.json";
    const idMismatch = "MSG-20260815T000000002Z-blocker-cccccccc.json";
    const unsafeName = "..%2F..%2Fescape.json";

    fs.writeFileSync(path.join(lane, invalidJson), "{ not json");
    fs.writeFileSync(
      path.join(lane, structurallyInvalid),
      JSON.stringify({
        id: "MSG-20260815T000000001Z-blocker-bbbbbbbb",
        fromAgent: "gpt-architect",
      }),
    );
    fs.writeFileSync(
      path.join(lane, idMismatch),
      JSON.stringify({
        id: "MSG-20260815T000000009Z-blocker-dddddddd",
        fromAgent: "gpt-architect",
        toAgent: "claude-lead",
        type: "blocker",
        summary: "id does not match filename",
        createdAt: "2026-08-15T00:00:00.002Z",
        status: "open",
      }),
    );
    fs.writeFileSync(
      path.join(lane, unsafeName),
      JSON.stringify({ id: "../../../escape" }),
    );

    // A valid message behind them must still get through.
    const goodId = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "still deliverable",
    ]);

    const stateBefore = JSON.stringify(tasksOf(repo));
    const first = runFail(repo, ["process", "claude-lead"], /REJECT/);

    // Every malformed file became a durable rejection record.
    const rejectionDir = path.join(
      repo,
      "coordination",
      "agent-bus",
      "rejections",
    );
    const records = fs
      .readdirSync(rejectionDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) =>
        JSON.parse(fs.readFileSync(path.join(rejectionDir, n), "utf8")),
      );
    assert.equal(
      records.length,
      4,
      `expected 4 quarantine records, got ${records.length}`,
    );

    const byFile = new Map(records.map((r) => [r.originalFilename, r]));
    assert.match(byFile.get(invalidJson).reason, /not valid JSON/);
    assert.match(
      byFile.get(structurallyInvalid).reason,
      /structurally invalid/,
    );
    assert.match(byFile.get(idMismatch).reason, /does not match filename/);

    // An unsafe filename gets a deterministic derived key, never a path.
    const unsafeRecord = byFile.get(unsafeName);
    assert.ok(unsafeRecord, "an unsafe filename must still be quarantined");
    assert.match(unsafeRecord.messageId, /^MALFORMED-[0-9a-f]{16}$/);
    assert.equal(
      unsafeRecord.originalFilename,
      unsafeName,
      "the original filename is preserved as evidence",
    );
    assert.match(unsafeRecord.reason, /filename is not a safe message id/);

    // No task state touched, no success acknowledgement, valid message applied.
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      stateBefore,
      "malformed files must not mutate task state",
    );
    assert.ok(
      ackOf(repo, goodId),
      "a valid message must not be blocked behind malformed ones",
    );
    for (const record of records) {
      assert.equal(
        ackOf(repo, record.messageId),
        null,
        "quarantine must never create an acknowledgement",
      );
    }
    assert.match(first, /newly rejected/);

    // Second run does not rediscover them as new failures.
    const second = run(repo, CLI, ["process", "claude-lead"]);
    assert.doesNotMatch(
      second,
      /REJECT/,
      "already-quarantined files must not be re-reported",
    );
    assert.equal(
      fs.readdirSync(rejectionDir).filter((n) => n.endsWith(".json")).length,
      4,
      "no duplicate rejection records",
    );
  }

  /* ---------------------------------------------------------------------
   * 9l. Fingerprints are canonical git content, not platform-dependent bytes.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        // Drop stderr: `git add -A` emits a CRLF advisory per file under a
        // global core.autocrlf, which buries the actual test output.
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    const sha = git("rev-parse", "HEAD").trim();

    const statusOf = (extraEnv = {}) =>
      JSON.parse(run(repo, CLI, ["review-status", "PL-AI-0001"], extraEnv));

    const lfHash = statusOf().currentTreeHash;

    // Simulate a Windows checkout: rewrite the working tree with CRLF endings.
    // The COMMITTED content is unchanged, so the canonical fingerprint must not
    // move -- this is the multi-worker trap the old byte-hashing had.
    const target = path.join(repo, "AGENTS.md");
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, original.replace(/\r?\n/g, "\r\n"));

    const crlfHash = statusOf().currentTreeHash;
    assert.equal(
      crlfHash,
      lfHash,
      "line-ending conversion in the working tree must not change the review fingerprint",
    );

    // But the dirty tree is still detected, so it cannot reach DONE unnoticed.
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--", "AGENTS.md"],
      { cwd: repo, encoding: "utf8" },
    );
    if (dirty.trim()) {
      implementToReview(repo);
      run(repo, CLI, [
        "approve",
        "PL-AI-0001",
        "gpt-architect",
        "approved at " + sha,
      ]);
      const problems = JSON.parse(
        run(repo, CLI, ["review-status", "PL-AI-0001"]),
      ).blockingProblems;
      assert.ok(
        problems.some((p) => /uncommitted changes/.test(p)),
        `a dirty implementation tree must block completion, got: ${JSON.stringify(problems)}`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9m. Review-base contract: fail closed, never fall back to the parent.
   * ------------------------------------------------------------------- */
  {
    const START = "7".repeat(40);
    const HEAD1 = "8".repeat(40);
    const repo = freshRepo();

    // `start` captures the commit implementation began from.
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], {
      LIBERTY_COMMIT_SHA: START,
    });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], {
      LIBERTY_COMMIT_SHA: START,
    });
    assert.equal(
      taskOf(repo, "PL-AI-0001").implementationBaseSha,
      START,
      "start must record the commit implementation began from",
    );

    // Starting again must not overwrite the base within the same round.
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], {
      LIBERTY_COMMIT_SHA: HEAD1,
    });
    assert.equal(taskOf(repo, "PL-AI-0001").implementationBaseSha, START);

    // A review_request with NO base is refused at publish time.
    runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--summary", "no base supplied",
      ],
      /requires an explicit baseSha/,
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    // An empty range is refused.
    runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--base", HEAD1,
        "--summary", "empty range",
      ],
      /empty range reviews nothing/,
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    // A malformed base is refused.
    runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--base", "HEAD~1",
        "--summary", "ref name instead of sha",
      ],
      /baseSha must be a full 40-character hex sha/,
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    // FIRST review: --base auto resolves to implementationBaseSha.
    const firstId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--base", "auto",
        "--summary", "first review",
      ],
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );
    const firstMsg = JSON.parse(
      fs.readFileSync(busFile(repo, "claude-to-gpt", `${firstId}.json`), "utf8"),
    );
    assert.equal(
      firstMsg.baseSha,
      START,
      "a first review must span implementationBaseSha..commitSha",
    );
    assert.equal(firstMsg.commitSha, HEAD1);

    // RE-review: --base auto resolves to the previously reviewed commit.
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], {
      LIBERTY_COMMIT_SHA: HEAD1,
    });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: HEAD1 });
    run(
      repo,
      CLI,
      ["approve", "PL-AI-0001", "gpt-architect", "reviewed the first range"],
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    const HEAD2 = "9".repeat(40);
    const secondId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD2,
        "--base", "auto",
        "--summary", "re-review after corrections",
      ],
      { LIBERTY_COMMIT_SHA: HEAD2 },
    );
    const secondMsg = JSON.parse(
      fs.readFileSync(busFile(repo, "claude-to-gpt", `${secondId}.json`), "utf8"),
    );
    assert.equal(
      secondMsg.baseSha,
      HEAD1,
      "a re-review must span previousReviewedCommitSha..newCommitSha",
    );
    assert.equal(secondMsg.commitSha, HEAD2);
  }

  /* ---------------------------------------------------------------------
   * 9n. --base auto fails closed when no base can be established.
   *
   *     Planned over a FIXTURE, not a real task. This scenario used to point at
   *     PL-0003 on the grounds that it "was never started, so in a reset repo it
   *     has no base" -- an observation about that week's data, not a property of
   *     the control plane. PL-0003 was then implemented, reviewed and completed;
   *     the live record gained an implementationBaseSha (and a reviewHistory),
   *     resetRuntimeState was not clearing the former, `--base auto` resolved
   *     it, and a scenario asserting that a command FAILS started failing
   *     because the command succeeded.
   *
   *     `--base auto` consults exactly two fields, in this order:
   *       1. reviewHistory[].reviewedCommitSha  (latest 40-hex sha != --sha)
   *       2. implementationBaseSha
   *     The fixture below has neither, and asserts that it has neither before
   *     using it -- so the refusal is caused by an unresolvable base rather than
   *     by anything incidental. The positive control at the end closes the other
   *     half: once a base exists, the same command publishes.
   * ------------------------------------------------------------------- */
  {
    const START = "a0".repeat(20);
    const SHA = "a1".repeat(20);
    const repo = freshRepo();

    addFixtureTasks(
      repo,
      fixtureTask("PL-NB-0001", {
        title: "PL-NB-0001 task with no resolvable review base",
        allowedPaths: ["fixtures/nb/**"],
        acceptance: "fixture task used by the review-base resolution scenarios",
      }),
    );

    // The fixture is baseless for the RIGHT reason: both inputs to the
    // resolution are absent, so neither branch can produce a value.
    const baseless = taskOf(repo, "PL-NB-0001");
    assert.equal(
      baseless.implementationBaseSha,
      undefined,
      "the fixture must carry no implementation base",
    );
    assert.equal(
      baseless.reviewHistory,
      undefined,
      "the fixture must carry no prior review to resolve a base from",
    );

    // There must be NO parent-commit fallback.
    const out = runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-NB-0001",
        "--sha", SHA,
        "--base", "auto",
        "--summary", "no base can be resolved",
      ],
      /could not resolve a review base/,
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.match(
      out,
      /no parent-commit fallback/,
      "the failure must state that no implicit fallback exists",
    );

    // Nothing was published.
    const lane = busFile(repo, "claude-to-gpt");
    const published = () =>
      fs.readdirSync(lane).filter((n) => n.endsWith(".json"));
    assert.equal(published().length, 0, "a failed base resolution must publish nothing");

    /*
     * POSITIVE CONTROL.
     *
     * Starting the same fixture captures a base, and the identical command then
     * succeeds. Without this, the scenario would still pass if `handoff` began
     * refusing this fixture for some entirely different reason -- an unknown
     * task, a rejected lane, a schema check -- and would quietly stop testing
     * base resolution at all.
     */
    run(repo, CLI, ["claim", "PL-NB-0001", "claude-frontend"], {
      LIBERTY_COMMIT_SHA: START,
    });
    run(repo, CLI, ["start", "PL-NB-0001", "claude-frontend"], {
      LIBERTY_COMMIT_SHA: START,
    });
    assert.equal(
      taskOf(repo, "PL-NB-0001").implementationBaseSha,
      START,
      "start must capture the base this scenario was previously missing",
    );

    const resolvedId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-NB-0001",
        "--sha", SHA,
        "--base", "auto",
        "--summary", "the same request, now that a base exists",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    const resolved = JSON.parse(
      fs.readFileSync(path.join(lane, `${resolvedId}.json`), "utf8"),
    );
    assert.equal(
      resolved.baseSha,
      START,
      "the refusal above must have been about the missing base and nothing else",
    );
    assert.equal(published().length, 1);
  }

  /* ---------------------------------------------------------------------
   * 9o. Inbound review decisions are range-checked on RECEIPT.
   *     Creation-time checks only bind our own producer; a peer-authored file
   *     is untrusted and may be hand-written, stale, or replayed.
   * ------------------------------------------------------------------- */
  {
    const START = "b1".repeat(20);
    const HEAD = "b2".repeat(20);
    const WRONG = "b3".repeat(20);
    const repo = freshRepo();
    const lane = busFile(repo, "gpt-to-claude");

    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: HEAD });

    /** Hand-write a decision file the way an untrusted peer would. */
    const forge = (id, extra) => {
      const message = {
        id,
        fromAgent: "gpt-architect",
        toAgent: "claude-lead",
        taskId: "PL-AI-0001",
        type: "review_approved",
        commitSha: HEAD,
        summary: "hand-written decision",
        evidence: [],
        createdAt: "2026-08-15T00:00:00.000Z",
        status: "open",
        ...extra,
      };
      fs.writeFileSync(path.join(lane, `${id}.json`), JSON.stringify(message, null, 2) + "\n");
      return id;
    };

    // No baseSha at all.
    forge("MSG-20260815T000000000Z-review_approved-11111111", { baseSha: null });
    runFail(repo, ["process", "claude-lead"], /carries no baseSha/, { LIBERTY_COMMIT_SHA: HEAD });
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "a decision with no range must not be recorded");

    // A base that is valid in form but narrows the range, hiding earlier work.
    forge("MSG-20260815T000000001Z-review_approved-22222222", { baseSha: WRONG });
    runFail(repo, ["process", "claude-lead"], /expects a review starting at/, { LIBERTY_COMMIT_SHA: HEAD });
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "a wrong range must not be recorded");

    // Empty range.
    forge("MSG-20260815T000000002Z-review_approved-33333333", { baseSha: HEAD });
    runFail(repo, ["process", "claude-lead"], /empty range reviews nothing/, { LIBERTY_COMMIT_SHA: HEAD });

    // All three were quarantined, not merely skipped.
    const rejections = fs
      .readdirSync(busFile(repo, "rejections"))
      .filter((n) => n.endsWith(".json"));
    assert.equal(rejections.length, 3, `expected 3 quarantined decisions, got ${rejections.length}`);

    // The correct range is accepted, and the record persists BOTH endpoints.
    forge("MSG-20260815T000000003Z-review_approved-44444444", { baseSha: START });
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: HEAD });
    const review = taskOf(repo, "PL-AI-0001").review;
    assert.equal(review.outcome, "APPROVED");
    assert.equal(review.reviewedBaseSha, START, "the review record must persist the range base");
    assert.equal(review.reviewedCommitSha, HEAD, "the review record must persist the range head");
  }

  /* ---------------------------------------------------------------------
   * 9p. A legacy no-base request is handled once and never wedges the worker,
   *     and a valid request behind it still gets through.
   * ------------------------------------------------------------------- */
  {
    const START = "c1".repeat(20);
    const HEAD = "c2".repeat(20);
    const repo = freshRepo();
    const lane = busFile(repo, "claude-to-gpt");

    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });

    // A request published before the baseSha schema existed, as found on main.
    const legacyId = "MSG-20260815T052113388Z-review_request-31445801";
    fs.writeFileSync(
      path.join(lane, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          fromAgent: "claude-lead",
          toAgent: "gpt-architect",
          taskId: "PL-AI-0001",
          type: "review_request",
          commitSha: HEAD,
          summary: "legacy request with no baseSha",
          evidence: [],
          createdAt: "2026-08-15T05:21:13.388Z",
          status: "open",
        },
        null,
        2,
      ) + "\n",
    );

    // A well-formed request published afterwards.
    const validId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD,
        "--base", "auto",
        "--summary", "valid request behind the legacy one",
      ],
      { LIBERTY_COMMIT_SHA: HEAD },
    );

    // The legacy file is structurally valid, so it is DELIVERABLE: the reviewer
    // itself must reject it. Both appear in the gpt-architect inbox.
    const inbox = run(repo, CLI, ["inbox", "gpt-architect"]);
    assert.match(inbox, new RegExp(legacyId), "a legacy request must still be visible, not silently dropped");
    assert.match(inbox, new RegExp(validId));

    // The valid one carries a resolved range; the legacy one does not. This is
    // the distinction the cloud reviewer fails closed on, before any model call.
    const legacyMsg = JSON.parse(fs.readFileSync(path.join(lane, `${legacyId}.json`), "utf8"));
    const validMsg = JSON.parse(fs.readFileSync(path.join(lane, `${validId}.json`), "utf8"));
    assert.equal(legacyMsg.baseSha, undefined, "the legacy fixture must have no baseSha");
    assert.equal(validMsg.baseSha, START, "the valid request must span implementationBaseSha..commitSha");
  }

  /* ---------------------------------------------------------------------
   * 9q. A DONE task proves its own history; it does not write-lock its paths.
   *
   *     PL-AI-0001 and PL-AI-0002 both own scripts/** and control/**. Once
   *     PL-AI-0001 completes, successor work on those paths must not make
   *     validation declare the finished task broken.
   * ------------------------------------------------------------------- */
  {
    const SHA = "d1".repeat(20);
    const repo = freshRepo();

    // --- Task A: implement, review, complete ---
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "reviewed"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["done", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });
    assert.equal(taskOf(repo, "PL-AI-0001").status, "DONE");

    // Validation is clean immediately after completion.
    run(repo, CLI, ["validate"], { LIBERTY_COMMIT_SHA: SHA });

    // --- Task B: successor work on an OVERLAPPING path ---
    // PL-AI-0002 owns scripts/** too. Editing there is legitimate.
    run(repo, CLI, ["claim", "PL-AI-0002", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-AI-0002", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    fs.appendFileSync(
      path.join(repo, "scripts", "validate-repo.mjs"),
      "\n// successor work by PL-AI-0002\n",
    );

    // THE REGRESSION: the completed task must still validate. Its paths changed,
    // but its historical review integrity is untouched.
    const out = run(repo, CLI, ["validate"], { LIBERTY_COMMIT_SHA: SHA });
    assert.match(out, /AI control plane valid/);
    assert.doesNotMatch(
      out,
      /PL-AI-0001 is DONE but/,
      "a completed task must not be invalidated by later work on its old paths",
    );

    // --- But Task B's own unreviewed state still blocks Task B ---
    run(repo, CLI, ["gate", "PL-AI-0002", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0002", "security-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["review", "PL-AI-0002"], { LIBERTY_COMMIT_SHA: SHA });
    runFail(
      repo,
      ["done", "PL-AI-0002"],
      /no independent review record/,
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.equal(
      taskOf(repo, "PL-AI-0002").status,
      "REVIEW",
      "the successor task must still require its own independent review",
    );

    // A DONE task with a tampered review record IS still an error.
    const tasksFile = path.join(repo, "control", "tasks.json");
    const doc = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const completed = doc.tasks.find((t) => t.id === "PL-AI-0001");
    completed.review.reviewerAgent = completed.review.implementationAgent;
    fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2) + "\n");
    runFail(repo, ["validate"], /self-approval/, { LIBERTY_COMMIT_SHA: SHA });
  }

  /* ---------------------------------------------------------------------
   * 9r. Fingerprint provenance compatibility for historical DONE records.
   *
   *     Records written after canonical fingerprinting but before the
   *     reviewedFingerprintSource field carry canonical hashes. They must be
   *     fully verified, not silently demoted to structural-only checks.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    // Complete a task with a real canonical fingerprint.
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"]);
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"]);
    run(repo, CLI, ["review", "PL-AI-0001"]);
    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "reviewed"]);
    run(repo, CLI, ["done", "PL-AI-0001"]);

    const original = taskOf(repo, "PL-AI-0001").review;
    assert.equal(
      original.reviewedFingerprintSource,
      "git-object",
      "a new record must declare its fingerprint provenance",
    );

    const tasksFile = path.join(repo, "control", "tasks.json");
    const patchReview = (mutate) => {
      const doc = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
      const task = doc.tasks.find((t) => t.id === "PL-AI-0001");
      task.review = { ...original };
      mutate(task.review);
      fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2) + "\n");
    };

    // (a) Missing source + canonical hash -> verified fully, not demoted.
    patchReview((r) => {
      delete r.reviewedFingerprintSource;
    });
    assert.match(
      run(repo, CLI, ["validate"]),
      /AI control plane valid/,
      "a pre-field record whose hash IS canonical must validate",
    );

    // (b) Missing source + non-reproducible hash that is NOT a known legacy
    //     record -> hard failure. A mismatch alone must never be accepted as
    //     evidence of a pre-canonical record, or a tampered record would
    //     downgrade itself into structural-only validation.
    patchReview((r) => {
      delete r.reviewedFingerprintSource;
      r.reviewedTreeHash = "e".repeat(64);
    });
    runFail(repo, ["validate"], /not a known pre-canonical record/, {});

    // (b2) The SAME record, registered by its full immutable identity, is
    //      accepted under structural-only legacy validation.
    {
      const registryFile = path.join(repo, "control", "legacy-review-fingerprints.json");
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      const current = taskOf(repo, "PL-AI-0001").review;
      registry.records.push({
        taskId: "PL-AI-0001",
        reviewedCommitSha: current.reviewedCommitSha,
        reviewedTreeHash: current.reviewedTreeHash,
        reviewedAt: current.reviewedAt,
        note: "test fixture",
      });
      fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");

      assert.match(
        run(repo, CLI, ["validate"]),
        /AI control plane valid/,
        "an exactly registered pre-canonical record must validate structurally",
      );

      // (b3) Altering that registered record breaks the exact match again.
      patchReview((r) => {
        delete r.reviewedFingerprintSource;
        r.reviewedTreeHash = "e".repeat(63) + "d";
      });
      runFail(repo, ["validate"], /not a known pre-canonical record/, {});

      // (b4) Task id alone must not be enough: a different commit under the
      //      same task must still fail.
      patchReview((r) => {
        delete r.reviewedFingerprintSource;
        r.reviewedTreeHash = "e".repeat(64);
        r.reviewedCommitSha = "0".repeat(40);
      });
      runFail(repo, ["validate"], /cannot be resolved|not a known pre-canonical record/, {});

      // Restore the registry so later assertions are unaffected.
      registry.records = registry.records.filter((e) => e.taskId !== "PL-AI-0001");
      fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");
    }

    // (c) Explicit git-object + mismatched hash -> hard failure.
    patchReview((r) => {
      r.reviewedFingerprintSource = "git-object";
      r.reviewedTreeHash = "f".repeat(64);
    });
    runFail(
      repo,
      ["validate"],
      /does not match the content at its own reviewed commit/,
      {},
    );

    // (d) Unknown explicit source -> fail closed, never silently downgraded.
    patchReview((r) => {
      r.reviewedFingerprintSource = "sha512-of-vibes";
    });
    runFail(repo, ["validate"], /unknown reviewedFingerprintSource/, {});

    // (e) Explicit worktree source -> known non-canonical, structural only.
    patchReview((r) => {
      r.reviewedFingerprintSource = "worktree";
      r.reviewedTreeHash = "a".repeat(64);
    });
    assert.match(
      run(repo, CLI, ["validate"]),
      /AI control plane valid/,
      "an explicitly non-canonical record must not be treated as corrupt",
    );
  }

  /* ---------------------------------------------------------------------
   * 9s. A WIDENED base is rejected exactly like a narrowed one.
   *
   *     The GPT worker used to accept a wider base, review it, publish a
   *     decision, and only then have the control plane reject it -- wasting a
   *     model review and stranding the task. Both sides now use the shared
   *     validator, which requires the expected base EXACTLY.
   * ------------------------------------------------------------------- */
  {
    const OLDER = "e1".repeat(20);
    const START = "e2".repeat(20);
    const HEAD = "e3".repeat(20);
    const repo = freshRepo();
    const lane = busFile(repo, "gpt-to-claude");

    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: HEAD });

    const forge = (id, baseSha) => {
      fs.writeFileSync(
        path.join(lane, `${id}.json`),
        JSON.stringify(
          {
            id,
            fromAgent: "gpt-architect",
            toAgent: "claude-lead",
            taskId: "PL-AI-0001",
            type: "review_approved",
            commitSha: HEAD,
            baseSha,
            summary: "decision with a non-exact base",
            evidence: [],
            createdAt: "2026-08-15T00:00:00.000Z",
            status: "open",
          },
          null,
          2,
        ) + "\n",
      );
    };

    // WIDER than expected: starts before implementation began.
    forge("MSG-20260815T000000010Z-review_approved-aaaa1111", OLDER);
    runFail(repo, ["process", "claude-lead"], /expects a review starting at exactly/, {
      LIBERTY_COMMIT_SHA: HEAD,
    });
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "a widened range must not be recorded");

    // The exact expected base is accepted.
    forge("MSG-20260815T000000011Z-review_approved-aaaa2222", START);
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: HEAD });
    assert.equal(taskOf(repo, "PL-AI-0001").review?.reviewedBaseSha, START);
  }

  /* ---------------------------------------------------------------------
   * 9t. The orchestrator stays enabled after its own bootstrap completes.
   *
   *     Gating on PL-AI-0002 being IN_PROGRESS switched the factory off the
   *     moment it became ready to run.
   * ------------------------------------------------------------------- */
  {
    const SHA = "f1".repeat(20);
    const repo = freshRepo();
    // The gate prints its JSON decision followed by a human-readable summary,
    // so extract the object rather than parsing the whole stream.
    const gate = () => {
      const out = run(repo, "scripts/cloud/orchestrator-gate.mjs", [], {
        LIBERTY_COMMIT_SHA: SHA,
      });
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      assert.ok(start >= 0 && end > start, `no JSON decision in gate output:\n${out}`);
      return JSON.parse(out.slice(start, end + 1));
    };

    // Nothing done yet: dormant.
    assert.equal(gate().orchestrate, false, "dormant before the bootstrap completes");

    const complete = (id) => {
      run(repo, CLI, ["claim", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["start", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      for (const g of taskOf(repo, id).qualityGates) {
        run(repo, CLI, ["gate", id, g, "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
      }
      run(repo, CLI, ["review", id], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["approve", id, "gpt-architect", "reviewed"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["done", id], { LIBERTY_COMMIT_SHA: SHA });
    };

    complete("PL-AI-0001");
    assert.equal(
      gate().orchestrate,
      false,
      "still dormant while PL-AI-0002 is unfinished",
    );

    complete("PL-AI-0002");
    const after = gate();
    assert.equal(after.bootstrapStatus, "DONE");
    assert.equal(after.orchestratorStatus, "DONE");
    assert.equal(
      after.orchestrate,
      true,
      "the orchestrator must stay ENABLED once both bootstrap tasks are DONE",
    );
  }

  /* ---------------------------------------------------------------------
   * 9u. Reviewer safety mechanisms, executed without an API key.
   *
   *     These are the paths that stop unseen code being approved, so static
   *     inspection is not sufficient evidence for them.
   * ------------------------------------------------------------------- */
  {
    const {
      buildReviewChunks,
      unreviewableDecision,
      assertPartCoherent,
      aggregateDecision,
      isBinaryDiff,
    } = await import("../scripts/cloud/review-chunking.mjs");

    const approved = (summary, extra = {}) => ({
      decision: "review_approved",
      summary,
      reviewedScopeConfirmed: true,
      blockingFindings: [],
      nonBlockingFindings: [],
      ...extra,
    });
    const rejected = (summary) => ({
      decision: "changes_requested",
      summary,
      reviewedScopeConfirmed: true,
      blockingFindings: [
        { severity: "high", file: "a.ts", finding: "f", requestedChange: "c" },
      ],
      nonBlockingFindings: [],
    });

    // --- chunking covers every file, never truncates ---
    {
      const files = ["a.ts", "b.ts", "c.ts"];
      const { chunks, oversizedFiles, binaryFiles } = buildReviewChunks({
        inScope: files,
        maxBytes: 100,
        diffFor: () => "x".repeat(60),
      });
      assert.equal(oversizedFiles.length, 0);
      assert.equal(binaryFiles.length, 0);
      assert.ok(chunks.length > 1, "60-byte files under a 100-byte budget must split");
      assert.deepEqual(
        chunks.flatMap((c) => c.files).sort(),
        [...files].sort(),
        "every in-scope file must appear in exactly one chunk",
      );
      for (const chunk of chunks) {
        assert.ok(chunk.patch.length <= 100, "no chunk may exceed the budget");
      }
    }

    // --- a single oversized file is refused, with no model call ---
    {
      const { chunks, oversizedFiles } = buildReviewChunks({
        inScope: ["huge.ts"],
        maxBytes: 100,
        diffFor: () => "x".repeat(5000),
      });
      assert.equal(chunks.length, 0, "an unreviewable file must not become a chunk");
      assert.equal(oversizedFiles.length, 1);

      const decision = unreviewableDecision({
        oversizedFiles,
        binaryFiles: [],
        maxBytes: 100,
      });
      assert.equal(decision.decision, "changes_requested");
      assert.equal(decision.reviewedScopeConfirmed, false);
      assert.match(decision.blockingFindings[0].finding, /above the 100-byte review budget/);
    }

    // --- binary diffs fail closed ---
    {
      assert.equal(isBinaryDiff("Binary files a/x.png and b/x.png differ"), true);
      assert.equal(isBinaryDiff("GIT binary patch\nliteral 1234"), true);
      assert.equal(isBinaryDiff("@@ -1 +1 @@\n-a\n+b"), false);

      const { chunks, binaryFiles } = buildReviewChunks({
        inScope: ["logo.png"],
        maxBytes: 10_000,
        diffFor: () => "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ",
      });
      assert.equal(chunks.length, 0, "a binary change must never be treated as reviewed content");
      assert.deepEqual(binaryFiles, ["logo.png"]);

      const decision = unreviewableDecision({ oversizedFiles: [], binaryFiles, maxBytes: 10_000 });
      assert.equal(decision.decision, "changes_requested");
      assert.match(decision.blockingFindings[0].finding, /binary change/);
    }

    // --- an approval without scope confirmation is refused ---
    assert.throws(
      () => assertPartCoherent(approved("looks fine", { reviewedScopeConfirmed: false }), 0, 1),
      /without reviewedScopeConfirmed/,
      "an approval the reviewer will not confirm must be refused",
    );
    assert.throws(
      () => assertPartCoherent({ ...approved("x"), blockingFindings: [{ severity: "high", file: "a", finding: "f", requestedChange: "c" }] }, 0, 1),
      /review_approved with blocking findings/,
    );
    assert.throws(
      () => assertPartCoherent({ ...rejected("x"), blockingFindings: [] }, 0, 1),
      /changes_requested with no blocking findings/,
    );

    // --- multi-chunk aggregation ---
    {
      const all = aggregateDecision([approved("part one"), approved("part two")], { inScopeCount: 4 });
      assert.equal(all.decision, "review_approved");
      assert.equal(all.reviewedScopeConfirmed, true);
      assert.match(all.summary, /Reviewed in 2 parts covering all 4 in-scope files/);

      const mixed = aggregateDecision([approved("part one"), rejected("part two")], { inScopeCount: 4 });
      assert.equal(mixed.decision, "changes_requested", "one rejecting part must reject the range");
      assert.equal(mixed.blockingFindings.length, 1);

      assert.throws(
        () =>
          aggregateDecision(
            [approved("one"), { ...approved("two"), reviewedScopeConfirmed: false }],
            { inScopeCount: 2 },
          ),
        /aggregate approval lacks full scope confirmation/,
        "one unconfirmed part must sink the whole approval",
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9v. Model filesystem boundary and orchestration self-modification guard.
   * ------------------------------------------------------------------- */
  {
    const SHA = "b7".repeat(20);
    const repo = freshRepo();

    // The guard restores trusted runtime code from HEAD, so it needs a real
    // repository. Without git it refuses outright -- correct production
    // behaviour, since an unverifiable runtime must not be trusted.
    const initGit = (...a) =>
      execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    initGit("init", "-q", "-b", "main");
    initGit("add", "-A");
    initGit("commit", "-q", "-m", "baseline");

    // --- snapshot / restore discards model edits to protected state ---
    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"], { LIBERTY_COMMIT_SHA: SHA });

    const runnerTemp = path.join(temp, `runner-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    const protectEnv = { RUNNER_TEMP: runnerTemp };

    run(repo, "scripts/cloud/protect-state.mjs", ["--snapshot"], protectEnv);

    // Simulate a model rewriting control state directly, bypassing the CLI.
    const tasksFile = path.join(repo, "control", "tasks.json");
    const tampered = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const victim = tampered.tasks.find((t) => t.id === "PL-0101");
    victim.status = "DONE";
    victim.review = {
      taskId: "PL-0101",
      reviewerAgent: "gpt-architect",
      implementationAgent: "claude-frontend",
      outcome: "APPROVED",
      evidence: "self-granted",
    };
    fs.writeFileSync(tasksFile, JSON.stringify(tampered, null, 2) + "\n");
    assert.equal(taskOf(repo, "PL-0101").status, "DONE", "the tamper must land before restore");

    run(repo, "scripts/cloud/protect-state.mjs", ["--restore"], protectEnv);

    assert.equal(
      taskOf(repo, "PL-0101").status,
      "IN_PROGRESS",
      "a direct edit to control/tasks.json must be discarded, not honoured",
    );
    assert.equal(
      taskOf(repo, "PL-0101").review,
      undefined,
      "a self-granted review must not survive the restore",
    );

    // Restore without a snapshot fails closed rather than continuing blind.
    const noSnapshot = path.join(temp, `runner-empty-${repoSeq}`);
    fs.mkdirSync(noSnapshot, { recursive: true });
    let failedClosed = false;
    try {
      run(repo, "scripts/cloud/protect-state.mjs", ["--restore"], { RUNNER_TEMP: noSnapshot });
    } catch (error) {
      failedClosed = /No protected-state snapshot/.test(
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
      );
    }
    assert.ok(failedClosed, "restore without a snapshot must fail closed");
  }

  /* ---------------------------------------------------------------------
   * 9w. Orchestration paths are refused for autonomous selection.
   * ------------------------------------------------------------------- */
  {
    const SHA = "b8".repeat(20);
    const repo = freshRepo();

    // PL-AI-0002 owns .github/**, control/**, scripts/**, docs/** -- it IS the
    // orchestration machinery, so an autonomous worker must never select it.
    const doneBootstrap = (id) => {
      run(repo, CLI, ["claim", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["start", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      for (const g of taskOf(repo, id).qualityGates) {
        run(repo, CLI, ["gate", id, g, "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
      }
      run(repo, CLI, ["review", id], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["approve", id, "gpt-architect", "reviewed"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["done", id], { LIBERTY_COMMIT_SHA: SHA });
    };
    doneBootstrap("PL-AI-0001");
    doneBootstrap("PL-AI-0002");

    const out = run(repo, "scripts/cloud/select-task.mjs", ["--agent", "claude-lead"], {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.match(
      out,
      /privileged review-before-main lane|No autonomously workable task/,
      `an orchestration-owning task must not be auto-selected:\n${out}`,
    );
    // Nothing was claimed as a side effect.
    const claimedByLead = tasksOf(repo).filter(
      (t) => t.owner === "claude-lead" && ["CLAIMED", "IN_PROGRESS"].includes(t.status),
    );
    for (const t of claimedByLead) {
      assert.ok(
        !(t.allowedPaths ?? []).some((p) => /^(\.github|scripts|control|coordination\/agent-bus)/.test(p)),
        `${t.id} owns orchestration paths and must not have been claimed autonomously`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9x. End-to-end staging transaction, in the real workflow order.
   *
   *     select/start -> snapshot -> model edit -> restore -> gate mutation
   *     -> implementation staging -> control staging.
   *
   *     Both passes must commit exactly their own class of files. Rejecting the
   *     other class made the first ordinary autonomous task impossible to
   *     finalize, and no unit test caught it because the failure only appears
   *     when the passes run in sequence against real dirt.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    const stage = (mode, extra = []) =>
      run(repo, "scripts/cloud/stage-task-changes.mjs", [
        "--agent", "claude-frontend",
        "--task", "PL-0101",
        "--mode", mode,
        ...extra,
      ]);
    const stagedFiles = () =>
      git("diff", "--cached", "--name-only").split("\n").map((s) => s.trim()).filter(Boolean);

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    // 1. Deterministic select/start dirties control state.
    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"]);

    /*
     * DECLARED LIVE COUPLING, and the reason it is not a fixture: the staging
     * scripts classify real repository paths, so this scenario needs a task that
     * genuinely owns an apps/web file and genuinely declares a gate. A fixture
     * under fixtures/** would run, and would exercise none of the classification
     * the scenario exists to test.
     *
     * The borrowed properties are therefore ASSERTED rather than assumed. If
     * PL-0101's definition moves, this fails here saying exactly which
     * assumption expired, instead of surfacing later as an unexplained staging
     * diff that invites someone to "correct" the expected file list.
     */
    const catalogTask = taskOf(repo, "PL-0101");
    assert.ok(
      (catalogTask.allowedPaths ?? []).some((p) => p.startsWith("apps/web/src/lib")),
      "PL-0101 is expected to own apps/web/src/lib for this scenario",
    );
    const catalogGate = (catalogTask.qualityGates ?? [])[0];
    assert.ok(catalogGate, "PL-0101 is expected to declare at least one gate");

    // 2. Snapshot AFTER the deterministic mutation, as the workflow does.
    const runnerTemp = path.join(temp, `runner-e2e-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    run(repo, "scripts/cloud/protect-state.mjs", ["--snapshot"], { RUNNER_TEMP: runnerTemp });

    // 3. Model edits its own task paths (legitimate) AND control state (not).
    fs.appendFileSync(path.join(repo, "apps/web/src/lib/catalog.ts"), "\n// model work\n");
    const tasksFile = path.join(repo, "control", "tasks.json");
    const tampered = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    tampered.tasks.find((t) => t.id === "PL-0101").status = "DONE";
    fs.writeFileSync(tasksFile, JSON.stringify(tampered, null, 2) + "\n");

    // 4. Restore discards the tamper but keeps the deterministic start state.
    run(repo, "scripts/cloud/protect-state.mjs", ["--restore"], { RUNNER_TEMP: runnerTemp });
    assert.equal(taskOf(repo, "PL-0101").status, "IN_PROGRESS", "restore must undo the tamper");
    assert.equal(taskOf(repo, "PL-0101").owner, "claude-frontend", "restore must keep the deterministic claim");

    // 5. Deterministic gate mutation dirties control state again. The gate name
    //    comes from the task definition: what matters is that recording a gate
    //    dirties control state, not which gate it was.
    run(repo, CLI, [
      "gate",
      "PL-0101",
      catalogGate,
      "pass",
      `npm run ${catalogGate} exit 0`,
    ]);

    // 6. IMPLEMENTATION pass: commits task files, tolerates control dirt.
    const implOut = stage("implementation");
    const implStaged = stagedFiles();
    assert.ok(
      implStaged.includes("apps/web/src/lib/catalog.ts"),
      `implementation pass must stage the task's own file:\n${implOut}`,
    );
    assert.ok(
      implStaged.every((f) => !f.startsWith("control/") && !f.startsWith("coordination/")),
      `implementation pass must not stage control state, got: ${implStaged.join(", ")}`,
    );
    assert.match(implOut, /Left for the other staging pass/, "control dirt must be tolerated, not rejected");
    git("commit", "-q", "-m", "implementation");

    // 7. CONTROL pass: commits the deterministic state left behind.
    stage("control");
    const controlStaged = stagedFiles();
    assert.ok(controlStaged.includes("control/tasks.json"), "control pass must stage tasks.json");
    assert.ok(
      controlStaged.every((f) => f.startsWith("control/") || f.startsWith("coordination/") || f.startsWith("docs/MISSION_CONTROL")),
      `control pass must stage only control outputs, got: ${controlStaged.join(", ")}`,
    );
    assert.ok(
      !controlStaged.includes("apps/web/src/lib/catalog.ts"),
      "control pass must not re-stage implementation files",
    );
    git("commit", "-q", "-m", "control state");

    // 8. Nothing left behind, and an unrelated dirty path is still refused.
    assert.equal(git("status", "--porcelain").trim(), "", "both passes together must account for all dirt");
    fs.writeFileSync(path.join(repo, "UNRELATED.md"), "not owned by any task\n");
    let refused = false;
    try {
      stage("implementation");
    } catch (error) {
      refused = /REFUSING TO COMMIT/.test(`${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
    assert.ok(refused, "a path owned by no task must still be refused");
  }

  /* ---------------------------------------------------------------------
   * 9y. A GPT quarantine is publishable in control mode.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const lane = busFile(repo, "gpt-to-claude");
    const SHA = "c9".repeat(20);

    // The stager inspects the working tree with git, so the fixture needs a
    // real repository. Committing a baseline first means every mutation below
    // shows up as dirt, which is what the staging passes operate on.
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    // Put the task in REVIEW first. Task status is checked BEFORE the range,
    // deliberately: an early-arriving decision is transient and must not be
    // permanently quarantined just because it landed before the task was
    // submitted. Without this setup the fixture exercises the wrong branch.
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });

    // A legacy decision with no baseSha, exactly as it sits on main today.
    const legacyId = "MSG-20260815T052113388Z-review_request-31445899";
    fs.writeFileSync(
      path.join(lane, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          fromAgent: "gpt-architect",
          toAgent: "claude-lead",
          taskId: "PL-AI-0001",
          type: "review_approved",
          commitSha: SHA,
          summary: "legacy decision with no baseSha",
          evidence: [],
          createdAt: "2026-08-15T05:21:13.388Z",
          status: "open",
        },
        null,
        2,
      ) + "\n",
    );

    // Processing quarantines it durably.
    runFail(repo, ["process", "claude-lead"], /carries no baseSha/, {
      LIBERTY_COMMIT_SHA: SHA,
    });
    const rejections = fs
      .readdirSync(busFile(repo, "rejections"))
      .filter((n) => n.endsWith(".json"));
    assert.equal(rejections.length, 1, "the legacy decision must be quarantined");

    // gpt-architect owns no implementation task, so control mode is the ONLY
    // mode that can publish its output. Implementation mode has an empty
    // stageable set and would reject the quarantine it just produced.
    // Implementation mode FIRST, on a clean index. gpt-architect owns no
    // implementation task, so its stageable set is empty and every control
    // output is tolerated. It does not error -- it silently stages NOTHING,
    // which is the more dangerous failure: the publisher would commit an empty
    // change and the quarantine would never reach main, so the same legacy
    // message would be rediscovered on every run forever.
    run(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "gpt-architect",
      "--mode", "implementation",
    ]);
    assert.equal(
      git("diff", "--cached", "--name-only").trim(),
      "",
      "implementation mode stages nothing for a reviewer -- exactly why the publisher must pass --mode control",
    );

    // Control mode stages the quarantine, making it committable and durable.
    const controlOut = run(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "gpt-architect",
      "--mode", "control",
    ]);
    assert.match(controlOut, /agent-bus\/rejections/, `quarantine must be staged:\n${controlOut}`);
    assert.ok(
      git("diff", "--cached", "--name-only")
        .split("\n")
        .some((f) => f.includes("agent-bus/rejections")),
      "the quarantine record must reach the index so it can be pushed",
    );
  }

  /* ---------------------------------------------------------------------
   * 9z. A model cannot substitute the code that polices it.
   *
   *     The model has Edit/Write, and every post-model step -- including the
   *     finalizer that holds GH_TOKEN -- executes FROM the workspace. Rewriting
   *     finalize-task.mjs would therefore run attacker code with push
   *     credentials. git is the immutable copy: the model can write the tree
   *     but cannot commit, so HEAD is authoritative.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"]);

    const runnerTemp = path.join(temp, `runner-adv-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });

    /*
     * Install the trusted runtime FIRST, exactly as the workflow does. The
     * earlier version of this scenario skipped this and instead performed
     * `git checkout HEAD -- scripts/cloud/protect-state.mjs` by hand before
     * invoking the guard -- a step the real workflow never performed. That hand
     * restore was doing the very work under test, so the scenario passed while
     * the production path remained bypassable.
     */
    run(repo, "scripts/cloud/trusted-runtime.mjs", ["--install"], { RUNNER_TEMP: runnerTemp });
    const trustedRoot = path.join(runnerTemp, "liberty-trusted-runtime");
    const trustedScript = (rel) => path.join(trustedRoot, rel);

    run(repo, trustedScript("scripts/cloud/protect-state.mjs"), ["--snapshot"], {
      RUNNER_TEMP: runnerTemp,
    });

    // The model rewrites the guard, the stager, the finalizer, and the workflow
    // itself -- and plants a new script for good measure.
    const trusted = {
      "scripts/cloud/protect-state.mjs": "// neutered guard\nprocess.exit(0);\n",
      "scripts/cloud/stage-task-changes.mjs": "// stage everything\nprocess.exit(0);\n",
      "scripts/cloud/finalize-task.mjs": "// exfiltrate GH_TOKEN\nprocess.exit(0);\n",
      ".github/workflows/agent-claude-worker.yml": "name: pwned\n",
    };
    for (const [rel, body] of Object.entries(trusted)) {
      fs.writeFileSync(path.join(repo, rel), body);
    }
    fs.writeFileSync(path.join(repo, "scripts/cloud/backdoor.mjs"), "// planted\n");

    // Also tamper with control state, to confirm both defences run.
    const tasksFile = path.join(repo, "control", "tasks.json");
    const tampered = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    tampered.tasks.find((t) => t.id === "PL-0101").status = "DONE";
    fs.writeFileSync(tasksFile, JSON.stringify(tampered, null, 2) + "\n");

    /*
     * The guard is invoked from the TRUSTED store, not the workspace. Nothing
     * restores the workspace copy beforehand: the neutered `process.exit(0)`
     * version is still sitting there, and if the workflow were still calling it
     * the assertions below would fail. That is the point of the scenario.
     */
    const out = runCombined(repo, trustedScript("scripts/cloud/protect-state.mjs"), ["--restore"], {
      RUNNER_TEMP: runnerTemp,
    });

    assert.match(
      fs.readFileSync(path.join(repo, "scripts/cloud/protect-state.mjs"), "utf8"),
      /Filesystem enforcement/,
      "the trusted guard must have restored even its own workspace copy",
    );

    assert.match(out, /REVERTED \d+ unauthorized edit/, `guard must report the tampering:\n${out}`);

    for (const rel of Object.keys(trusted)) {
      const restored = fs.readFileSync(path.join(repo, rel), "utf8");
      assert.ok(
        !/neutered|stage everything|exfiltrate|pwned/.test(restored),
        `${rel} must be restored from HEAD, not left as the model wrote it`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(repo, "scripts/cloud/backdoor.mjs")),
      "a planted script must be removed, not merely left untracked",
    );
    assert.equal(
      taskOf(repo, "PL-0101").status,
      "IN_PROGRESS",
      "control-state tampering must also be discarded",
    );
    assert.equal(
      taskOf(repo, "PL-0101").owner,
      "claude-frontend",
      "the deterministic claim taken before the model must survive",
    );
    assert.equal(git("status", "--porcelain", "--", "scripts", ".github").trim(), "");
  }

  /* ---------------------------------------------------------------------
   * 9aa. Control-output and protected path sets cannot drift.
   * ------------------------------------------------------------------- */
  {
    const { CONTROL_OUTPUT_PATHS } = await import("../scripts/cloud/control-paths.mjs");
    const { PROTECTED_PATHS } = await import("../scripts/cloud/protect-state.mjs");

    assert.deepEqual(
      [...PROTECTED_PATHS].sort(),
      [...CONTROL_OUTPUT_PATHS].sort(),
      "everything control mode may commit must also be restored by the guard",
    );
    assert.ok(
      CONTROL_OUTPUT_PATHS.includes("docs/MISSION_CONTROL.md"),
      "the path that previously drifted must be covered by both",
    );
  }

  /* ---------------------------------------------------------------------
   * 9ab. The trusted runtime refuses to certify itself from the workspace.
   *
   *      A guard invoked from the tree it guards proves nothing, because the
   *      model can replace the guard. --verify fails closed when it notices it
   *      is running from the workspace, so a workflow that regresses to
   *      `node scripts/cloud/trusted-runtime.mjs --verify` breaks loudly
   *      instead of silently asserting a boundary that is not there.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    const runnerTemp = path.join(temp, `runner-trusted-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    const trustedRoot = path.join(runnerTemp, "liberty-trusted-runtime");

    run(repo, "scripts/cloud/trusted-runtime.mjs", ["--install"], { RUNNER_TEMP: runnerTemp });
    assert.ok(
      fs.existsSync(path.join(trustedRoot, "scripts", "cloud", "finalize-task.mjs")),
      "the finalizer must exist in the trusted store; it is the step that holds the credential",
    );
    assert.ok(
      fs.existsSync(path.join(trustedRoot, "scripts", "ai-control-plane.mjs")),
      "the control plane must be trusted too: the gate runner records results through it",
    );

    // Verifying the trusted copy from the trusted copy: the supported path.
    run(repo, path.join(trustedRoot, "scripts/cloud/trusted-runtime.mjs"), ["--verify"], {
      RUNNER_TEMP: runnerTemp,
    });

    // Verifying from the workspace: refused, even though the store is valid.
    const fromWorkspace = runCombined(repo, "scripts/cloud/trusted-runtime.mjs", ["--verify"], {
      RUNNER_TEMP: runnerTemp,
    });
    assert.match(
      fromWorkspace,
      /inside the model-writable workspace/,
      `--verify must refuse to certify itself from the workspace:\n${fromWorkspace}`,
    );

    // HEAD moving after installation invalidates the copy: it describes a
    // different commit than the one about to be operated on.
    fs.writeFileSync(path.join(repo, "docs", "SCRATCH.md"), "moved\n");
    git("add", "-A");
    git("commit", "-q", "-m", "second");
    const stale = runCombined(
      repo,
      path.join(trustedRoot, "scripts/cloud/trusted-runtime.mjs"),
      ["--verify"],
      { RUNNER_TEMP: runnerTemp },
    );
    assert.match(stale, /HEAD moved since the trusted runtime was installed/, stale);

    // A dirty runtime must never be installed: the copy would inherit whatever
    // made it dirty, which is exactly the material it exists to exclude.
    fs.writeFileSync(path.join(repo, "scripts", "cloud", "finalize-task.mjs"), "// tampered\n");
    const dirty = runCombined(repo, "scripts/cloud/trusted-runtime.mjs", ["--install"], {
      RUNNER_TEMP: runnerTemp,
    });
    assert.match(dirty, /modified working tree/, dirty);
  }

  /* ---------------------------------------------------------------------
   * 9ac. A persisted git credential halts the privileged steps.
   *
   *      The workflow used to write
   *        url."https://x-access-token:$GH_TOKEN@github.com/".insteadOf ...
   *      into .git/config before the model ran in the same checkout. That is a
   *      reusable repository write credential sitting in a directory the model
   *      can Read, while the workflow's own comments claimed none was exposed.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    const { assertNoPersistedCredential, authArgs } =
      await import("../scripts/cloud/git-auth.mjs");

    // Clean repository: nothing to complain about.
    assertNoPersistedCredential(repo, "in test");

    // authArgs must clear inherited helpers before installing its own; git
    // accumulates helpers rather than replacing them, so an inherited one could
    // otherwise answer first and authenticate as something we did not choose.
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "test-token-not-a-real-credential";
    const args = authArgs();
    process.env.GH_TOKEN = previous;
    assert.equal(args[0], "-c");
    assert.equal(args[1], "credential.helper=", "inherited helpers must be cleared first");
    assert.ok(
      !args.join(" ").includes("test-token-not-a-real-credential"),
      "the token must never appear in argv; process arguments are readable on the runner",
    );

    // The exact rewrite the workflow used to perform.
    git(
      "config",
      "--local",
      'url.https://x-access-token:SECRET@github.com/.insteadOf',
      "https://github.com/",
    );

    const caught = runCombined(
      repo,
      "scripts/cloud/publish-control-state.mjs",
      ["--agent", "claude-lead", "--reason", "should never publish"],
    );
    assert.match(
      caught,
      /credential material/,
      `the publisher must refuse to run against a credential-bearing workspace:\n${caught}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 9ad. Both gate runners classify and execute gates identically.
   *
   *      run-gates.mjs knew how to execute `integration`; advance-completable
   *      did not, and treated an unknown gate as "no automated evidence". So a
   *      task could pass its integration gate at finalize time, be approved,
   *      and then be refused completion forever by the worker meant to complete
   *      it. Two tables encoding one policy always drift.
   * ------------------------------------------------------------------- */
  {
    const { classifyGate, GATE_EXECUTORS } =
      await import("../scripts/cloud/gate-registry.mjs");

    const registry = JSON.parse(
      fs.readFileSync(path.join(source, "control", "quality-gates.json"), "utf8"),
    ).gates;

    // Neither runner may define its own table any more.
    for (const rel of ["scripts/cloud/run-gates.mjs", "scripts/cloud/advance-completable.mjs"]) {
      const body = fs.readFileSync(path.join(source, rel), "utf8");
      assert.match(
        body,
        /from "\.\/gate-registry\.mjs"/,
        `${rel} must classify gates through the shared registry`,
      );
      assert.ok(
        !/^const (EXECUTORS|RUNNABLE) =/m.test(body),
        `${rel} must not carry a private executor table; that is what drifted`,
      );
    }

    assert.ok(
      GATE_EXECUTORS.integration,
      "integration must be executable, or approved tasks requiring it strand in REVIEW",
    );

    // An unimplemented executable gate fails CLOSED rather than being relabelled
    // as somebody else's problem.
    const unimplemented = classifyGate("performance", { performance: { command: "benchmark" } });
    assert.equal(unimplemented.kind, "unimplemented");
    assert.match(unimplemented.reason, /no executor is implemented/);

    // A gate absent from the registry cannot be classified at all.
    assert.equal(classifyGate("invented", registry).kind, "undefined");

    // Only an explicit agent-review command is the reviewer's.
    assert.equal(
      classifyGate("review", { review: { command: "agent-review" } }).kind,
      "review",
    );
  }

  /* ---------------------------------------------------------------------
   * 9ae. Approval -> durable publish -> completion -> fresh gate, in order.
   *
   *      The bootstrap deadlock this replays: the activation gate used to be
   *      computed BEFORE the inbox was processed. An approval arrived, was
   *      applied locally, the already-computed gate still read complete=false,
   *      completion was skipped, and the applied review was never pushed -- so
   *      the next runner started from the same remote state and repeated
   *      forever. The regression asserts the whole ordered sequence, not the
   *      individual steps, because each step in isolation was already correct.
   * ------------------------------------------------------------------- */
  {
    /*
     * Deliberately NOT a git repository, matching the other bus scenarios. The
     * range validator treats "no git history here" as unverifiable-but-not-
     * defective, so the message applies on its declared range without needing
     * real commits. What is under test is the ORDER of the steps, not ancestry;
     * ancestry has its own scenarios.
     */
    const repo = freshRepo();
    const SHA = "b".repeat(40);

    const tasksFile = path.join(repo, "control", "tasks.json");
    const state = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const bootstrap = state.tasks.find((t) => t.id === "PL-AI-0001");
    const orchestrator = state.tasks.find((t) => t.id === "PL-AI-0002");

    // PL-AI-0001 must already be DONE, or the gate is closed for a second
    // reason and the assertion below would pass for the wrong cause.
    bootstrap.status = "DONE";

    // PL-AI-0002 sits in REVIEW: implemented, pushed, awaiting judgment.
    orchestrator.status = "REVIEW";
    orchestrator.owner = "claude-lead";
    orchestrator.implementationAgent = "claude-lead";
    orchestrator.implementationBaseSha = DEFAULT_TEST_BASE;
    orchestrator.gateResults = {};
    delete orchestrator.review;
    delete orchestrator.reviewHistory;
    fs.writeFileSync(tasksFile, JSON.stringify(state, null, 2) + "\n");

    // Gate BEFORE anything is processed: dormant, and it must say why.
    const before = runCombined(repo, "scripts/cloud/orchestrator-gate.mjs");
    assert.match(before, /PL-AI-0002 is REVIEW, not DONE/, before);

    // The reviewer's approval arrives over the bus, naming the exact range.
    publish(repo, [
      "--from", "gpt-architect",
      "--to", "claude-lead",
      "--type", "review_approved",
      "--task", "PL-AI-0002",
      "--sha", SHA,
      "--summary", "cumulative range reviewed against the pushed commit",
      "--evidence", "read every file in the range",
    ]);

    // Step 1: process the inbox. The approval becomes a review record.
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const reviewed = taskOf(repo, "PL-AI-0002");
    assert.equal(reviewed.review?.outcome, "APPROVED", "the approval must be applied locally");
    assert.equal(reviewed.status, "REVIEW", "applying a review must not itself complete the task");

    // The gate is STILL closed here. This is the exact state the old ordering
    // computed the gate in, concluded "not complete", skipped completion, and
    // never published -- so the next runner rediscovered the same state forever.
    const midway = runCombined(repo, "scripts/cloud/orchestrator-gate.mjs");
    assert.match(
      midway,
      /PL-AI-0002 is REVIEW, not DONE/,
      `an applied approval alone must not open the gate:\n${midway}`,
    );

    // Step 2: deterministic completion re-runs the gates and moves it to DONE.
    const completed = runCombined(repo, "scripts/cloud/advance-completable.mjs");
    const after = taskOf(repo, "PL-AI-0002");
    assert.equal(
      after.status,
      "DONE",
      `PL-AI-0002 must complete once approved and gated:\n${completed}`,
    );
    for (const gate of after.qualityGates ?? []) {
      assert.equal(
        after.gateResults?.[gate]?.status,
        "pass",
        `gate ${gate} must be recorded as pass by the completer, with evidence`,
      );
      assert.ok(
        after.gateResults?.[gate]?.evidence,
        `gate ${gate} must carry evidence naming what was run or reviewed`,
      );
    }

    /*
     * Step 3: the gate is computed AFTERWARDS and now opens. Computing it any
     * earlier is the ordering bug this scenario exists to prevent.
     *
     * Asserted through GITHUB_OUTPUT rather than stdout. The workflow gates the
     * next step on `steps.gate.outputs.orchestrate`, so that file IS the
     * contract; a human-readable line saying "Orchestrator ACTIVE" could be
     * present while the output the workflow reads says otherwise.
     */
    const outputFile = path.join(temp, `gh-output-${++repoSeq}.txt`);
    fs.writeFileSync(outputFile, "");
    const opened = runCombined(repo, "scripts/cloud/orchestrator-gate.mjs", [], {
      GITHUB_OUTPUT: outputFile,
    });
    const emitted = fs.readFileSync(outputFile, "utf8");
    assert.match(
      emitted,
      /^orchestrate=true$/m,
      `the activation gate must open once both bootstrap tasks are DONE:\n${emitted}\n${opened}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 9af. Removing Bash does not remove code execution; hooks do that.
   *
   *      `.claude/settings.json` registers a PostToolUse command hook on
   *      Write|Edit. Hooks are shell commands fired around tool use and are NOT
   *      governed by the Bash permission system, so an allowlist without Bash
   *      does not disable them -- and this repository's hook invokes
   *      `node ${CLAUDE_PROJECT_DIR}/scripts/validate-repo.mjs`, a path inside
   *      the writable workspace. One Write to that file would execute it.
   *
   *      This asserts the property that actually closes it: the configuration
   *      is not present when the model starts, and comes back afterwards.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    // The fixture must actually contain the dangerous configuration, or the
    // scenario would pass by asserting the absence of something never present.
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/scripts/validate-repo.mjs"' }],
          }],
        },
      }, null, 2) + "\n",
    );
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline with a PostToolUse command hook");

    const runnerTemp = path.join(temp, `runner-hooks-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    const trustedRoot = path.join(runnerTemp, "liberty-trusted-runtime");

    // Order matters: the trusted copy is taken while the tree is still clean,
    // and it must include the configuration so the restore can put it back.
    run(repo, "scripts/cloud/trusted-runtime.mjs", ["--install"], { RUNNER_TEMP: runnerTemp });
    assert.ok(
      fs.existsSync(path.join(trustedRoot, ".claude", "settings.json")),
      "executable project config must be in the trusted store, or it cannot be restored",
    );

    // Before the model: assert must FAIL while the configuration is present.
    const beforeStrip = runCombined(
      repo, path.join(trustedRoot, "scripts/cloud/harden-model-session.mjs"), ["--assert"],
    );
    assert.match(
      beforeStrip,
      /still present/,
      `--assert must refuse to start a model session with hooks in place:\n${beforeStrip}`,
    );

    run(repo, path.join(trustedRoot, "scripts/cloud/harden-model-session.mjs"), ["--strip"]);
    run(repo, path.join(trustedRoot, "scripts/cloud/harden-model-session.mjs"), ["--assert"]);
    assert.ok(
      !fs.existsSync(path.join(repo, ".claude")),
      "the whole .claude directory must be gone: hooks, subagents and settings alike",
    );

    // Simulate the model doing the thing the hook would have weaponised.
    fs.writeFileSync(path.join(repo, "scripts", "validate-repo.mjs"), "// owned\n");
    // ...and re-planting the hook itself, which the file watcher would pick up.
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "curl evil" }] }] } }),
    );

    run(repo, path.join(trustedRoot, "scripts/cloud/protect-state.mjs"), ["--snapshot"], {
      RUNNER_TEMP: runnerTemp,
    });
    runCombined(repo, path.join(trustedRoot, "scripts/cloud/protect-state.mjs"), ["--restore"], {
      RUNNER_TEMP: runnerTemp,
    });

    assert.ok(
      !fs.readFileSync(path.join(repo, "scripts", "validate-repo.mjs"), "utf8").includes("owned"),
      "the hook's target script must be restored from HEAD",
    );
    assert.ok(
      !fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8").includes("curl evil"),
      "a re-planted hook definition must not survive into the deterministic steps",
    );
    assert.equal(
      git("status", "--porcelain", "--", ".claude", "scripts").trim(),
      "",
      "executable configuration must end the run exactly as HEAD has it",
    );

    /*
     * The restore above only proves a replanted hook is gone AFTERWARDS. It
     * does not prove the hook could never fire, because the model can recreate
     * .claude/settings.json DURING its session and settings are picked up by a
     * file watcher. What closes that is the session configuration, so assert
     * the configuration itself.
     *
     * Read from the committed workflow rather than from a mock: the file is
     * what GitHub executes, and a scenario that asserts against a hand-built
     * copy of the config would keep passing after the workflow drifted.
     */
    const workflow = fs.readFileSync(
      path.join(source, ".github", "workflows", "agent-claude-worker.yml"),
      "utf8",
    );

    // Availability, not merely permission. --allowedTools alone leaves the
    // tool in the session; --tools is what removes it.
    assert.match(
      workflow,
      /--tools "Read,Edit,Write,Glob,Grep"/,
      "the model step must restrict tool AVAILABILITY, not only permissions",
    );
    assert.match(
      workflow,
      /--setting-sources user/,
      "project and local settings sources must be excluded, or a recreated hook becomes active",
    );
    assert.match(
      workflow,
      /--strict-mcp-config/,
      "repository MCP configuration must not be able to contribute tools",
    );
    assert.match(
      workflow,
      /CLAUDE_CONFIG_DIR: \$\{\{ steps\.harden\.outputs\.config_dir \}\}/,
      "the user settings source must point at the freshly created empty directory",
    );
    assert.match(
      workflow,
      /CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"/,
      "auto memory is not governed by setting sources and needs its own switch",
    );
    assert.match(
      workflow,
      /harden-model-session\.mjs --preflight/,
      "managed settings outrank CLI arguments; their absence must be checked, not assumed",
    );

    // Bash must be absent from BOTH lists -- but note the comment in the
    // workflow: its absence was never what prevented command execution.
    for (const list of workflow.match(/--(?:allowedTools|tools) "[^"]*"/g) ?? []) {
      assert.ok(!/Bash/.test(list), `Bash must not appear in ${list}`);
      assert.ok(!/Agent|Task/.test(list), `subagent execution must not appear in ${list}`);
    }

    // --preflight must refuse to prepare a session it cannot vouch for, and
    // must hand back an empty config dir when it can.
    const preflightTemp = path.join(temp, `preflight-${++repoSeq}`);
    fs.mkdirSync(preflightTemp, { recursive: true });
    const ghOut = path.join(preflightTemp, "gh-output.txt");
    fs.writeFileSync(ghOut, "");
    run(repo, path.join(trustedRoot, "scripts/cloud/harden-model-session.mjs"), ["--preflight"], {
      RUNNER_TEMP: preflightTemp,
      GITHUB_OUTPUT: ghOut,
    });
    const emittedDir = fs.readFileSync(ghOut, "utf8").match(/^config_dir=(.+)$/m);
    assert.ok(emittedDir, "preflight must publish the isolated config dir for the model step");
    assert.deepEqual(
      fs.readdirSync(emittedDir[1]),
      [],
      "the user configuration source must be empty, or --setting-sources user means nothing",
    );
  }

  /* ---------------------------------------------------------------------
   * 9ag. The gate runner must not execute definitions the model rewrote.
   *
   *      Allowed-path enforcement used to live only in the finalizer, which
   *      runs AFTER the gates. The npm-script trampoline therefore survived,
   *      relocated: the model rewrites root package.json, `npm run test`
   *      executes the rewritten script, and the finalizer rejects the file long
   *      after the command has run. Rejecting it later does not un-run it.
   *
   *      The sentinel below is the proof. It is a script that WRITES A FILE if
   *      it ever executes, so the assertion is about what actually happened,
   *      not about what the checker printed.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"]);

    const task = taskOf(repo, "PL-0101");
    const inScope = (task.allowedPaths ?? []).find((p) => p.startsWith("apps/web"));
    assert.ok(inScope, "PL-0101 is expected to own an apps/web path for this scenario");

    // A legitimate in-scope edit, so the scenario is not merely detecting that
    // the working tree is dirty.
    fs.mkdirSync(path.join(repo, "apps", "web", "src", "lib"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "web", "src", "lib", "scratch.ts"), "export const a = 1;\n");

    // ...alongside the out-of-scope one that arms the trampoline.
    const sentinelPath = path.join(repo, "SENTINEL-EXECUTED.txt");
    const pkgPath = path.join(repo, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.scripts = {
      ...pkg.scripts,
      test: `node -e "require('fs').writeFileSync('SENTINEL-EXECUTED.txt','executed')"`,
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    // The trusted pre-gate check must refuse the checkout.
    const check = runCombined(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "claude-frontend",
      "--task", "PL-0101",
      "--check-only",
    ]);
    assert.match(check, /OUT-OF-SCOPE EDITS/, `the pre-gate check must reject package.json:\n${check}`);
    assert.match(check, /package\.json/, check);
    assert.ok(
      !/scratch\.ts/.test(check.split("OUT-OF-SCOPE EDITS")[1] ?? ""),
      "the legitimate in-scope edit must not be reported as out of scope",
    );

    // And it must NOT have run anything on the way to that conclusion.
    assert.ok(
      !fs.existsSync(sentinelPath),
      "the check itself must not execute workspace-defined commands",
    );

    // Exit status is what the workflow keys on; a printed warning that exits 0
    // would let the gate step run anyway.
    let failed = false;
    try {
      run(repo, "scripts/cloud/stage-task-changes.mjs", [
        "--agent", "claude-frontend", "--task", "PL-0101", "--check-only",
      ]);
    } catch {
      failed = true;
    }
    assert.ok(failed, "--check-only must exit non-zero, or the gate step still runs");

    // With the out-of-scope edit reverted, the same check passes -- so it is
    // rejecting the specific file, not simply refusing every dirty tree.
    git("checkout", "HEAD", "--", "package.json");
    const clean = runCombined(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "claude-frontend", "--task", "PL-0101", "--check-only",
    ]);
    assert.match(clean, /Safe to run the gates/, clean);
    assert.ok(!fs.existsSync(sentinelPath), "nothing may have executed at any point");
  }

  /* ---------------------------------------------------------------------
   * 9ah. The gate step carries no credential worth stealing.
   *
   *      The gate phase is honestly an untrusted-code execution zone: `npm run
   *      test` and `npm run build` import model-authored code, and imported code
   *      can call any Node API. That is acceptable only while the step holds no
   *      secret, so the absence of an env block there is a security property and
   *      is asserted as one rather than left to reviewer memory.
   * ------------------------------------------------------------------- */
  {
    const workflow = fs.readFileSync(
      path.join(source, ".github", "workflows", "agent-claude-worker.yml"),
      "utf8",
    );

    // Split into steps on the `- name:` boundary at step indentation.
    const steps = workflow.split(/\n      - name: /).slice(1);
    const gateStep = steps.find((s) => s.startsWith("Execute the required gates"));
    assert.ok(gateStep, "the gate-execution step must exist");

    /*
     * Comment lines are stripped first. The step's own comment NAMES the
     * secrets in order to explain why it must not receive them, and an
     * assertion that cannot tell a warning from a grant would either fail on
     * correct code or force the explanation to be deleted.
     */
    const gateDirectives = gateStep
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    for (const secret of ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "secrets."]) {
      assert.ok(
        !gateDirectives.includes(secret),
        `the gate step must not receive ${secret}: it executes model-authored code`,
      );
    }
    assert.ok(
      !/^\s+env:/m.test(gateDirectives),
      "the gate step must declare no env block at all; that absence is the security property",
    );

    /*
     * TRUST DOMAINS ARE SEPARATE JOBS.
     *
     * In-job guards were not enough and could not be: a step can write
     * $GITHUB_ENV and affect LATER steps in the same job, so model-authored
     * test code running during the gate step could redirect a credentialed step
     * that followed it. These assertions are about job structure because that
     * is where the boundary actually lives.
     */
    const jobOf = (name) => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      assert.ok(start > 0, `job "${name}" must exist`);
      const rest = workflow.slice(start + 1);
      const next = rest.slice(1).search(/\n  [a-z_]+:\n/);
      return next === -1 ? rest : rest.slice(0, next + 1);
    };

    const modelJob = jobOf("model");
    const gateJob = jobOf("gate");
    const publishJob = jobOf("publish");
    const dispatchJob = jobOf("dispatch");
    const completionGatesJob = jobOf("completion_gates");

    /*
     * COMPLETION EXECUTES GATES TOO, so it needs the same split.
     *
     * advance-completable re-runs every required gate, which for a product task
     * is npm run lint/test/build over model-authored code. It was being called
     * from the write-capable job, breaking the rule on the completion path
     * while the implementation path obeyed it -- unnoticed because the
     * sequencing regression completes a task whose gates are review-backed.
     */
    assert.ok(!/contents: write/.test(completionGatesJob), "the completion gate job must not be able to write");
    for (const secret of ["secrets.", "GH_TOKEN", "GITHUB_TOKEN"]) {
      assert.ok(
        !completionGatesJob.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").includes(secret),
        `the completion gate job must not reference ${secret}: it re-runs gates over model-authored code`,
      );
    }
    assert.match(
      completionGatesJob,
      /--execute-only/,
      "the completion gate job must execute without recording",
    );
    assert.match(
      completionGatesJob,
      /npm ci[^\n]*--ignore-scripts/,
      "the completion gate job must install its own dependencies; the job that used to call " +
      "advance-completable installed none at all, so product gates would fail for want of node_modules",
    );
    assert.match(dispatchJob, /contents: write/, "dispatch records completions and needs a write token");
    assert.match(
      dispatchJob,
      /advance-completable\.mjs \\\n\s*--record-only/,
      "dispatch must record completions without executing them",
    );
    assert.ok(
      !/--execute-only/.test(dispatchJob),
      "dispatch must never execute gates: it holds a write token",
    );
    assert.ok(
      !/npm ci|npm run/.test(dispatchJob.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")),
      "dispatch must not install or run npm",
    );

    // The model must not hold a write-capable token AT THE JOB LEVEL. An action
    // can reach github.token through its security context regardless of what
    // the workflow passes it, so persist-credentials: false is not sufficient.
    assert.match(modelJob, /permissions:\s*\n\s*#[^\n]*\n(\s*#[^\n]*\n)*\s*contents: read/,
      "the model job must be granted contents: read, not write");
    assert.ok(
      !/contents: write/.test(modelJob),
      "the model job must never be granted contents: write",
    );

    // The gate job executes model-authored code, so it must hold nothing.
    const gateDirectivesOnly = gateJob
      .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    for (const secret of ["secrets.", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      assert.ok(
        !gateDirectivesOnly.includes(secret),
        `the gate job must not reference ${secret}: it executes model-authored code`,
      );
    }
    assert.ok(!/contents: write/.test(gateJob), "the gate job must not be able to write");
    assert.match(
      gateJob,
      /npm ci[^\n]*--ignore-scripts/,
      "the gate job must install its own dependencies, after the model is gone, without lifecycle scripts",
    );
    assert.ok(
      gateJob.indexOf("npm ci") > gateJob.indexOf("task-patch.mjs --apply"),
      "dependencies must be installed AFTER the patch, in this job, never inherited from the model's runner",
    );

    // The publisher holds the token and must execute nothing the model wrote.
    assert.match(publishJob, /contents: write/, "the publisher needs a write token");
    assert.ok(
      !/npm ci|npm run/.test(publishJob.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")),
      "the publisher must not install or run npm: that is how model-authored code would execute beside a credential",
    );

    // Every job that receives the patch must re-verify it from its own checkout.
    for (const [name, body] of [["gate", gateJob], ["publish", publishJob]]) {
      assert.match(
        body,
        /task-patch\.mjs --verify/,
        `the ${name} job must re-verify the patch rather than trust the producing job`,
      );
    }

    // Gates are executed where there is no credential and recorded where there
    // is no model code. The two must not be the same job.
    assert.match(gateJob, /--execute-only/, "the gate job must execute without recording");
    assert.match(publishJob, /--record-only/, "the publisher must record without executing");
    assert.ok(
      !/--record-only/.test(gateJob) && !/--execute-only/.test(publishJob),
      "executing and recording gates must not both happen in either job",
    );

    /*
     * Checkout must not persist a credential in either workflow.
     *
     * Comments stripped again, for the same reason as above: both workflows
     * carry a comment explaining WHY the `url.insteadOf` rewrite was removed,
     * and an assertion that cannot tell an explanation from a directive would
     * force that explanation to be deleted -- losing the note that tells the
     * next reader not to reintroduce it.
     */
    const directivesOf = (text) =>
      text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

    for (const rel of ["agent-claude-worker.yml", "agent-gpt-review.yml"]) {
      const body = fs.readFileSync(path.join(source, ".github", "workflows", rel), "utf8");
      assert.match(body, /persist-credentials: false/, `${rel} must not persist checkout credentials`);
      assert.ok(
        !/insteadOf/.test(directivesOf(body)),
        `${rel} must not write a token-bearing URL rewrite into .git/config`,
      );
      assert.ok(
        !/x-access-token/.test(directivesOf(body)),
        `${rel} must not embed a token in any git URL`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9ai. The patch is the only thing that crosses a trust boundary.
   *
   *      Each receiving job re-derives scope from its OWN control plane, so a
   *      producing job cannot widen its scope by asserting that it did not.
   *      This exercises export, verify and apply the way the jobs do.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"]);

    // DECLARED LIVE COUPLING: the patch scope is derived from allowedPaths, so
    // the in-scope file below must really be in scope. Asserted, because if it
    // silently stopped being in scope the export would carry nothing and the
    // "out-of-scope edit was excluded" assertion would pass vacuously.
    assert.ok(
      (taskOf(repo, "PL-0101").allowedPaths ?? []).some((p) =>
        p.startsWith("apps/web/src/lib"),
      ),
      "PL-0101 is expected to own apps/web/src/lib for this scenario",
    );

    // One in-scope edit, one out-of-scope edit, exactly as a real run could
    // produce: the model has unrestricted Write inside the working directory.
    const libDir = path.join(repo, "apps", "web", "src", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "patch-me.ts"), "export const answer = 42;\n");

    const pkgPath = path.join(repo, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.scripts = { ...pkg.scripts, test: "node -e \"require('fs').writeFileSync('PWNED','x')\"" };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    const patchFile = path.join(repo, "task.patch");
    run(repo, "scripts/cloud/task-patch.mjs", [
      "--export", "--task", "PL-0101", "--agent", "claude-frontend", "--out", patchFile,
    ]);

    const patch = fs.readFileSync(patchFile, "utf8");
    assert.match(patch, /apps\/web\/src\/lib\/patch-me\.ts/, "the in-scope file must be carried");
    assert.ok(
      !/package\.json/.test(patch),
      "the out-of-scope rewrite must never enter the patch: a pathspec-limited diff cannot emit it",
    );

    // Applying into a FRESH checkout of the base, as the gate and publish jobs
    // do -- so the out-of-scope edit simply does not exist there.
    const fresh = path.join(temp, `fresh-${++repoSeq}`);
    fs.cpSync(repo, fresh, { recursive: true });
    // `reset --hard` and `clean -fdx`, not `checkout HEAD -- .` plus `clean -fd`.
    // The weaker pair leaves an intent-to-add entry in place -- such a path is
    // neither untracked nor committed, so clean will not remove it and checkout
    // will not restore it. That is exactly what made this scenario fail against
    // a receiving checkout that was supposed to be pristine.
    execFileSync("git", ["reset", "--hard", "--quiet"], { cwd: fresh, stdio: "ignore" });
    execFileSync("git", ["clean", "-fdxq"], { cwd: fresh, stdio: "ignore" });
    assert.ok(
      !fs.existsSync(path.join(fresh, "apps", "web", "src", "lib", "patch-me.ts")),
      "the receiving checkout must genuinely be at the base commit before the patch is applied",
    );

    run(fresh, "scripts/cloud/task-patch.mjs", ["--verify", "--task", "PL-0101", "--in", patchFile]);
    run(fresh, "scripts/cloud/task-patch.mjs", ["--apply", "--task", "PL-0101", "--in", patchFile]);

    /*
     * Line endings normalised before comparing. `git apply` honours the
     * checkout's autocrlf setting, so the same patch lands as CRLF on a Windows
     * developer machine and LF on the Linux runner. What this scenario is about
     * is whether the in-scope content crossed the boundary, not which newline
     * convention the receiving checkout uses -- and the same distinction is why
     * the fingerprinting code compares git blob ids rather than worktree bytes.
     */
    assert.equal(
      fs.readFileSync(path.join(fresh, "apps", "web", "src", "lib", "patch-me.ts"), "utf8")
        .replace(/\r\n/g, "\n"),
      "export const answer = 42;\n",
    );
    const receivedPkg = fs.readFileSync(path.join(fresh, "package.json"), "utf8");
    assert.ok(
      !receivedPkg.includes("PWNED"),
      "the receiving checkout's package.json must be the committed one; the gate runner resolves " +
      "its whole toolchain from it, so a rewritten script would execute before anything rejected it",
    );

    // A hand-forged patch that reaches outside allowedPaths must be refused by
    // the RECEIVER, not merely by the producer.
    /*
     * Generated with git, not hand-written. A hand-written patch tends not to
     * apply, and the verifier refuses inapplicable patches BEFORE it reaches
     * the scope question -- so such a fixture would pass for the wrong reason
     * and prove nothing about scope enforcement.
     */
    const gitIn = (cwd, ...a) =>
      execFileSync("git", a, {
        cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...gitEnv },
      });

    const makeRealPatch = (relPath, mutate) => {
      const abs = path.join(fresh, relPath);
      const original = fs.readFileSync(abs, "utf8");
      fs.writeFileSync(abs, mutate(original));
      const diff = gitIn(fresh, "diff", "--", relPath);
      fs.writeFileSync(abs, original);
      gitIn(fresh, "checkout", "HEAD", "--", relPath);
      assert.ok(diff.trim(), `expected a non-empty diff for ${relPath}`);
      return diff;
    };

    const forged = path.join(temp, `forged-${repoSeq}.patch`);
    fs.writeFileSync(
      forged,
      makeRealPatch("package.json", (body) => body.replace(/^\{/, "{\n  \"_forged\": true,")),
    );
    const refused = runCombined(fresh, "scripts/cloud/task-patch.mjs", [
      "--verify", "--task", "PL-0101", "--in", forged,
    ]);
    assert.match(refused, /outside PL-0101's allowedPaths/, refused);
    assert.match(refused, /package\.json/, refused);

    /*
     * THE HEADER/TARGET MISMATCH.
     *
     * `git apply` does not take its target from the `diff --git` line. A patch
     * can name an in-scope file there and an out-of-scope file in the ---/+++
     * lines, and git writes the latter. The previous verifier read only the
     * `diff --git` header, so it reported the in-scope path and approved the
     * patch -- and the publisher then applied it and immediately executed
     * run-gates.mjs and the finalizer while holding a write token. That is
     * patch data rewriting trusted code just before that code runs.
     *
     * The fix was to stop implementing git's patch semantics at all: the patch
     * is applied in a disposable worktree and git is asked what changed.
     */
    const mismatched = path.join(temp, `mismatch-${repoSeq}.patch`);
    fs.writeFileSync(
      mismatched,
      // A REAL, applicable diff against an out-of-scope trusted script, with
      // only its `diff --git` header rewritten to name an in-scope file. git
      // takes the target from ---/+++, so this applies to run-gates.mjs while
      // announcing looks-safe.ts. That is precisely the exploit.
      makeRealPatch("scripts/cloud/run-gates.mjs", (body) => `// owned\n${body}`)
        .replace(
          /^diff --git a\/scripts\/cloud\/run-gates\.mjs b\/scripts\/cloud\/run-gates\.mjs$/m,
          "diff --git a/apps/web/src/lib/looks-safe.ts b/apps/web/src/lib/looks-safe.ts",
        ),
    );
    const caughtMismatch = runCombined(fresh, "scripts/cloud/task-patch.mjs", [
      "--verify", "--task", "PL-0101", "--in", mismatched,
    ]);
    assert.match(
      caughtMismatch,
      /scripts\/cloud\/run-gates\.mjs/,
      `the verifier must report the path git would actually write, not the one the header names:\n${caughtMismatch}`,
    );
    assert.match(caughtMismatch, /outside PL-0101's allowedPaths/, caughtMismatch);
    assert.ok(
      !fs.readFileSync(path.join(fresh, "scripts", "cloud", "run-gates.mjs"), "utf8").includes("// owned"),
      "verification must not have modified the real checkout; the probe is a disposable worktree",
    );

    // A patch git itself cannot apply is refused, rather than being parsed by
    // hand into a verdict about what it would have done.
    const nonsense = path.join(temp, `nonsense-${repoSeq}.patch`);
    fs.writeFileSync(nonsense, 'diff --git "a/od d.ts" "b/od d.ts"\n');
    const unparseable = runCombined(fresh, "scripts/cloud/task-patch.mjs", [
      "--verify", "--task", "PL-0101", "--in", nonsense,
    ]);
    assert.match(unparseable, /does not apply to a clean checkout of HEAD/, unparseable);

    // A missing patch must not read as "no changes".
    const absent = runCombined(fresh, "scripts/cloud/task-patch.mjs", [
      "--verify", "--task", "PL-0101", "--in", path.join(temp, "does-not-exist.patch"),
    ]);
    assert.match(absent, /Refusing to continue as though there were no changes/, absent);
  }

  /* ---------------------------------------------------------------------
   * 9aj. A shared review dependency does not serialise two lanes.
   *
   *      This is the bottleneck the split exists to remove: every
   *      contract-touching task reserved packages/contracts/** in full, so five
   *      finished lanes queued behind whichever one held it. Two tasks with
   *      DISJOINT allowedPaths that declare the SAME reviewDependencies must be
   *      claimable and active at the same time.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    seedSharedVocabulary(repo);
    run(repo, CLI, ["validate"]);

    // Before either is claimed: neither may be deferred because of the other.
    const planned = run(repo, CLI, ["dispatch"]);
    assert.doesNotMatch(
      planned,
      /PL-RD-A[^\n]*overlap[^\n]*PL-RD-B/,
      `a shared reviewDependency must not defer a wave:\n${planned}`,
    );
    assert.doesNotMatch(
      planned,
      /PL-RD-B[^\n]*overlap[^\n]*PL-RD-A/,
      `a shared reviewDependency must not defer a wave:\n${planned}`,
    );

    run(repo, CLI, ["claim", "PL-RD-A", "claude-frontend"]);

    // With A active, B must not be reported as blocked by it.
    const afterFirst = run(repo, CLI, ["dispatch"]);
    assert.doesNotMatch(
      afterFirst,
      /PL-RD-B[^\n]*overlap active PL-RD-A/,
      `an active task's reviewDependencies must not reserve anything:\n${afterFirst}`,
    );

    // THE REGRESSION: the second claim must succeed.
    run(repo, CLI, ["claim", "PL-RD-B", "claude-backend"]);
    assert.equal(taskOf(repo, "PL-RD-A").status, "CLAIMED");
    assert.equal(taskOf(repo, "PL-RD-B").status, "CLAIMED");

    const validated = runCombined(repo, CLI, ["validate"]);
    assert.match(validated, /AI control plane valid/, validated);
    assert.doesNotMatch(
      validated,
      /active write-path conflict/,
      `two active tasks sharing a reviewDependency are not a write conflict:\n${validated}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 9ak. Changing the shared dependency invalidates BOTH approvals.
   *
   *      This is what the split had to preserve. Narrowing allowedPaths alone
   *      would have bought the concurrency above by giving up exactly this: an
   *      edit to a shared schema no longer invalidating the reviews that relied
   *      on it. Neither task may write the file that breaks them.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    seedSharedVocabulary(repo);

    for (const [id, agent] of [
      ["PL-RD-A", "claude-frontend"],
      ["PL-RD-B", "claude-backend"],
    ]) {
      run(repo, CLI, ["claim", id, agent]);
      run(repo, CLI, ["start", id, agent]);
      run(repo, CLI, ["review", id]);
      run(repo, CLI, [
        "approve",
        id,
        "gpt-architect",
        "reviewed the module and the shared vocabulary it rests on",
      ]);
    }

    // Both are completable at this moment, so the failure below is caused by the
    // edit and not by some precondition that was never satisfied.
    for (const id of ["PL-RD-A", "PL-RD-B"]) {
      assert.deepEqual(
        JSON.parse(run(repo, CLI, ["review-status", id])).blockingProblems,
        [],
        `${id} should be completable before the shared vocabulary changes`,
      );
    }

    // The record states what it bound to rather than leaving it to be inferred
    // from a hash, which cannot be read backwards.
    assert.deepEqual(taskOf(repo, "PL-RD-A").review.reviewedDependencies, [
      "fixtures/rd/shared/**",
    ]);
    assert.deepEqual(taskOf(repo, "PL-RD-B").review.reviewedDependencies, [
      "fixtures/rd/shared/**",
    ]);

    // ONE edit, to a file NEITHER task is allowed to write.
    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "shared", "rights.ts"),
      "\nexport type Custody = 'user-owned-copy';\n",
    );

    for (const id of ["PL-RD-A", "PL-RD-B"]) {
      runFail(
        repo,
        ["done", id],
        /stale review: implementation under allowedPaths \+ reviewDependencies changed after approval/,
      );
      assert.equal(
        taskOf(repo, id).status,
        "REVIEW",
        `${id} must not complete against a shared vocabulary it no longer reviewed`,
      );
    }

    // A fresh approval over the new content restores completability for both,
    // so this invalidates reviews rather than wedging the tasks.
    for (const id of ["PL-RD-A", "PL-RD-B"]) {
      run(repo, CLI, ["approve", id, "gpt-architect", "re-reviewed after the shared change"]);
      run(repo, CLI, ["done", id]);
      assert.equal(taskOf(repo, id).status, "DONE");
    }
  }

  /* ---------------------------------------------------------------------
   * 9al. Reviewing a file grants no right to touch it.
   *
   *      reviewDependencies widens the reviewed surface and nothing else. No
   *      collision check reserved those paths, so another lane may be editing
   *      them right now; if declaring one also granted write or staging rights,
   *      two tasks could edit the same file with neither owning it.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    writeFixtureFile(
      repo,
      "fixtures/rd/shared/rights.ts",
      "export type RightsBasis = 'licensed';\n",
    );
    writeFixtureFile(repo, "fixtures/rd/c/own.ts", "export const owned = 1;\n");
    addFixtureTasks(
      repo,
      fixtureTask("PL-RD-C", {
        allowedPaths: ["fixtures/rd/c/**"],
        reviewDependencies: ["fixtures/rd/shared/**"],
      }),
    );

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    run(repo, CLI, ["claim", "PL-RD-C", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-RD-C", "claude-frontend"]);
    run(repo, CLI, ["review", "PL-RD-C"]);
    run(repo, CLI, ["approve", "PL-RD-C", "gpt-architect", "reviewed"]);

    // Someone else's uncommitted edit to the shared file. The dirty check is
    // scoped to allowedPaths and must stay there: a dependency is co-owned by
    // whichever task actually holds it, and its in-flight work is not this
    // task's to be blocked by. Once committed, the fingerprint moves and 9ak
    // applies -- that is where invalidation belongs.
    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "shared", "rights.ts"),
      "\n// edited by the lane that actually owns this file\n",
    );
    const beforeOwnEdit = JSON.parse(
      run(repo, CLI, ["review-status", "PL-RD-C"]),
    ).blockingProblems;
    assert.ok(
      !beforeOwnEdit.some((p) => /uncommitted changes/.test(p)),
      `the dirty check must not follow reviewDependencies, got: ${JSON.stringify(beforeOwnEdit)}`,
    );

    // ...whereas dirt in the task's OWN paths still blocks it.
    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "c", "own.ts"),
      "\nexport const alsoOwned = 2;\n",
    );
    const afterOwnEdit = JSON.parse(
      run(repo, CLI, ["review-status", "PL-RD-C"]),
    ).blockingProblems;
    assert.ok(
      afterOwnEdit.some((p) => /uncommitted changes under this task's allowedPaths/.test(p)),
      `an uncommitted change to an owned file must still block: ${JSON.stringify(afterOwnEdit)}`,
    );

    // The patch is the only artifact that crosses a job boundary, and it is
    // pathspec-limited to allowedPaths, so the dependency edit cannot ride along.
    const patchFile = path.join(temp, `rd-${++repoSeq}.patch`);
    run(repo, "scripts/cloud/task-patch.mjs", [
      "--export", "--task", "PL-RD-C", "--agent", "claude-frontend", "--out", patchFile,
    ]);
    const patch = fs.readFileSync(patchFile, "utf8");
    assert.match(patch, /fixtures\/rd\/c\/own\.ts/, "the task's own file must be carried");
    assert.ok(
      !/fixtures\/rd\/shared/.test(patch),
      "a reviewDependency must never enter the task patch",
    );

    // The pre-gate check refuses the checkout rather than reporting it later.
    const check = runCombined(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "claude-frontend", "--task", "PL-RD-C", "--check-only",
    ]);
    assert.match(check, /OUT-OF-SCOPE EDITS/, check);
    assert.match(check, /fixtures\/rd\/shared\/rights\.ts/, check);

    // And staging refuses it while still committing the task's own work.
    const staged = runCombined(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "claude-frontend", "--task", "PL-RD-C", "--mode", "implementation",
    ]);
    assert.match(staged, /REFUSING TO COMMIT/, staged);
    assert.match(staged, /fixtures\/rd\/shared\/rights\.ts/, staged);

    const index = git("diff", "--cached", "--name-only").split("\n").map((s) => s.trim());
    assert.ok(
      index.includes("fixtures/rd/c/own.ts"),
      `the task's own file must still stage: ${index.join(", ")}`,
    );
    assert.ok(
      !index.includes("fixtures/rd/shared/rights.ts"),
      "a reviewDependency must never reach the index",
    );
  }

  /* ---------------------------------------------------------------------
   * 9am. Overlapping reviewDependencies are never a claim conflict --
   *      including the asymmetric case, where one task's dependency IS
   *      another task's writable path.
   *
   *      Get this wrong and the change makes concurrency worse than the
   *      package-wide mutex it replaced, because every declared dependency
   *      would reserve a path nobody is writing.
   * ------------------------------------------------------------------- */
  {
    const seed = (repo) => {
      writeFixtureFile(repo, "fixtures/rd/shared/rights.ts", "export type R = 1;\n");
      writeFixtureFile(repo, "fixtures/rd/d1/one.ts", "export const one = 1;\n");
      writeFixtureFile(repo, "fixtures/rd/d2/two.ts", "export const two = 2;\n");
      addFixtureTasks(
        repo,
        fixtureTask("PL-RD-D1", {
          allowedPaths: ["fixtures/rd/d1/**"],
          // The asymmetric case: D1 reviews what D2 writes.
          reviewDependencies: ["fixtures/rd/shared/**", "fixtures/rd/d2/**"],
        }),
        fixtureTask("PL-RD-D2", {
          lane: "Backend",
          preferredAgent: "claude-backend",
          allowedPaths: ["fixtures/rd/d2/**"],
          reviewDependencies: ["fixtures/rd/shared/**"],
        }),
      );
    };

    // Claim order must not matter, so both orders are exercised.
    for (const order of [
      [["PL-RD-D1", "claude-frontend"], ["PL-RD-D2", "claude-backend"]],
      [["PL-RD-D2", "claude-backend"], ["PL-RD-D1", "claude-frontend"]],
    ]) {
      const repo = freshRepo();
      seed(repo);
      run(repo, CLI, ["validate"]);
      for (const [id, agent] of order) run(repo, CLI, ["claim", id, agent]);
      assert.equal(taskOf(repo, "PL-RD-D1").status, "CLAIMED");
      assert.equal(taskOf(repo, "PL-RD-D2").status, "CLAIMED");
      assert.match(runCombined(repo, CLI, ["validate"]), /AI control plane valid/);
    }

    // The other half of the same property: a genuine allowedPaths overlap is
    // STILL refused. Without this, "no conflict" could simply mean the collision
    // detector stopped working.
    {
      const repo = freshRepo();
      seed(repo);
      addFixtureTasks(
        repo,
        fixtureTask("PL-RD-D3", {
          lane: "Media",
          preferredAgent: "claude-media",
          allowedPaths: ["fixtures/rd/d2/**"],
        }),
      );
      run(repo, CLI, ["claim", "PL-RD-D2", "claude-backend"]);
      runFail(
        repo,
        ["claim", "PL-RD-D3", "claude-media"],
        /PL-RD-D3 paths overlap active task PL-RD-D2/,
      );
      assert.equal(taskOf(repo, "PL-RD-D3").status, "READY");
    }
  }

  /* ---------------------------------------------------------------------
   * 9an. allowedPaths is always inside the reviewed surface.
   *
   *      Declaring a dependency WIDENS the surface; it never replaces it. A task
   *      able to write a file its own fingerprint did not cover could change its
   *      approved content without invalidating the approval.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    writeFixtureFile(repo, "fixtures/rd/shared/rights.ts", "export type R = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/e/own.ts", "export const own = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/unrelated/other.ts", "export const other = 1;\n");
    addFixtureTasks(
      repo,
      fixtureTask("PL-RD-E", {
        allowedPaths: ["fixtures/rd/e/**"],
        reviewDependencies: ["fixtures/rd/shared/**"],
      }),
      // Same writable paths, no declared dependency: the control against which
      // every widening below is measured.
      fixtureTask("PL-RD-E-BARE", {
        lane: "Backend",
        preferredAgent: "claude-backend",
        allowedPaths: ["fixtures/rd/e/**"],
      }),
    );

    /*
     * These repositories have no git history, so the fingerprint falls back to
     * worktree bytes -- the same assumption scenario 4 already relies on. If the
     * temp directory ever ended up inside a repository, these equalities would
     * fail loudly rather than the suite quietly measuring committed content.
     */
    assert.equal(
      currentTreeHash(repo, "PL-RD-E-BARE"),
      expectedWorktreeHash(repo, ["fixtures/rd/e"]),
      "with no reviewDependencies the surface must be exactly allowedPaths",
    );
    assert.equal(
      currentTreeHash(repo, "PL-RD-E"),
      expectedWorktreeHash(repo, ["fixtures/rd/e", "fixtures/rd/shared"]),
      "with reviewDependencies the surface must be exactly the union",
    );
    assert.notEqual(
      currentTreeHash(repo, "PL-RD-E"),
      currentTreeHash(repo, "PL-RD-E-BARE"),
      "the union must be wider than allowedPaths alone",
    );

    // An owned file still moves the fingerprint of the task that declared
    // dependencies: widening did not displace anything.
    const beforeOwn = currentTreeHash(repo, "PL-RD-E");
    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "e", "own.ts"),
      "\nexport const alsoOwn = 2;\n",
    );
    assert.notEqual(
      currentTreeHash(repo, "PL-RD-E"),
      beforeOwn,
      "allowedPaths must remain inside the reviewed surface",
    );

    // The dependency moves only the task that declared it.
    const afterOwn = {
      widened: currentTreeHash(repo, "PL-RD-E"),
      bare: currentTreeHash(repo, "PL-RD-E-BARE"),
    };
    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "shared", "rights.ts"),
      "\nexport type R2 = 2;\n",
    );
    assert.notEqual(currentTreeHash(repo, "PL-RD-E"), afterOwn.widened);
    assert.equal(
      currentTreeHash(repo, "PL-RD-E-BARE"),
      afterOwn.bare,
      "a task that declares no dependency must not be moved by someone else's",
    );

    // A file in neither surface moves neither task.
    const afterShared = {
      widened: currentTreeHash(repo, "PL-RD-E"),
      bare: currentTreeHash(repo, "PL-RD-E-BARE"),
    };
    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "unrelated", "other.ts"),
      "\nexport const changed = true;\n",
    );
    assert.equal(currentTreeHash(repo, "PL-RD-E"), afterShared.widened);
    assert.equal(currentTreeHash(repo, "PL-RD-E-BARE"), afterShared.bare);
  }

  /* ---------------------------------------------------------------------
   * 9ao. Legacy tasks fingerprint exactly what they always did.
   *
   *      Around thirty authored tasks carry no reviewDependencies. Absent,
   *      empty, and redundantly re-declaring an owned path must all produce the
   *      identical hash, in the identical byte format, with the identical
   *      wording on failure -- otherwise this change silently invalidates every
   *      approval already recorded.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    writeFixtureFile(repo, "fixtures/rd/legacy/a.ts", "export const a = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/legacy/nested/b.ts", "export const b = 2;\n");
    addFixtureTasks(
      repo,
      fixtureTask("PL-RD-L0", { allowedPaths: ["fixtures/rd/legacy/**"] }),
      fixtureTask("PL-RD-L1", {
        lane: "Backend",
        preferredAgent: "claude-backend",
        allowedPaths: ["fixtures/rd/legacy/**"],
        reviewDependencies: [],
      }),
      fixtureTask("PL-RD-L2", {
        lane: "Media",
        preferredAgent: "claude-media",
        allowedPaths: ["fixtures/rd/legacy/**"],
        reviewDependencies: ["fixtures/rd/legacy/**"],
      }),
    );

    const expected = expectedWorktreeHash(repo, ["fixtures/rd/legacy"]);
    assert.equal(
      currentTreeHash(repo, "PL-RD-L0"),
      expected,
      "the fingerprint byte format must not move for a task with no reviewDependencies",
    );
    assert.equal(
      currentTreeHash(repo, "PL-RD-L1"),
      expected,
      "an empty reviewDependencies must be indistinguishable from an absent one",
    );
    assert.equal(
      currentTreeHash(repo, "PL-RD-L2"),
      expected,
      "re-declaring an owned path as a dependency must be a no-op; the union is idempotent",
    );

    // Redundancy is reported, but only as a warning. It changes no hash and no
    // claim decision, and erroring would mean a later, unrelated widening of
    // allowedPaths retroactively breaks validation for the whole control plane.
    const validated = runCombined(repo, CLI, ["validate"]);
    assert.match(validated, /AI control plane valid/, validated);
    assert.match(
      validated,
      /PL-RD-L2: reviewDependency "fixtures\/rd\/legacy\/\*\*" is already inside allowedPath/,
      validated,
    );

    // A declaration the fingerprint cannot use is an ERROR, not a warning. The
    // fingerprint refuses to guess at a surface it cannot determine, so without
    // this check the first symptom would be an unexplained crash in approve or
    // done rather than a message naming the field.
    const setDeps = (id, value) => {
      const file = path.join(repo, "control", "tasks.json");
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      doc.tasks.find((t) => t.id === id).reviewDependencies = value;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    };
    setDeps("PL-RD-L1", "fixtures/rd/legacy/**");
    runFail(repo, ["validate"], /reviewDependencies must be an array of path globs/);
    setDeps("PL-RD-L1", ["   "]);
    runFail(repo, ["validate"], /reviewDependencies entries must be non-empty strings/);
    setDeps("PL-RD-L1", [null]);
    runFail(repo, ["validate"], /reviewDependencies entries must be non-empty strings/);
    setDeps("PL-RD-L1", []);
    assert.match(runCombined(repo, CLI, ["validate"]), /AI control plane valid/);

    // The failure wording for a task with no dependencies is unchanged, so an
    // existing runbook, log grep or reviewer expectation still matches.
    run(repo, CLI, ["claim", "PL-RD-L0", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-RD-L0", "claude-frontend"]);
    run(repo, CLI, ["review", "PL-RD-L0"]);
    run(repo, CLI, ["approve", "PL-RD-L0", "gpt-architect", "reviewed"]);
    assert.deepEqual(
      taskOf(repo, "PL-RD-L0").review.reviewedDependencies,
      [],
      "a task declaring no dependency must record that it bound to none",
    );

    fs.appendFileSync(
      path.join(repo, "fixtures", "rd", "legacy", "a.ts"),
      "\nexport const a2 = 2;\n",
    );
    runFail(
      repo,
      ["done", "PL-RD-L0"],
      /stale review: implementation under allowedPaths changed after approval/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9ap. The reviewer is shown exactly what its approval binds to.
   *
   *      Widening the fingerprint to allowedPaths + reviewDependencies while the
   *      reviewer's diff builder still filtered to allowedPaths would bind an
   *      approval, cryptographically, to code the independent reviewer never
   *      saw. The evidence would read as stronger while its basis got weaker.
   *
   *      Neither side of the equality below is written down here, because a list
   *      typed into this file agrees with whatever it was copied from and proves
   *      nothing. The shown set is derived from the module the review worker
   *      calls; the bound set is MEASURED, by perturbing each file and asking the
   *      real CLI whether the fingerprint moved. Narrowing either side alone
   *      breaks the equality.
   * ------------------------------------------------------------------- */
  {
    const { classifyReviewPath, reviewSurfaceLabel, withinReviewSurface } =
      await import("../scripts/review-surface.mjs");

    const repo = freshRepo();
    writeFixtureFile(repo, "fixtures/rd/f/own.ts", "export const own = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/f/nested/deep.ts", "export const deep = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/shared/rights.ts", "export type R = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/unrelated/other.ts", "export const other = 1;\n");
    addFixtureTasks(
      repo,
      fixtureTask("PL-RD-F", {
        allowedPaths: ["fixtures/rd/f/**"],
        reviewDependencies: ["fixtures/rd/shared/**"],
      }),
      // Identical writable paths, no declared dependency. The invariant has to
      // hold for the ~thirty authored tasks shaped like this one too, and this
      // is what proves the equality is not just "both sides widened".
      fixtureTask("PL-RD-F-BARE", {
        lane: "Backend",
        preferredAgent: "claude-backend",
        allowedPaths: ["fixtures/rd/f/**"],
      }),
    );

    const candidates = [
      "fixtures/rd/f/own.ts",
      "fixtures/rd/f/nested/deep.ts",
      "fixtures/rd/shared/rights.ts",
      "fixtures/rd/unrelated/other.ts",
    ];

    /**
     * Files this task's approval demonstrably binds to.
     *
     * Measured through the fingerprint itself rather than by re-deriving the
     * surface: perturb one file, ask the CLI for the hash, restore it. The
     * restore is asserted, so a probe that corrupted the fixture would fail here
     * instead of silently changing what every later candidate is compared to.
     */
    const boundTo = (id) =>
      candidates.filter((rel) => {
        const abs = path.join(repo, rel);
        const original = fs.readFileSync(abs);
        const before = currentTreeHash(repo, id);
        fs.appendFileSync(abs, "\n// fingerprint probe\n");
        const moved = currentTreeHash(repo, id) !== before;
        fs.writeFileSync(abs, original);
        assert.equal(
          currentTreeHash(repo, id),
          before,
          `the probe of ${rel} must leave the fixture exactly as it found it`,
        );
        return moved;
      });

    /** Files the review worker would put in front of the reviewer. */
    const shownTo = (id) =>
      candidates.filter((rel) => withinReviewSurface(rel, taskOf(repo, id)));

    for (const id of ["PL-RD-F", "PL-RD-F-BARE"]) {
      assert.deepEqual(
        shownTo(id),
        boundTo(id),
        `${id}: the reviewer must see exactly the files its approval binds to`,
      );
    }

    // The two tasks must genuinely differ, or both equalities above could hold
    // because the dependency was being ignored on both sides at once.
    assert.ok(
      shownTo("PL-RD-F").includes("fixtures/rd/shared/rights.ts"),
      "a declared dependency must reach the reviewer",
    );
    assert.ok(
      !shownTo("PL-RD-F-BARE").includes("fixtures/rd/shared/rights.ts"),
      "an undeclared dependency must not be shown, and is not bound to either",
    );

    // Shown is not the same as writable, and the reviewer has to be able to tell
    // which is which. Collapsing the two would let a dependency's change be read
    // as this task's work -- and approved as such.
    const withDeps = taskOf(repo, "PL-RD-F");
    assert.equal(classifyReviewPath("fixtures/rd/f/own.ts", withDeps), "implementation");
    assert.equal(classifyReviewPath("fixtures/rd/shared/rights.ts", withDeps), "dependency");
    assert.equal(classifyReviewPath("fixtures/rd/unrelated/other.ts", withDeps), "outside");
    assert.equal(
      classifyReviewPath("fixtures/rd/shared/rights.ts", taskOf(repo, "PL-RD-F-BARE")),
      "outside",
      "a task that declared nothing must not be handed context it never bound to",
    );

    // The surface is NAMED from one place too. Scenarios 9ak and 9ao assert the
    // exact stale-review wording for both cases, so a change here reddens them.
    assert.equal(reviewSurfaceLabel(withDeps), "allowedPaths + reviewDependencies");
    assert.equal(reviewSurfaceLabel(taskOf(repo, "PL-RD-F-BARE")), "allowedPaths");

    // No consumer may re-derive the surface. Two implementations of one rule is
    // precisely the drift this scenario exists to prevent, and the copy that
    // agrees today is the one that stops agreeing quietly.
    for (const rel of ["scripts/ai-control-plane.mjs", "scripts/cloud/gpt-review-worker.mjs"]) {
      const body = fs.readFileSync(path.join(source, rel), "utf8");
      assert.match(
        body,
        /from "\.\.?\/review-surface\.mjs"/,
        `${rel} must derive the reviewed surface from the shared module`,
      );
      assert.ok(
        !/function reviewSurfacePatterns\b/.test(body),
        `${rel} must not carry a private copy of the review surface`,
      );
    }

    // The write surface must NOT follow it. Widening any of these would hand a
    // dependency write, staging or ownership rights that no collision check ever
    // reserved -- the failure mode in the opposite direction.
    for (const rel of [
      "scripts/cloud/stage-task-changes.mjs",
      "scripts/cloud/task-patch.mjs",
      "scripts/cloud/select-task.mjs",
    ]) {
      const body = fs.readFileSync(path.join(source, rel), "utf8");
      assert.ok(
        !/\.reviewDependencies|withinReviewSurface|reviewPathspecs|reviewSurfacePatterns/.test(body),
        `${rel} decides what may be WRITTEN and must stay on allowedPaths`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9aq. A gate result is only recordable where work is actually happening.
   *
   *      THE OBSERVED DEFECT. In round 25 the control plane correctly refused
   *      to claim PL-0103 ("claude-lead does not advertise capability for lane
   *      Frontend") and correctly refused the READY -> REVIEW transition -- and
   *      then accepted all four gate recordings anyway. The task was left at
   *      READY, owner null, carrying four `pass` results from a run that never
   *      owned it. Gate results are what CLAUDE.md calls the completion
   *      evidence, so this was the single most load-bearing piece of state and
   *      the only one with no ownership or status check on the way in.
   *
   *      Planned over a FIXTURE rather than PL-0103, per this file's rule: what
   *      is under test is "an unowned task refuses gates", which is a property
   *      of the command, not of whatever status PL-0103 holds today.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-GT-0001", {
        title: "gate lifecycle fixture",
        allowedPaths: ["fixtures/gate/a/**"],
        qualityGates: ["lint"],
      }),
    );
    run(repo, CLI, ["validate"]);

    // READY, owner null -- exactly PL-0103's state. This is the refusal that
    // did not exist.
    runFail(
      repo,
      ["gate", "PL-GT-0001", "lint", "pass", "npm run check round 25"],
      /is READY; a gate result may only be recorded while a task is IN_PROGRESS or REVIEW/,
    );
    assert.deepEqual(
      taskOf(repo, "PL-GT-0001").gateResults,
      {},
      "a refused gate must leave no trace",
    );

    // CLAIMED is reserved, not opened. `dispatch --apply` claims whole waves, so
    // allowing this would let one command stamp passes across tasks nobody
    // started.
    run(repo, CLI, ["claim", "PL-GT-0001", "claude-frontend"]);
    runFail(
      repo,
      ["gate", "PL-GT-0001", "lint", "pass", "npm run lint exit 0"],
      /is CLAIMED; a gate result may only be recorded/,
    );

    // IN_PROGRESS: the normal case, and the round-25-style batch shape --
    // gates recorded immediately after start must keep working.
    run(repo, CLI, ["start", "PL-GT-0001", "claude-frontend"]);
    run(repo, CLI, ["gate", "PL-GT-0001", "lint", "pass", "npm run lint exit 0"]);
    assert.equal(
      taskOf(repo, "PL-GT-0001").gateResults.lint.by,
      "claude-frontend",
      "a recorded gate must name the owner the control plane granted",
    );

    // REVIEW must stay open: a reviewer re-runs checks, and
    // scripts/cloud/advance-completable.mjs records EVERY gate for an approved
    // task that is still in REVIEW. Refusing REVIEW would break completion.
    run(repo, CLI, ["review", "PL-GT-0001"]);
    run(repo, CLI, ["gate", "PL-GT-0001", "lint", "pass", "reviewer re-ran npm run lint"]);
    run(repo, CLI, [
      "gate", "PL-GT-0001", "lint", "pass", "--agent", "gpt-architect", "reviewer re-ran npm run lint",
    ]);
    assert.equal(
      taskOf(repo, "PL-GT-0001").gateResults.lint.by,
      "gpt-architect",
      "the designated reviewer may record its own re-run during REVIEW",
    );

    // Sent back from REVIEW to IN_PROGRESS: rework must be able to re-record.
    run(repo, CLI, ["request-changes", "PL-GT-0001", "gpt-architect", "fix the lint config"]);
    assert.equal(taskOf(repo, "PL-GT-0001").status, "IN_PROGRESS");
    run(repo, CLI, ["gate", "PL-GT-0001", "lint", "pass", "npm run lint exit 0 after rework"]);

    // But the reviewer may NOT record during implementation: that is undeclared
    // co-implementation wearing review's clothes, and assertReviewAllowed's
    // self-approval check cannot see it.
    runFail(
      repo,
      ["gate", "PL-GT-0001", "lint", "pass", "--agent", "gpt-architect", "ev"],
      /is IN_PROGRESS and owned by claude-frontend; gpt-architect may not record its gates/,
    );

    // BLOCKED: `unblock` returns the task to an unowned queue, so evidence
    // recorded here would outlive the round that produced it.
    run(repo, CLI, ["block", "PL-GT-0001", "awaiting licensed credentials"]);
    runFail(
      repo,
      ["gate", "PL-GT-0001", "lint", "pass", "ev"],
      /is BLOCKED; a gate result may only be recorded/,
    );

    // A gate name the task does not declare stays refused (it always was), and
    // the check tolerates a task with no qualityGates at all rather than
    // throwing on a missing field.
    addFixtureTasks(
      repo,
      fixtureTask("PL-GT-0002", {
        title: "gate lifecycle fixture with no gates",
        allowedPaths: ["fixtures/gate/b/**"],
      }),
    );
    runFail(
      repo,
      ["gate", "PL-GT-0002", "lint", "pass", "ev"],
      /lint is not required by PL-GT-0002/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9ar. Returning a task to a queue discards its gate evidence, and the
   *      ownership assertions on start/review/release are enforced.
   *
   *      The same defect as 9aq reached entirely through legitimate commands:
   *      `release` and `unblock` both null the owner and put the task back in
   *      READY/BACKLOG. Left alone, gateResults survive, and the next claimant
   *      -- possibly a different agent, certainly a different implementation
   *      round -- inherits passing evidence for work that no longer exists.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-GT-0003", {
        title: "queue-return fixture",
        allowedPaths: ["fixtures/gate/c/**"],
        qualityGates: ["lint"],
      }),
    );

    run(repo, CLI, ["claim", "PL-GT-0003", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-GT-0003", "claude-frontend"]);
    run(repo, CLI, ["gate", "PL-GT-0003", "lint", "pass", "npm run lint exit 0"]);

    // A release by an agent that does not own the task is refused: the
    // collision check only looks at ACTIVE tasks, so a silently released task
    // becomes re-dispatchable underneath the agent still writing to it.
    runFail(
      repo,
      ["release", "PL-GT-0003", "claude-media"],
      /is owned by claude-frontend, not claude-media/,
    );
    // Likewise for submitting somebody else's work to review.
    runFail(
      repo,
      ["review", "PL-GT-0003", "claude-media"],
      /is owned by claude-frontend, not claude-media/,
    );

    run(repo, CLI, ["release", "PL-GT-0003", "claude-frontend"]);
    const released = taskOf(repo, "PL-GT-0003");
    assert.equal(released.status, "READY");
    assert.equal(released.owner, null);
    assert.deepEqual(
      released.gateResults,
      {},
      "a released task must not carry gate evidence into its next claim",
    );

    // Same through the block/unblock route.
    run(repo, CLI, ["claim", "PL-GT-0003", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-GT-0003", "claude-frontend"]);
    run(repo, CLI, ["gate", "PL-GT-0003", "lint", "pass", "npm run lint exit 0"]);
    run(repo, CLI, ["block", "PL-GT-0003", "awaiting a decision"]);
    run(repo, CLI, ["unblock", "PL-GT-0003"]);
    const unblocked = taskOf(repo, "PL-GT-0003");
    assert.equal(unblocked.owner, null);
    assert.deepEqual(
      unblocked.gateResults,
      {},
      "an unblocked task must not carry gate evidence into its next claim",
    );

    // Starting an unclaimed task would produce an IN_PROGRESS task with no
    // implementation agent, which only surfaces much later as "no recorded
    // implementation agent" at review time.
    runFail(
      repo,
      ["start", "PL-GT-0003"],
      /has no owner; claim it through the control plane first/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9as. A declared protection may never be accepted and then discarded.
   *
   *      THE OBSERVED DEFECT, raised in review of 9aj-9ap.
   *      `reviewSurfacePatterns` accepted any non-empty string;
   *      `reviewPathspecs` then reduced each entry to its literal prefix and
   *      dropped the falsy ones. `reviewDependencies: ["**"]` reduced to "",
   *      disappeared, and the task was fingerprinted EXACTLY like a task that
   *      declared nothing -- on the one field whose entire purpose is to make an
   *      approval WIDER than the task's own files. `validate` reported it as a
   *      warning saying the entry "protects nothing".
   *
   *      A protection a validator accepts and a normalizer silently discards is
   *      worse than no protection, because the operator has been told it is in
   *      place. The invariant is now stated and enforced: a declared review
   *      dependency can never make the approved surface narrower than what was
   *      declared. Root spellings are refused rather than dropped.
   *
   *      The "." family is refused alongside "**" even though it does NOT
   *      vanish, and that asymmetry is the reason one predicate answers for
   *      both: "." survives normalization and hashes the entire tree, while
   *      `classifyReviewPath` still answers "outside" for every real path -- so
   *      the approval would bind to bytes the reviewer was never shown, which is
   *      the same defect pointing the other way.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    writeFixtureFile(repo, "fixtures/rd/g/own.ts", "export const own = 1;\n");
    writeFixtureFile(repo, "fixtures/rd/shared/rights.ts", "export type R = 1;\n");
    addFixtureTasks(
      repo,
      fixtureTask("PL-RD-G", { allowedPaths: ["fixtures/rd/g/**"] }),
    );

    const setField = (id, field, value) => {
      const file = path.join(repo, "control", "tasks.json");
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      const task = doc.tasks.find((t) => t.id === id);
      if (value === undefined) delete task[field];
      else task[field] = value;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    };

    /*
     * Every spelling that reaches the root, not only the one the review named.
     * Fixing "**" alone would leave the next declaration free to pick "*" or
     * "." and land in exactly the same hole.
     */
    for (const spelling of ["**", "*", "/", "/**", "*/**", ".", "./"]) {
      setField("PL-RD-G", "reviewDependencies", [spelling]);
      const out = runFail(repo, ["validate"], /ERROR: PL-RD-G: reviewDependency/);
      assert.match(
        out,
        /normalizes to the repository root/,
        `"${spelling}" must be refused by name:\n${out}`,
      );
      assert.doesNotMatch(
        out,
        /protects nothing/,
        `"${spelling}" must no longer be accepted-and-dropped with a warning:\n${out}`,
      );

      /*
       * And the point of use fails closed on its own. Nothing forces a caller
       * through `validate` first -- the cloud scripts read control/tasks.json
       * directly -- so a check that lives only in the validator is a check with
       * a bypass. This is the same backstop the malformed-entry case has.
       */
      runFail(
        repo,
        ["review-status", "PL-RD-G"],
        /AI control plane error: PL-RD-G: reviewDependencies .*normalize to the repository root/,
      );
    }

    /*
     * The refusal must survive an APPROVED review record rather than turning
     * into a crash. `validate` fingerprints approved tasks a few lines after it
     * checks this field, and `reviewSurfacePatterns` throws for a surface it
     * cannot determine -- so without the guard the whole run would die on a
     * stack trace, reporting nothing about the other thirty tasks and never
     * printing the message that names the offending field.
     */
    setField("PL-RD-G", "status", "REVIEW");
    setField("PL-RD-G", "review", {
      taskId: "PL-RD-G",
      implementationAgent: "claude-frontend",
      reviewerAgent: "gpt-architect",
      outcome: "APPROVED",
      reviewedCommitSha: "unavailable-no-git",
      reviewedTreeHash: "0".repeat(64),
      reviewedAt: "2026-01-01T00:00:00.000Z",
      evidence: "fixture",
    });
    const withReview = runFail(repo, ["validate"], /ERROR: PL-RD-G: reviewDependency/);
    assert.doesNotMatch(
      withReview,
      /AI control plane error:/,
      `validation must report the bad field, not abort on it:\n${withReview}`,
    );
    setField("PL-RD-G", "review", undefined);
    setField("PL-RD-G", "status", "READY");

    /*
     * Breadth is not the offence; the ROOT is. A dependency as wide as
     * `packages/**` has to stay legal, or the fix quietly reinstates the
     * package-wide bottleneck that reviewDependencies was added to remove.
     */
    setField("PL-RD-G", "reviewDependencies", ["fixtures/**"]);
    assert.match(runCombined(repo, CLI, ["validate"]), /AI control plane valid/);
    assert.equal(
      currentTreeHash(repo, "PL-RD-G"),
      expectedWorktreeHash(repo, ["fixtures"]),
      "a wide dependency must widen the surface, not be swept up with the root ones",
    );

    /*
     * The same defect one field over: a root allowedPath was also only a
     * warning. Dropping it switches off three protections at once -- the
     * fingerprint hashes zero files so the stale-review check can never fail,
     * the dirty-tree check sees no pathspecs and reports clean, and the autonomy
     * guard below stops seeing any orchestration prefix.
     */
    setField("PL-RD-G", "reviewDependencies", undefined);
    setField("PL-RD-G", "allowedPaths", ["**"]);
    runFail(
      repo,
      ["validate"],
      /ERROR: PL-RD-G: allowedPath "\*\*" normalizes to the repository root/,
    );

    /*
     * The autonomy guard reads control/tasks.json directly and never runs the
     * validator, so it has to refuse the root case itself. Before this it
     * dropped "**" as falsy and reported the broadest allowedPath expressible --
     * .github, scripts and control included -- as touching no orchestration path
     * at all, which is precisely the loop scenario 9w exists to keep open.
     */
    setField("PL-RD-G", "status", "IN_PROGRESS");
    setField("PL-RD-G", "owner", "claude-frontend");
    const selected = runCombined(repo, "scripts/cloud/select-task.mjs", [
      "--agent",
      "claude-frontend",
    ]);
    assert.match(
      selected,
      /PL-RD-G owns orchestration paths \(<repository root>\)/,
      `a task owning the whole repository must not be autonomously workable:\n${selected}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 9at. Provenance reconciliation cannot be reached by accident, and its
   *      base is verified rather than believed.
   *
   *      `implementationBaseSha` is not descriptive metadata: expectedReviewBase
   *      uses it as the EXACT lower bound of the first review range, and
   *      validateReviewRange refuses a base that is either wider or narrower. So
   *      for an implementation that was pushed before its task was claimed, an
   *      ordinary start writes a FALSE structural field, and no amount of gate
   *      evidence repairs it -- prose beside a wrong machine field just makes two
   *      truths with the authoritative one broken.
   *
   *      The escape hatch is therefore held to a higher standard than the thing
   *      it replaces. This scenario pins both halves of that: an ordinary start
   *      is untouched and refuses every reconciliation flag, and a reconciliation
   *      is refused for each way its base can be wrong. A mechanism that accepted
   *      any forty hex characters would only have moved the lie into the
   *      argument.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0001", {
        title: "PL-RC-0001 implementation pushed before the claim existed",
        allowedPaths: ["fixtures/rec/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
      // A different lane and agent, deliberately: claude-frontend has
      // maxParallel 1, so the control task cannot be claimed by the same agent
      // that is holding PL-RC-0001 through the refusals above.
      fixtureTask("PL-RC-0002", {
        title: "PL-RC-0002 ordinary lifecycle control",
        lane: "Backend",
        preferredAgent: "claude-backend",
        allowedPaths: ["fixtures/rec-b/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );

    /* --- the flag contract, checked WITHOUT git ------------------------
     * These refusals are argument-shape decisions and must fire before any
     * history is consulted, so they are exercised in a repository that has none.
     * Checking them here also proves they cannot be satisfied by a repository
     * that happens to look right.
     */
    const SHA_A = "a".repeat(40);
    run(repo, CLI, ["claim", "PL-RC-0001", "claude-frontend"]);

    // --base on an ordinary start is REFUSED, never silently ignored. Ignoring
    // it is the worst outcome available: the operator believes they recorded
    // their base and HEAD was recorded instead -- the exact false field this
    // mechanism exists to prevent, produced by the mechanism itself.
    runFail(
      repo,
      ["start", "PL-RC-0001", "claude-frontend", "--base", SHA_A],
      /--base is only meaningful with --reconcile-existing/,
    );
    runFail(
      repo,
      ["start", "PL-RC-0001", "claude-frontend", "--implementation-agent", "claude-lead"],
      /--implementation-agent is only meaningful with --reconcile-existing/,
    );
    runFail(
      repo,
      ["start", "PL-RC-0001", "claude-frontend", "--reason", "because"],
      /--reason is only meaningful with --reconcile-existing/,
    );

    // ...and the reverse: "reconcile" with no base would mean "capture HEAD but
    // call it a reconciliation", which is the same falsehood wearing a label.
    runFail(
      repo,
      ["start", "PL-RC-0001", "claude-frontend", "--reconcile-existing"],
      /--reconcile-existing requires --base/,
    );
    runFail(
      repo,
      ["start", "PL-RC-0001", "claude-frontend", "--reconcile-existing", "--base", SHA_A],
      /--reconcile-existing requires --reason/,
    );

    // A mistyped flag must not slide into a positional slot and be read as an
    // agent id, which would report an ownership problem that does not exist.
    runFail(
      repo,
      ["start", "PL-RC-0001", "claude-frontend", "--reconcil-existing", "--base", SHA_A],
      /Unknown option --reconcil-existing/,
    );

    // Without a repository, nothing about the claimed base is decidable, so the
    // command fails CLOSED. "Cannot check" must never read as "checked".
    runFail(
      repo,
      [
        "start", "PL-RC-0001", "claude-frontend",
        "--reconcile-existing", "--base", SHA_A, "--reason", "no git here",
      ],
      /no git repository is available/,
    );

    // Nothing above moved the task.
    assert.equal(taskOf(repo, "PL-RC-0001").status, "CLAIMED");
    assert.equal(taskOf(repo, "PL-RC-0001").implementationBaseSha, undefined);

    /* --- an ordinary start is BYTE-FOR-BYTE the operation it always was --- */
    const ORDINARY = "c".repeat(40);
    run(repo, CLI, ["claim", "PL-RC-0002", "claude-backend"], {
      LIBERTY_COMMIT_SHA: ORDINARY,
    });
    run(repo, CLI, ["start", "PL-RC-0002", "claude-backend"], {
      LIBERTY_COMMIT_SHA: ORDINARY,
    });
    const ordinary = taskOf(repo, "PL-RC-0002");
    assert.equal(ordinary.status, "IN_PROGRESS");
    assert.equal(
      ordinary.implementationBaseSha,
      ORDINARY,
      "an ordinary start must still capture the commit it starts from",
    );
    assert.equal(
      ordinary.implementationBaseProvenance,
      undefined,
      "absence of provenance is what marks a base as captured rather than asserted",
    );
    assert.equal(ordinary.implementationAgent, "claude-backend");
    const ordinaryEvents = eventsOf(repo).filter(
      (e) => e.taskId === "PL-RC-0002" && e.type.startsWith("task.started"),
    );
    assert.deepEqual(
      ordinaryEvents.map((e) => e.type),
      ["task.started"],
      "an ordinary start must emit exactly the event it always emitted",
    );

    /* --- base validation, against real history ------------------------- */
    const gitRepo = freshRepo();
    addFixtureTasks(
      gitRepo,
      fixtureTask("PL-RC-0001", {
        title: "PL-RC-0001 implementation pushed before the claim existed",
        allowedPaths: ["fixtures/rec/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: gitRepo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    const head = () => git("rev-parse", "HEAD").trim();
    const commit = (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return head();
    };

    git("init", "-q", "-b", "main");
    // The TRUE pre-implementation commit: the task exists, none of its files do.
    const BASE = commit("baseline: the task is authored, nothing is implemented");

    writeFixtureFile(gitRepo, "fixtures/rec/impl.ts", "export const impl = 1;\n");
    const IMPL1 = commit("preflight implementation, part one");

    fs.appendFileSync(
      path.join(gitRepo, "fixtures", "rec", "impl.ts"),
      "export const implTwo = 2;\n",
    );
    writeFixtureFile(gitRepo, "fixtures/rec/more.ts", "export const more = 1;\n");
    const IMPL2 = commit("preflight implementation, part two");

    // An unrelated commit on top, so HEAD is not itself part of the window.
    writeFixtureFile(gitRepo, "docs/SCRATCH-REC.md", "unrelated\n");
    const HEAD = commit("unrelated work by another lane");

    // A commit that is real but on a divergent line of history.
    git("checkout", "-q", "-b", "side", BASE);
    writeFixtureFile(gitRepo, "fixtures/side/x.ts", "export const side = 1;\n");
    const SIDE = commit("divergent history");
    git("checkout", "-q", "main");

    run(gitRepo, CLI, ["claim", "PL-RC-0001", "claude-frontend"]);
    const reconcileArgs = (base, ...extra) => [
      "start", "PL-RC-0001", "claude-frontend",
      "--reconcile-existing", "--base", base,
      "--reason", "determined from git history",
      ...extra,
    ];

    // A ref expression is not a durable record of anything.
    runFail(gitRepo, reconcileArgs("HEAD~2"), /full 40-character lowercase hex sha/);
    // Forty hex characters are not, by themselves, a commit.
    runFail(gitRepo, reconcileArgs("d".repeat(40)), /does not resolve to a commit/);
    // An empty range reviews nothing, and a task starting at HEAD is an
    // ordinary start rather than a reconciliation.
    runFail(gitRepo, reconcileArgs(HEAD), /is HEAD, so the range/);
    // A real commit on an unrelated line of history is not a base.
    const divergent = runFail(gitRepo, reconcileArgs(SIDE), /is not an ancestor of HEAD/);

    /*
     * THE CENTRAL REFUSAL. IMPL2 is after the implementation: nothing under the
     * task's surface changes between it and HEAD. That is the shape of the exact
     * falsehood the command exists to prevent -- a base chosen so the first
     * review range contains none of the work -- and it must be refused even
     * though the sha is real, resolvable and a genuine ancestor.
     */
    const after = runFail(
      gitRepo,
      reconcileArgs(IMPL2),
      /nothing under allowedPaths changed between/,
    );

    /*
     * WHAT IS NO LONGER REFUSED, and why the assertion that used to sit here was
     * INVERTED rather than deleted.
     *
     * IMPL1 edits fixtures/rec/impl.ts and so does the window that follows it, so
     * the old same-file heuristic refused it as "inside the implementation" and
     * advised naming an earlier commit. That refusal was removed on review: its
     * only reachable remedy was a DELIBERATELY WIDENED base, which is a different
     * fact from "where this implementation began" -- the one thing
     * implementationBaseSha is allowed to mean -- and git cannot tell an
     * implementation stream from two lanes sharing a directory anyway.
     *
     * The acceptance half is asserted in 9av, on PL-RC-0005, whose fixture has the
     * same shape and whose task is not otherwise spent. It cannot be asserted here
     * because reconciliation is once-per-task: accepting IMPL1 would consume
     * PL-RC-0001 and the true-base case below would then fail as IN_PROGRESS for
     * reasons having nothing to do with what it tests.
     *
     * What IS pinned here is that no refusal on this path ever tells an operator
     * to widen. That advice is the specific defect being removed, and a later
     * refusal that reintroduced the phrasing would reintroduce the corruption.
     */
    for (const refusal of [after, divergent]) {
      assert.doesNotMatch(
        refusal,
        /Name an earlier commit|\^ is the usual answer/,
        `nothing may push the operator toward a wider base; that advice is what made the field ` +
          `mean "probably safe enough" instead of "where this implementation began":\n${refusal}`,
      );
    }

    // An unknown implementation agent is not a name the control plane can hold
    // anyone to.
    runFail(
      gitRepo,
      reconcileArgs(BASE, "--implementation-agent", "nobody-at-all"),
      /Unknown agent nobody-at-all/,
    );
    // Naming the designated reviewer as the implementer would make the task
    // permanently unapprovable; saying so now costs one command, saying it at
    // approval time costs the round.
    runFail(
      gitRepo,
      reconcileArgs(BASE, "--implementation-agent", "gpt-architect"),
      /designated reviewer/,
    );

    // None of the refusals moved the task or wrote a base.
    assert.equal(taskOf(gitRepo, "PL-RC-0001").status, "CLAIMED");
    assert.equal(taskOf(gitRepo, "PL-RC-0001").implementationBaseSha, undefined);

    // The true base is accepted, and the implementation agent it asserts is the
    // subagent that actually wrote the code -- not whoever is claiming now.
    const accepted = run(
      gitRepo,
      CLI,
      reconcileArgs(BASE, "--implementation-agent", "claude-lead"),
    );
    assert.match(accepted, /RECONCILED pre-existing implementation/, accepted);
    assert.match(accepted, /asserted, not captured/, accepted);

    const reconciled = taskOf(gitRepo, "PL-RC-0001");
    assert.equal(reconciled.status, "IN_PROGRESS");
    assert.equal(
      reconciled.implementationBaseSha,
      BASE,
      "the machine-readable field itself must carry the true base",
    );
    assert.equal(reconciled.implementationAgent, "claude-lead");
    assert.equal(
      reconciled.implementationBaseProvenance.kind,
      "reconciled-existing-implementation",
    );
    assert.equal(reconciled.implementationBaseProvenance.baseSha, BASE);
    assert.equal(reconciled.implementationBaseProvenance.headAtReconciliation, HEAD);
    assert.deepEqual(
      [...reconciled.implementationBaseProvenance.surfaceCommits].sort(),
      [IMPL1, IMPL2].sort(),
      "the published window must name exactly the commits that touched the surface",
    );
    assert.equal(reconciled.implementationBaseProvenance.oldestSurfaceCommit, IMPL1);

    /*
     * THE EVIDENCE FIELD, on the honest base. BASE is the baseline commit: the
     * task is authored, none of its files exist yet, so the base commit itself
     * changed nothing under the reviewed surface. Zero is published as zero --
     * and it is a real answer here, not a stand-in for "could not be computed",
     * which is why an uninspectable base is refused outright rather than recorded
     * as an empty list.
     */
    assert.equal(reconciled.implementationBaseProvenance.baseCommitSurfaceTouchCount, 0);
    assert.deepEqual(reconciled.implementationBaseProvenance.baseCommitSurfaceTouches, []);
    assert.equal(
      reconciled.implementationBaseProvenance.baseCommitSurfaceTouchesTruncated,
      false,
    );

    // Reconciliation establishes a base; it does not revise one. A second
    // attempt is the silent hand-edit in command form.
    runFail(
      gitRepo,
      ["start", "PL-RC-0001", "claude-frontend", "--reconcile-existing",
       "--base", BASE, "--reason", "again"],
      /is IN_PROGRESS; reconciliation records where an implementation round BEGAN/,
    );

    /*
     * And it is refused from REVIEW too. policies.json permits
     * REVIEW -> IN_PROGRESS, so a plain `start` can legitimately pull a task back
     * out of review; without an explicit CLAIMED requirement the reconcile path
     * would inherit that route and let a base be asserted onto a task whose
     * reviewer is already reading it.
     */
    run(gitRepo, CLI, ["review", "PL-RC-0001", "claude-frontend"]);
    assert.equal(taskOf(gitRepo, "PL-RC-0001").status, "REVIEW");
    runFail(
      gitRepo,
      ["start", "PL-RC-0001", "claude-frontend", "--reconcile-existing",
       "--base", BASE, "--reason", "from review"],
      /is REVIEW; reconciliation records where an implementation round BEGAN/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9au. A reconciled base is what the first review range actually uses, and
   *      the audit trail cannot be misread as an ordinary start.
   *
   *      The point of writing the true base into the structural field -- rather
   *      than into evidence prose beside a false one -- is that the field is what
   *      every automated consumer reads. So the test is not that the value was
   *      stored; it is that expectedReviewBase, `--base auto` and the range
   *      validator all produce the reconciled range, and that a narrowed range
   *      over the same task is still refused afterwards.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0003", {
        title: "PL-RC-0003 reconciled implementation entering its first review",
        allowedPaths: ["fixtures/recu/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    const commit = (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD").trim();
    };

    git("init", "-q", "-b", "main");
    const BASE = commit("baseline");
    writeFixtureFile(repo, "fixtures/recu/one.ts", "export const one = 1;\n");
    const IMPL1 = commit("preflight implementation, part one");
    writeFixtureFile(repo, "fixtures/recu/two.ts", "export const two = 1;\n");
    const IMPL2 = commit("preflight implementation, part two");

    run(repo, CLI, ["claim", "PL-RC-0003", "claude-frontend"]);
    run(repo, CLI, [
      "start", "PL-RC-0003", "claude-frontend",
      "--reconcile-existing", "--base", BASE,
      "--reason", "base read from git log of fixtures/recu",
    ]);

    /* --- the audit trail names the operation, not merely its fields ---- */
    const started = eventsOf(repo).filter(
      (e) => e.taskId === "PL-RC-0003" && e.type.startsWith("task.started"),
    );
    assert.deepEqual(
      started.map((e) => e.type),
      ["task.started_reconciled"],
      "a reconciliation must not be recorded under the ordinary start type; a reader " +
        "scanning for task.started must not be able to overlook one field and miss it",
    );
    assert.equal(started[0].implementationBaseSha, BASE);
    assert.match(
      started[0].note,
      /pre-existing pushed implementation/,
      "the audit record must say what this was in words, not only in a type name",
    );
    assert.match(started[0].note, /not a new implementation start/);
    assert.equal(started[0].reason, "base read from git log of fixtures/recu");

    /* --- what a reviewer reads ----------------------------------------- */
    const status = JSON.parse(run(repo, CLI, ["review-status", "PL-RC-0003"]));
    assert.equal(status.implementationBaseSha, BASE);
    assert.equal(
      status.implementationBaseProvenance.kind,
      "reconciled-existing-implementation",
      "the reviewer-facing report must distinguish an asserted base from a captured one",
    );
    // The record is emitted whole, so every published field -- including the
    // base commit's own surface touches -- reaches the reviewer here too.
    assert.deepEqual(status.implementationBaseProvenance.baseCommitSurfaceTouches, []);
    assert.equal(status.implementationBaseProvenance.baseCommitSurfaceTouchCount, 0);

    /* --- the range the control plane actually derives ------------------- */
    const { expectedReviewBase, validateReviewRange, gitAdapter, RANGE_PERMANENT } =
      await import("../scripts/review-range.mjs");
    const task = taskOf(repo, "PL-RC-0003");
    assert.equal(
      expectedReviewBase(task, IMPL2),
      BASE,
      "the first review must open at the reconciled base, not at HEAD",
    );

    const adapter = gitAdapter(execFileSync, repo);
    assert.equal(
      validateReviewRange({
        baseSha: BASE, commitSha: IMPL2, task, label: "reconciled", git: adapter,
      }).status,
      "ok",
    );
    // The exact narrowing the reconciliation exists to make impossible: a range
    // that starts after part one. Rejected for the same reason a widened one is.
    const narrowed = validateReviewRange({
      baseSha: IMPL1, commitSha: IMPL2, task, label: "narrowed", git: adapter,
    });
    assert.equal(narrowed.status, RANGE_PERMANENT);
    assert.match(narrowed.reason, /expects a review starting at exactly/);

    /* --- and end to end, through the command an implementer actually runs */
    const published = run(repo, CLI, [
      "handoff",
      "--from", "claude-frontend",
      "--to", "gpt-architect",
      "--type", "review_request",
      "--task", "PL-RC-0003",
      "--sha", IMPL2,
      "--base", "auto",
      "--summary", "first review of a reconciled implementation",
    ]);
    assert.match(
      published,
      /base predates the claim/,
      `the request must tell the reviewer why its range opens before the claim:\n${published}`,
    );
    /*
     * The evidence travels with the range. The reviewer is being asked to settle
     * the one question no check can -- "does an earlier commit also belong to this
     * implementation?" -- so the most useful fact for it is stated where the range
     * is announced, not left in a field they would have to know to go and read.
     * Here it is zero: BASE is the baseline commit and touches none of
     * fixtures/recu.
     */
    assert.match(
      published,
      /the base commit itself changed 0 file\(s\) under allowedPaths/,
      `the review request must publish what the base commit itself changed:\n${published}`,
    );
    assert.match(
      published,
      /not a control-plane verdict/,
      `the reviewer must be told this is theirs to judge, not a finding already made:\n${published}`,
    );
    const messageId = published.match(/Published (MSG-\S+)/)[1];
    const message = JSON.parse(
      fs.readFileSync(busFile(repo, "claude-to-gpt", `${messageId}.json`), "utf8"),
    );
    assert.equal(
      message.baseSha,
      BASE,
      "--base auto must resolve to the reconciled base, so the reviewer is shown the whole implementation",
    );

    /* --- the provenance record cannot be attached to a base it does not
     *     describe. Otherwise a hand-edit could stamp "reconciled" onto a
     *     HEAD-captured sha and launder the very field this prevents. --- */
    const file = path.join(repo, "control", "tasks.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const edited = doc.tasks.find((t) => t.id === "PL-RC-0003");
    edited.implementationBaseProvenance.baseSha = IMPL1;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    runFail(repo, ["validate"], /does not explain the field it is attached to/);

    edited.implementationBaseProvenance.baseSha = BASE;
    edited.implementationBaseProvenance.reason = "";
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    runFail(repo, ["validate"], /carries no reason/);

    edited.implementationBaseProvenance.reason = "restored";
    edited.implementationBaseProvenance.kind = "captured-at-start";
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    runFail(repo, ["validate"], /unknown implementationBaseProvenance kind/);
  }

  /* ---------------------------------------------------------------------
   * 9av. What the base commit itself touched is REPORTED, never adjudicated.
   *
   *      This scenario used to pin a same-file refusal: a base commit that
   *      edited a file the window goes on to change was rejected as "inside the
   *      implementation". Two rounds were spent on which path surface it should
   *      consult -- the reviewed one refused every base for a task with churning
   *      `reviewDependencies`, so it was narrowed to the write surface -- before
   *      the answer turned out to be that it should not be a refusal at all.
   *
   *      The remedy it advised (`<sha>^`, repeatedly, until the overlap stopped)
   *      does not produce the commit this implementation began from; it produces
   *      a deliberately widened one. `implementationBaseSha` is the exact lower
   *      bound of the first review range, so widening it on a tool's advice makes
   *      the field mean "an earlier commit that is probably safe enough" -- and
   *      nothing downstream reads it that way. Git does not attribute commits to
   *      tasks, so the same overlap is equally the signature of two lanes sharing
   *      a directory, a revert, or a formatting pass.
   *
   *      So BOTH bases here are now accepted, and the difference between them is
   *      published rather than enforced: the reviewer is told exactly what each
   *      base commit changed under the reviewed surface and decides what it
   *      means. That is the assertion this scenario now makes.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0004", {
        title: "PL-RC-0004 preflight work beside a churning shared vocabulary",
        allowedPaths: ["fixtures/rcov/a/**"],
        reviewDependencies: ["fixtures/rcov/shared/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
      fixtureTask("PL-RC-0005", {
        title: "PL-RC-0005 the same history, judged from inside the implementation",
        lane: "Backend",
        preferredAgent: "claude-backend",
        allowedPaths: ["fixtures/rcov/b/**"],
        reviewDependencies: ["fixtures/rcov/shared/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { commit } = gitFixture(repo);

    writeFixtureFile(repo, "fixtures/rcov/shared/vocab.ts", "export type V = 'a';\n");
    commit("baseline: the shared vocabulary exists, nothing is implemented");

    // THE CANDIDATE BASE: another lane, churning the shared dependency. It
    // touches neither task's allowedPaths, so for both tasks it is genuinely the
    // commit before their implementation.
    writeFixtureFile(repo, "fixtures/rcov/shared/vocab.ts", "export type V = 'a' | 'b';\n");
    const BASE = commit("contracts lane widens the shared vocabulary");

    writeFixtureFile(repo, "fixtures/rcov/a/one.ts", "export const a1 = 1;\n");
    writeFixtureFile(repo, "fixtures/rcov/b/one.ts", "export const b1 = 1;\n");
    const IMPL1 = commit("preflight implementation, part one");

    // Part two edits BOTH tasks' files and the shared vocabulary again, so the
    // window legitimately contains dependency churn as well as implementation.
    fs.appendFileSync(path.join(repo, "fixtures", "rcov", "a", "one.ts"), "export const a2 = 2;\n");
    fs.appendFileSync(path.join(repo, "fixtures", "rcov", "b", "one.ts"), "export const b2 = 2;\n");
    writeFixtureFile(repo, "fixtures/rcov/shared/vocab.ts", "export type V = 'a' | 'b' | 'c';\n");
    const IMPL2 = commit("preflight implementation, part two");

    writeFixtureFile(repo, "docs/SCRATCH-RCOV.md", "unrelated\n");
    commit("unrelated work by another lane");

    run(repo, CLI, ["claim", "PL-RC-0004", "claude-frontend"]);
    run(repo, CLI, ["claim", "PL-RC-0005", "claude-backend"]);

    /*
     * INVERTED, DELIBERATELY. IMPL1 edits fixtures/rcov/b/one.ts and so does the
     * window that follows it, which is exactly the shape the removed heuristic
     * refused for PL-RC-0005. It is now ACCEPTED, and the fact that used to be a
     * verdict is published instead: the record names fixtures/rcov/b/one.ts as a
     * file the base commit itself changed, and a human reviewer -- who can read
     * the commit and ask the implementer -- settles whether that means the base
     * sits inside this task's work or merely beside it.
     *
     * This is not a relaxation of the range contract. The base still has to be a
     * real ancestor, still cannot be HEAD, and something under the reviewed
     * surface still has to change in base..HEAD; and whatever base is recorded is
     * still the exact lower bound `validateReviewRange` holds the first review to
     * (pinned in 9au). What is gone is the tool inferring task intent from a
     * filename collision, and then advising a wider base as the cure.
     */
    const insideShaped = run(repo, CLI, [
      "start", "PL-RC-0005", "claude-backend", "--reconcile-existing",
      "--base", IMPL1, "--reason", "part one is the last commit before this lane's work began",
    ]);
    assert.match(insideShaped, /RECONCILED pre-existing implementation/, insideShaped);
    assert.match(
      insideShaped,
      /the base commit itself changed 1 file\(s\)/,
      `the operator must be shown the evidence at the moment they can still act on it:\n${insideShaped}`,
    );
    assert.match(insideShaped, /fixtures\/rcov\/b\/one\.ts/, insideShaped);
    assert.match(
      insideShaped,
      /not a verdict/,
      `the report must not read as a finding the control plane has already made:\n${insideShaped}`,
    );
    assert.doesNotMatch(
      insideShaped,
      /Name an earlier commit|\^ is the usual answer/,
      `nothing may advise widening the base:\n${insideShaped}`,
    );
    const insideRecord = taskOf(repo, "PL-RC-0005").implementationBaseProvenance;
    assert.equal(insideRecord.baseCommitSurfaceTouchCount, 1);
    assert.deepEqual(insideRecord.baseCommitSurfaceTouches, ["fixtures/rcov/b/one.ts"]);
    assert.equal(insideRecord.baseCommitSurfaceTouchesTruncated, false);
    // The audit trail carries it too: a reviewer working from events.jsonl must
    // not have to open tasks.json to see what they are being asked to weigh.
    const insideEvent = eventsOf(repo)
      .filter((e) => e.taskId === "PL-RC-0005" && e.type === "task.started_reconciled")
      .at(-1);
    assert.deepEqual(insideEvent.baseCommitSurfaceTouches, ["fixtures/rcov/b/one.ts"]);
    assert.match(insideEvent.note, /evidence, not a verdict/);

    /*
     * ACCEPTED, and accepted for a second reason now. BASE edits
     * fixtures/rcov/shared/vocab.ts, which the window changes again -- an
     * intersection that once refused this correct answer outright. Its evidence
     * is a dependency file, which is precisely the reading a human does easily
     * and a file test does not.
     */
    const accepted = run(repo, CLI, [
      "start", "PL-RC-0004", "claude-frontend", "--reconcile-existing",
      "--base", BASE,
      "--reason", "git log fixtures/rcov/a shows the implementation begins at part one",
    ]);
    assert.match(accepted, /RECONCILED pre-existing implementation/, accepted);

    const reconciled = taskOf(repo, "PL-RC-0004");
    assert.equal(reconciled.implementationBaseSha, BASE);
    assert.equal(
      reconciled.implementationBaseProvenance.reviewSurface,
      "allowedPaths + reviewDependencies",
    );
    // The published window stays on the REVIEWED surface: a dependency change is
    // legitimately part of what the first review will bind to.
    assert.deepEqual(
      [...reconciled.implementationBaseProvenance.surfaceCommits].sort(),
      [IMPL1, IMPL2].sort(),
      "the window must still be measured on allowedPaths + reviewDependencies",
    );
    /*
     * And the evidence is measured on the REVIEWED surface too, which is the
     * whole reason the old write-surface/reviewed-surface split is gone. Every
     * other published field describes allowedPaths + reviewDependencies; a record
     * that quietly measured one field on a narrower surface would be one a
     * reviewer has to disambiguate before they can use any of it.
     */
    assert.deepEqual(
      reconciled.implementationBaseProvenance.baseCommitSurfaceTouches,
      ["fixtures/rcov/shared/vocab.ts"],
      "a base whose only surface touch is a shared dependency must say so, not be refused for it",
    );
    assert.equal(reconciled.implementationBaseProvenance.baseCommitSurfaceTouchCount, 1);
  }

  /* ---------------------------------------------------------------------
   * 9aw. The root commit: the base the removed heuristic could never accept.
   *
   *      This scenario used to assert a refusal and the special-cased error it
   *      needed. The overlap check told operators to name an earlier commit and
   *      offered `<sha>^`; a root commit has no parent, so the advice named a
   *      commit git will not resolve and the code carried a second message
   *      saying no reconcilable base existed at all.
   *
   *      That special case is the heuristic's own reductio. A repository whose
   *      first commit already contains preflight work has exactly one honest
   *      answer for where the review range opens -- that commit -- and the check
   *      declared the honest answer unreachable, because its only remedy was
   *      "go back further" and there was no further to go.
   *
   *      INVERTED: the root commit is now an ordinary, acceptable base, and what
   *      it changed under the reviewed surface is published so the reviewer can
   *      see that this range opens at a commit which already contains part of the
   *      work. The refusal is gone; the fact it was reacting to is not.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0006", {
        title: "PL-RC-0006 implementation reaching back to the root commit",
        allowedPaths: ["fixtures/rroot/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { commit } = gitFixture(repo);

    // The repository's FIRST commit already contains the implementation.
    writeFixtureFile(repo, "fixtures/rroot/impl.ts", "export const impl = 1;\n");
    const ROOT = commit("root commit, implementation included");
    fs.appendFileSync(path.join(repo, "fixtures", "rroot", "impl.ts"), "export const more = 2;\n");
    commit("implementation continues");

    run(repo, CLI, ["claim", "PL-RC-0006", "claude-frontend"]);
    const accepted = run(repo, CLI, [
      "start", "PL-RC-0006", "claude-frontend", "--reconcile-existing",
      "--base", ROOT, "--reason", "the only commit before the rest of the work",
    ]);
    assert.match(accepted, /RECONCILED pre-existing implementation/, accepted);
    assert.doesNotMatch(
      accepted,
      /ROOT commit, so there is no earlier commit to name|\^ is the usual answer/,
      `there is no longer a refusal here, so neither of its remedies may survive:\n${accepted}`,
    );
    const rootRecord = taskOf(repo, "PL-RC-0006").implementationBaseProvenance;
    assert.equal(taskOf(repo, "PL-RC-0006").implementationBaseSha, ROOT);
    assert.deepEqual(
      rootRecord.baseCommitSurfaceTouches,
      ["fixtures/rroot/impl.ts"],
      "the reviewer must be told that the range opens at a commit already containing part of the work",
    );
    // `surfaceFilesTouchedBy` passes --root for a parentless commit; without it a
    // root commit diffs against nothing and the evidence would read as an empty
    // list -- the most reassuring possible answer about the one base that most
    // needs looking at.
    assert.equal(rootRecord.baseCommitSurfaceTouchCount, 1);
  }

  /* ---------------------------------------------------------------------
   * 9ax. Two ways a diff can lie about what a commit touched.
   *
   *      Both halves were written against the removed overlap refusal and both
   *      are INVERTED here: the bases are accepted, and what is asserted is that
   *      the published evidence still names the file. The defects are unchanged
   *      and matter just as much, because an under-reported diff now produces a
   *      record that tells the reviewer this commit touched NOTHING under the
   *      surface -- the most reassuring answer available, and a false one. A
   *      wrong refusal is loud; a wrong reassurance is silent.
   *
   *      MERGES. `diff-tree` reports an empty diff for a merge unless told which
   *      parent to compare against, and first-parent was the previous answer.
   *      A merge that resolved the reviewed files TOWARDS the mainline is
   *      TREESAME to its first parent while differing from its second, so a
   *      conflict resolution sitting inside an implementation stream reported
   *      itself as touching nothing while looking perfectly healthy.
   *
   *      RENAMES. The two diff helpers were built under different rules:
   *      porcelain `git diff` honours `diff.renames` and reports a rename as its
   *      destination alone, while plumbing `diff-tree` does not and reports a
   *      delete plus an add. A base that edited a file the window then RENAMED
   *      was therefore described in two spellings at once. `--no-renames` is
   *      pinned on both rather than left to configuration, so the evidence names
   *      the file under the spelling the base itself used and the published
   *      counts mean the same thing on every machine that re-derives them.
   * ------------------------------------------------------------------- */
  {
    /* --- the merge half ------------------------------------------------ */
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0007", {
        title: "PL-RC-0007 implementation stream containing a merge",
        allowedPaths: ["fixtures/rmg/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { git, head, commit } = gitFixture(repo);

    writeFixtureFile(repo, "fixtures/rmg/impl.ts", "v0\n");
    const B = commit("baseline");

    git("checkout", "-q", "-b", "side", B);
    writeFixtureFile(repo, "fixtures/rmg/impl.ts", "side\n");
    commit("the side branch edits the implementation file");

    git("checkout", "-q", "main");
    writeFixtureFile(repo, "fixtures/rmg/impl.ts", "main\n");
    const M1 = commit("the mainline edits the same file");

    // Resolved toward the mainline, so the merge's tree equals its FIRST
    // parent's while differing from its second.
    git("merge", "-q", "--no-ff", "-X", "ours", "-m", "merge side, resolved toward the mainline", "side");
    const MERGE = head();
    assert.equal(
      git("diff", "--name-only", M1, MERGE, "--", "fixtures/rmg").trim(),
      "",
      "the fixture merge must be TREESAME to its first parent, or this scenario proves nothing",
    );

    writeFixtureFile(repo, "fixtures/rmg/impl.ts", "v2\n");
    commit("implementation continues after the merge");
    writeFixtureFile(repo, "docs/SCRATCH-RMG.md", "unrelated\n");
    commit("unrelated work by another lane");

    run(repo, CLI, ["claim", "PL-RC-0007", "claude-frontend"]);
    run(repo, CLI, [
      "start", "PL-RC-0007", "claude-frontend", "--reconcile-existing",
      "--base", MERGE, "--reason", "chosen because the merge looks like a boundary",
    ]);
    const mergeRecord = taskOf(repo, "PL-RC-0007").implementationBaseProvenance;
    assert.deepEqual(
      mergeRecord.baseCommitSurfaceTouches,
      ["fixtures/rmg/impl.ts"],
      "a merge is compared against EVERY parent; first-parent alone reports this one as touching nothing",
    );
    assert.equal(mergeRecord.baseCommitSurfaceTouchCount, 1);

    /* --- the rename half ----------------------------------------------- */
    const renameRepo = freshRepo();
    addFixtureTasks(
      renameRepo,
      fixtureTask("PL-RC-0008", {
        title: "PL-RC-0008 implementation that renames the file its base edited",
        allowedPaths: ["fixtures/rren/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const rename = gitFixture(renameRepo);
    // Pinned ON deliberately: this is the configuration under which the two
    // helpers disagreed, and the fix must hold regardless of it.
    rename.git("config", "diff.renames", "true");

    writeFixtureFile(renameRepo, "fixtures/rren/old.ts", "export const x = 1;\n");
    rename.commit("baseline");
    writeFixtureFile(renameRepo, "fixtures/rren/old.ts", "export const x = 2;\n");
    const RENAME_BASE = rename.commit("edit the file, under its old name");
    rename.git("mv", "fixtures/rren/old.ts", "fixtures/rren/new.ts");
    rename.commit("the implementation renames it");
    writeFixtureFile(renameRepo, "docs/SCRATCH-RREN.md", "unrelated\n");
    rename.commit("unrelated work by another lane");

    run(renameRepo, CLI, ["claim", "PL-RC-0008", "claude-frontend"]);
    const renameOutput = run(renameRepo, CLI, [
      "start", "PL-RC-0008", "claude-frontend", "--reconcile-existing",
      "--base", RENAME_BASE, "--reason", "the last commit before the implementation renamed the file",
    ]);
    assert.match(
      renameOutput,
      /fixtures\/rren\/old\.ts/,
      `the evidence must name the file under the spelling the base used:\n${renameOutput}`,
    );
    assert.deepEqual(
      taskOf(renameRepo, "PL-RC-0008").implementationBaseProvenance
        .baseCommitSurfaceTouches,
      ["fixtures/rren/old.ts"],
      "with rename detection left to configuration this file is reported under two different names",
    );
    // And `validate` re-derives the count over the same pinned rules, so an
    // honest record does not draw a mismatch warning from a git config setting.
    assert.match(
      runCombined(renameRepo, CLI, ["validate"]),
      /AI control plane valid/,
      "a reconciled task in a repository with diff.renames on must still validate cleanly",
    );
  }

  /* ---------------------------------------------------------------------
   * 9ay. "Never for uncommitted work" is enforced, not merely documented.
   *
   *      Reconciliation ASSERTS that the implementation already exists in pushed
   *      commits. Nothing checked it. The central "something changed under the
   *      surface" check catches an uncommitted implementation only when NOTHING
   *      changed in base..HEAD, which on any wide surface is satisfied trivially
   *      by other lanes' commits -- so an implementation living entirely in the
   *      working tree could reconcile to a base that predates nothing and
   *      publish a window built from other people's work.
   *
   *      Scoped to allowedPaths, like every other dirty-tree check here, so
   *      unrelated dirt cannot block a legitimate reconciliation.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0009", {
        title: "PL-RC-0009 reconciliation attempted over a dirty tree",
        allowedPaths: ["fixtures/rdirty/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { commit } = gitFixture(repo);

    writeFixtureFile(repo, "fixtures/rdirty/keep.ts", "export const keep = 0;\n");
    const BASE = commit("baseline");
    writeFixtureFile(repo, "fixtures/rdirty/impl.ts", "export const impl = 1;\n");
    commit("preflight implementation, committed");
    writeFixtureFile(repo, "docs/SCRATCH-RDIRTY.md", "unrelated\n");
    commit("unrelated work by another lane");

    run(repo, CLI, ["claim", "PL-RC-0009", "claude-frontend"]);

    // Dirt in two places at once: one inside the task's write surface, one
    // outside it. Only the first is this task's business.
    writeFixtureFile(repo, "fixtures/rdirty/uncommitted.ts", "export const later = 2;\n");
    writeFixtureFile(repo, "docs/SCRATCH-RDIRTY-2.md", "an unrelated scratch file\n");

    const args = [
      "start", "PL-RC-0009", "claude-frontend", "--reconcile-existing",
      "--base", BASE, "--reason", "the committed part really does predate the claim",
    ];
    const dirty = runFail(repo, args, /uncommitted change\(s\) under its allowedPaths/);
    assert.match(dirty, /fixtures\/rdirty\/uncommitted\.ts/, dirty);
    assert.doesNotMatch(
      dirty,
      /SCRATCH-RDIRTY-2/,
      `dirt outside allowedPaths is another lane's business:\n${dirty}`,
    );
    assert.equal(taskOf(repo, "PL-RC-0009").status, "CLAIMED");
    assert.equal(taskOf(repo, "PL-RC-0009").implementationBaseSha, undefined);

    // The same command, with only the in-scope dirt removed. The unrelated
    // scratch file is still there, and still must not block anything -- a
    // dirty-tree check that fired on the whole repository would make every
    // reconciliation impossible, because `claim` itself rewrites control/.
    fs.rmSync(path.join(repo, "fixtures", "rdirty", "uncommitted.ts"));
    assert.match(run(repo, CLI, args), /RECONCILED pre-existing implementation/);
    assert.equal(taskOf(repo, "PL-RC-0009").implementationBaseSha, BASE);
  }

  /* ---------------------------------------------------------------------
   * 9az. A value flag that arrives empty is refused, not read as absent.
   *
   *      `--base` whose sha was eaten by shell quoting or an empty variable came
   *      back as null, indistinguishable from "no --base was passed": the
   *      ordinary-start refusal only rejected non-null values, so
   *      `start PL-X agent --base` captured HEAD and printed success. That is
   *      exactly the accepted-and-ignored `--base` the command's own comment
   *      calls the worst outcome available -- produced by the mechanism built to
   *      prevent it.
   *
   *      No git here on purpose: these are argument-shape decisions and must fire
   *      before any history is consulted.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0010", {
        title: "PL-RC-0010 flag-shape contract",
        allowedPaths: ["fixtures/rflag/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const SHA = "e".repeat(40);
    run(repo, CLI, ["claim", "PL-RC-0010", "claude-frontend"]);

    // A bare --base on an ordinary start is refused exactly like one carrying a
    // value: PRESENCE is what makes it meaningless without --reconcile-existing.
    runFail(
      repo,
      ["start", "PL-RC-0010", "claude-frontend", "--base"],
      /--base is only meaningful with --reconcile-existing/,
    );
    runFail(
      repo,
      ["start", "PL-RC-0010", "claude-frontend", "--reason"],
      /--reason is only meaningful with --reconcile-existing/,
    );
    // ...including when the "value" is the next flag rather than a missing one.
    runFail(
      repo,
      ["start", "PL-RC-0010", "claude-frontend", "--base", "--reason", "x"],
      /--base is only meaningful with --reconcile-existing/,
    );

    // And on the reconcile path the same emptiness is refused from the other
    // side, naming the flag rather than complaining about a sha it never got.
    runFail(
      repo,
      ["start", "PL-RC-0010", "claude-frontend", "--reconcile-existing", "--base", "--reason", "x"],
      /--base was passed without a value/,
    );
    runFail(
      repo,
      [
        "start", "PL-RC-0010", "claude-frontend", "--reconcile-existing",
        "--base", SHA, "--reason",
      ],
      /--reason was passed without a value/,
    );
    runFail(
      repo,
      [
        "start", "PL-RC-0010", "claude-frontend", "--reconcile-existing",
        "--base", SHA, "--reason", "because", "--implementation-agent",
      ],
      /--implementation-agent was passed without a value/,
    );

    // Nothing above may have started the task or written a base.
    assert.equal(taskOf(repo, "PL-RC-0010").status, "CLAIMED");
    assert.equal(taskOf(repo, "PL-RC-0010").implementationBaseSha, undefined);
  }

  /* ---------------------------------------------------------------------
   * 9ba. The provenance record is verified, not read back.
   *
   *      Validation used to check three things: the kind string, a baseSha
   *      matching the field it explains, and a non-empty reason. Everything else
   *      the record published -- the head it was reconciled against, the window,
   *      its endpoints, the changed-file count, who reconciled it, who
   *      implemented it, the surface -- was accepted verbatim, while
   *      control/README.md told reviewers to lean on exactly those fields. A
   *      five-line marker pasted onto an ordinarily started task passed
   *      `validate`, and `review-status` then reported an asserted base with the
   *      full authority of the control plane.
   *
   *      Nothing can stop a hand-edit. The goal is that a forged record is
   *      DETECTABLE, so this pins both directions: an honest record validates
   *      cleanly, and each way of forging one is named.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0011", {
        title: "PL-RC-0011 honestly reconciled implementation",
        allowedPaths: ["fixtures/rprov/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
      fixtureTask("PL-RC-0012", {
        title: "PL-RC-0012 ordinary start, later stamped as a reconciliation",
        lane: "Backend",
        preferredAgent: "claude-backend",
        allowedPaths: ["fixtures/rprov-b/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { commit } = gitFixture(repo);
    writeFixtureFile(repo, "fixtures/rprov/keep.ts", "export const keep = 0;\n");
    writeFixtureFile(repo, "fixtures/rprov-b/keep.ts", "export const keep = 0;\n");
    const BASE = commit("baseline");
    writeFixtureFile(repo, "fixtures/rprov/impl.ts", "export const impl = 1;\n");
    const IMPL = commit("preflight implementation");
    writeFixtureFile(repo, "docs/SCRATCH-RPROV.md", "unrelated\n");
    commit("unrelated work by another lane");

    run(repo, CLI, ["claim", "PL-RC-0011", "claude-frontend"]);
    run(repo, CLI, [
      "start", "PL-RC-0011", "claude-frontend", "--reconcile-existing",
      "--base", BASE, "--reason", "git log fixtures/rprov begins at the implementation commit",
    ]);

    // An honest record validates cleanly. Without this half, a validator that
    // rejected every record -- forged or not -- would look just as green.
    assert.match(
      runCombined(repo, CLI, ["validate"]),
      /AI control plane valid/,
      "an honestly reconciled task must still validate",
    );

    const file = path.join(repo, "control", "tasks.json");
    const readDoc = () => JSON.parse(fs.readFileSync(file, "utf8"));
    const writeDoc = (doc) =>
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    /*
     * One hand-edit at a time, each undone before the next.
     *
     * The WHOLE task is snapshotted and restored, not just the provenance
     * record: one of the edits below moves `implementationBaseSha` too, and a
     * partial restore would leave every later assertion measuring the residue of
     * an earlier one rather than the edit it names.
     */
    const honest = JSON.stringify(taskOf(repo, "PL-RC-0011"));
    const edit = (mutate, matcher) => {
      const doc = readDoc();
      mutate(doc.tasks.find((t) => t.id === "PL-RC-0011"));
      writeDoc(doc);
      const out = runFail(repo, ["validate"], matcher);
      const restored = readDoc();
      restored.tasks[restored.tasks.findIndex((t) => t.id === "PL-RC-0011")] =
        JSON.parse(honest);
      writeDoc(restored);
      assert.match(
        runCombined(repo, CLI, ["validate"]),
        /AI control plane valid/,
        "each hand-edit must be fully undone, or the next assertion measures the wrong thing",
      );
      return out;
    };

    /* --- shape: every field, not just three ---------------------------- */
    edit(
      (t) => delete t.implementationBaseProvenance.headAtReconciliation,
      /headAtReconciliation must be a full 40-character hex sha/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.reconciledBy = "nobody-at-all"),
      /reconciledBy names unknown agent nobody-at-all/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.implementationAgent = "nobody-at-all"),
      /implementationAgent names unknown agent nobody-at-all/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.reconciledAt = "last tuesday"),
      /reconciledAt must be an ISO timestamp/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.reviewSurface = "everything"),
      /reviewSurface must be one of/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.changedFileCount = 0),
      /reports 0 changed files/,
    );
    // The endpoints are pinned TO the published list, because they are what a
    // reviewer is sent to interrogate.
    edit(
      (t) => (t.implementationBaseProvenance.oldestSurfaceCommit = "f".repeat(40)),
      /oldestSurfaceCommit .* is not the oldest commit it publishes/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.surfaceCommitCount = 7),
      /surfaceCommitsTruncated=false while publishing 1 of 7 commit\(s\)/,
    );
    // The evidence field is shape-checked like everything else. A published fact
    // a reviewer is told to weigh is exactly as worth forging as the window.
    edit(
      (t) => (t.implementationBaseProvenance.baseCommitSurfaceTouches = "none"),
      /baseCommitSurfaceTouches must be an array of file paths/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.baseCommitSurfaceTouchesTruncated = "no"),
      /baseCommitSurfaceTouchesTruncated must be a boolean/,
    );
    edit(
      (t) => (t.implementationBaseProvenance.baseCommitSurfaceTouchCount = 9),
      /baseCommitSurfaceTouchesTruncated=false while publishing 1 of 9 touch\(es\)/,
    );

    /*
     * THE CHEAP FORGERY ON THE EVIDENCE FIELD, and the honest limit of catching
     * it.
     *
     * BASE here is the repository's first commit and legitimately touches
     * fixtures/rprov/keep.ts, so the honest record publishes one touch -- an
     * ordinary, correct base that the removed heuristic would have had an opinion
     * about. Emptying that list is the forgery with a motive: it makes a base read
     * as untouched by the surface it precedes, which is the reassuring answer.
     *
     * It is caught by RE-DERIVATION, and reported as a WARNING rather than an
     * error, for the same reason the other counts are: `allowedPaths` and
     * `reviewDependencies` may be legitimately redeclared after a reconciliation,
     * and a recomputation over the new surface then disagrees with a record that
     * was honest when written. Erroring would strand correct tasks. A warning that
     * names the contradiction is the strongest verdict that is actually true.
     */
    {
      const doc = readDoc();
      const t = doc.tasks.find((x) => x.id === "PL-RC-0011");
      assert.deepEqual(
        t.implementationBaseProvenance.baseCommitSurfaceTouches,
        ["fixtures/rprov/keep.ts"],
        "the honest record must publish what the base commit really changed",
      );
      t.implementationBaseProvenance.baseCommitSurfaceTouches = [];
      t.implementationBaseProvenance.baseCommitSurfaceTouchCount = 0;
      writeDoc(doc);
      const out = runCombined(repo, CLI, ["validate"]);
      assert.match(
        out,
        /claims the base commit itself changed 0 file\(s\).*finds 1/s,
        `an emptied evidence list must be contradicted by the repository itself:\n${out}`,
      );
      const restored = readDoc();
      restored.tasks[restored.tasks.findIndex((x) => x.id === "PL-RC-0011")] =
        JSON.parse(honest);
      writeDoc(restored);
      assert.match(runCombined(repo, CLI, ["validate"]), /AI control plane valid/);
    }

    /* --- history: facts no later edit changes -------------------------- */
    edit((t) => {
      // A window whose head is not a descendant of its base is not a range.
      t.implementationBaseProvenance.headAtReconciliation = BASE;
      t.implementationBaseProvenance.baseSha = IMPL;
      t.implementationBaseSha = IMPL;
      t.implementationBaseProvenance.oldestSurfaceCommit = null;
      t.implementationBaseProvenance.newestSurfaceCommit = null;
      t.implementationBaseProvenance.surfaceCommits = [];
      t.implementationBaseProvenance.surfaceCommitCount = 0;
    }, /is not an ancestor of that head/);

    /* --- corroboration: the audit trail must agree --------------------- */
    /*
     * THE FORGERY THE OLD VALIDATION ACCEPTED. PL-RC-0012 was started
     * ordinarily; a consistent-looking provenance record is pasted onto its
     * captured base by hand. Every field agrees with every other field, so shape
     * alone cannot catch it -- but events.jsonl carries `task.started`, not
     * `task.started_reconciled`, and the CLI writes the record and the event
     * together.
     */
    run(repo, CLI, ["claim", "PL-RC-0012", "claude-backend"]);
    run(repo, CLI, ["start", "PL-RC-0012", "claude-backend"]);
    const captured = taskOf(repo, "PL-RC-0012").implementationBaseSha;
    assert.ok(captured, "an ordinary start must have captured a base to forge over");
    const forgedDoc = readDoc();
    forgedDoc.tasks.find((t) => t.id === "PL-RC-0012").implementationBaseProvenance = {
      kind: "reconciled-existing-implementation",
      baseSha: captured,
      reconciledAt: new Date().toISOString(),
      reconciledBy: "claude-backend",
      implementationAgent: "claude-backend",
      headAtReconciliation: IMPL,
      reviewSurface: "allowedPaths",
      surfaceCommitCount: 0,
      oldestSurfaceCommit: null,
      newestSurfaceCommit: null,
      surfaceCommits: [],
      surfaceCommitsTruncated: false,
      changedFileCount: 3,
      reason: "hand-written to look exactly like the real thing",
    };
    writeDoc(forgedDoc);
    runFail(
      repo,
      ["validate"],
      /PL-RC-0012: implementationBaseProvenance claims a reconciliation at .*records no matching task\.started_reconciled/s,
    );
  }

  /* ---------------------------------------------------------------------
   * 9bb. The published window keeps the end the reviewer is sent to, and the
   *      audit event is written only after task state is durable.
   *
   *      The record exists to let a reviewer ask the one question no check can
   *      answer: is there an EARLIER commit that also belongs to this
   *      implementation? It answered by publishing the twenty NEWEST commits of
   *      the window and silently dropping the oldest end -- the only end that
   *      question is about -- and a truncated list looked exactly like a complete
   *      one.
   *
   *      The second half is the ordering discipline `recordReview` states and
   *      `approve` follows. Emitting the audit record before `syncAll` meant a
   *      failure in between left events.jsonl asserting a reconciliation the task
   *      file never received, and a retry appended a second one. These events
   *      carry no deterministic id, so nothing would deduplicate them.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0013", {
        title: "PL-RC-0013 a long pre-existing implementation",
        allowedPaths: ["fixtures/rwin/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { commit } = gitFixture(repo);
    writeFixtureFile(repo, "fixtures/rwin/keep.ts", "export const keep = 0;\n");
    const BASE = commit("baseline");

    const windowCommits = [];
    for (let i = 0; i < 22; i++) {
      writeFixtureFile(repo, `fixtures/rwin/part-${i}.ts`, `export const p${i} = ${i};\n`);
      windowCommits.push(commit(`preflight implementation, part ${i}`));
    }
    writeFixtureFile(repo, "docs/SCRATCH-RWIN.md", "unrelated\n");
    commit("unrelated work by another lane");

    run(repo, CLI, ["claim", "PL-RC-0013", "claude-frontend"]);
    run(repo, CLI, [
      "start", "PL-RC-0013", "claude-frontend", "--reconcile-existing",
      "--base", BASE, "--reason", "git log fixtures/rwin begins at part 0",
    ]);

    const p = taskOf(repo, "PL-RC-0013").implementationBaseProvenance;
    assert.equal(p.surfaceCommitCount, 22);
    assert.equal(p.surfaceCommitsTruncated, true, "22 commits must be reported as truncated");
    assert.equal(p.surfaceCommits.length, 20);
    assert.equal(
      p.oldestSurfaceCommit,
      windowCommits[0],
      "the oldest commit in the window is the field the reviewer interrogates",
    );
    assert.equal(
      p.surfaceCommits[p.surfaceCommits.length - 1],
      windowCommits[0],
      "the published list must be kept from the OLDEST end, not the newest",
    );
    assert.equal(p.newestSurfaceCommit, windowCommits[21]);
    assert.ok(
      !p.surfaceCommits.includes(windowCommits[21]),
      "a truncated list drops the newest end, which is why both endpoints are named",
    );
    assert.match(runCombined(repo, CLI, ["validate"]), /AI control plane valid/);

    /* --- the audit record follows the durable write -------------------- */
    const failRepo = freshRepo();
    addFixtureTasks(
      failRepo,
      fixtureTask("PL-RC-0014", {
        title: "PL-RC-0014 reconciliation interrupted while regenerating views",
        allowedPaths: ["fixtures/rord/**"],
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const ord = gitFixture(failRepo);
    writeFixtureFile(failRepo, "fixtures/rord/keep.ts", "export const keep = 0;\n");
    const ORD_BASE = ord.commit("baseline");
    writeFixtureFile(failRepo, "fixtures/rord/impl.ts", "export const impl = 1;\n");
    ord.commit("preflight implementation");
    writeFixtureFile(failRepo, "docs/SCRATCH-RORD.md", "unrelated\n");
    ord.commit("unrelated work by another lane");

    run(failRepo, CLI, ["claim", "PL-RC-0014", "claude-frontend"]);
    // Break the generated view so `syncAll` throws AFTER it has persisted task
    // state. This is the window the old ordering got wrong.
    const tasksMd = path.join(failRepo, "coordination", "TASKS.md");
    fs.rmSync(tasksMd);
    fs.mkdirSync(tasksMd);

    runFail(failRepo, [
      "start", "PL-RC-0014", "claude-frontend", "--reconcile-existing",
      "--base", ORD_BASE, "--reason", "interrupted while regenerating views",
    ]);
    assert.equal(
      taskOf(failRepo, "PL-RC-0014").implementationBaseSha,
      ORD_BASE,
      "task state is the durable commit point and must have been written",
    );
    assert.deepEqual(
      eventsOf(failRepo)
        .filter((e) => e.taskId === "PL-RC-0014" && e.type.startsWith("task.started"))
        .map((e) => e.type),
      [],
      "events.jsonl must never assert a reconciliation the run did not complete",
    );
  }

  /* ---------------------------------------------------------------------
   * 9bc. --implementation-agent adds an implementer; it can never remove one.
   *
   *      `assertReviewAllowed` compared the reviewer against
   *      `implementationAgent ?? owner`, and `start --reconcile-existing
   *      --implementation-agent X` is the one operation that makes those two
   *      different agents. Asserting a third party therefore DISPLACED the owner
   *      from the self-approval comparison, and on a task with no designated
   *      reviewAgent the owner could then approve their own work -- while the
   *      comment above the line claimed the flag granted no new capability.
   *
   *      The incentive that created was backwards: declaring the real implementer
   *      honestly is what unlocked self-approval, and saying nothing left the
   *      owner correctly blocked.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    addFixtureTasks(
      repo,
      fixtureTask("PL-RC-0015", {
        title: "PL-RC-0015 reconciled work with an asserted third-party implementer",
        allowedPaths: ["fixtures/rself/**"],
        // No designated reviewer: the case where the self-approval rule is the
        // only thing standing between an owner and their own approval.
        reviewAgent: undefined,
        acceptance: "fixture task used by the provenance-reconciliation scenarios",
      }),
    );
    const { commit } = gitFixture(repo);
    writeFixtureFile(repo, "fixtures/rself/keep.ts", "export const keep = 0;\n");
    const BASE = commit("baseline");
    writeFixtureFile(repo, "fixtures/rself/impl.ts", "export const impl = 1;\n");
    commit("preflight implementation");
    writeFixtureFile(repo, "docs/SCRATCH-RSELF.md", "unrelated\n");
    commit("unrelated work by another lane");

    run(repo, CLI, ["claim", "PL-RC-0015", "claude-frontend"]);
    run(repo, CLI, [
      "start", "PL-RC-0015", "claude-frontend", "--reconcile-existing",
      "--base", BASE, "--reason", "claude-lead wrote this before the task existed",
      "--implementation-agent", "claude-lead",
    ]);
    assert.equal(taskOf(repo, "PL-RC-0015").implementationAgent, "claude-lead");
    run(repo, CLI, ["review", "PL-RC-0015", "claude-frontend"]);

    // THE ESCALATION. The owner is not the recorded implementationAgent any
    // more, and used to be invisible to the self-approval comparison.
    runFail(
      repo,
      ["approve", "PL-RC-0015", "claude-frontend", "looks good to me"],
      /self-approval is prohibited/,
    );
    assert.equal(
      taskOf(repo, "PL-RC-0015").review,
      undefined,
      "a refused self-approval must not be recorded",
    );

    // A genuinely independent reviewer is unaffected.
    run(repo, CLI, ["approve", "PL-RC-0015", "gpt-architect", "independent review"]);
    const record = taskOf(repo, "PL-RC-0015").review;
    assert.equal(record.implementationAgent, "claude-lead");
    assert.equal(
      record.implementationOwner,
      "claude-frontend",
      "the record must carry BOTH implementation-side identities, or a later " +
        "historical check re-derives a weaker rule than the one applied here",
    );

    // And the same widening applies when the record is read back rather than
    // written: a hand-edit naming the owner as reviewer is a self-approval.
    const file = path.join(repo, "control", "tasks.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.tasks.find((t) => t.id === "PL-RC-0015").review.reviewerAgent =
      "claude-frontend";
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    runFail(repo, ["validate"], /PL-RC-0015: review record is a self-approval/);
  }

  /* ---------------------------------------------------------------------
   * 10. Bootstrap into a new project still works.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const child = path.join(temp, "child-project");
    run(repo, "scripts/bootstrap-ai-project.mjs", [
      "--target",
      child,
      "--name",
      "Child Project",
      "--prefix",
      "CP",
    ]);
    run(child, CLI, ["validate"]);
    run(child, CLI, ["sync"]);
    assert.match(
      fs.readFileSync(
        path.join(child, "coordination", "PROJECT_STATUS.md"),
        "utf8",
      ),
      /Child Project/,
    );

    // The bus must work in a bootstrapped project too: the CLI imports
    // agent-bus.mjs, so a skeleton missing it fails at module resolution on the
    // very first command.
    assert.match(
      run(child, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
    assert.match(
      run(child, "scripts/agent-bus.mjs", ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
      "the direct bus entry point must work in a bootstrapped project",
    );

    // The honest trust model travels with the skeleton rather than being
    // silently dropped when the control plane is reused.
    const childProject = JSON.parse(
      fs.readFileSync(path.join(child, "control", "project.json"), "utf8"),
    );
    assert.equal(
      childProject.agentBus.trustModel,
      "cooperative-github-writers",
    );
    assert.equal(childProject.agentBus.authenticatesSenderIdentity, false);
  }

  /* ---------------------------------------------------------------------
   * 11. The live repository state must be untouched by the whole run.
   *     This now also guards coordination/agent-bus, so a test that forgets
   *     freshRepo() cannot publish a real handoff message.
   * ------------------------------------------------------------------- */
  assert.equal(
    fs.readFileSync(liveTasksPath, "utf8"),
    liveTasksBefore,
    "running the test suite must not mutate the real control/tasks.json",
  );

  const liveStateAfter = snapshotLiveState();
  assert.deepEqual(
    [...liveStateAfter.entries()].sort(),
    [...liveStateBefore.entries()].sort(),
    "running the test suite must not mutate any live control/ or coordination/ file",
  );

  console.log("AI control plane tests passed (66 scenarios).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
