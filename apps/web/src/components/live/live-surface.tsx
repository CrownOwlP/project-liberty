/* -------------------------------------------------------------------------
 * THE LIVE TV SURFACE (Wave 132, Worker E).
 *
 * A SERVER COMPONENT WITH NO LOGIC IN IT. Every decision on this screen was made
 * by `./live-page-data.ts` and is asserted by `live-page-data.test.ts`, because
 * `apps/web/vitest.config.ts` sets `environment: "node"` and this repository
 * therefore cannot render a component in a test at all. So this file is a
 * function from `LivePageModel` to JSX: it switches on `model.status`, which is a
 * discriminated union, and the switch is TOTAL — a sixth state added to the model
 * fails the build here rather than rendering a blank panel in front of somebody.
 *
 * WHAT IT SAYS IN THE SHIPPED CONFIGURATION, WHICH IS THE POINT OF THE SCREEN:
 * that this installation has no licensed live feed, that live acquisition is
 * PL-0602 and blocked on licensed feed access, and that the answer will not
 * change by retrying. It shows no channel art, no placeholder grid, no synthetic
 * fixtures and no "coming soon" teaser, because `docs/CONTENT_RIGHTS.md` is a
 * boundary and a channel list a viewer can see is a channel list this project
 * claims to carry. `UNCONFIGURED` IS NOT AN ERROR STATE AND IS NOT STYLED AS
 * ONE: nothing is broken, the feature is honestly absent, and the panel says so
 * in the vocabulary `components/browse/browse-surface.tsx` established for
 * "no metadata source is configured".
 *
 * NO CLIENT BOUNDARY. The group filter is a set of links and the search is a GET
 * form, so the whole surface is a server render and the filter survives a reload
 * — the same arrangement `browse-surface.tsx` uses. Favourites are rendered from
 * state that is PASSED IN and cannot be toggled here: a toggle needs a client
 * component and a store, and `lib/livetv/epg-cache.ts` records which durable
 * homes exist and why none is wired. A star that did nothing would be worse than
 * no star, so the indicator appears only for channels already favourited.
 * ---------------------------------------------------------------------- */
import { UNGROUPED_LABEL } from "../../lib/livetv/channels";
import { describeStreamFailure } from "../../lib/livetv/stream-errors";
import styles from "./live.module.css";
import type { LivePageModel } from "./live-page-data";

export const LIVE_PATH = "/live";

function Unconfigured({ detail }: { readonly detail: string | null }) {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>Live TV is not available on this installation</h2>
        <p>{describeStreamFailure("feed_not_configured")}</p>
        <p>
          Project Liberty carries live channels only from a feed it is licensed to carry. No such
          feed is configured here, so there are no channels to list — not an empty list, and not a
          list we are hiding. Nothing is wrong with your account.
        </p>
        {detail === null ? null : <p className="code state-detail">{detail}</p>}
      </div>
    </section>
  );
}

function EpgRefused({ refusal, detail }: { readonly refusal: string; readonly detail: string }) {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>This installation&apos;s guide data could not be read</h2>
        <p>
          A live feed is configured, and the schedule document it supplied was refused rather than
          partially read. Retrying will not change the answer; the remedy belongs to an operator.
        </p>
        <p className="code state-detail">
          {refusal}: {detail}
        </p>
      </div>
    </section>
  );
}

function NoAuthorizedChannels({
  rejectedByReason
}: {
  readonly rejectedByReason: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
}) {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>No channel on this feed is one we may carry</h2>
        <p>
          A live feed is configured and every entry in its playlist was refused. The most common
          cause is that the feed states no rights basis for its channels, which is a refusal rather
          than a failure: a channel with no established basis is not a channel this platform may
          list.
        </p>
        <ul>
          {rejectedByReason.map((entry) => (
            <li className="code" key={entry.reason}>
              {entry.reason}: {entry.count}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function LiveSurface({ model }: { readonly model: LivePageModel }) {
  if (model.status === "unconfigured") return <Unconfigured detail={model.detail} />;
  if (model.status === "epg_refused") {
    return <EpgRefused detail={model.detail} refusal={model.refusal} />;
  }
  if (model.status === "no_authorized_channels") {
    return <NoAuthorizedChannels rejectedByReason={model.rejectedByReason} />;
  }

  return (
    <>
      <section aria-labelledby="live-heading" className="section">
        <div className="section-head">
          <h1 className={styles.heading} id="live-heading">
            Live TV
          </h1>
        </div>
        <p className={styles.summary} id="live-summary">
          {model.rows.length} of {model.rows.length + model.filteredOut} authorized channels from{" "}
          {model.providerLabel}.
        </p>
        <div className={styles.filters}>
          <a className={styles.groupLink} href={LIVE_PATH}>
            All
          </a>
          {model.groups.map((group) => (
            <a
              aria-current={group.selected ? "true" : undefined}
              className={
                group.selected ? `${styles.groupLink} ${styles.groupLinkSelected}` : styles.groupLink
              }
              href={`${LIVE_PATH}?group=${encodeURIComponent(group.key)}`}
              key={group.key}
            >
              {group.label === UNGROUPED_LABEL ? UNGROUPED_LABEL : group.label} ({group.count})
            </a>
          ))}
        </div>
        <form action={LIVE_PATH} className={styles.filters} method="get">
          <label htmlFor="live-q">Search channels</label>
          <input defaultValue={model.query} id="live-q" name="q" type="search" />
          <button type="submit">Search</button>
        </form>
      </section>

      <section aria-labelledby="live-channels-heading" className="section">
        <h2 id="live-channels-heading">Channels</h2>
        {model.rows.length === 0 ? (
          <div className="state-panel">
            <h3>No authorized channel matches this filter</h3>
            <p>
              The feed has channels, just not these ones. <a href={LIVE_PATH}>See all channels</a>.
            </p>
          </div>
        ) : (
          <ul className={styles.channels}>
            {model.rows.map((row) => (
              <li className={styles.channel} key={row.channel.id}>
                <span className={styles.channelName}>{row.channel.displayName}</span>
                <span className={styles.channelGroup}>{row.groupLabel}</span>
                {row.favourite ? <span className={styles.favourite}>Favourite</span> : null}
                {row.nowLabel === null ? null : <span className={styles.now}>Now: {row.nowLabel}</span>}
                {row.nextLabel === null ? null : (
                  <span className={styles.next}>Next: {row.nextLabel}</span>
                )}
                {row.idleExplanation === null ? null : (
                  <span className={styles.idle}>{row.idleExplanation}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {model.rejectedByReason.length === 0 && model.droppedListings === 0 ? null : (
        <section aria-labelledby="live-diagnostics-heading" className="section">
          <h2 id="live-diagnostics-heading">What this feed did not admit</h2>
          {/*
            * SHOWN, NOT SWALLOWED. A refused entry never appears as a channel row
            * in any styling — a greyed-out row is still a bundled channel — but
            * the COUNTS are visible, because a feed that silently admits 3 of 400
            * entries looks identical to a feed with 3 channels.
            */}
          <div className={styles.diagnostics}>
            <ul>
              {model.rejectedByReason.map((entry) => (
                <li className="code" key={entry.reason}>
                  {entry.reason}: {entry.count}
                </li>
              ))}
              {model.droppedListings === 0 ? null : (
                <li className="code">
                  listings_for_unheld_channels: {model.droppedListings}
                </li>
              )}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
