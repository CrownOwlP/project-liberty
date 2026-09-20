/* -------------------------------------------------------------------------
 * The server entry point (PL-0308)
 *
 * WHAT NEXT DOES WITH THIS FILE. `register` is called ONCE per server process,
 * before any request is served, and once per runtime -- which is why the guard
 * below is the first line of the body rather than a nicety.
 *
 * WHY IT IS AT `apps/web/src/instrumentation.ts` AND NOT AT THE APP ROOT, which
 * is where this task's write surface originally put it. Next 16.3.1 discovers
 * the file by scanning exactly one directory, non-recursively:
 * `path.join(pagesDir || appDir, "..")` in `next/dist/build/index.js`. This
 * application has `src/app` and no `pages`, so that directory is `apps/web/src`
 * and a file at `apps/web/instrumentation.ts` is never seen -- checked by
 * replaying Next's own discovery (`findPagesDir`, `getFilesInDir`, its
 * constants and its `isAtConventionLevel` test) over this tree and over two
 * fixtures differing only in where the file sits, not by reading the docs.
 *
 * NO CONFIGURATION OPTS THIS IN. On this version `experimental.instrumentationHook`
 * is deprecated with the message that "`instrumentation.js` is available by
 * default" (`next/dist/server/config.js`), so `next.config.ts` is untouched.
 *
 * THE IMPORT IS DYNAMIC AND INSIDE THE GUARD, DELIBERATELY. Next compiles an
 * instrumentation entry for the edge runtime as well as the Node one, and
 * `lib/server-bootstrap.ts` imports `node:dns/promises` and the Node pinned
 * fetch. A static import would pull both into an edge bundle that cannot
 * contain them, and it would do so at BUILD time, where the guard cannot help
 * -- a runtime check does not remove a module from a bundle. So the guard
 * decides whether the module is loaded at all.
 *
 * THERE IS NO LOGIC HERE, AND THAT IS THE POINT. Everything this file could get
 * wrong -- which variables are read, what a half-configured deployment gets,
 * what the log line says -- lives in `lib/server-bootstrap.ts`, where
 * `server-bootstrap.test.ts` drives it. A framework convention file is the one
 * place in an application that no test can call, so it should hold nothing
 * worth testing.
 * ---------------------------------------------------------------------- */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { bootstrapCatalogMetadataSource, describeCatalogBootstrapOutcome } = await import(
    "./lib/server-bootstrap"
  );

  /*
   * ONE LINE, ALWAYS, INCLUDING WHEN NOTHING IS CONFIGURED. "No catalog source
   * requested" is the state an operator most needs to see stated at startup,
   * because it is indistinguishable at the browse surfaces from a source that
   * is configured and publishing nothing.
   *
   * IT DOES NOT THROW ON A REFUSED DECLARATION. `bootstrapCatalogMetadataSource`
   * returns the defect list instead, for the reason recorded there: a catalog
   * misconfiguration that takes playback and search down with it is a worse
   * outcome than a named refusal on the browse surfaces plus this line in the
   * log.
   */
  console.info(describeCatalogBootstrapOutcome(bootstrapCatalogMetadataSource()));
}
