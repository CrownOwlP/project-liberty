#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const target = arg("--target");
const name = arg("--name");
const prefix = arg("--prefix");
if (!target || !name || !prefix) {
  console.error('Usage: node scripts/bootstrap-ai-project.mjs --target <path> --name "Project Name" --prefix ABC');
  process.exit(1);
}
const sourceRoot = process.cwd();
const dest = path.resolve(target);
fs.mkdirSync(path.join(dest, "control", "queues"), { recursive: true });
fs.mkdirSync(path.join(dest, "coordination"), { recursive: true });
fs.mkdirSync(path.join(dest, "scripts"), { recursive: true });

const baseAgents = JSON.parse(fs.readFileSync(path.join(sourceRoot, "control", "agents.json"), "utf8"));
const baseGates = JSON.parse(fs.readFileSync(path.join(sourceRoot, "control", "quality-gates.json"), "utf8"));
const basePolicies = JSON.parse(fs.readFileSync(path.join(sourceRoot, "control", "policies.json"), "utf8"));
const baseAdapters = JSON.parse(fs.readFileSync(path.join(sourceRoot, "control", "adapters.json"), "utf8"));
const project = {
  "$schemaVersion": 1,
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  name,
  taskPrefix: prefix.toUpperCase(),
  mission: "Define the project mission here.",
  repositoryRoot: ".",
  controlPlane: {
    sourceOfTruth: "control/tasks.json",
    humanStatus: "coordination/PROJECT_STATUS.md",
    humanTaskBoard: "coordination/TASKS.md",
    eventLog: "control/events.jsonl",
    agentRegistry: "control/agents.json",
    qualityGates: "control/quality-gates.json",
    policies: "control/policies.json",
    milestones: "control/milestones.json"
  },
  agentBus: {
    path: "coordination/agent-bus",
    trustModel: "cooperative-github-writers",
    authenticatesSenderIdentity: false,
    description: "GitHub-transported handoff between agent lanes. The `fromAgent` field is self-asserted and is NOT authenticated: any principal with write access to this repository can publish a message claiming any agent identity. The control plane enforces that the CLAIMED reviewer is the designated one and is not the implementer, but cannot prove authorship.",
    notProvided: [
      "cryptographic agent identity",
      "protection against a malicious peer holding the same repository credential",
      "resistance to identity spoofing"
    ],
    recoveryScope: "persistent local worker checkout; the crash-recovery journal is local and is NOT sufficient for an ephemeral CI runner"
  },
  operatingPrinciples: ["maximize safe parallelism", "protect independent path ownership", "require explicit quality evidence before completion"]
};
const tasks = { "$schemaVersion": 1, tasks: [] };
const milestones = { "$schemaVersion": 1, milestones: [] };
const writes = [
  ["control/project.json", project], ["control/tasks.json", tasks], ["control/milestones.json", milestones], ["control/agents.json", baseAgents],
  ["control/quality-gates.json", baseGates], ["control/policies.json", basePolicies], ["control/adapters.json", baseAdapters]
];
for (const [rel, value] of writes) fs.writeFileSync(path.join(dest, rel), JSON.stringify(value, null, 2) + "\n");
fs.writeFileSync(path.join(dest, "control", "events.jsonl"), "");
/*
 * Copy the control-plane CLI and everything it imports, TRANSITIVELY.
 *
 * A hardcoded list is a trap: adding a new local import to the CLI silently
 * produces a child project that dies at module resolution on its first command,
 * and the failure surfaces far from the change that caused it. Resolving the
 * import graph means the list can never drift again.
 */
function collectLocalModules(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = fs.readFileSync(path.join(sourceRoot, "scripts", entry), "utf8");
  for (const match of source.matchAll(/from\s+["']\.\/([A-Za-z0-9._-]+\.mjs)["']/g)) {
    collectLocalModules(match[1], seen);
  }
  return seen;
}

const runtimeScripts = [...collectLocalModules("ai-control-plane.mjs")];
for (const name of runtimeScripts) {
  fs.copyFileSync(path.join(sourceRoot, "scripts", name), path.join(dest, "scripts", name));
}
console.log(`Copied control-plane runtime: ${runtimeScripts.join(", ")}`);
for (const dir of ["gpt-to-claude", "claude-to-gpt", "acknowledgements", "rejections"]) {
  fs.mkdirSync(path.join(dest, "coordination", "agent-bus", dir), { recursive: true });
  fs.writeFileSync(path.join(dest, "coordination", "agent-bus", dir, ".gitkeep"), "");
}
fs.mkdirSync(path.join(dest, "coordination", "agent-bus", "journal"), { recursive: true });
fs.writeFileSync(path.join(dest, "coordination", "agent-bus", "journal", ".gitignore"), "*\n!.gitignore\n");
fs.writeFileSync(path.join(dest, "coordination", "PROJECT_STATUS.md"), `# ${name} - Project Status\n\nRun the control-plane sync command after adding tasks.\n`);
fs.writeFileSync(path.join(dest, "coordination", "TASKS.md"), `# ${name} Task Board\n\nMachine source of truth: control/tasks.json\n`);

const packagePath = path.join(dest, "package.json");
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  pkg.scripts ??= {};
  pkg.scripts["ai:validate"] ??= "node scripts/ai-control-plane.mjs validate";
  pkg.scripts["ai:status"] ??= "node scripts/ai-control-plane.mjs status";
  pkg.scripts["ai:sync"] ??= "node scripts/ai-control-plane.mjs sync";
  pkg.scripts["ai:dispatch"] ??= "node scripts/ai-control-plane.mjs dispatch";
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
}
console.log(`AI engineering control plane initialized at ${dest}. Add ${prefix.toUpperCase()}-* tasks to control/tasks.json, then run the sync command.`);
