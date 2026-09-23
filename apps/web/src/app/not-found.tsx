import Link from "next/link";
import { AppShell } from "../components/shell/app-shell";

/*
 * The ROOT not-found (PW-0301).
 *
 * There was none. A path this application does not serve produced Next's
 * built-in page -- unstyled, unbranded, with no way back -- which on a desktop
 * application with no browser address bar is a dead end a viewer cannot leave.
 *
 * SAFE TO PUT A SHELL HERE, unlike a `loading.tsx`: PL-0704's rule is about
 * Suspense boundaries ABOVE a `notFound()`-capable page flushing HTTP 200 before
 * the status can be set. This file IS the 404 response, not a boundary over one.
 */
export default function RootNotFound() {
  return (
    <AppShell pathname="/" badge="Not found">
      <section className="section">
        <h1>That page does not exist</h1>
        <p className="muted">
          The address does not match anything this application serves.
        </p>
        <p>
          <Link className="button" href="/">
            Back to home
          </Link>
        </p>
      </section>
    </AppShell>
  );
}
