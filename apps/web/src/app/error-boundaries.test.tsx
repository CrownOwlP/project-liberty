import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GlobalError from "./global-error";

/* -------------------------------------------------------------------------
 * The boundaries, and the premise the packaged smoke test rests on (PL-0759).
 *
 * `apps/desktop/scripts/packaged-server-smoke.mjs` now refuses a homepage that
 * lacks `AppShell`'s markers or carries the error headline. That assertion is
 * only worth anything while the error page really is distinguishable from a
 * working one, and that is a fact about THIS component. So it is asserted here,
 * beside the component, rather than assumed by a script in another workspace
 * that cannot import it.
 * ---------------------------------------------------------------------- */

/** Must equal `APPLICATION_FRAME_MARKERS` in `packaged-server-smoke.mjs`. */
const APPLICATION_FRAME_MARKERS = ["skip-link", 'class="shell"', 'id="main"'];
/** Must equal `ERROR_PAGE_HEADLINE` there. */
const ERROR_PAGE_HEADLINE = "could not start this page";

const noop = () => undefined;
const withDigest = Object.assign(new Error("a message that must not appear"), {
  digest: "9f2a1c0d"
});

describe("the global error boundary", () => {
  it("carries the headline the packaged smoke test refuses", () => {
    const html = renderToStaticMarkup(<GlobalError error={withDigest} reset={noop} />);
    expect(html).toContain(ERROR_PAGE_HEADLINE);
  });

  it("carries NONE of the application-frame markers the smoke test requires", () => {
    /*
     * THE PREMISE. If this component ever grew a skip link or a `.shell` main,
     * the smoke test's "this is the application" assertion would start passing
     * on the error page and would be worth nothing -- silently. This is the
     * test that fails instead.
     */
    const html = renderToStaticMarkup(<GlobalError error={withDigest} reset={noop} />);
    for (const marker of APPLICATION_FRAME_MARKERS) {
      expect(html, `global-error must not emit ${marker}; the smoke test depends on it`).not.toContain(
        marker
      );
    }
  });

  it("shows the digest, which it used to omit while claiming the log had it", () => {
    const html = renderToStaticMarkup(<GlobalError error={withDigest} reset={noop} />);
    expect(html).toContain("9f2a1c0d");
  });

  it("says so plainly when there is no digest, rather than leaving a blank", () => {
    const html = renderToStaticMarkup(<GlobalError error={new Error("x")} reset={noop} />);
    expect(html).toContain("No reference was issued");
  });

  it("never renders the error message", () => {
    const html = renderToStaticMarkup(<GlobalError error={withDigest} reset={noop} />);
    expect(html).not.toContain("a message that must not appear");
  });

  it("still imports no stylesheet and no shell: every style is inline", () => {
    /* The original constraint. A boundary that imports what may have failed is
     * a boundary that fails with it. */
    const html = renderToStaticMarkup(<GlobalError error={withDigest} reset={noop} />);
    expect(html).toContain("<html");
    expect(html).toContain("style=");
    expect(html).not.toContain("class=");
  });
});

/*
 * THE ROUTE BOUNDARY IS NOT RENDERED HERE, AND THE REASON IS WORTH RECORDING.
 *
 * `error.tsx` is a `"use client"` component that renders `AppShell`, and
 * `AppShell` contains `next/link`. Rendering a client component through
 * `renderToStaticMarkup` puts that `Link` in a client tree with no app-router
 * context, and React fails with "invariant expected app router to be mounted".
 * `profile-ui.test.tsx` renders the same `AppShell` successfully because it
 * renders it from a SERVER tree, where `Link` resolves statically.
 *
 * `apps/web/vitest.config.ts` sets `environment: "node"` with no jsdom and no
 * router mock, so there is nowhere to mount one. Two assertions were written
 * here, failed for exactly that reason, and were removed rather than propped up
 * with a mock that would have made this file the only place in the suite that
 * fakes Next's internals.
 *
 * What covers it instead: the shared reporter it calls is tested directly in
 * `lib/diagnostics/client-failure.test.ts`, including that no message or stack
 * can travel; and the boundary's markup was already covered by the digest line
 * it has rendered since PW-0301. The browser half belongs to Playwright, which
 * this session cannot execute.
 */
