/* -------------------------------------------------------------------------
 * `@liberty/auth` -- the seam the rest of Liberty depends on.
 *
 * Re-export only; nothing is defined here.
 *
 * The vendor library is NOT re-exported. `createLibertyAuth` lives behind the
 * `@liberty/auth/server` subpath so that importing a session type does not drag
 * `better-auth` and its transitive dependency tree into a module that only
 * needed to know what a `ProfileScope` is -- which is also what keeps this
 * package's pure half testable without a database or a running auth instance.
 * ---------------------------------------------------------------------- */

export * from "./authorization";
export * from "./config";
export * from "./enabled-surface";
export * from "./session";
