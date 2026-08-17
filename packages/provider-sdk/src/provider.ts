import { PLAYABLE_CONTENT_RIGHTS, type ContentRights, type StreamCandidate } from "@liberty/contracts";

/**
 * The provider boundary.
 *
 * Everything provider-specific enters core application logic through this
 * interface and nothing else (docs/ARCHITECTURE.md). An adapter's job is to turn
 * whatever a source speaks into normalized, AUTHORIZED candidates; deciding
 * between them belongs to `@liberty/media-engine`, and an adapter that ranks or
 * filters on quality is an adapter whose decisions cannot be seen in a playback
 * decision's reason trail.
 */

export interface CatalogItemRef {
  providerId: string;
  externalId: string;
  rights: ContentRights;
}

export interface ProviderContext {
  requestId: string;
  /**
   * Present so an adapter for a provider that requires a per-viewer session can
   * find one. It is NOT a value to forward to a third party by default: see the
   * Stremio adapter, which deliberately sends neither this nor the request id.
   */
  profileId?: string;
}

export interface AuthorizedMediaProvider {
  readonly id: string;
  readonly displayName: string;

  health(): Promise<{ ok: boolean; latencyMs: number }>;

  resolveAuthorizedCandidates(
    item: CatalogItemRef,
    context: ProviderContext
  ): Promise<StreamCandidate[]>;
}

/**
 * Throws unless `rights` is on the contract's playable allowlist.
 *
 * Reads the allowlist from `@liberty/contracts` rather than restating it. It
 * previously carried its own inline copy of the three values, which meant a
 * rights value added to the contract would be refused here and accepted there --
 * two allowlists that agree today and silently disagree on the day one of them
 * is edited. There is one allowlist.
 *
 * Note the shape of the check: membership of an explicit allowlist, so anything
 * unrecognised is refused rather than permitted. Prefer the result-returning
 * gates (`defineStremioSource`) where a caller can act on a refusal; this exists
 * for the assertion points where continuing would be a bug.
 */
export function assertAuthorizedRights(rights: ContentRights): void {
  if (!PLAYABLE_CONTENT_RIGHTS.includes(rights)) {
    throw new Error("Unauthorized content-rights state");
  }
}
