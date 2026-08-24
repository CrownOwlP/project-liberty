/* -------------------------------------------------------------------------
 * `@liberty/persistence` -- profile-scoped storage for Liberty.
 *
 * Re-export only; nothing is defined here.
 *
 * The pure modules (`writer-epoch`, `heartbeat`, `contracts`) are exported
 * alongside the repositories deliberately: a caller that only needs to reason
 * about a write conflict should not have to import a module that constructs a
 * connection pool, and keeping them in one package is what lets the SQL guard
 * and the pure explanation of that guard stay in sync.
 * ---------------------------------------------------------------------- */

export * from "./client";
export * from "./contracts";
export * from "./heartbeat";
export * from "./profile-repository";
export * from "./progress-repository";
export * from "./watchlist-repository";
export * from "./writer-epoch";
export { PROFILE_SCOPED_TABLES, schema } from "./schema";
export { betterAuthSchema } from "./schema/auth";
