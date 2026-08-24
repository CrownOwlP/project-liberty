import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { schema } from "./schema";

/* -------------------------------------------------------------------------
 * The database handle
 *
 * `pg` (node-postgres) as the driver, because it is the one Better Auth 1.7.1
 * declares as an optional peer for PostgreSQL and the one Drizzle's
 * `node-postgres` dialect is built on -- so auth and application queries share a
 * single pool rather than opening two and doubling the connection budget for no
 * reason.
 *
 * The pool is created by the CALLER's composition root and passed in. A module
 * that opens a connection at import time cannot be imported by a test, a CLI or
 * a migration script without opening a connection, and that is how a unit test
 * run ends up needing a database.
 * ---------------------------------------------------------------------- */

export interface DatabaseHandle {
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly pool: Pool;
}

/**
 * Build a pool and a Drizzle client over it.
 *
 * `max` is left to the caller: the right number is a function of how many
 * application instances share the server's `max_connections`, which this
 * package cannot know. Guessing here would produce a value that looks
 * authoritative and is wrong on every deployment topology but one.
 */
export function createDatabase(config: PoolConfig): DatabaseHandle {
  const pool = new Pool(config);
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * The type every repository takes.
 *
 * A type alias rather than each repository naming the drizzle generic, so that
 * a future move to a different dialect or a transaction-scoped client is one
 * edit rather than one per file.
 */
export type LibertyDatabase = DatabaseHandle["db"];
