import Link from "next/link";
import { SearchForm } from "../../components/search/search-form";
import { SearchResultList } from "../../components/search/search-results";
import styles from "../../components/search/search.module.css";
import { describeSearchState, loadSearchResults, readSearchQueryParam } from "./search";

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

function SearchUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel" role="alert">
        <h2>We couldn&apos;t run that search</h2>
        <p>
          The search service didn&apos;t return a usable response. Nothing is wrong with your
          account — try again in a moment.
        </p>
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
        <SearchForm initialQuery={query} />
      </section>

      {/*
        One live region, rendered in every state and never conditionally, so the
        browser has it before the text inside it changes — a region that appears
        together with its message is frequently not announced at all. This is
        the only way a screen-reader user learns that results changed under a
        search field they are still focused on.
      */}
      <p aria-live="polite" className="visually-hidden" role="status">
        {describeSearchState(result)}
      </p>

      {result.status === "idle" && <SearchIdle />}
      {result.status === "error" && <SearchUnavailable reason={result.reason} />}
      {result.status === "empty" && <SearchEmpty query={result.query} />}
      {result.status === "ok" && <SearchResultList response={result.response} />}
    </main>
  );
}
