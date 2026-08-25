import { defineConfig } from "drizzle-kit";

/* -------------------------------------------------------------------------
 * drizzle-kit configuration
 *
 * `schema` points at the barrel, so a table that is not re-exported from
 * `src/schema/index.ts` is invisible to `drizzle-kit generate` -- and an
 * invisible table is one the next generated migration will propose DROPPING.
 *
 * No credentials are inlined. `DATABASE_URL` must be present in the
 * environment; there is no development default, because a default is how a
 * migration gets applied to the wrong database by somebody who forgot to set a
 * variable they did not know existed.
 *
 * HOW `DATABASE_URL` GETS HERE, AND WHY IT DID NOT USED TO.
 *
 * `db:generate`, `db:migrate` and `db:check` run with cwd
 * `packages/persistence` -- that is where npm puts a workspace script, and
 * `npm run db:migrate -w @liberty/persistence` inherits it. drizzle-kit's
 * bundled `bin.cjs` does call dotenv's auto-config, but dotenv's default path is
 * `path.resolve(process.cwd(), ".env")` and nothing else: not `.env.local`, not
 * a mode-specific file, and not the repository root. So the file
 * `docs/DEVELOPMENT.md` tells developers to write real values into -- the ROOT
 * `.env.local` -- was never opened, `process.env["DATABASE_URL"]` fell through
 * to `""`, and `drizzle-kit migrate` failed on an empty connection URL while the
 * developer was looking at a file that plainly contained one. That is the same
 * root-versus-package-directory defect `scripts/with-root-env.mjs` was written
 * for in `apps/web`; it merely failed loudly here instead of silently.
 *
 * The three scripts therefore run through `scripts/with-root-env.mjs`, which
 * loads the root dotenv files into `process.env` before spawning drizzle-kit,
 * using the same file list and parser the validator uses. Two details make the
 * layering safe rather than merely convenient: the wrapper only sets names that
 * are not already present, and dotenv's default is likewise not to override, so
 * an exported `DATABASE_URL` still beats both, and a future
 * `packages/persistence/.env` would lose to the root -- which is the precedence
 * `docs/DEVELOPMENT.md` documents, not a new one invented here.
 *
 * WHY `--mode development`, EXPLICITLY.
 *
 * The wrapper derives the mode only for `next`, whose subcommand names the
 * phase; `drizzle-kit migrate` has no phase to read, so it refuses to guess and
 * the mode has to be stated. `development` is the answer, and the two rejected
 * ones are rejected for opposite reasons:
 *
 *   - `test` omits `.env.local` by Next's own rule (see `envFilesForMode`), and
 *     `.env.local` is precisely where the setup instructions put a real
 *     `DATABASE_URL`. It would reintroduce the defect under a different name;
 *   - `production` reads `.env.production.local` FIRST. Making that the default
 *     for a migration command is how the "wrong database" this header already
 *     warns about actually happens -- a deploy supplies `DATABASE_URL` from a
 *     secret store in the environment, which outranks every file anyway, so
 *     production never needed the file list to begin with.
 *
 * `development` reads `.env.development.local`, `.env.local`,
 * `.env.development`, `.env` -- the developer's own database, and deliberately
 * NOT the production overlay.
 *
 * The residual hazard is worth naming rather than hiding: a developer who keeps
 * a real deployment credential in the root `.env.local` now has
 * `npm run db:migrate` pick it up without typing it. That is not new exposure --
 * an exported variable did the same thing, and less visibly -- and the wrapper
 * announces on stderr which file supplied which variable NAMES (never values)
 * before the command runs, alongside `verbose: true` below. Read that line
 * before answering the migration prompt.
 *
 * Unlike `apps/web`'s `build`, there is no cache-correctness objection: none of
 * the three is a `turbo.json` task, none is listed in `globalEnv`, and none
 * produces a cached artifact whose contents depend on the environment. The
 * argument that kept `build` unwrapped simply does not apply here.
 * ---------------------------------------------------------------------- */

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  // Verbose because a migration is one of the few things in this repository
  // that is not reversible by editing a file, so the operator should see the
  // statements before they run.
  verbose: true,
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? ""
  }
});
