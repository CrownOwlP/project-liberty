/* -------------------------------------------------------------------------
 * Where to go after signing in (PW-0312)
 *
 * THE OPEN-REDIRECT THIS FILE EXISTS TO PREVENT. A sign-in screen that takes
 * its destination from a query string -- which it must, because the whole point
 * is to send somebody back where they were refused -- is one careless line away
 * from `/signin?next=https://evil.example/liberty`, a page that looks like this
 * product, collects a password and forwards the viewer on. It is the single
 * most common vulnerability in the single most sensitive screen in any
 * application, and it is a one-function fix applied at the boundary.
 *
 * AN ALLOWLIST OF SHAPE, NOT A BLOCKLIST OF HOSTS. Nothing here compares a host
 * against anything, because a value that can name a host has already lost: the
 * near-misses -- `//evil.example`, `https:/\evil.example`, `\/\/evil.example`,
 * a percent-encoded scheme -- are exactly what a host check lets through. What
 * is accepted is a single leading `/` followed by something that is not another
 * slash or a backslash. Everything else becomes the default.
 * ---------------------------------------------------------------------- */

/** Where a viewer lands when they arrive at the form with no destination. */
export const DEFAULT_NEXT_PATH = "/";

/**
 * The destination, narrowed to a same-origin path.
 *
 * Returns `DEFAULT_NEXT_PATH` rather than throwing or reporting, because a
 * hostile or malformed `next` is not something a viewer can act on and not
 * something worth a screen of its own: they asked to sign in, and they get to
 * sign in and land on the home page.
 *
 * A SEARCH PARAM CAN BE AN ARRAY, and `?next=/a&next=https://evil.example` is
 * the reason that case is handled rather than ignored. Only a lone string is
 * accepted; a repeated parameter is somebody testing this function.
 */
export function safeNextPath(value: string | readonly string[] | undefined): string {
  if (typeof value !== "string") return DEFAULT_NEXT_PATH;
  if (value.length === 0 || value.length > 512) return DEFAULT_NEXT_PATH;

  /* Must begin exactly one `/`, and the next character must not be another
   * slash or a backslash -- `//host` and `/\host` are both protocol-relative
   * URLs to most browsers. */
  if (!value.startsWith("/")) return DEFAULT_NEXT_PATH;
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_NEXT_PATH;

  /* No control characters, no backslash anywhere, and no scheme separator: a
   * `:` before the first `/` cannot occur given the check above, but one
   * anywhere in a path is still never something this product routes on. */
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_NEXT_PATH;
  if (value.includes(":")) return DEFAULT_NEXT_PATH;

  return value;
}

/** The sign-in URL that comes back to `path` afterwards. */
export function signInHref(path?: string): string {
  const next = safeNextPath(path);
  if (next === DEFAULT_NEXT_PATH) return "/signin";
  return `/signin?next=${encodeURIComponent(next)}`;
}
