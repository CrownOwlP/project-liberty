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

/* -------------------------------------------------------------------------
 * `./profile-scope` IS RE-EXPORTED BY NAME, NOT WITH `export *`, AND THAT IS
 * THE BOUNDARY.
 *
 * `issueProfileScope` is the only producer of a `ProfileScope` in the
 * repository. A star re-export would publish it to every consumer, and a
 * capability anyone can mint proves nothing about the authorization decision it
 * is supposed to stand for -- which is the whole failure PL-0405 is correcting,
 * one level up. So the four names below are the public half of that module and
 * the producer is not among them. `profile-scope.test.ts` asserts it, because a
 * later `export *` added here would be a one-word edit that silently reopens it.
 *
 * `ProfileScope` itself is exported as a TYPE ONLY. There is nothing else to
 * export: the brand is a module-private symbol, so the type cannot be satisfied
 * by anything a consumer writes.
 * ---------------------------------------------------------------------- */
export type { ProfileScope } from "./profile-scope";
export {
  ForgedProfileScopeError,
  grantedAccountFromScope,
  isIssuedProfileScope,
  profileIdFromScope
} from "./profile-scope";
