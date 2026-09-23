"use client";

/* -------------------------------------------------------------------------
 * Who is watching (PW-0303).
 *
 * THE BACKEND FOR THIS SCREEN HAS BEEN COMPLETE AND REVIEWED SINCE PL-0402 AND
 * NOTHING RENDERED IT. `/api/v1/profiles` and `/api/v1/profiles/selection` have
 * handlers, a five-outcome contract, a closed reason vocabulary and tests, and
 * until this file there was no picker, no switch, no create and no avatar
 * anywhere in the application -- while every progress and watchlist row in the
 * product is profile-scoped. A viewer could not see, choose or change the
 * identity their entire continue-watching list is keyed by.
 *
 * FIVE OUTCOMES ARE RENDERED AS FIVE OUTCOMES. The contract draws a remedy
 * distinction between `refused` ("retrying changes nothing") and `unavailable`
 * ("retrying later is sometimes reasonable"), and collapsing them into one
 * "something went wrong" would throw away the only information the viewer can
 * act on. `unavailable` with `authentication_not_configured` is the state a
 * deployment reaches today, and it is shown as exactly that rather than as an
 * empty household -- PW-0403 is the task that removes it, and a screen that hid
 * it would make its absence invisible.
 *
 * THE LIST IS NEVER SORTED HERE. `profilesResponseSchema` states oldest-first as
 * part of the contract, and gives the reason: a picker is muscle memory and a
 * household aims at the tile its profile has always been on. Re-sorting on the
 * client would be a second ordering authority that is free to disagree with the
 * published one.
 *
 * SWITCHING RELOADS RATHER THAN UPDATES IN PLACE. After a successful selection
 * this component re-lists from the server AND calls `router.refresh()`, because
 * every server-rendered profile-scoped view above it -- continue watching, the
 * watchlist rail -- was rendered for the previous profile and is now wrong.
 * Setting `activeProfileId` locally would make the picker agree with itself
 * while the rest of the page showed another profile's rows, which is the exact
 * state this task's acceptance forbids.
 * ---------------------------------------------------------------------- */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { ProfileView } from "../../app/api/v1/profiles/contract";
import { avatarStyle, profileInitial } from "./avatar";
import {
  createProfile,
  listProfiles,
  reasonDetails,
  selectProfile,
  type ProfilesCallResult
} from "./profiles-client";

/**
 * What the screen is doing, as one value.
 *
 * A single state rather than the four booleans this would otherwise be
 * (`loading`, `error`, `submitting`, `creating`), because four booleans admit
 * twelve combinations that cannot happen and the one that eventually does is a
 * spinner over an error message. The states below are mutually exclusive by
 * construction.
 */
type PickerState =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready";
      readonly profiles: readonly ProfileView[];
      readonly activeProfileId: string | null;
      /** Non-empty while a selection or a create is in flight; the tile shows it. */
      readonly pending: string | null;
    }
  | { readonly phase: "failed"; readonly heading: string; readonly details: readonly string[] };

/**
 * Turn any call result into the next state.
 *
 * ONE FUNCTION FOR ALL THREE CALLS, so the failure rendering cannot drift
 * between "listing failed" and "selecting failed". `listed` is the only outcome
 * that carries a list, so the other four are failures *of this screen* even when
 * they are successes of the API: a `created` or `selected` response is always
 * followed by a re-list, and is therefore never passed to this function.
 */
function stateFromList(result: ProfilesCallResult): PickerState {
  if (result.kind !== "answered") {
    return {
      phase: "failed",
      heading:
        result.kind === "unreachable"
          ? "We couldn't reach the profile service"
          : "The profile service returned something we don't understand",
      details: reasonDetails(result)
    };
  }

  const response = result.response;
  if (response.outcome === "listed") {
    return {
      phase: "ready",
      profiles: response.profiles,
      activeProfileId: response.activeProfileId,
      pending: null
    };
  }

  return {
    phase: "failed",
    heading:
      response.outcome === "unavailable"
        ? "Profiles aren't available right now"
        : "We can't show profiles for this session",
    details: reasonDetails(result)
  };
}

