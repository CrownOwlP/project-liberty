import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project Liberty",
  description: "A fast, rights-aware media platform foundation."
};

/*
 * THE ROOT LAYOUT STILL DOES NOT RENDER THE CHROME, AND THAT IS DELIBERATE
 * (PW-0301).
 *
 * The obvious move is to put `<AppShell>` here and delete it from every page.
 * It is refused for one concrete reason: the shell needs the CURRENT PATHNAME to
 * mark where the viewer is, a root layout in the App Router is not re-rendered
 * on navigation and is not given the path, and the only ways to get it are a
 * `usePathname()` hook -- which would make the entire application a client
 * boundary -- or reading `headers()`, which opts every route into dynamic
 * rendering whether it needed to or not.
 *
 * So the shell is a COMPONENT each page renders with its own path, and the
 * duplication that remains is one import and one prop rather than twenty lines
 * of copied markup with drifting contents. `shell-usage.test.ts` fails if a
 * route goes back to hand-rolling a header.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
