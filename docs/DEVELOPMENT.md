# Development Guide

## Environment validation

Before anything else, and before trusting any gate result:

```bash
node scripts/validate-env.mjs
```

It exits `0` when the machine can actually run this project, `1` when it cannot,
and `2` when the command line itself was wrong. `npm run check` runs it, and
`npm run env:validate` is the same thing by a shorter name. Every failure names
what was expected, what was found, and what to type next:

```text
FAIL node.version
  expected: Node 22.x, pinned by .nvmrc
  found:    Node 20.11.1
  fix:      install Node 22 (nvm install 22 / fnm install 22), then re-run
```

### Failures and warnings

A fresh clone with no `.env.local` passes. That is a deliberate constraint, not
an accident of what happens to be declared: a validator that fails a correct
checkout is one people learn to run with their eyes closed, and an ignored
validator catches nothing. So the severity split is:

| Situation                                        | `--scope app` | `--scope ci` |
| ------------------------------------------------ | ------------- | ------------ |
| `@required` variable unset or empty               | fail          | fail         |
| Any variable set to a value its `@format` rejects | fail          | fail         |
| `@default` variable unset                         | warn          | warn         |
| `@default @cache-key` variable unset              | warn          | **fail**     |
| Runtime major **older** than `.nvmrc`             | fail          | fail         |
| Runtime major **newer** than `.nvmrc`             | warn          | **fail**     |
| Name in `.env.local` not declared in the contract | warn          | warn         |

The two escalations share a reason. Locally, a newer Node and an unset
defaulted variable are both things a correct machine can have, and blocking on
them would mean the gate does not get run at all — which is not a stricter gate,
it is a skipped one. Under `--scope ci` the runtime comes from a workflow file
rather than from whoever is sitting there, the build cache is shared between
machines, and the run is the thing gate evidence is recorded from. There, the
same two states are misconfigurations.

Warnings print to stderr in every mode, including `--quiet`, and the success
line says how many there were, because on a machine that separates the two
streams `passed` would otherwise be all anyone sees.

Flags:

| Flag             | Effect                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| `--quiet`        | Suppress the success line. Failures and warnings still print. For hooks.  |
| `--scope ci`     | Also require variables annotated `@scope ci` (see below).                 |
| `--services`     | Additionally probe PostgreSQL and Redis reachability. Opt-in.             |
| `--help`         | Usage.                                                                    |

What it checks:

- **Node major matches `.nvmrc`**, in both directions, and agrees with
  `package.json` `engines.node`. A newer runtime is reported as loudly as an
  older one — a gate recorded as `pass` under a runtime the project does not
  ship on is weaker evidence than it looks, and the control plane unlocks
  dependent work on the strength of that evidence — but it is a warning locally
  and a failure only under `--scope ci`. See the severity table above.
- **Install state.** Workspace globs resolve, every workspace package parses and
  has a unique name, `node_modules` exists, `package-lock.json` agrees with
  `package.json`, and the installed tree contains everything the lockfile
  requires. Workspace links are checked by where they *resolve*, so a published
  package shadowing a `@liberty/*` name is caught rather than silently imported.
  Platform-gated optional dependencies are excluded from the comparison; they
  are absent by design on every machine but one.
- **Environment variables**, against `.env.example` as the declared contract.
- Nothing else. Docker, git, and a running database are not required to build,
  test, or gate this repository, so it does not pretend they are.

It never prints a variable's value — not even to report that one is malformed.
Findings name the variable and the nature of the problem, because a validator
that echoes environment into a CI log is a credential-disclosure bug.

Run the script's own tests with:

```bash
node scripts/test-validate-env.mjs   # or: npm run test:scripts
```

(Plain node and `node:assert`, matching `scripts/test-ai-control-plane.mjs`.
`turbo run test` only visits workspaces, and `scripts/` is not one — which is
why `npm run check` invokes it directly.)

## Environment contract

`.env.example` is the single source of truth for which variables exist, what
each is for, and which are required. It is **parsed** by `validate-env.mjs`, not
merely copied: the `@`-prefixed comment lines are machine-read annotations.

```bash
cp .env.example .env.local
```

