import Link from "next/link";

import { signInHref } from "./next-path";

/* -------------------------------------------------------------------------
 * The screen a signed-out viewer actually gets (PW-0312)
 *
 * THE ACCEPTANCE'S CENTRAL COMPLAINT, ANSWERED. PW-0403 made a deployment
 * answer 401 `not_authenticated`, and until this component nothing in the
 * application consumed it: `/api/auth/*` was served and nothing linked to it,
 * so the honest description of a deployment was that it refused everybody
 * correctly and offered them nowhere to go. A 401 rendered as a generic error
 * panel is the same dead end with better manners.
 *
 * IT CARRIES THE DESTINATION. A viewer refused at `/profiles` is sent to
 * `/signin?next=/profiles` and lands back where they were, rather than on the
 * home page having to find their way again. `signInHref` narrows that
 * destination to a same-origin path before it is ever put in a URL -- see
 * `next-path.ts` for the open redirect that guard exists to prevent.
 * ---------------------------------------------------------------------- */

export interface SignedOutPanelProps {
  /** What the viewer was trying to reach, so they can be returned to it. */
  readonly next?: string;
  /** What they were trying to do, in a few words. */
  readonly what: string;
}

export function SignedOutPanel({ next, what }: SignedOutPanelProps) {
  return (
    <section className="section">
      <div className="state-panel">
        {/*
          ONE INTERPOLATION, NOT TWO TEXT NODES. Written as `Sign in to {what}`
          this renders as `Sign in to <!-- -->choose who is watching` under the
          streaming server renderer, which separates adjacent text nodes with a
          comment so hydration can tell where one ends. Harmless to a reader and
          to a screen reader -- but it also means `renderToStaticMarkup`, which
          inserts no separator, produces different bytes from production. A
          single template literal produces one text node in both, so a test and
          the page agree. Same correction PW-0305 made to its progress label.
        */}
        <h2>{`Sign in to ${what}`}</h2>
        <p>
          This is kept for your household, so it needs an account. Nothing is wrong with what you
          asked for.
        </p>
        <p>
          <Link className="button button-primary" href={signInHref(next)}>
            Sign in
          </Link>
        </p>
      </div>
    </section>
  );
}
