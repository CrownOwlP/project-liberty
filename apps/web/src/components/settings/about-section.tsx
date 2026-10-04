import packageJson from "../../../package.json";

import styles from "./settings.module.css";

/* -------------------------------------------------------------------------
 * What this build is, and what it owes other people (PW-0308)
 *
 * ==========================================================================
 * THE VERSION IS IMPORTED, NOT TYPED
 * ==========================================================================
 *
 * `package.json`'s own `version`, read at build time. A literal here would be
 * a second copy of a number that changes on every release, and the copy that
 * drifted would be the one on the screen telling a viewer -- and anybody
 * diagnosing their problem -- the wrong thing.
 *
 * WHAT THIS CLAIM IS, EXACTLY. It is the version this web build DECLARES. It
 * is not a proof that the running application is that version, which is a
 * different and harder claim: PW-0502 is "Updates, and a version the
 * application can prove", and it owns that. Saying "declared" here rather
 * than implying the stronger thing is the whole difference, and the text says
 * so to the viewer.
 *
 * A SERVER COMPONENT, so importing `package.json` costs the browser nothing.
 * The file names every dependency this application has, and shipping it into
 * a client bundle to render one string would publish the dependency list of
 * a media application to anybody who opens developer tools.
 *
 * ==========================================================================
 * THE LICENCES ARE AN OBLIGATION, NOT A COURTESY
 * ==========================================================================
 *
 * PW-0308's acceptance puts it plainly: this is "where PW-0208's LGPL
 * attribution obligation is discharged in the product". An LGPL component --
 * which is what a media application's decoding stack tends to be -- requires
 * that the recipient be TOLD, and a notices file sitting in an installer
 * directory that nobody opens is a weaker discharge than a screen that names
 * it.
 *
 * WHAT THIS SECTION DOES NOT DO IS CLAIM THE FILE IS THERE. PW-0208 is the
 * task that proves the packaged tree actually carries THIRD-PARTY-NOTICES.md,
 * and it is still in review precisely because inspecting the real package is
 * the hard part. So this names the file, says where it belongs, and does not
 * assert that a given install has it -- a product that cheerfully reported a
 * notices file it had never looked for would be making the attribution
 * problem worse, not better.
 * ---------------------------------------------------------------------- */

/** The notices file the installer is required to carry. Named by PW-0208. */
export const NOTICES_FILE_NAME = "THIRD-PARTY-NOTICES.md";

export function AboutSection() {
  return (
    <section className="section" aria-labelledby="settings-about">
      <h2 id="settings-about">About</h2>

      <dl className={styles.facts}>
        <dt>Application</dt>
        <dd>Project Liberty</dd>
        <dt>Version</dt>
        {/*
          `data-testid` so a test can assert the rendered string is the one
          `package.json` holds, rather than asserting a literal that would
          have to be edited on every release -- which is the drift this whole
          component avoids.
        */}
        <dd data-testid="about-version">{packageJson.version}</dd>
      </dl>

      <p className={styles.hint}>
        That is the version this build declares. Proving that a running installation is the
        version it says it is — and updating it — is separate work and is not claimed here.
      </p>

      <h3>Open-source licences</h3>
      <p>
        Project Liberty is built on open-source software, and some of it is licensed on terms
        that require you to be told about it and to be able to read the licence. The desktop
        installer carries those notices as <code>{NOTICES_FILE_NAME}</code>, generated from the
        dependency tree that is actually packaged rather than from a list somebody maintained
        by hand.
      </p>
      <p className={styles.hint}>
        This screen names the file; it does not inspect your installation. Verifying that a
        built package really contains it is part of the packaging work and is deliberately not
        something this page claims to have done.
      </p>
    </section>
  );
}