`.env.local` is git-ignored and is where real values go. Precedence when
resolving a variable is `process.env`, then `.env.local`, then `.env` — the same
order Next.js applies, and the reported source is part of every finding.

Never put a real secret in `.env.example`. It is committed, and a credential
that reaches version control has to be rotated even if nobody ever used it.
Variables annotated `@secret` must stay blank or `replace-me`; the validator
fails the contract file itself otherwise.

### Annotations

| Annotation       | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `@required`       | Validation fails when the variable is unset or empty.                       |
| `@optional`       | Absence is fine. The format is still checked when a value is present.       |
| `@default <value>` | Absence is fine *and* well-defined: this is the value the project behaves as if it had. Unset is a warning, never a failure. The example on the assignment line must equal it, and it must satisfy its own `@format`. |
| `@secret`         | A credential. Must be a placeholder in `.env.example`, and a live value still equal to that placeholder counts as unconfigured rather than satisfied. Cannot have a `@default` — a committed default for a credential is a committed credential. |
| `@cache-key`      | `turbo.json` lists this variable in `globalEnv`, so its value is hashed into the build cache key and an unset one hashes as *absent*. Requires `@default`, and turns the unset warning into a failure under `--scope ci`. |
| `@format <kind>`  | `nonempty`, `url`, `postgres-url`, `redis-url`, `integer`, `hex40`, `enum:a,b,c`. |
| `@scope app\|ci`  | `app` (default) applies everywhere the app or build runs. `ci` applies to automation only, so a local run does not demand it. |

Every variable must carry a description and exactly one answer to "what if it is
unset": `@required`, `@optional`, or `@default`. An entry that does not say what
the variable is for is not documentation, and the validator rejects it.

Annotations are recognised only in the forms above, each on a line of its own:
either a line whose first token is one of the keywords, or a line that is
nothing but a single `@word` token (so a typo like `@requred` is still reported
rather than silently ignored). Everything else is prose — a description may say
`@liberty/observability` mid-sentence without the parser mistaking it for an
annotation, and `.env.example` asserts exactly that case.

### Declared variables

Application runtime (`@scope app`):

| Variable                     | Required | Format                              | Purpose                                                                                                   |
| ---------------------------- | -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | no       | `development` \| `test` \| `production` | Build mode. Tooling normally sets it; declared because `turbo.json` lists it in `globalEnv`, so it is part of the build cache key. Not `@cache-key`, because that annotation is about what an *unset* variable hashes as, and this one is set by whatever is running the build rather than by a person. |
| `NEXT_PUBLIC_APP_NAME`       | no       | non-empty                           | Product name shown in UI chrome, in one place instead of retyped per surface.                              |
| `NEXT_PUBLIC_APP_URL`        | no       | `http(s)://` URL                    | Absolute origin this deployment is reachable at, for share URLs, OAuth callbacks, and sitemaps. Inferring it from the request host is attacker-controlled behind a proxy. |
| `CONTENT_RIGHTS_ENFORCEMENT` | no, defaults to `strict` | `strict`            | Rights-enforcement mode. `strict` is the only accepted value; relaxing it is a `docs/CONTENT_RIGHTS.md` change first. `@default strict @cache-key`: turbo hashes it into the build cache key, so leaving it unset warns and names that consequence, and `--scope ci` fails on it. Setting it to anything but `strict` fails everywhere. |
| `LOG_LEVEL`                  | no       | `debug` \| `info` \| `warn` \| `error` | Minimum log level. Mirrors `LogLevel` in `@liberty/observability`, which ignores unknown values silently. |

Local infrastructure (`@scope app`, both optional):

| Variable       | Format                  | Purpose                                                                                       |
| -------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | `postgresql://…/db`     | PostgreSQL connection string. Optional today because `docs/DATABASE.md` pins no ORM yet, so no code reads it; format-checked whenever present. |
| `REDIS_URL`    | `redis://` \| `rediss://` | Redis connection string for ephemeral cache, rate limits, and provider health snapshots. Documented as optional in `docs/DATABASE.md`. |

The credentials committed in `.env.example` for these two are the throwaway ones
hard-coded in `infra/docker-compose.yml`. A real deployment's connection string
is a credential and belongs in `.env.local` or a secret store.

Automation only (`@scope ci`, supplied by GitHub Actions, all optional locally):

