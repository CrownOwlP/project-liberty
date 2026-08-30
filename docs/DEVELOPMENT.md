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
[Why `build` is not wrapped](#why-build-is-not-wrapped) below. So do
`packages/persistence`'s `db:*` scripts, which had the same defect for the same
reason; see [The `db:*` scripts had the same defect](#the-persistence-db-scripts):

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

<a id="the-persistence-db-scripts"></a>

### The `db:*` scripts had the same defect

That example is not hypothetical. `packages/persistence`'s `db:generate`,
`db:migrate` and `db:check` run exactly that line, and until they did, this
guide was wrong about them.

They run with cwd `packages/persistence`, for the same reason `next dev` runs
with cwd `apps/web`: that is the workspace whose `package.json` holds the
script. drizzle-kit's bundled CLI *does* call dotenv — but dotenv's default path
is `path.resolve(process.cwd(), ".env")` and nothing else: not `.env.local`, not
a mode-specific file, and not the repository root. So
`packages/persistence/drizzle.config.ts` read `process.env["DATABASE_URL"]`, got
nothing, fell back to `""`, and `drizzle-kit migrate` failed on an empty
connection URL while the developer was looking at a root `.env.local` that
plainly contained one.

This half of the defect failed **loudly**, which is the only reason it cost
minutes rather than the three debugging rounds the `apps/web` half cost. It was
the same defect, and it made the setup instructions on this page untrue.

The mode is stated rather than derived, and which one it is matters:

| Mode          | Why not                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| `test`        | omits `.env.local` — the one file this guide tells you to put `DATABASE_URL` in. It would reintroduce the defect under a new name. |
| `production`  | reads `.env.production.local` first. Defaulting a *migration* command to the production overlay is how a migration reaches the wrong database. A real deployment supplies `DATABASE_URL` from the environment, which outranks every file anyway. |
| `development` | reads `.env.development.local`, `.env.local`, `.env.development`, `.env` — the developer's own database, and not the production overlay. |

Two consequences to know before you run a migration:

- **An exported `DATABASE_URL` still wins**, and so does a value already in the
  environment. The loader sets only names that are absent, and dotenv's default
  is likewise not to override, so a `packages/persistence/.env` would lose to
  the root rather than shadow it.
- **The loader names the file it took `DATABASE_URL` from**, on stderr, before
  drizzle-kit starts — and `drizzle.config.ts` sets `verbose: true`. If you keep
  a real deployment credential in the root `.env.local`, that line is the one
  that tells you `db:migrate` is about to use it. Read it.

There is no cache-correctness objection here, which is why all three are wrapped
and `apps/web`'s `build` is not: none of the `db:*` scripts is a `turbo.json`
task, none appears in `globalEnv`, and none produces a cached artifact whose
contents depend on the environment.

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
| `DATABASE_URL` | `postgresql://…/db`     | PostgreSQL connection string. Read by `packages/persistence/drizzle.config.ts`, which supplies no fallback: `drizzle-kit migrate` fails on an empty connection URL rather than inventing a database. Still `@optional` — see below — and format-checked whenever present. |
| `REDIS_URL`    | `redis://` \| `rediss://` | Redis connection string for ephemeral cache, rate limits, and provider health snapshots. Documented as optional in `docs/DATABASE.md`. |

The credentials committed in `.env.example` for these two are the throwaway ones
hard-coded in `infra/docker-compose.yml`. A real deployment's connection string
is a credential and belongs in `.env.local` or a secret store.

**Why `DATABASE_URL` stays `@optional` even though code now reads it.** The
annotation answers one question — *what happens when this is unset* — and the
honest answer is still "nothing breaks, unless you asked for a migration".

- `@required` is a claim about the whole checkout, and it would be false here.
  Nothing the gates run touches `DATABASE_URL`: the application does not read it,
  `npm run check` does not, and CI does not set it. Only three opt-in
  maintenance scripts in one package need it. Marking it `@required` would make
  `npm run env:validate` — and therefore `npm run check` — fail on a correct
  clone that simply has no database, and fail CI for the same reason. That is the
  outcome rule 4 in `validate-env.mjs`'s header exists to prevent: a check that
  fails a correct checkout gets run with eyes closed, and then stops catching
  anything.
- `@default` is unavailable and would be worse than unavailable. It means "this
  is the value the project behaves as if it had", and
  `packages/persistence/drizzle.config.ts` deliberately has no fallback —
  a default connection string is exactly how a migration reaches the wrong
  database.
- The loudness that matters already exists, and it is closer to the mistake than
  a validator could be. `drizzle-kit migrate` with an empty URL fails at the
  moment you asked for the migration, naming the command you just typed, rather
  than warning three commands earlier about a database you may not want.

So the prose changed and the annotation did not. `@optional` still buys the
format check, which is the part that catches a URL pointing at the wrong port —
a failure that surfaces much later and much less obviously than absence.

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

Both services are optional. Nothing the gates run reads `DATABASE_URL` or
`REDIS_URL`, and the full gate (`npm run check`) passes with neither running.
The one thing that does read `DATABASE_URL` is
`packages/persistence/drizzle.config.ts`, and only when you invoke `db:generate`,
`db:migrate` or `db:check` yourself — none of which any gate runs. Nothing reads
`REDIS_URL` yet. Start the services when you are working on persistence or
caching:

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

## Continuous integration

`.github/workflows/ci.yml` is the only automated verification of a commit that
is not somebody's laptop. Until recently it did not verify this project's
commits at all: it fired on pushes to `main` and on pull requests, all
development happens on a long-lived working branch, `main` is deliberately
untouched, and no pull request is open. The working branch therefore carried
zero workflow runs and zero commit statuses, every green result came from one
Windows machine, and nothing had ever been built on a clean Linux checkout
installed from the lockfile.

That is worth naming as a pattern rather than an incident, because it is the
third time this repository has produced a confident pass over nothing: the
environment validator that read files the application never read, the
`vitest` path filter that would have matched no test files and exited zero, and
this. **Absence of signal reads as success.** Nothing in a dashboard
distinguishes "the gate ran and passed" from "the gate never ran".

### When it runs

| Event | Fires on |
| --- | --- |
| `push` | every branch **except** `dependabot/**`, `wip/**`, `scratch/**`, `experiment/**` |
| `pull_request` | every pull request, whatever the base |
| `workflow_dispatch` | manually, and from the agent workers after they push |

The push filter is a deny list rather than an allow list on purpose. An allow
list leaves a branch nobody thought to name with no CI and no way to notice,
which is the failure above with a new spelling. Push under a name that is not
excluded and you get a run; opting out is a deliberate act with a name on it.

Two consequences to read correctly:

- **`cancel-in-progress` is on.** A burst of pushes to one branch leaves one
  surviving run, so cost scales with distinct branches per night rather than
  with pushes. Superseded commits are left **cancelled**, which is neither a
  pass nor a failure — read it as *no verdict for that commit*. The head commit
  is the one that gets a verdict.
- **A push and a pull request on the same branch both run, on the same commit.**
  This is not a duplicate. The push run tests the branch tip; the pull-request
  run tests that tip merged into its base, and `main` moves underneath the
  working branch whenever an agent worker publishes control state. Deduplicating
  them would mean cancelling one, and which one died would be a race.

Bot pushes do not trigger anything. GitHub does not fire push-triggered
workflows for commits made with the default `GITHUB_TOKEN`, which is why
`agent-claude-worker.yml` dispatches `ci.yml` explicitly after it pushes.

### What it runs, against what `npm run check` runs

CI enumerates the constituents of the local round as separate steps rather than
calling `npm run check`, because ten named steps give ten readable red/green
marks instead of one. The cost is a drift surface: a step added to `check` has
to be added to the workflow too.

| Local round | CI |
| --- | --- |
| `npm install` | `npm ci --no-audit --no-fund` — strictly from the lockfile, and it fails if the lockfile disagrees with `package.json` |
| `npm run ai:validate` | same, before install (Node builtins only, so a dependency problem cannot mask it) |
| `npm run test:scripts` | both halves, as separate steps: `test-validate-env.mjs` and `test-ai-control-plane.mjs` |
| `npm run repo:validate` | same, before install |
| `npm run env:validate` | **stricter**: `--scope ci`, which turns an unset `@cache-key` variable and a runtime newer than `.nvmrc` from warnings into failures |
| `npm run lint` / `typecheck` / `test` / `build` | same |
| `e2e` typecheck | its own job: `npm ci --ignore-scripts` in `e2e/`, then `npm run typecheck` |

Where CI still differs, deliberately:

- **The e2e suite does not run.** Only its typecheck does. `npm test` in `e2e/`
  downloads browser builds, does a cold `turbo run build` and starts a server;
  that belongs in a job of its own (see `docs/E2E.md`). The typecheck closes the
  compile gap — `e2e/` is outside the npm workspaces, so the root `npm ci` and
  `turbo run typecheck` never touch it — without pretending the harness ran.
- **`npm run format:check` runs in neither.** It is not part of `check` either,
  so this is not a CI gap; it is a gate nobody has chosen to have.
- **`e2e/package-lock.json` is not covered by Dependabot.** `.github/dependabot.yml`
  watches `/` only. Now that CI installs from that lockfile, a stale entry there
  is a CI input nothing updates.

### The transport suite

`packages/media-inspection/src/node/pinned-fetch.test.ts` opens real loopback
sockets, because the claim it exists to prove — that Node consults the pinned
`lookup` when it opens a connection — is a claim about the runtime that a double
cannot make. It runs inside `npm run test`, locally and in CI, like every other
suite, and it blocks a commit the ordinary way. CI has no separate step for it;
`.github/workflows/ci.yml` records why not.

It was not always arranged that way, and the wrong version is worth remembering
because it was seductive. The suite was excluded from `npm run test` and run in
CI on its own, behind a wrapper that gated on vitest's parsed summary line
rather than on its exit code, because every assertion passed while the run
exited non-zero on an `ECONNRESET` believed to arrive at worker teardown. Three
ways of silencing that were considered and rejected — `|| true`,
`continue-on-error: true`, and `dangerouslyIgnoreUnhandledErrors` — and rejecting
them was right, but the wrapper that replaced them was a fourth way of not
blocking on the exit code, dressed as rigour.

The exit code was telling the truth. Four rounds went at the test, the server's
closing behaviour and the transport's socket handling; the defect was in none of
them. `nodePinnedFetch` checked `init.signal.aborted` *after* constructing the
request, so an already-aborted call built a `ClientRequest` — which opens a
socket immediately — and then returned without sending a request line and
without ever attaching an `error` listener. An established connection owned by a
request nobody was listening to, invisible to the suite's request counter, and
the source of the eventual unowned reset. The deadline is now checked before
anything is constructed, and the suite counts accepted TCP connections as well
as served requests so the same defect cannot return unnoticed.

That account is written once, at the line that was wrong, in
`packages/media-inspection/src/node/pinned-fetch.ts`. Read it there rather than
trusting this summary.

What survives is `test:transport`, a plain `vitest run src/node` for iterating
on that one suite. It is a convenience, not a gate: nothing in CI calls it, and
every test it runs is a test `npm run test` already ran.

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
