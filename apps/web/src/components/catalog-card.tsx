export interface CatalogCardProps {
  title: string;
  meta: string;
}

export function CatalogCard({ title, meta }: CatalogCardProps) {
  return (
    <article className="card">
      <div className="poster" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{meta}</p>
    </article>
  );
}
