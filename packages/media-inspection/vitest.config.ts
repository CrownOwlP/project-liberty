import { configDefaults, defineConfig } from "vitest/config";

/*
 * `src/node` is not in THIS run. It is still gated -- by `npm run test:transport`
 * -- and the distinction matters, so read `scripts/gate-transport.mjs` before
 * changing either.
 *
 * The short version. `src/node/pinned-fetch.test.ts` opens real loopback sockets
 * because the claim it proves is a claim about the RUNTIME: that Node consults
 * the `lookup` we install, so the address that was validated is the address
 * connected to. Every assertion in it passes. What fails is the EXIT CODE -- a
 * connection emits `ECONNRESET` at worker teardown, after the module context is
 * gone, where neither the transport nor the test can hold a listener for it.
 *
 * Four attempts went at that emit directly: destroying the server socket, ending
 * it politely, waiting for quiescence, closing the in-flight socket that
 * `agent.destroy()` provably cannot (a real transport leak, found this way and
 * kept fixed), and answering with a genuine TLS fatal alert rather than going
 * silent. It survived all of them.
 *
 * Splitting the run is what lets BOTH facts stay true: this suite exits zero on
 * its own merits, and the runtime proof still blocks a commit through a wrapper
 * that gates on the assertions instead of the exit code. The reviewer's
 * objection was to that proof being UNGATED, not to the artefact being tolerated
 * by something that still fails on a real regression.
 *
 * If `test:transport` ever reports that vitest exited zero, the artefact is gone
 * and both this exclusion and the wrapper should be deleted.
 */
export default defineConfig({
  test: {
    // Spread the defaults rather than replacing them: a bare `exclude` drops
    // `node_modules` and `dist`, and vitest would start collecting tests out of
    // dependencies.
    exclude: [...configDefaults.exclude, "src/node/**"]
  }
});
