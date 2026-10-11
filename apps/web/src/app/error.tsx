"use client";

import { AppShell } from "../components/shell/app-shell";
import { useEffect } from "react";
import {
  describeClientFailure,
  reportClientFailure
} from "../lib/diagnostics/client-failure";

/**
 * Route-segment error boundary. `loadHomeCatalog` already converts expected
 * failures into a handled `error` result, so reaching this boundary means
 * something genuinely unexpected threw during render. It stays deliberately
 * generic and never surfaces the raw message, which can contain internal
 * detail.
 */
export default function HomeError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /*
   * THE `console.error` HERE WENT NOWHERE (PL-0759). In the installed
   * application the webview's console is not captured by anything, so this
   * boundary was as silent as the global one. The report below reaches the
   * sidecar's stderr and therefore the log file the operator pastes; the
   * console call is kept for a developer who has devtools open.
   */
  useEffect(() => {
    const report = describeClientFailure(
      "route-error",
      error,
      typeof window === "undefined" ? "/" : window.location.pathname
    );
    console.error("home route failed to render", report);
    reportClientFailure(report);
  }, [error]);

  return (
    <AppShell pathname="/">

      <div className="state-panel" role="alert">
        <h2>Something went wrong</h2>
        <p>The page couldn&apos;t be displayed. This has been logged.</p>
        {error.digest ? <p className="code state-detail">Reference: {error.digest}</p> : null}
        <div className="actions">
          <button className="button button-primary" onClick={reset} type="button">
            Try again
          </button>
        </div>
      </div>
    </AppShell>
  );
}
