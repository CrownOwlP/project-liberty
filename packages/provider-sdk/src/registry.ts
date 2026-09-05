import type { CatalogItemRef } from "./provider";

/* -------------------------------------------------------------------------
 * The deferred mapping, named as a port (PL-0301).
 *
 * `AuthorizedMediaProvider.resolveAuthorizedCandidates` takes a
 * `CatalogItemRef` -- a provider id, a provider-native external id and a rights
 * value. Every surface that wants to PLAY something holds a normalized content
 * id instead: `/title/<id>`, `/watch/<id>`, and the playback session request,
 * which carries a content id and a device capability profile and deliberately
 * nothing else. Something has to turn the second into the first, and nothing in
 * this repository does.
 *
 * That gap was recorded rather than filled, and it is still the right call: the
 * mapping is catalog and provider-registry data, it is what says WHICH provider
 * serves a given work and under what entitlement, and inventing entries for it
 * would be fabricating exactly the rights-bearing facts the rest of this package
 * refuses to fabricate. `apps/web`'s session route makes the same argument for
 * why it injects a resolver instead of calling a provider directly.
 *
 * WHAT IS ADDED HERE IS THE NAME, NOT THE DATA. A deferral with a declared port
 * is a different thing from a deferral without one: the shape of the answer is
 * agreed, both sides can be written and tested against it, and the day a real
 * registry exists it is wired in rather than designed. A deferral with no port
 * is one where each consumer eventually invents its own shape.
 *
 * It is deliberately the narrowest interface that closes the gap. No listing, no
 * search, no bulk load, no cache hints: those are catalog questions, and a port
 * that anticipated them would be a guess at an interface for a system that does
 * not exist yet.
 * ---------------------------------------------------------------------- */

export interface CatalogItemRegistry {
  /**
   * The item a normalized content id names, or `null`.
   *
   * `null` MEANS "NOT IN THIS REGISTRY", AND IT IS NEVER A GUESS. It is the
   * answer for an id this registry does not carry and for an id that is not a
   * well-formed normalized content id, and both must stay refusals: an id
   * interpolated into a provider URL is an id that can walk out of a path prefix
   * (`..` survives percent-encoding, since dots are unreserved), so an
   * implementation that answered with a `CatalogItemRef` built out of an
   * unvalidated string would be handing a traversal to whatever composes the
   * URL.
   *
   * The `rights` on the returned ref is the CATALOG's statement of what we are
   * entitled to serve for this work. It is not the provider's, and the two are
   * checked against each other rather than reconciled -- see the
   * `item_rights_conflict` refusals in both adapters in this package. A registry
   * that copied the provider's declared rights onto every ref would delete that
   * check by making the two values one value.
   *
   * SYNCHRONOUS on purpose. A registry backed by a database or an HTTP catalog
   * will want to be async, and the day one exists this port grows a second
   * method or its own async variant. Declaring it `Promise`-returning today
   * would mean every caller and every test awaiting a lookup that cannot block,
   * to buy compatibility with an implementation nobody has written and whose
   * shape nobody has settled.
   */
  lookup(contentId: string): CatalogItemRef | null;
}