| Variable                 | Format    | Purpose                                                                        |
| ------------------------ | --------- | -------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`         | secret    | Used by `scripts/cloud/gpt-review-worker.mjs`.                                    |
| `GH_TOKEN`               | secret    | Used by `scripts/cloud/git-auth.mjs` to push control-plane state.                 |
| `OPENAI_REVIEW_MODEL`    | non-empty | Review model override; defaults in code when unset.                               |
| `OPENAI_REVIEW_EFFORT`   | non-empty | Reasoning effort override; defaults in code when unset.                           |
| `REVIEW_MAX_PATCH_BYTES` | integer   | Largest patch the review worker will send to the model.                           |
| `LIBERTY_JOURNAL_DIR`    | non-empty | Durable agent-bus journal directory. Unset means the journal is in-repo and not durable across runners. |
| `LIBERTY_COMMIT_SHA`     | hex40     | Commit sha override for harnesses with no git checkout. Never set on a real runner: it makes the control plane record a sha it did not verify. |
| `LIBERTY_CI_CONCLUSION`  | non-empty | CI conclusion reported into the mission-control status snapshot.                  |

A name set in `.env.local` but absent from `.env.example` produces a warning
rather than a failure. It is usually documentation lagging behind a feature —
but the other cause is a typo in a variable name, and a typo'd variable looks
exactly like a variable that is doing nothing.

## Local PostgreSQL and Redis

Both services are optional. Nothing in the current tree reads `DATABASE_URL` or
`REDIS_URL`, and the full gate (`npm run check`) passes with neither running.
Start them when you are working on persistence or caching:

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

`infra/docker-compose.yml` defines a healthcheck for each service, so `ps`
reports `healthy` rather than merely `running`:

| Service    | Image               | Port   | Healthcheck                     |
| ---------- | ------------------- | ------ | ------------------------------- |
| `postgres` | `postgres:17-alpine` | `5432` | `pg_isready -U liberty -d liberty` |
| `redis`    | `redis:7-alpine`     | `6379` | `redis-cli ping`                |

Both retry ten times at five-second intervals, so a service that never reaches
`healthy` has failed rather than merely started slowly.

Check them directly:

```bash
docker compose -f infra/docker-compose.yml exec postgres pg_isready -U liberty -d liberty
docker compose -f infra/docker-compose.yml exec redis redis-cli ping     # -> PONG
```

Or from the repository, using the URLs your environment actually has:

```bash
node scripts/validate-env.mjs --services
```

Be precise about what that proves. `--services` opens a TCP connection to the
host and port in each URL. A success means something is listening there. It does
**not** mean PostgreSQL is healthy, that the credentials work, or that the
database exists — that needs a protocol handshake through a driver this repo has
not chosen yet (`docs/DATABASE.md`). The commands above are the real health
check; `--services` catches the common case of "the container is not up" without
adding a dependency. The failure it reports is deliberately specific:

- `nothing is listening on that port` — the stack is down; `docker compose up -d`.
- `the hostname does not resolve` — the URL points somewhere that does not exist.
- `no response within 2000ms` — something is filtering the connection.

Data lives in the `liberty_postgres` and `liberty_redis` named volumes and
survives `down`. To discard it:

```bash
docker compose -f infra/docker-compose.yml down -v
```

## Branches

- `main` stays releasable.
- Agent work: `agent/<task-id>-<description>`.
- Human feature branches may use the same task-oriented naming.

## Parallel work

Use separate worktrees when two agents need to make code changes concurrently:

```bash
git worktree add ../liberty-pl-0101 -b agent/pl-0101-catalog main
git worktree add ../liberty-pl-0201 -b agent/pl-0201-ranking main
```

Do not create a worktree for read-only review.

## Commit style

Prefer small commits tied to a Project Liberty task ID:

```text
PL-0201 implement playback scoring baseline
```

## Dependency changes

- Keep dependency additions narrow.
- Run the full affected tests.
- Commit the lockfile once generated.
- Do not add two libraries that solve the same problem without an ADR.
- After any dependency change, re-run `node scripts/validate-env.mjs`: a stale
  `node_modules` and a fresh lockfile is exactly the state it exists to catch.
