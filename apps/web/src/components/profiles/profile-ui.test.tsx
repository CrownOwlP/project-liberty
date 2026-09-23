import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../shell/app-shell";
import { PRIMARY_NAVIGATION } from "../shell/navigation";
import { ActiveProfileBadge } from "./active-profile-badge";
import { ProfilePicker } from "./profile-picker";

/**
 * This suite renders with `react-dom/server` and reads source.
 *
 * WHY BOTH. There is no DOM and no testing-library in this workspace -- the
 * vitest environment is `node` -- so an effect never runs here and no click can
 * be dispatched. `profiles-client.test.ts` already covers everything that
 * crosses the wire, which is where the security properties live. What is left
 * for this file is the two things a transport test cannot see: what the FIRST
 * paint contains, and structural rules about the components that a later edit
 * could quietly break. Source assertions are stated as rules with a non-vacuity
 * check beside them, the pattern `shell-usage.test.ts` established.
 */

/*
 * `useRouter` throws outside a mounted app router, and there is no router in a
 * node test. The stub is the smallest thing that satisfies the hook: `refresh`
 * is the only member this component calls, and the assertion below is that it is
 * NOT called during a render -- a refresh at first paint would reload every
 * server component on every navigation. The rule that a successful SELECTION
 * does call it is asserted against source further down, so the stub cannot make
 * that requirement pass vacuously.
 */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

async function sourceOf(file: string): Promise<string> {
  const raw = await readFile(new URL(file, import.meta.url), "utf8");
  /* Comments are stripped first: this file's own prose names the things the
   * rules forbid, and a rule that its own explanation can fail is not a rule. */
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the badge is in the shell, on every route", () => {
  it("AppShell renders the badge without being asked to", async () => {
    /*
     * The acceptance says the active profile is visible "at all times". The
     * shell takes no profile prop and no page passes one -- the badge is
     * unconditional -- so a route cannot opt out of it by forgetting an
     * argument, which is exactly how eight routes came to have eight different
     * headers before PW-0301.
     */
    const html = renderToStaticMarkup(<AppShell pathname="/">content</AppShell>);
    expect(html).toContain("profile-badge");
  });

  it("renders it on a route with a badge and on one without", () => {
    const withBadge = renderToStaticMarkup(
      <AppShell pathname="/search" badge="Preview">
        content
      </AppShell>
    );
    const without = renderToStaticMarkup(<AppShell pathname="/watch/x">content</AppShell>);
    expect(withBadge).toContain("profile-badge");
    expect(withBadge).toContain("Preview");
    expect(without).toContain("profile-badge");
  });

  it("does not add a sixth navigation entry", () => {
    /*
     * `navigation.ts` is read-only to this task. Identity is not a content
     * destination, and putting it in the nav would make `activeEntryId` have to
     * decide whether `/profiles` is "where the viewer is".
     */
    expect(PRIMARY_NAVIGATION).toHaveLength(5);
    expect(PRIMARY_NAVIGATION.map((entry) => entry.href)).not.toContain("/profiles");
  });

  it("the first paint makes no claim about the session", () => {
    /*
     * Before the list resolves the badge is an empty placeholder. Painting
     * "Choose profile" first would assert something about the session that has
     * not been established, and it would flicker to a name a moment later.
     */
    const html = renderToStaticMarkup(<ActiveProfileBadge />);
    expect(html).toContain("profile-badge-checking");
    expect(html).not.toContain("Choose profile");
    expect(html).not.toContain("Watching as");
    expect(html).not.toContain("href");
  });
});

