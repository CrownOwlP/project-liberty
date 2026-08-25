# Development Guide

## Environment validation

Before anything else, and before trusting any gate result:

```bash
node scripts/validate-env.mjs
```

It exits `0` when the machine can actually run this project, `1` when it cannot,
and `2` when the command line itself was wrong. `npm run check` runs it through
`npm run env:validate`, which is the same script asked for all three build modes
at once rather than for whichever one the shell happens to be in — the reason
that distinction matters has a section of its own below. Every failure names what
was expected, what was found, and what to type next:

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
| `--mode <m>`     | Resolve variables as `development`, `test`, or `production`. Repeatable; each mode reads a different set of `.env` files. Defaults to `NODE_ENV` when it names one of the three, otherwise `development`. |
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
- **Environment variables**, against `.env.example` as the declared contract, and
  resolved separately for each build mode that was asked for — see *Which files a
  variable is resolved from*.
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

`.env.local` is git-ignored and is where real values go.

Never put a real secret in `.env.example`. It is committed, and a credential
that reaches version control has to be rotated even if nobody ever used it.
Variables annotated `@secret` must stay blank or `replace-me`; the validator
fails the contract file itself otherwise.

### Which files a variable is resolved from

Next.js does not read one fixed list of `.env` files. `loadEnvConfig` in
`@next/env` chooses the list from `NODE_ENV`, and the validator mirrors that
choice rather than approximating it. The approximation it replaced is worth
describing, because it is the failure this check exists to prevent, committed by
the check itself: resolving `.env.local` and then `.env`, and calling that "the
order Next.js applies", means a malformed `DATABASE_URL` in
`.env.production.local` wins at runtime while the validator never opens the file
that won. It then passes, having validated a value the application does not use.
A confident pass over the wrong bytes is worse than no check at all, because gate
evidence is recorded on the strength of it.

`process.env` outranks every file, in every mode. After that, highest precedence
first:

| `NODE_ENV`    | Files consulted, in order                                            |
| ------------- | --------------------------------------------------------------------- |
| `development` | `.env.development.local`, `.env.local`, `.env.development`, `.env`     |
| `test`        | `.env.test.local`, `.env.test`, `.env`                                 |
| `production`  | `.env.production.local`, `.env.local`, `.env.production`, `.env`       |

`.env.local` is absent from the `test` row deliberately, and that is Next.js's
rule rather than a simplification here. A test run is supposed to mean the same
thing on every machine, and a git-ignored per-developer file is precisely what
would stop it meaning that. The consequence is worth stating plainly rather than
leaving to be discovered: a value that lives only in `.env.local` does **not**
satisfy a `@required` variable under `--mode test`, and a malformed value there
is not reported under `--mode test` either, because in that mode nothing reads
it.

Files that do not exist are skipped rather than searched, so the `found:` line
names the places that were really looked in — being told a variable is "not set
in `.env.production`" when there is no such file sends you to write one, which is
rarely the fix. The source that did supply a value is part of every finding, and
is usually the whole answer to "but I set that".

### Which directory those files are read from

The table above says *which* files. It says nothing about *where*, and for three
debugging rounds that omission was the whole problem.

`next dev` and `next build` run with cwd `apps/web`, because that is the
workspace whose `package.json` holds the script — and `turbo run dev`,
`npm run dev --workspace @liberty/web`, and the e2e harness's `webServer` all
inherit that. Next resolves dotenv files from its project directory, so left to
itself it reads `apps/web/.env*` and nothing else. Everything else in this
repository points at the **repository root**: this guide says to put real values
in `.env.local` there, `README.md` says `cp .env.example .env.local` from there,
`turbo.json` hashes the root `.env*` files into every task's cache key, and
`scripts/validate-env.mjs` validates the root files.

Nothing bridged the two. A value written at the root was invisible to the
running application and the variable silently fell back to its documented
default — which is why `LIBERTY_FIXTURE_MEDIA_ORIGIN` stayed
`https://fixtures.invalid`, a TLD reserved by RFC 2606 that can never resolve,
and every playback attempt burned its retry budget on DNS for a hostname that
cannot exist. The validator, meanwhile, passed: it was reading files the
application never read. Its own header warns that *a confident pass over the
wrong bytes is worse than no check at all*, and that is precisely what it was
doing.

