import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const quick = process.argv.includes("--quick");
const required = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/agents/orchestration-lead.md",
  "package.json",
  "turbo.json",
  "docs/PRODUCT_SPEC.md",
  "docs/ARCHITECTURE.md",
  "docs/API_CONTRACTS.md",
  "docs/CONTENT_RIGHTS.md",
  "coordination/AI_OPERATING_MODEL.md",
  "coordination/PROJECT_STATUS.md",
  "coordination/MASTER_PLAN.md",
  "coordination/TASKS.md",
  "coordination/OWNERSHIP.md",
  "coordination/IN_PROGRESS.md",
  "coordination/CLAUDE_TO_GPT.md",
  "coordination/GPT_TO_CLAUDE.md",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/media-engine/package.json",
  "packages/provider-sdk/package.json",
  "control/project.json",
  "control/tasks.json",
  "control/milestones.json",
  "control/agents.json",
  "control/policies.json",
  "control/quality-gates.json",
  "control/adapters.json",
  "scripts/ai-control-plane.mjs",
  "scripts/bootstrap-ai-project.mjs",
  "scripts/test-ai-control-plane.mjs",
  // The environment contract and its validator. Required here because a repo
  // that has lost .env.example has not lost documentation -- it has lost the
  // only declaration of which variables exist, and validate-env.mjs would then
  // report a clean environment over an empty contract.
  ".env.example",
  "scripts/validate-env.mjs",
  "scripts/test-validate-env.mjs",
  "infra/docker-compose.yml",
  "scripts/start-ai-engineering.ps1",
  "scripts/start-ai-engineering.cmd"
];

const errors = [];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`missing required file: ${file}`);
}

for (const file of ["package.json", "turbo.json", ".claude/settings.json", "apps/web/package.json", "packages/contracts/package.json", "packages/media-engine/package.json", "packages/provider-sdk/package.json", "packages/observability/package.json", "control/project.json", "control/tasks.json", "control/milestones.json", "control/agents.json", "control/policies.json", "control/quality-gates.json", "control/adapters.json"]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  try {
    JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    errors.push(`invalid JSON: ${file}: ${error.message}`);
  }
}

if (!quick) {
  const taskDoc = JSON.parse(fs.readFileSync(path.join(root, "control/tasks.json"), "utf8"));
  const ids = (taskDoc.tasks ?? []).map((task) => task.id);
  const unique = new Set(ids);
  if (unique.size < 20) errors.push("control plane has fewer than 20 unique executable task IDs");
  if (unique.size !== ids.length) errors.push("control plane contains duplicate task IDs");

  const rights = fs.readFileSync(path.join(root, "docs/CONTENT_RIGHTS.md"), "utf8");
  for (const phrase of ["DRM circumvention", "paywalls", "geographic restrictions"]) {
    if (!rights.includes(phrase)) errors.push(`content-rights invariant missing phrase: ${phrase}`);
  }
}

if (errors.length) {
  console.error("Project Liberty repository validation failed:\n" + errors.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Project Liberty repository validation passed${quick ? " (quick)" : ""}.`);
