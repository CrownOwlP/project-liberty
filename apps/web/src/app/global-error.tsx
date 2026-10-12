"use client";

import { useEffect, useMemo } from "react";
import {
  describeClientFailure,
  formatClientFailureReference,
  reportClientFailure
} from "../lib/diagnostics/client-failure";

/*
 * The LAST resort (PW-0301), which until PL-0759 could not say what it caught.
 *
 * `app/error.tsx` cannot catch a failure in the root layout itself, because it
 * renders INSIDE that layout. `global-error.tsx` replaces the whole document,
 * which is why it must emit its own `<html>` and `<body>` -- and why it must not
 * import the shell, the stylesheet or anything else that could be the thing that
 * just failed. Every style here is inline for that reason, not for brevity.
 *
 * There was no such boundary. A throw in the root layout produced a blank page.
 */
export default function GlobalError({
  error,
  reset
}: {
  /*
   * NEXT HAS ALWAYS PASSED THIS AND THIS COMPONENT NEVER DECLARED IT.
   *
   * The signature was `{ reset }`, so the error was dropped at the parameter
   * list -- which is why the body below could claim the log had the detail
   * while nothing anywhere received it. The installed Windows application
   * showed this screen for three rounds and reported nothing.
   */
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  /*
   * REPORTED FROM AN EFFECT, so it happens once per caught failure and never
   * during render. `window.location.pathname` is read here rather than passed,
   * because this boundary has replaced the document and has no router context
   * to ask; `describeClientFailure` strips the query before it travels.
   *
   * THE IMPORTS ARE THE RISK AND THEY ARE BOUNDED. This file must not import
   * the shell, the stylesheet, or anything that could be what just failed.
   * `react` is already the thing rendering this component, and
   * `lib/diagnostics/client-failure` imports nothing at all -- no React, no
   * CSS, no contract package -- and swallows every failure of its own. A
   * reporter that could throw in here would turn a diagnosable failure back
   * into the blank page this boundary exists to replace.
   */
  /*
   * ONE REPORT, USED TWICE (Wave 132). The screen and the log line are now
   * built from the SAME value rather than from two reads of the error, because
   * the operator's job is to match what is on the screen against what is in the
   * file -- and two independently derived strings are two things that can
   * disagree. `describeClientFailure` is total and pure, so computing it during
   * render is safe here; `useMemo` keeps it to once per caught error.
   */
  const report = useMemo(
    () =>
      describeClientFailure(
        "global-error",
        error,
        typeof window === "undefined" ? "/" : window.location.pathname
      ),
    [error]
  );

  useEffect(() => {
    /* Visible in the webview's own console as well, for a developer who has it
     * open; the POST is what reaches the file an operator can paste. */
    console.error("liberty: the application frame failed to render", report);
    reportClientFailure(report);
  }, [report]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#06080d",
          color: "#f7f9fc",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
        }}
      >
        <main style={{ maxWidth: "36rem", padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>
            Project Liberty could not start this page
          </h1>
          {/*
            * STILL NO ERROR TEXT, AND NOW THE DIGEST IS SHOWN (PL-0759).
            *
            * The reasoning this replaces was half right: a root-layout failure
            * can carry a stack trace, and a digest is the only thing safe to
            * surface. It then omitted the digest too and told the reader the log
            * had the detail. The log had nothing, because nothing wrote it.
            *
            * A digest is Next's own correlation id -- lowercase hex, no message,
            * no path, no user data -- and it is checked against that shape
            * before it is reported. Showing it is what lets an operator quote
            * one line that matches a line in the log. When Next did not mint one
            * (a purely client-side throw), the sentence says so rather than
            * leaving a blank where a reference should be.
            */}
          <p style={{ color: "#9aa5b5", margin: "0 0 1.5rem" }}>
            Something failed before the application frame could render. Reloading
            usually clears it. If it does not, the application log now records
            this failure.
          </p>
          <p
            style={{
              color: "#6b7280",
              margin: "0 0 1.5rem",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.8rem"
            }}
          >
            {/*
              * WAVE 132: THE REFERENCE IS NO LONGER JUST THE DIGEST.
              *
              * The operator's installed build threw a client-side TypeError,
              * for which Next mints NO digest -- so the previous version of
              * this line said "No reference was issued for this failure" on
              * exactly the failure that was happening, which is the same defect
              * as the comment that claimed the log had the detail. The
              * reference now names the boundary, the error's constructor, the
              * classified shape of its message and the first served-asset frame
              * -- which is enough to find the expression -- and still carries
              * no message, no path and no user data.
              */}
            {formatClientFailureReference(report)}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              padding: "0.6rem 1.2rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.18)",
              background: "#171d29",
              color: "inherit",
              cursor: "pointer"
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
