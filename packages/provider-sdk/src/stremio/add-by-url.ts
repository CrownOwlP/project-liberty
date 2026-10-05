import { parseStremioManifest, type StremioManifest } from "./protocol";
import { fetchJson, type HttpFailureReason, type HttpOptions } from "./http";
import { checkUrl, truncate, type UrlPolicyOptions, type UrlRejectionReason } from "./url-policy";

/**
 * Add-by-URL: the one step the adapter did not already have (PL-0743).
 *
 * Everything this file needs already exists and none of it is reimplemented
 * here. `url-policy.ts` decides scheme, credentials and host class; `http.ts`
 * resolves the name, classifies every answer, pins the connection and bounds
 * the body; `protocol.ts` parses the manifest; `source.ts` is the only thing
 * that can turn a URL into something playback may use. This file is the
 * ordering between them, plus two small absences that stopped a pasted URL
 * from reaching any of it.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE ONE: NOTHING IN THIS REPOSITORY SPOKE `stremio://`
 *
 * It is the scheme every Stremio addon directory publishes and the one a user
 * will paste, and `checkUrl` rejects it -- correctly, since it rejects every
 * scheme it does not know. Normalising it is a SCHEME SWAP AND NOTHING ELSE,
 * and it happens BEFORE the policy runs. Both halves of that sentence are
 * load-bearing in opposite directions:
 *
 *   - before, because a policy that runs on `stremio://` refuses a legitimate
 *     paste for a reason the user cannot act on;
 *   - and nothing else, because a rewrite that touched the host, the port or
 *     the path would mean the policy judged one URL and the socket reached
 *     another, which is the exact failure `http.ts` exists to prevent.
 *
 * So `stremio://127.0.0.1/manifest.json` is refused by the loopback rule in
 * precisely the way `https://127.0.0.1/manifest.json` is. The normalisation
 * buys a user convenience and no authority whatsoever.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE TWO: NOTHING COULD DESCRIBE AN ADDON WITHOUT FIRST TRUSTING IT
 *
 * A person pasting a URL should see what they are about to add before they
 * declare anything about it. There was no way to do that: the only object this
 * package produced from a manifest URL was an `AuthorizedStremioSource`, which
 * by construction already carries a rights declaration.
 *
 * `StremioAddonPreview` is that missing object, and it is defined by what it
 * does NOT have. It carries no `ContentRights`, no `RightsBasis`, and not the
 * `RIGHTS_DECLARED` brand -- so it is not assignable anywhere an authorized
 * source is required, and `createStremioProvider` cannot be handed one. The
 * type system enforces that; it is not a convention.
 *
 * A preview also travels as JSON into a UI, where a unique symbol does not
 * survive, so it carries `authorization: "none"` and the sentence explaining
 * it IN THE OBJECT. The same reasoning the Windows qualification report uses
 * for its `notCovered` list: the thing that gets read later is the payload,
 * not the documentation of the payload.
 *
 * gpt-architect's round-115 section 7, which this file exists to obey:
 * "Stremio protocol compatibility is NOT playback authorization. A pasted URL
 * must NEVER automatically become an authorized production source."
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE TO EXIST AT ALL
 *
 * `url-policy.ts` records host-literal checking as an accepted residual risk
 * and states the condition that ends the acceptance: "the moment this becomes
 * the general server-side client for arbitrary operator- or user-configured
 * addons, host-string checks are no longer a control at all ... and
 * resolve-and-pin has to land BEFORE that ships to production." Add-by-URL is
 * that moment. It is writable now only because PL-0710 landed resolve-and-pin
 * in `http.ts`, and the only network call below goes through it. There is no
 * second transport in this file and there must never be one.
 *
 * Nothing here throws. A paste that is wrong, a host that is private, a name
 * that resolves somewhere it may not, an addon that is down or lying -- all of
 * them are ordinary outcomes with a reason attached, as everywhere else in
 * this directory.
 */

/** Every way a paste can fail to become a preview. */
export type AddByUrlRejectionReason =
  | "empty_input"
  | "manifest_url_not_manifest_json"
  | "manifest_malformed"
  | HttpFailureReason;

/**
 * What an addon SAYS about itself, shown to a human before anything is
 * declared about it.
 *
 * Every field is the addon's own claim and none of it has been checked against
 * anything. That is not a weakness of the preview -- it is what a preview is.
 */
export interface StremioAddonPreview {
  /**
   * The URL that was actually fetched, after `stremio://` normalisation and
   * after every redirect hop. Shown rather than the paste, because an addon
   * directory link that redirects elsewhere is exactly the case a person needs
   * to see before declaring rights over it.
   */
  readonly manifestUrl: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | undefined;
  /** `types`, verbatim. Empty means the manifest declared no restriction. */
  readonly declaredTypes: readonly string[];
  /**
   * `resources`, flattened to names. The protocol allows a bare string or an
   * object narrowing the resource, and a preview is about what the addon
   * offers, not how narrowly.
   */
  readonly declaredResources: readonly string[];
  readonly catalogCount: number;
  /** The addon's own hints. `adult` and `p2p` are the two worth surfacing. */
  readonly behaviorHints: StremioManifest["behaviorHints"];
  /**
   * ALWAYS `"none"`. A preview is not an authorization and cannot become one
   * by being passed around; becoming a source is `defineStremioSource`, with
   * an explicit operator declaration and an auditable basis.
   */
  readonly authorization: "none";
  /** Travels in the payload, because the payload is what gets read later. */
  readonly authorizationNote: string;
  readonly elapsedMs: number;
}

