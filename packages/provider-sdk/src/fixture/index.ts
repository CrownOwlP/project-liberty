/**
 * The authorized fixture provider (PL-0301).
 *
 * Read the files in this order, because the rights argument only makes sense
 * that way round:
 *
 *   1. `environment.ts` -- why a fabricated rights basis is a value that cannot
 *      be CONSTRUCTED in a production runtime, rather than one that is built and
 *      then withheld, and exactly what that does and does not establish. It also
 *      says why the runtime allowlist is NOT here: the application classifies its
 *      own process through `@liberty/contracts/shared/runtime`, this package
 *      requires evidence that the classification happened, and there is one
 *      allowlist rather than two that agree until they do not.
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

/*
 * `NonProductionRuntime` and `fixtureRightsBasis` are deliberately NOT re-
 * exported, here or from `../index.ts`, and the omission is the mechanism rather
 * than tidiness. `fixtureRightsBasis` is the only constructor of a fabricated
 * `owned` declaration; keeping it off the public surface, together with the
 * witness its signature demands, means a consumer cannot build that declaration
 * without building a provider. `createFixtureProvider` mints the witness from
 * the classification it is handed and is the only door. `./rights.ts` withholds
 * its brand symbol for the same reason: a thing you can reach is a thing you can
 * forge.
 *
 * `RuntimeClassification` USED TO BE EXPORTED FROM HERE AND MUST NOT COME BACK.
 * It was a structural interface holding one public field, so exporting it told
 * every consumer the exact shape of the argument that unlocks the fixture
 * provider -- and an argument whose shape you can read is an argument you can
 * write. `createFixtureProvider` now takes `ClassifiedRuntime` from
 * `@liberty/contracts/shared/runtime`, which a consumer can name (it is a public
 * contract) and cannot mint: the brand key is a private symbol in that module
 * and the factory checks the issuing registry. Nothing about the capability is
 * re-published here, because this package has nothing to add to it.
 */

export {
  FIXTURE_RIGHTS_REFERENCE,
  MAX_RIGHTS_REFERENCE_LENGTH,
  OPAQUE_RIGHTS_REFERENCE_PATTERN,
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
