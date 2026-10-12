/* -------------------------------------------------------------------------
 * WHETHER THIS INSTALLATION HAS A LICENSED LIVE FEED (Wave 132, Worker E).
 *
 * THE HONEST ANSWER, IN THE SHIPPED CONFIGURATION, IS NO. Nothing in this
 * repository registers a live feed. `docs/LIVE_TV.md` places acquisition at
 * PL-0602, behind `@liberty/provider-sdk`, blocked on licensed feed access, and
 * this module does not quietly change that: `resolveLiveFeed()` called on a
 * process where nobody registered anything returns
 * `not-configured / no_licensed_live_feed_configured`, and that is what
 * `/live` renders. Worker E built the parsing, organisation and presentation
 * layer a licensed feed would feed. It did not acquire a feed, and this file is
 * where that fact is represented rather than papered over.
 *
 * REGISTRATION, NOT DISCOVERY — THE SAME DECISION `lib/catalog-source-registry.ts`
 * MAKES AND FOR THE SAME REASON, SET OUT THERE AT LENGTH: nothing here reads an
 * environment variable, consults a file, or holds a credential. A feed is
 * SUPPLIED by a composition root that constructed it on purpose, with a provider
 * identity, the origins that provider declared, and a per-channel rights basis
 * the provider established. A runtime read out of `process.env` would be a
 * hosted process describing its own entitlements into existence — and for a
 * LIVE feed that is not a configuration smell, it is product invariant 1.
 *
 * (It is also why `LIVE_TV_M3U_URL`-shaped configuration does not exist here. An
 * operator who can name a playlist URL in an environment variable can point this
 * application at an arbitrary channel list, which is precisely the "inclusion in
 * a third-party index is not permission from anybody" problem
 * `docs/LIVE_TV.md` refuses. A rights basis per channel cannot be expressed in
 * an environment variable, so there is no shape of one this module could accept.)
 *
 * THE DEFECT CLASS REMOVED: THE DEMO FIXTURE THAT BECOMES THE PRODUCT. The
 * tempting move, with a parser finished and no feed to parse, is to register the
 * synthetic fixtures in `media/fixtures/livetv/` as a development feed so the
 * screen has something on it. That is how a synthetic channel list ends up in
 * front of a user, and it is forbidden here by construction: there is NO
 * fixture-backed default, no environment in which one is substituted, and no
 * import of the fixtures from this module or from any module `/live` reaches.
 * `live-page-data.test.ts` and `fixtures.test.ts` both assert it. The fixtures
 * are test inputs; the surface's unconfigured state is the truth.
 * ---------------------------------------------------------------------- */
import type { LiveFeedAuthorization } from "./playlist-validation";

/** The stated reason an installation has no live TV. Exported so the surface can switch on it. */
export const LIVE_FEED_NOT_CONFIGURED_REASON = "no_licensed_live_feed_configured";

/**
 * A registered feed: the authorization, plus where its documents come from.
 *
 * `playlistText` and `epgText` are SUPPLIED TEXT, not URLs. The adapter that
 * acquired them is the thing that proved authorization and opened the connection
 * — PL-0602's job behind `@liberty/provider-sdk` — and by the time the
 * presentation layer sees a feed, there is nothing left for it to fetch. That is
 * what lets every module in `lib/livetv/**` be pure and lets this layer contain
 * no network call at all.
 */
export interface RegisteredLiveFeed {
  readonly authorization: LiveFeedAuthorization;
  /** The M3U document the authorized adapter retrieved. */
  readonly playlistText: string;
  /** The XMLTV document the authorized adapter retrieved, or `null` if it has none yet. */
  readonly epgText: string | null;
  /** A human-readable name for the arrangement, for an operator-facing panel. */
  readonly label: string;
}

export type LiveFeedResolution =
  | { readonly status: "configured"; readonly feed: RegisteredLiveFeed }
  | {
      readonly status: "not-configured";
      readonly reason: typeof LIVE_FEED_NOT_CONFIGURED_REASON;
      /** `null` rather than a sentence: the surface owns the wording. */
      readonly detail: string | null;
    };

let registered: RegisteredLiveFeed | null = null;

/**
 * Register the one live feed this process has.
 *
 * A call somebody makes on purpose, visible in a stack trace, with a value they
 * constructed. There is no caller in this repository, which is the correct state
 * while PL-0602 is blocked.
 */
export function registerLiveFeed(feed: RegisteredLiveFeed): void {
  registered = feed;
}

/**
 * Forget the registered feed.
 *
 * Exists for tests, and named for what it does rather than hidden behind a
 * `__test` prefix — a module with process-wide state needs a stated way back to
 * its initial condition, and a test that could not reach it would leak a feed
 * into every later test in the file.
 */
export function clearRegisteredLiveFeed(): void {
  registered = null;
}

/** What is registered, if anything. Exposed so a caller can pass it explicitly. */
export function registeredLiveFeed(): RegisteredLiveFeed | null {
  return registered;
}

/**
 * The answer `/live` renders.
 *
 * The argument defaults to the registry for the same reason
 * `resolveCatalogMetadataSource`'s does: a test can hand in a feed without
 * touching process state, and production calls it with no argument and gets the
 * registry's answer.
 */
export function resolveLiveFeed(
  feed: RegisteredLiveFeed | null = registeredLiveFeed()
): LiveFeedResolution {
  if (feed === null) {
    return {
      status: "not-configured",
      reason: LIVE_FEED_NOT_CONFIGURED_REASON,
      detail: "live acquisition is PL-0602 and is blocked on licensed feed access"
    };
  }
  if (feed.authorization.declaredOrigins.length === 0) {
    /*
     * A feed that declared no origins admits no channels (see
     * `./playlist-validation.ts`), so reporting it as configured would produce a
     * screen that says "0 channels" for a configuration error. Reported as
     * not-configured with its own detail instead.
     */
    return {
      status: "not-configured",
      reason: LIVE_FEED_NOT_CONFIGURED_REASON,
      detail: "a feed was registered without declaring any origin it serves from"
    };
  }
  if (Object.keys(feed.authorization.channelRights).length === 0) {
    return {
      status: "not-configured",
      reason: LIVE_FEED_NOT_CONFIGURED_REASON,
      detail: "a feed was registered without a rights basis for any channel"
    };
  }
  return { status: "configured", feed };
}