describe("the picker's first paint", () => {
  it("is a loading state, not an empty household", () => {
    /*
     * The worst thing a profile picker can show is "you have no profiles" while
     * it is still asking. `aria-busy` carries the same fact to assistive
     * technology that the text carries to everyone else.
     */
    const html = renderToStaticMarkup(<ProfilePicker />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading profiles");
    expect(html).not.toContain("no profiles yet");
    expect(html).not.toContain("profile-tile");
  });

  it("refreshes nothing while it is still asking", () => {
    refresh.mockClear();
    renderToStaticMarkup(<ProfilePicker />);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("structural rules", () => {
  it("the picker never sorts, reverses or re-orders the served list", async () => {
    /*
     * `profilesResponseSchema` states oldest-first as part of the contract and
     * gives the reason: a household aims at the tile its profile has always been
     * on. A client sort would be a second ordering authority.
     */
    const source = await sourceOf("./profile-picker.tsx");
    for (const forbidden of [".sort(", ".reverse(", ".toSorted(", ".toReversed("]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("profiles.map");
  });

  it("a successful selection re-lists AND refreshes rather than setting the active id locally", async () => {
    /*
     * THE ACCEPTANCE CLAUSE THIS GUARDS: switching profiles must not leave
     * another profile's rows on screen. `reload()` replaces this component's
     * idea of who is active with the server's, and `router.refresh()` re-renders
     * every server component above it. Setting `activeProfileId` from the id we
     * asked for would make the picker agree with itself while the page did not.
     */
    const source = await sourceOf("./profile-picker.tsx");
    const selected = source.indexOf('outcome === "selected"');
    expect(selected).toBeGreaterThan(-1);
    const branch = source.slice(selected, selected + 240);
    expect(branch).toContain("await reload()");
    expect(branch).toContain("router.refresh()");
    expect(branch).not.toContain("activeProfileId:");
  });

  it("no profile id is ever read from the URL, storage or a cookie", async () => {
    /*
     * PL-0405 recorded a forgeable-scope defect. The scope must come from the
     * session, so there is no client-side source of a profile id anywhere in
     * this directory -- not a query parameter, not `localStorage`, not
     * `document.cookie`.
     */
    for (const file of ["./profile-picker.tsx", "./active-profile-badge.tsx", "./profiles-client.ts"]) {
      const source = await sourceOf(file);
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "document.cookie",
        "useSearchParams",
        "URLSearchParams",
        "window.location"
      ]) {
        expect(source, `${file} must not read ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the badge shows a label for every failure and never disappears", async () => {
    /*
     * A badge that returned null when the service was down would leave the
     * topbar looking correct while the scope underneath it was unknown. Every
     * branch after `checking` returns an anchor.
     */
    const source = await sourceOf("./active-profile-badge.tsx");
    expect(source).toContain("Profile unavailable");
    expect(source).toContain("Choose profile");
    expect(source).not.toContain("return null");
  });

  it("the badge shows no reason detail, because the topbar is not a diagnostic surface", async () => {
    /*
     * Some of those details name the storage adapter. The picker shows the full
     * trail; the badge links to the picker.
     */
    const source = await sourceOf("./active-profile-badge.tsx");
    expect(source).not.toContain("reasonDetails");
    expect(source).toContain('href={PROFILES_HREF}');
  });

  it("the picker renders the server's reasons rather than inventing copy", async () => {
    const source = await sourceOf("./profile-picker.tsx");
    expect(source).toContain("reasonDetails(result)");
    /* Refused and unavailable are told apart, per the contract's remedy split. */
    expect(source).toContain('outcome === "unavailable"');
  });

  it("a failed create does not discard the household's existing profiles", async () => {
    /*
     * Losing a working picker because a new name was too long is a worse answer
     * than the refusal. The create failure goes to its own state, never to the
     * screen-replacing one.
     */
    const source = await sourceOf("./profile-picker.tsx");
    const submit = source.indexOf("submitCreate");
    expect(submit).toBeGreaterThan(-1);
    const body = source.slice(submit, source.indexOf("[draftName", submit));
    expect(body).toContain("setCreateFailure(reasonDetails(result))");
    expect(body).not.toContain('phase: "failed"');
  });

  it("every effect that sets state guards against unmount", async () => {
    for (const file of ["./profile-picker.tsx", "./active-profile-badge.tsx"]) {
      const source = await sourceOf(file);
      const effects = source.match(/useEffect\(/g) ?? [];
      const guards = source.match(/let live = true;/g) ?? [];
      expect(guards.length, `${file} guards every effect`).toBe(effects.length);
      expect(effects.length).toBeGreaterThan(0);
    }
  });
});