export type NormalizeResult =
  | { readonly ok: true; readonly url: string; readonly normalizedFromStremioScheme: boolean }
  | {
      readonly ok: false;
      readonly reason: "empty_input" | "manifest_url_not_manifest_json" | UrlRejectionReason;
      readonly detail: string;
    };

export type AddByUrlResult =
  | { readonly ok: true; readonly preview: StremioAddonPreview }
  | {
      readonly ok: false;
      readonly reason: AddByUrlRejectionReason;
      readonly detail: string;
      readonly elapsedMs?: number;
    };

const AUTHORIZATION_NOTE =
  "This is what the addon says about itself. It is not an authorization. " +
  "No content may be resolved from this URL until an operator declares rights " +
  "for it with an auditable basis (defineStremioSource).";

/** Matches ONLY a leading `stremio://`, case-insensitively. */
const STREMIO_SCHEME = /^stremio:\/\//i;

/**
 * Accepts what a person pastes and produces the URL the policy will judge.
 *
 * Exported separately from the fetch so a UI can validate a paste as it is
 * typed without opening a socket, and so the BEFORE-the-policy ordering is
 * testable on its own rather than inferred from the behaviour of a network
 * call.
 */
export function normalizeAddonUrl(rawInput: string, policy: UrlPolicyOptions): NormalizeResult {
  const trimmed = rawInput.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty_input", detail: "no URL was given" };
  }

  /*
   * Anchored, so a `stremio://` appearing anywhere other than the scheme --
   * inside a query parameter, say -- is left exactly as it is. The replacement
   * is on the SCHEME SUBSTRING and cannot reach the host, the port, the path,
   * the query or the fragment.
   */
  const normalizedFromStremioScheme = STREMIO_SCHEME.test(trimmed);
  const swapped = normalizedFromStremioScheme ? trimmed.replace(STREMIO_SCHEME, "https://") : trimmed;

  /*
   * THE PRODUCTION GATE, NOT A SECOND ONE. Parsing, scheme, embedded
   * credentials, host class and the two-key loopback rule are all `checkUrl`'s
   * and are not restated here -- a second scheme or host judgement in this
   * file would be the two-classifiers defect PL-0710 spent half its budget
   * removing, one layer up.
   *
   * It runs here as well as inside `fetchJson` on purpose. `checkUrl` is pure,
   * so the second call costs nothing, and it means a UI validating a paste as
   * it is typed gets the SAME answer the server will give it rather than an
   * approximation that disagrees at submit time.
   */
  const checked = checkUrl(swapped, policy);
  if (!checked.ok) {
    return { ok: false, reason: checked.reason, detail: checked.detail };
  }

  /*
   * The same requirement `source.ts` enforces, with the same reason name, and
   * checked HERE rather than only there. A preview that succeeded on a URL
   * that can never become a source would send a person through the rights
   * declaration to be refused at the end of it.
   *
   * After the security gate, deliberately: a private-host URL with a bad path
   * should report the private host.
   */
  if (!checked.url.pathname.endsWith("/manifest.json")) {
    return {
      ok: false,
      reason: "manifest_url_not_manifest_json",
      detail: `manifest URL path ${truncate(checked.url.pathname)} must end with /manifest.json`
    };
  }

  return { ok: true, url: checked.url.toString(), normalizedFromStremioScheme };
}

/** Flattens `resources` to names; the protocol allows two spellings. */
function resourceNames(manifest: StremioManifest): readonly string[] {
  return manifest.resources.map((entry) => (typeof entry === "string" ? entry : entry.name));
}

/**
 * Fetches and describes an addon, without authorizing anything.
 *
 * Takes `HttpOptions` whole, so this path cannot be configured with a
 * different timeout, body cap, redirect limit, resolver or loopback policy
 * than the rest of the adapter. A separate options bag here would be the first
 * step towards a second transport.
 */
export async function previewStremioAddon(
  rawInput: string,
  options: HttpOptions
): Promise<AddByUrlResult> {
  const normalized = normalizeAddonUrl(rawInput, {
    allowLoopback: options.allowLoopback,
    localDeployment: options.localDeployment
  });
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason, detail: normalized.detail };
  }

  // THE ONLY NETWORK CALL. Policy, resolution, pinning, redirect re-validation
  // and the body cap all live inside it.
  const response = await fetchJson(normalized.url, options);
  if (!response.ok) {
    return { ok: false, reason: response.reason, detail: response.detail, elapsedMs: response.elapsedMs };
  }

  const parsed = parseStremioManifest(response.value);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "manifest_malformed",
      detail: parsed.detail,
      elapsedMs: response.elapsedMs
    };
  }

  const manifest = parsed.value;
  return {
    ok: true,
    preview: {
      // `response.url` is the hop the body actually came from, not the paste.
      manifestUrl: response.url,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      declaredTypes: manifest.types,
      declaredResources: resourceNames(manifest),
      catalogCount: manifest.catalogs.length,
      behaviorHints: manifest.behaviorHints,
      authorization: "none",
      authorizationNote: AUTHORIZATION_NOTE,
      elapsedMs: response.elapsedMs
    }
  };
}
