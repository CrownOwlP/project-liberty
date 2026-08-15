"use client";

import { useEffect } from "react";

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
  useEffect(() => {
    console.error("home route failed to render", error);
  }, [error]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">PROJECT <span>LIBERTY</span></div>
      </header>

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
    </main>
  );
}
