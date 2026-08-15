import type { CatalogItem } from "@liberty/contracts";
import { formatCatalogMeta } from "../lib/catalog";

export interface CatalogCardProps {
  item: CatalogItem;
}

export function CatalogCard({ item }: CatalogCardProps) {
  return (
    <article className="card">
      <div className="poster" aria-hidden="true" />
      <h3>{item.title}</h3>
      <p>{formatCatalogMeta(item)}</p>
    </article>
  );
}
