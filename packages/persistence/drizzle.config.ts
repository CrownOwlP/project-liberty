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
