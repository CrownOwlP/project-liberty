import Link from "next/link";
import type { TitleDetail, TitleDetailKind } from "@liberty/contracts/domains/title";
import {
  NO_SYNOPSIS_LABEL,
  formatTitleMeta,
  resolveTitlePlayAvailability,
  titleHref
} from "../../app/title/title-detail";
import { PlayCta } from "./play-cta";
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

        {detail.kind === "episode" ? (
          <p>
            <Link href={titleHref(detail.seriesId)}>All of {detail.seriesTitle}</Link>
          </p>
        ) : null}

        <PlayCta availability={availability} label={PLAY_LABEL[detail.kind]} />
      </div>
    </section>
  );
}
