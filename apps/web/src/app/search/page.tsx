import Link from "next/link";
import { SearchForm } from "../../components/search/search-form";
import { SearchResultList } from "../../components/search/search-results";
import styles from "../../components/search/search.module.css";
import {
  CATALOG_SOURCE_NOT_CONFIGURED_REASON,
  describeSearchState,
  loadSearchResults,
  readSearchQueryParam
} from "./search";

/**
 * Rendered per request. The query lives in the URL, so a prerendered page would
 * serve one query's results at every other query's address — and the loading
 * state below could never appear.
 */
export const revalidate = 0;

function SearchIdle() {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>Search the catalog</h2>
        <p>
          Start typing to find a film or series by title or genre. Your search stays in the
          address bar, so you can share or bookmark it.
        </p>
      </div>
    </section>
  );
}

function SearchEmpty({ query }: { query: string }) {
  return (
    <section className="section">
      <div className="state-panel">
        {/* The query is a React text node here, so it is escaped on render. */}
        <h2>No titles match &ldquo;{query}&rdquo;</h2>
        <p>
          Nothing in the available catalog matches that search. Try a shorter search, a
          different spelling, or a genre such as Drama.
        </p>
      </div>
    </section>
  );
}

/**
 * The failure state, and deliberately NOT a live region.
 *
 * This panel used to carry `role="alert"`, which is implicitly assertive. The
 * form below renders the one polite region for this surface, so in the failure
 * state both fired: assertive interrupts polite, and an alert announces its
 * whole subtree — so what the user actually heard was the heading, the apology
 * and the raw `search_source_unavailable` reason code, on top of the one
 * sentence written to explain the state. One region announcing
 * "Search is currently unavailable." is the coherent version of that, and it is
 * the sentence `describeSearchState` already derives on the server.
 *
 * Nothing is lost by dropping the role. This panel only ever appears as part of
 * a server render, and an alert whose content is present when the region is
 * first inserted is frequently not announced by assistive technology anyway; it
 * remains a heading and body text that a reader reaches normally.
 *
 * TWO SENTENCES FOR TWO FAILURES, because "try again in a moment" is FALSE for
 * one of them. `catalog_source_not_configured` means this process has no catalog
 * metadata source at all — retrying will produce the identical refusal forever,
 * and the remedy belongs to an operator rather than to the reader. Telling a
 * user to retry something that cannot succeed is the same class of defect as
 * telling them nothing matched a search that never ran. The heading and the
 * reason line are shared, so the panel is one panel; only the explanation
 * branches.
 */
function SearchUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>We couldn&apos;t run that search</h2>
        {reason === CATALOG_SOURCE_NOT_CONFIGURED_REASON ? (
          <p>
            This deployment has no catalog to search — no metadata source is configured for it.
            Nothing is wrong with your account, and retrying will not change the answer until an
            operator configures one.
          </p>
        ) : (
          <p>
            The search service didn&apos;t return a usable response. Nothing is wrong with your
            account — try again in a moment.
          </p>
        )}
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

/**
 * There is no `error.tsx` in this segment on purpose: `loadSearchResults`
 * converts every expected failure into the handled `error` state above, and the
 * root boundary from PL-0101 already covers anything genuinely unexpected.
 */
export default async function SearchPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = readSearchQueryParam(params.q);
  const result = await loadSearchResults(query);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          <Link href="/">Home</Link>
        </nav>
        <div className="status">Search</div>
      </header>

      <section className="section" aria-labelledby="search-heading">
        <div className="section-head">
          <h1 className={styles.heading} id="search-heading">
            Search
          </h1>
        </div>
        {/*
          The live region that announces what happened to the results is
          rendered by the form, not here. It has to describe the in-flight state
          as well as the settled one, and only the client component knows a
          navigation is running; a second region here would compete with it for
          the same announcement. The sentence itself is still derived on the
          server, so every state — including `idle` and `error` — has one and it
          stays unit-tested.

          "One region" is a rule about this whole page, not about this file:
          `role="alert"` counts, which is why `SearchUnavailable` above no longer
          has one. Anything added below that announces state changes has to go
          through `describeSearchState` and this region instead.
        */}
        <SearchForm initialQuery={query} statusMessage={describeSearchState(result)} />
      </section>

      {result.status === "idle" && <SearchIdle />}
      {result.status === "error" && <SearchUnavailable reason={result.reason} />}
      {result.status === "empty" && <SearchEmpty query={result.query} />}
      {result.status === "ok" && <SearchResultList response={result.response} />}
    </main>
  );
}
