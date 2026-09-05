import type { ContentRights } from "@liberty/contracts/shared/rights";
import { assertAuthorizedRights } from "../provider";
import { RIGHTS_BASES_FOR_RIGHTS, type RightsBasis, type RightsBasisKind } from "../stremio/source";
import type { NonProductionRuntime } from "./environment";

/* -------------------------------------------------------------------------
 * The fixture provider's rights declaration, and the shape rule its reference
 * has to satisfy (PL-0301).
 *
 * Read `./environment.ts` first: the argument for why a fabricated rights basis
 * cannot exist as a value in a production runtime lives there, and everything
 * below is the second half of it.
 * ---------------------------------------------------------------------- */

/**
 * The shape an internal rights reference is allowed to have.
 *
 * A `RightsBasis` carries a CATEGORY -- `rights`, plus the `basis` KIND, both
 * closed vocabularies this package owns and checks -- and a REFERENCE. The
 * reference is an OPAQUE INTERNAL IDENTIFIER: it names a record in the
 * operator's own rights register and means nothing to anyone who does not hold
 * that register.
 *
 * IT IS OPAQUE BECAUSE THE AGREEMENTS THEMSELVES ARE NOT THIS REPOSITORY'S TO
 * CARRY. No licence body, no counterparty, no scope, no term dates and no URL
 * may be written into a rights basis. What is left is the category, which is the
 * part the engine actually enforces, plus an identifier that lets the operator
 * find the paperwork somewhere this repository cannot see. It matters downstream
 * too: `describeRightsBasis` renders the reference into a human line for reason
 * trails and logs, so whatever is written here is something a bug-report
 * screenshot can carry out of the building.
 *
 * WHAT THIS PATTERN DOES AND DOES NOT ESTABLISH, stated exactly, because a
 * comment that overclaims a check is worse than having no check. It admits only
 * lowercase alphanumeric groups joined by single hyphens, so it MECHANICALLY
 * excludes whitespace and prose, any URL (there is no `:` and no `/` in it),
 * userinfo or an address (`@`), and anything carrying capitals or punctuation.
 * It CANNOT tell whether a conforming token is a counterparty name, a date or a
 * contract title: `acme-tv-2026-emea` matches it. Those are refused by the
 * rights review, and the rule is written here so that review has one place to
 * point at.
 *
 * NOTHING PARSES OR BRANCHES ON THE VALUE. It is checked for shape and carried;
 * no code in this package splits it, reads a prefix out of it or decides
 * anything from its content. An identifier that gets interpreted has stopped
 * being an identifier, and the interpretation becomes a rights decision taken by
 * a string parser.
 *
 * A SECOND COPY OF THIS RULE EXISTS TODAY, in
 * `apps/web/src/app/api/v1/playback/session/authorized-candidates.ts`, which is
 * where the fixture provider lived before PL-0301 moved the adapter behind the
 * provider boundary. That file is outside this task's write surface, so the copy
 * is recorded rather than deleted: the follow-up is for that module to import
 * this one and drop its own, which is the entire point of the adapter being
 * here. Until it does, note the drift direction -- both are SHAPE checks that
 * refuse what they do not recognise, so a divergence makes one of them stricter
 * and neither of them permissive.
 */
export const OPAQUE_RIGHTS_REFERENCE_PATTERN = /^[a-z0-9]{2,16}(?:-[a-z0-9]{1,16}){1,7}$/;

/**
 * The longest an internal reference may be.
 *
 * A register id is short and a sentence is not, so length is the one crude
 * signal that separates them. The pattern above would otherwise admit 135
 * characters, which is long enough to hold a description.
 */
export const MAX_RIGHTS_REFERENCE_LENGTH = 64;

/**
 * Shape only -- see `OPAQUE_RIGHTS_REFERENCE_PATTERN` for what that can and
 * cannot establish, and for why nothing here reads what the token says.
 */
export function isOpaqueRightsReference(value: string): boolean {
  return value.length <= MAX_RIGHTS_REFERENCE_LENGTH && OPAQUE_RIGHTS_REFERENCE_PATTERN.test(value);
}

/**
 * The fixture provider's reference: a reserved all-zero token.
 *
 * IT NAMES NO RECORD ANYWHERE, AND THAT IS THE POINT. There is no agreement
 * covering media a fixture rig happens to be serving, so a reference that
 * pointed at one would be a fabrication in a smaller font. This token is the
 * rights-register counterpart of an RFC 2606 `.invalid` host: well formed,
 * unmistakably reserved, and impossible to confuse with a real entry.
 *
 * It is deliberately NOT prose. A reference that described where the media came
 * from, named an environment variable or cited a document would be a scope
 * description rather than an identifier, it is exactly the class of content a
 * rights basis must not carry, and `describeRightsBasis` would put the first
 * sixty characters of it into any trail that printed the basis.
 */
