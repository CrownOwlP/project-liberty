import type { TitleTechnicalMetadata } from "@liberty/contracts/domains/title";
import { formatLanguageList, formatMaxHeight } from "../../app/title/title-detail";

export interface TitleFactsProps {
  technical: TitleTechnicalMetadata;
}

/**
 * Presentation facts, including the ones nobody has stated.
 *
 * Unreported rows are rendered as "Not reported" rather than hidden, and that
 * is the whole point of the component. Hiding a row leaves the reader to
 * assume a default, and printing a plausible default is worse still: it turns
 * "we have not checked whether this plays in 4K" into "this plays in 4K". An
 * empty reported list is a different sentence again — "None" is a fact, "Not
 * reported" is a gap.
 */
export function TitleFacts({ technical }: TitleFactsProps) {
  return (
    <section className="section" aria-labelledby="title-facts">
      <div className="section-head">
        <h2 id="title-facts">Presentation</h2>
      </div>
      <div className="state-panel">
        <p>
          <strong>Maximum resolution:</strong> {formatMaxHeight(technical.maxHeight)}
        </p>
        <p>
          <strong>Audio languages:</strong> {formatLanguageList(technical.audioLanguages)}
        </p>
        <p>
          <strong>Subtitle languages:</strong> {formatLanguageList(technical.subtitleLanguages)}
        </p>
      </div>
    </section>
  );
}