export function ProfilePicker() {
  const router = useRouter();
  const [state, setState] = useState<PickerState>({ phase: "loading" });
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [createFailure, setCreateFailure] = useState<readonly string[] | null>(null);

  const reload = useCallback(async () => {
    setState(stateFromList(await listProfiles()));
  }, []);

  /*
   * THE FIRST LIST, WITH AN UNMOUNT GUARD.
   *
   * Written as an async closure inside the effect rather than as `void reload()`
   * for two reasons, and only one of them is the lint rule. `live` is the real
   * one: a viewer who selects a profile and lands on a new screen before the
   * list resolves would otherwise have `setState` called on an unmounted
   * component. `reload` is deliberately NOT in the dependency list and cannot
   * change -- it is a `useCallback` with an empty dependency array -- so this
   * effect runs exactly once.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const result = stateFromList(await listProfiles());
      if (live) setState(result);
    })();
    return () => {
      live = false;
    };
  }, []);

  const choose = useCallback(
    async (profileId: string) => {
      setState((current) =>
        current.phase === "ready" ? { ...current, pending: profileId } : current
      );
      const result = await selectProfile(profileId);
      if (result.kind === "answered" && result.response.outcome === "selected") {
        /*
         * RE-LIST FIRST, THEN REFRESH. The re-list gives this component the
         * server's own view of which profile is now active -- rather than
         * assuming the one we asked for -- and `router.refresh()` re-renders
         * every server component above, which is what actually clears another
         * profile's rows off the screen.
         */
        await reload();
        router.refresh();
        return;
      }
      setState(stateFromList(result));
    },
    [reload, router]
  );

  const submitCreate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreateFailure(null);
      /*
       * `avatarKey` and `maxRating` are sent as explicit `null`. The schema is
       * `.strict()` and both are required-and-nullable, so omitting them is a
       * malformed request -- and `null` is the true statement anyway: this form
       * collects neither, because there is no avatar store yet (PW-0302) and no
       * ratings vocabulary on this screen.
       */
      const result = await createProfile({
        displayName: draftName,
        avatarKey: null,
        maxRating: null
      });
      if (result.kind === "answered" && result.response.outcome === "created") {
        setDraftName("");
        setCreating(false);
        await reload();
        router.refresh();
        return;
      }
      /*
       * A FAILED CREATE DOES NOT REPLACE THE SCREEN. The household's existing
       * profiles are still valid and still selectable; losing them because a new
       * name was too long would be a worse answer than the refusal itself. The
       * server's reasons are shown against the form.
       */
      setCreateFailure(reasonDetails(result));
    },
    [draftName, reload, router]
  );

  if (state.phase === "loading") {
    return (
      <section className="profiles" aria-busy="true">
        <h1>Who&apos;s watching?</h1>
        <p className="profiles-note">Loading profiles…</p>
      </section>
    );
  }

  if (state.phase === "failed") {
    return (
      <section className="profiles">
        <h1>Who&apos;s watching?</h1>
        <div className="profiles-failure" role="alert">
          <h2>{state.heading}</h2>
          <ul>
            {state.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  const { profiles, activeProfileId, pending } = state;

  return (
    <section className="profiles">
      <h1>Who&apos;s watching?</h1>
      {profiles.length === 0 ? (
        <p className="profiles-note">
          This account has no profiles yet. Create one to start watching.
        </p>
      ) : null}

      <ul className="profile-grid">
        {profiles.map((profile) => {
          const active = profile.id === activeProfileId;
          const initial = profileInitial(profile.displayName);
          return (
            <li key={profile.id}>
              <button
                type="button"
                className="profile-tile"
                aria-current={active ? "true" : undefined}
                aria-busy={pending === profile.id ? "true" : undefined}
                disabled={pending !== null}
                onClick={() => {
                  void choose(profile.id);
                }}
              >
                <span className="profile-avatar" style={avatarStyle(profile)} aria-hidden="true">
                  {initial}
                </span>
                <span className="profile-name">{profile.displayName}</span>
                {/*
                  * The active marker is TEXT, not only a border. A ring alone is
                  * invisible to a screen reader and invisible again to anybody
                  * in high-contrast mode, where custom borders are frequently
                  * overridden. `aria-current` above carries it to assistive
                  * technology; this carries it to everyone else.
                  */}
                {active ? <span className="profile-active">Watching as</span> : null}
              </button>
            </li>
          );
        })}
      </ul>

      {creating ? (
        <form className="profile-create" onSubmit={submitCreate}>
          <label htmlFor="profile-display-name">Profile name</label>
          <input
            id="profile-display-name"
            name="displayName"
            value={draftName}
            autoComplete="off"
            onChange={(event) => {
              setDraftName(event.target.value);
            }}
          />
          {createFailure === null ? null : (
            <ul className="profiles-failure" role="alert">
              {createFailure.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          <div className="profile-create-actions">
            <button type="submit" className="button button-primary">
              Create profile
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setCreating(false);
                setCreateFailure(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setCreating(true);
          }}
        >
          Add a profile
        </button>
      )}
    </section>
  );
}
