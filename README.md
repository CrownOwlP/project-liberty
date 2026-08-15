# Project Liberty

Project Liberty is an agent-friendly foundation for a modern media discovery and playback platform. The repository is designed for parallel implementation by ChatGPT/OpenAI review workflows and Claude Code implementation teams without letting agents collide in the same modules.

## Current scaffold

- Next.js 16 App Router web application.
- Turborepo monorepo orchestration.
- Shared contracts, provider SDK, media ranking, and observability packages.
- Deterministic stream-ranking unit tests.
- GitHub Actions CI and Dependabot configuration.
- Optional local PostgreSQL and Redis services.
- Project-level Claude Code agent teams and specialized subagents.
- Architecture, API, database, security, testing, release, and content-rights documentation.
- Shared coordination files for GPT <-> Claude handoffs.

## Important content boundary

Project Liberty must only ingest, index, resolve, or play media the application is authorized to use: licensed sources, user-owned media, or public-domain content. Provider adapters must never be used to bypass DRM, access controls, subscription controls, or content rights.

## Prerequisites

- Node.js 22 or newer.
- npm 10 or newer.
- Docker Desktop or Docker Engine if using the local PostgreSQL/Redis stack.
- Claude Code if using the implementation-agent workflow.

## Start locally

```bash
cp .env.example .env.local
npm install
npm run repo:validate
npm run dev
```

Open `http://localhost:3000`.

Optional infrastructure:

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Quality gate

```bash
npm run check
```

Every implementation task must leave the relevant package passing lint, typecheck, tests, and build. The repo validator can run without installing dependencies:

```bash
node scripts/validate-repo.mjs
```

## Agent workflow

1. Read `AGENTS.md` and `CLAUDE.md`.
2. Read `coordination/MASTER_PLAN.md`, `coordination/TASKS.md`, and `coordination/OWNERSHIP.md`.
3. Claim one task and one ownership lane.
4. Work in an isolated branch/worktree whenever parallel edits could overlap.
5. Run the relevant checks.
6. Record the result in `coordination/CLAUDE_TO_GPT.md` or `coordination/GPT_TO_CLAUDE.md`.
7. Keep architecture decisions in `docs/DECISIONS.md`.

## First implementation target

The first end-to-end vertical slice is:

`home catalog -> title detail -> authorized provider resolution -> ranked playback decision -> watch page -> progress persistence contract`

See `coordination/TASKS.md` for the executable backlog.

## Publish to GitHub

This generated archive already contains Git history. See `docs/GITHUB_SETUP.md` for the two-command private-repository publish path.
