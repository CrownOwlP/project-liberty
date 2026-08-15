import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const quick = process.argv.includes("--quick");
const required = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  "package.json",
  "turbo.json",
  "docs/PRODUCT_SPEC.md",
  "docs/ARCHITECTURE.md",
  "docs/API_CONTRACTS.md",
  "docs/CONTENT_RIGHTS.md",
  "coordination/MASTER_PLAN.md",
  "coordination/TASKS.md",
  "coordination/OWNERSHIP.md",
  "coordination/IN_PROGRESS.md",
  "coordination/CLAUDE_TO_GPT.md",
  "coordination/GPT_TO_CLAUDE.md",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/media-engine/package.json",
  "packages/provider-sdk/package.json"
];

const errors = [];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`missing required file: ${file}`);
}

for (const file of ["package.json", "turbo.json", ".claude/settings.json", "apps/web/package.json", "packages/contracts/package.json", "packages/media-engine/package.json", "packages/provider-sdk/package.json", "packages/observability/package.json"]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  try {
    JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    errors.push(`invalid JSON: ${file}: ${error.message}`);
  }
}

if (!quick) {
  const taskBoard = fs.readFileSync(path.join(root, "coordination/TASKS.md"), "utf8");
  const ids = [...taskBoard.matchAll(/\bPL-\d{4}\b/g)].map((match) => match[0]);
  const unique = new Set(ids);
  if (unique.size < 20) errors.push("task board has fewer than 20 unique executable task IDs");

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
