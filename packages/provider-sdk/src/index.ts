import type { ContentRights, StreamCandidate } from "@liberty/contracts";

export interface CatalogItemRef {
  providerId: string;
  externalId: string;
  rights: ContentRights;
}

export interface ProviderContext {
  requestId: string;
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

export function assertAuthorizedRights(rights: ContentRights): void {
  if (!(["licensed", "owned", "public-domain"] as const).includes(rights)) {
    throw new Error("Unauthorized content-rights state");
  }
}
