import type { CatalogRail as CatalogRailModel } from "@liberty/contracts";
import { CatalogCard } from "./catalog-card";

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
      <div className="rail">
        {rail.items.map((item) => (
          <CatalogCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
