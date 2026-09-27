/* -------------------------------------------------------------------------
 * The word beside the sign-out control (PW-0312)
 *
 * A MODULE OF ITS OWN FOR ONE STRING, AND THE REASON IS A BUNDLE BOUNDARY THAT
 * A UNIT SUITE CANNOT SEE. This constant is read by `account-state.ts`, which
 * is a SERVER module -- it reaches `lib/session/auth-instance.ts`, and through
 * it `@liberty/persistence` and `pg` -- and by `account-region.tsx`, which is a
 * CLIENT component. While the constant lived in `account-state.ts`, importing
 * it from the client pulled that whole graph into the browser bundle, and
 * `next build` refused with a module-not-found on `pg`'s node-only imports.
 *
 * THE SUITE DID NOT CATCH IT AND COULD NOT. vitest resolves both sides of that
 * boundary happily; only the bundler enforces it. So the lesson is recorded
 * here rather than in a commit message: a value shared between a server module
 * and a client one belongs in a module that imports nothing, and this file
 * imports nothing on purpose. `auth-ui.test.tsx` asserts that every client
 * module on this surface still reaches no composition root, so the next such
 * import fails a unit gate rather than a production build.
 * ---------------------------------------------------------------------- */

/**
 * What an account with no name is called.
 *
 * THE NAME, NEVER THE EMAIL ADDRESS, and the reason is the room this product
 * runs in. The shell is on screen the whole time a television is on, visible to
 * everybody present and to anybody photographing it; an email address there is
 * a durable identifier published to a room, for no benefit the name does not
 * already give. An account with no name gets a word rather than a fallback to
 * the address -- it tells a viewer which control signs them out, which is the
 * entire job of this string.
 */
export const UNNAMED_ACCOUNT_LABEL = "Account";
