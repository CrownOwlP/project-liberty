import Link from "next/link";
import type { TitleDetail, TitleDetailKind } from "@liberty/contracts/domains/title";
import {
  NO_SYNOPSIS_LABEL,
  formatTitleMeta,
  resolveTitlePlayAvailability,
  titleHref
} from "../../app/title/title-detail";
import { PlayCta } from "./play-cta";
import { WatchlistControl } from "../watchlist/watchlist-control";
import styles from "./title.module.css";

const KIND_LABEL: Readonly<Record<TitleDetailKind, string>> = {
  movie: "Film",
  series: "Series",
  episode: "Episode"
};

/**
 * The series CTA can legitimately land on an episode that is not the first one,
 * because an earlier episode may not have cleared the rights gate. The label
 * therefore promises "available" rather than "first", so it never describes the
 * link as something it is not.
 */
const PLAY_LABEL: Readonly<Record<TitleDetailKind, string>> = {
  movie: "Play",
  series: "Play first available episode",
  episode: "Play episode"
};

export interface TitleHeroProps {
  detail: TitleDetail;
}

export function TitleHero({ detail }: TitleHeroProps) {
  const availability = resolveTitlePlayAvailability(detail);

  return (
    <section className="hero">
      <div className="hero-copy">
        <div className="eyebrow">{KIND_LABEL[detail.kind]}</div>
        <h1 className={styles.heroTitle}>{detail.title}</h1>
        <p>{formatTitleMeta(detail)}</p>
        <p>{detail.synopsis ?? NO_SYNOPSIS_LABEL}</p>

        {/*
         * The only navigation an episode page exists for, so it gets a stated
         * focus indicator rather than the user agent's — see `title.module.css`.
         */}
        {detail.kind === "episode" ? (
          <p>
            <Link className={styles.focusRing} href={titleHref(detail.seriesId)}>
              All of {detail.seriesTitle}
            </Link>
          </p>
        ) : null}

        <PlayCta availability={availability} label={PLAY_LABEL[detail.kind]} />

        {/*
          * MY LIST SITS BESIDE PLAY, NOT INSTEAD OF IT (PW-0304).
          *
          * It is rendered for every kind, including an episode, because the
          * list is a list of things a household means to watch and an episode
          * is one of those. It is NOT gated on `availability`: whether a title
          * can be played right now and whether someone wants to keep it are
          * different questions, and hiding the control on an unavailable title
          * would remove the one affordance that still makes sense there.
          *
          * It is a client component and this file is not. That boundary is the
          * same one `account-region.tsx` opens and for the same reason -- it
          * reads the viewer's own list, and a server component that did the
          * same would make every title page dynamic.
          */}
        <WatchlistControl contentId={detail.id} />
      </div>
    </section>
  );
}
