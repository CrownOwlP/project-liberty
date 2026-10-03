import type { CatalogRail as CatalogRailModel } from "@liberty/contracts/domains/catalog";
import { CatalogCard } from "./catalog-card";
import { RovingGroup } from "../lib/a11y/roving-group";

export interface CatalogRailProps {
  rail: CatalogRailModel;
}

export function CatalogRail({ rail }: CatalogRailProps) {
  return (
    <section className="section" aria-labelledby={`rail-${rail.id}`}>
      <div className="section-head">
        <h2 id={`rail-${rail.id}`}>{rail.title}</h2>
        <small>
          {rail.items.length} {rail.items.length === 1 ? "title" : "titles"}
        </small>
      </div>
      {/*
        ARROW KEYS ACROSS THE RAIL, NOT FIFTEEN TABS (PW-0310).

        Each card carries a heading link and, where the id is one the list can
        hold, a My List control -- so a five-card rail was up to ten tab stops
        and the home page renders several of them. `RovingGroup` renders this
        same `div.rail` and changes nothing until it has hydrated; see
        `lib/a11y/roving-group.tsx` for the shape and `lib/a11y/roving.ts` for
        every decision it makes.
      */}
      <RovingGroup as="div" className="rail" itemNoun="titles in this row">
        {rail.items.map((item) => (
          <CatalogCard key={item.id} item={item} />
        ))}
      </RovingGroup>
    </section>
  );
}
