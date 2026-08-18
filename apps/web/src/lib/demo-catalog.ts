import type { CatalogItem } from "@liberty/contracts/domains/catalog";

/**
 * Fictional development fixtures. These are original titles created for this
 * project, so they carry `owned` rights — no third-party catalog metadata is
 * reproduced here. They are replaced by an authorized provider adapter in
 * PL-0301; nothing downstream should assume this module exists in production.
 */
export const demoCatalog: readonly CatalogItem[] = [
  {
    id: "aurora-fall",
    title: "Aurora Fall",
    kind: "movie",
    rights: "owned",
    genre: "Sci-fi",
    releaseYear: 2024,
    runtimeMinutes: 128,
    episodeCount: null
  },
  {
    id: "signal-zero",
    title: "Signal Zero",
    kind: "movie",
    rights: "owned",
    genre: "Thriller",
    releaseYear: 2023,
    runtimeMinutes: 114,
    episodeCount: null
  },
  {
    id: "deep-current",
    title: "Deep Current",
    kind: "movie",
    rights: "owned",
    genre: "Documentary",
    releaseYear: 2025,
    runtimeMinutes: 52,
    episodeCount: null
  },
  {
    id: "northstar",
    title: "Northstar",
    kind: "series",
    rights: "owned",
    genre: "Drama",
    releaseYear: 2024,
    runtimeMinutes: null,
    episodeCount: 8
  },
  {
    id: "open-skies",
    title: "Open Skies",
    kind: "movie",
    rights: "owned",
    genre: "Adventure",
    releaseYear: 2022,
    runtimeMinutes: 107,
    episodeCount: null
  },
  {
    id: "harbor-lights",
    title: "Harbor Lights",
    kind: "series",
    rights: "owned",
    genre: "Mystery",
    releaseYear: 2025,
    runtimeMinutes: null,
    episodeCount: 6
  }
];
