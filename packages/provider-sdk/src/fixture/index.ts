/**
 * The authorized fixture provider (PL-0301).
 *
 * Read the files in this order, because the rights argument only makes sense
 * that way round:
 *
 *   1. `environment.ts` -- why a fabricated rights basis is a value that cannot
 *      be CONSTRUCTED in a production runtime, rather than one that is built and
 *      then withheld, and exactly what that does and does not establish.
 *   2. `rights.ts` -- the declaration itself: a category from this package's own
 *      closed vocabularies, plus an OPAQUE internal reference that names a record
 *      in the operator's rights register and nothing else. No agreement text, no
 *      counterparty, no term, no URL. Nothing parses or branches on it.
 *   3. `provider.ts` -- the adapter, which states no media facts, ranks nothing,
 *      opens no socket, and is the only thing here that produces candidates.
 *
 * WHAT THIS IS FOR. A development rig, and the reference implementation of an
 * `AuthorizedMediaProvider` that a real one can be read against. It is not a
 * template for a licensed provider in one respect that matters: a real provider
 * establishes authorization from something outside this repository, whereas this
 * one declares it and is confined to a non-production runtime because it cannot.
 */

export { NON_PRODUCTION_RUNTIMES, NonProductionRuntime } from "./environment";

export {
  FIXTURE_RIGHTS_REFERENCE,
  MAX_RIGHTS_REFERENCE_LENGTH,
  OPAQUE_RIGHTS_REFERENCE_PATTERN,
  fixtureRightsBasis,
  isOpaqueRightsReference
} from "./rights";
export type { FixtureRightsBasis } from "./rights";

export {
  DEFAULT_FIXTURE_PROVIDER_ID,
  FIXTURE_VARIANTS,
  createFixtureProvider,
  fixtureCatalogItemRegistry
} from "./provider";
export type {
  CreateFixtureProviderResult,
  FixtureCandidate,
  FixtureProvider,
  FixtureProviderOptions,
  FixtureProviderRejectionReason,
  FixtureResolution,
  FixtureResolutionReason,
  FixtureVariant
} from "./provider";