**`scripts/with-root-env.mjs` is what bridges them now.** `apps/web`'s `dev` and
`start` scripts run through it — `build` deliberately does not; see
[Why `build` is not wrapped](#why-build-is-not-wrapped) below:

```json
"dev": "node ../../scripts/with-root-env.mjs next dev"
```

It finds the repository root (by walking up for the `package.json` that declares
`workspaces` — it does not assume `../..`, because being silently wrong about
which directory holds the environment is the defect it exists to prevent), reads
the root files for the mode the command is about to run in, sets any variable
**not already present** into `process.env`, and then runs the real command,
passing through its arguments, its exit code, and Ctrl-C.

Three consequences worth knowing:

- **`process.env` still wins.** The loader never overwrites a name that is
  already set, which is Next's own precedence rule. So the values pinned in
  `.github/workflows/ci.yml`'s job `env:` and in `e2e/playwright.config.ts`'s
  `webServer.env` still beat every file, exactly as before. An exported *empty*
  string counts as set, matching `@next/env`, which tests presence rather than
  truthiness.
- **`NODE_ENV` is never loaded from a file.** `.env.example` ships
  `NODE_ENV=development` and this guide tells you to copy it, while
  `next/dist/bin/next` does `process.env.NODE_ENV = process.env.NODE_ENV ||
  defaultEnv` — it *respects* a pre-set value. `.env.local` is in the
  *production* file list as well as the development one, so applying it would
  silently turn `npm run start` into a development server and flip the
  production branches in `authorized-candidates.ts`, `issue-session.ts` and the
  resolve handler — a deployment that resolves fixtures and exposes the resolve
  scaffold a security review made a production build refuse. Export it in your
  shell if you really mean it. The loader prints a note when a root file
  declares a `NODE_ENV` that disagrees with the mode the command is running in.
- **The mode comes from the command, not from `NODE_ENV`.** `next dev` loads
  the `development` list even under `NODE_ENV=production`, and `next start`
  loads the `production` list even under `NODE_ENV=development`. That is
  `@next/env`'s rule (`NODE_ENV=test` is the one value it does read), and the
  loader reproduces it exactly because, unlike the validator, it can see the
  subcommand. (`next build` derives the same way, and the loader still answers
  for it, even though `apps/web` no longer routes `build` through it.)

The loader and the validator import `envFilesForMode` and `parseEnvFile` from
the *same* module. That is not tidiness. Two file lists or two parsers is
exactly how this class of defect returns: each side would be internally
consistent, they would disagree about which bytes win, and the symptom would be
a variable that validates clean and behaves wrong.
`scripts/test-validate-env.mjs` scenario 36 pins the agreement against a single
fixture.

Because the parser is shared, it is also the parser your root env files are
*read* with. It is deliberately minimal — no `${VAR}` interpolation, no
multi-line values, no inline `#` comments after a value — so
`FOO=bar # note` sets `FOO` to `bar # note`. Write plain `NAME=value` lines.

The loader prints one line to stderr saying which mode it used, which root it
found, and which variables came from which file — never a value, for the same
reason the validator never prints one. `--quiet` suppresses that line; errors
still print. To wrap something that is not `next`, pass the mode explicitly,
because only `next` has a subcommand the loader can read a phase from:

```bash
node ../../scripts/with-root-env.mjs --mode development drizzle-kit migrate
```

`apps/web` currently has no dotenv files of its own, and adding one is not
recommended: the root loader runs first, so a root value would land in
`process.env` and shadow an `apps/web/.env.local` entry rather than the other
way round.

`npm run test` is deliberately **not** routed through the loader. vitest reads
no dotenv file at all today, so wrapping it would newly make the unit gate
depend on `.env` and on a git-ignored `.env.test.local` — the determinism
`envFilesForMode` protects by omitting `.env.local` from the `test` list, given
away one level up. (The `.env.local` guarantee itself survives either way, since
both sides get their list from that one function.)

<a id="why-build-is-not-wrapped"></a>

### Why `build` is not wrapped, and the open question behind it

`npm run build` does **not** read the root `.env` files. A value you want a
production build to see must be exported:

```bash
LIBERTY_FIXTURE_MEDIA_ORIGIN=http://localhost:8080 npm run build
```

This is not a regression — it is what every build did before the loader existed,
and exporting is also the spelling turbo hashes correctly. It is a deliberate
retreat from a risk that could not be measured.

**The mechanism.** `turbo.json` lists `LIBERTY_FIXTURE_MEDIA_ORIGIN`,
`CONTENT_RIGHTS_ENFORCEMENT`, `LIBERTY_FC_SEED` and `NODE_ENV` in `globalEnv`.
That is what stops one `.next/**` cache entry serving builds that meant
different values. But turbo hashes `globalEnv` from the environment it sees
**before** it launches the task, and the loader sets those variables **inside**
the task. So for `build`, `globalEnv` would be hashing the *absence* of exactly
the variables the build then used. And this is a build input rather than only a
runtime one: `authorized-candidates.ts` and `watch/watch-session.ts` both read
`LIBERTY_FIXTURE_MEDIA_ORIGIN` at module scope.

**The unsettled part.** The remaining guard would be `globalDependencies`, which
does list all eight root `.env*` files. Whether it holds is not currently known:
`.gitignore` ignores `.env*`, and turbo is documented to skip gitignored files
when hashing task `inputs`. If it does the same for `globalDependencies`, then
the cache key ignores the file *and* the variable, and the failure mode is
silent — a cache hit that serves a build made for a different media origin, with
no error and nothing in the log.

**The experiment that settles it.** Five minutes, and worth doing:

```bash
echo 'LIBERTY_FIXTURE_MEDIA_ORIGIN=https://one.invalid'  > .env.local
npx turbo run build --force          # seed the cache
echo 'LIBERTY_FIXTURE_MEDIA_ORIGIN=https://two.invalid' > .env.local
npx turbo run build                  # look at this line
```

Temporarily restore the wrapper on `apps/web`'s `build` script first, or the
loader never runs and the experiment measures nothing. If the second run reports
**`cache hit`**, turbo is not hashing the gitignored file, the risk is real, and
`build` must stay unwrapped. If it reports a **`cache miss`**, `globalDependencies`
covers gitignored files, and `build` can be wrapped again — one line in
`apps/web/package.json`, plus scenario 36(f) in `scripts/test-validate-env.mjs`,
which pins which scripts are wrapped.

**Why the split is where it is.** `dev` is the case the loader exists for and
turbo declares it `"cache": false`, so nothing it reads outlives the process.
`start` reads the environment at request time and produces no cached artifact.
`build` is the only one whose *output* depends on these values — and it is also
the one that already has a correct answer elsewhere: `.github/workflows/ci.yml`
pins all three in the job `env:`, where turbo hashes them properly, and that is
the build that ships.

### Choosing a mode

`--mode` chooses which of those lists to resolve against, and it is repeatable.
`--mode development --mode test --mode production` validates all three from a
single pass over the filesystem, which is what `npm run env:validate`, and
therefore `npm run check`, does: the gate exercises all three modes, so letting
one of them stand in for the others would be recording evidence about a question
nobody asked. With no `--mode` at all the validator uses `NODE_ENV` when it names
one of the three and `development` otherwise, which is the choice Next.js itself
would make on that machine.

A problem that is true of every mode validated prints once, unannotated. A
problem true of only some of them — the shape a mode-specific override makes —
prints with the modes that produced it:

```text
FAIL env.malformed
  expected: DATABASE_URL to be a postgresql:// URL including host, port, and database name
  found:    not a parseable URL (from .env.production.local; value not shown)
  fix:      correct DATABASE_URL in .env.production.local
  modes:    production
```

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
| `LIBERTY_FC_SEED`            | no, defaults to `20250819` | integer            | Seed for the fast-check property suite. Pinned rather than random because an unpinned suite fails roughly one run in forty with a counterexample nobody can reproduce, and an irreproducible test gets retried until green — turning a real defect into noise. Override it in a nightly job to widen the search, then pin anything it finds by copying the seed fast-check prints. `@cache-key`: the seed changes what the test task computes, so runs under different seeds must not share a cache entry. |
| `LIBERTY_FIXTURE_MEDIA_ORIGIN` | no, defaults to `https://fixtures.invalid` | `http(s)://` URL | Origin the watch route's development fixtures are served from, read by `apps/web/src/app/watch/watch-session.ts`. The default host is reserved by RFC 2606 and resolves nowhere, so a fresh checkout fails over through every fixture and renders the whole reason trail rather than silently doing nothing — and it can never reach a real host by accident. Point it at a local DASH/HLS rig to actually watch something; a loopback origin is carved out by the transport check in `playback-source.ts`. `@cache-key`: the value is baked into the candidate URIs a build produces, so builds made against different origins must not share a cache entry. Because it is a build input, `npm run build` does **not** pick it up from a root `.env` file — export it, which is also the spelling turbo hashes correctly. See [Why `build` is not wrapped](#why-build-is-not-wrapped). |

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