export const FIXTURE_RIGHTS_REFERENCE = "lty-ref-00000000-0000-0000";

/**
 * The rights class a fixture declares, and the KIND of authorization it rests
 * on.
 *
 * `owned` via `operator-owned-master` is the only pair that can honestly
 * describe a fixture rig: the operator points the provider at files they put
 * there themselves, and there is no third party to ask. It is stated as a pair
 * of module constants rather than as configuration because a configurable rights
 * class on a provider whose media nothing has inspected is a hole -- it would
 * let a caller declare `licensed` over the same unopened files and produce a
 * claim about a counterparty that does not exist.
 *
 * The pair is checked against `RIGHTS_BASES_FOR_RIGHTS` at construction rather
 * than trusted, so it is the same compatibility table `defineStremioSource`
 * applies and not a second opinion about which bases support which class.
 */
const FIXTURE_RIGHTS: ContentRights = "owned";
const FIXTURE_BASIS_KIND: RightsBasisKind = "operator-owned-master";

/**
 * Compile-time proof that a rights basis came from this module, and therefore
 * that a `NonProductionRuntime` was presented for it.
 *
 * NOT exported, on purpose: an exported brand is a forgeable brand. The only way
 * to obtain a value of this type outside this module is `fixtureRightsBasis`,
 * and the only way to call that is to hold a witness. Same mechanism, and the
 * same reasoning, as `RIGHTS_DECLARED` in `../stremio/source.ts`.
 */
const FIXTURE_RIGHTS_DECLARED: unique symbol = Symbol("liberty.fixture.rights-declared");

export interface FixtureRightsBasis extends RightsBasis {
  readonly [FIXTURE_RIGHTS_DECLARED]: true;
  /**
   * The runtime name that attested this basis into existence.
   *
   * Reported, never re-tested, and carried for the reason the witness exposes
   * its own name: something that logs or asserts WHICH runtime admitted the
   * fixtures should read the value the attestation used rather than reaching for
   * the environment a second time and possibly reporting a different one.
   *
   * It is a runtime name, not rights content, so it is not subject to the
   * opacity rule above -- and `describeRightsBasis` does not print it.
   */
  readonly attestedRuntime: string;
}

/**
 * The only constructor of a `FixtureRightsBasis`, and it cannot be called
 * without a witness.
 *
 * THIS SIGNATURE IS THE CONTROL. See `./environment.ts` for the whole argument;
 * the short form is that the fabricated `owned` declaration below is a value
 * that CANNOT BE BUILT in a production runtime, rather than a value that is
 * built and then withheld. Nothing here is a runtime `if` that a later edit can
 * delete and still compile.
 *
 * It THROWS on a self-inconsistent constant rather than returning a reason. The
 * three inputs are literals in this file: a failure here is a programming error
 * in a rights-critical module, not a configuration mistake somebody can act on,
 * and there is no honest basis object to hand back for one. That is the same
 * distinction `defineStremioSource` (data, because configuration is expected to
 * be wrong) and `assertRightsRemainEvidenced` (throw, because reaching it is a
 * bug) already draw.
 *
 * All three checks are reachable in exactly one circumstance -- somebody editing
 * the constants above -- and that is what they are for. An edit that replaces
 * the reserved token with a sentence, a URL or a counterparty's name fails at
 * construction instead of publishing that string into a reason trail.
 */
export function fixtureRightsBasis(runtime: NonProductionRuntime): FixtureRightsBasis {
  // Membership of the contract's playable allowlist, read from the one place
  // that owns it rather than restated here.
  assertAuthorizedRights(FIXTURE_RIGHTS);

  const permitted = RIGHTS_BASES_FOR_RIGHTS[FIXTURE_RIGHTS];
  if (!permitted.includes(FIXTURE_BASIS_KIND)) {
    throw new Error(
      `refusing to build a fixture rights basis: rights ${JSON.stringify(FIXTURE_RIGHTS)} cannot ` +
        `rest on ${JSON.stringify(FIXTURE_BASIS_KIND)}; permitted bases are ${permitted.join(", ")}`
    );
  }

  if (!isOpaqueRightsReference(FIXTURE_RIGHTS_REFERENCE)) {
    throw new Error(
      "refusing to build a fixture rights basis: its reference is not an opaque internal " +
        "identifier, and a rights declaration nobody may read out loud is not one worth serving"
    );
  }

  return {
    [FIXTURE_RIGHTS_DECLARED]: true,
    rights: FIXTURE_RIGHTS,
    basis: FIXTURE_BASIS_KIND,
    reference: FIXTURE_RIGHTS_REFERENCE,
    attestedRuntime: runtime.name
  };
}
