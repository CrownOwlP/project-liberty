"use client";

/*
 * The LAST resort (PW-0301).
 *
 * `app/error.tsx` cannot catch a failure in the root layout itself, because it
 * renders INSIDE that layout. `global-error.tsx` replaces the whole document,
 * which is why it must emit its own `<html>` and `<body>` -- and why it must not
 * import the shell, the stylesheet or anything else that could be the thing that
 * just failed. Every style here is inline for that reason, not for brevity.
 *
 * There was no such boundary. A throw in the root layout produced a blank page.
 */
export default function GlobalError({ reset }: { readonly reset: () => void }) {
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
            * NO ERROR TEXT. A root-layout failure can carry a stack trace, and a
            * digest is the only thing safe to surface; here even that is omitted
            * because this boundary cannot rely on the redaction the rest of the
            * application does. The log has it.
            */}
          <p style={{ color: "#9aa5b5", margin: "0 0 1.5rem" }}>
            Something failed before the application frame could render. Reloading
            usually clears it. If it does not, the application log has the detail.
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
