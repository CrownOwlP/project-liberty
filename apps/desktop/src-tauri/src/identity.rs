//! Application identity, and the single place the version comes from (PW-0501).
//!
//! THE ACCEPTANCE CLAUSE THIS FILE GUARDS: "application identity -- product
//! name, publisher, icons, a version scheme derived from ONE SOURCE rather than
//! restated in three manifests."
//!
//! THE SOURCE IS `Cargo.toml`, AND THE MECHANISM IS AN ABSENCE. Tauri's config
//! documents it in one line: the app version "is a semver version number or a
//! path to a `package.json` file containing the `version` field. If removed the
//! version number from `Cargo.toml` is used." So `tauri.conf.json` carries NO
//! `version` key, and the installer's ProductVersion, the executable's file
//! version and `CARGO_PKG_VERSION` are all one number by construction rather
//! than by three people remembering.
//!
//! WHY AN ABSENCE NEEDS A TEST. A restated value that agrees today is invisible
//! -- nothing fails when somebody adds `"version": "0.2.0"` to the config and
//! forgets the crate, and the symptom is an installer that upgrades to a
//! version the running application does not report. The test below fails the
//! moment the key comes back, which is the only point at which the mistake is
//! cheap.
//!
//! WHAT IS NOT CLAIMED HERE. Nothing in this module signs anything, and
//! `publisher` is a STRING IN AN INSTALLER, not an identity anybody verified.
//! An unsigned MSI naming a publisher is exactly as unsigned as one that names
//! none; SmartScreen will say so. Signing is PW-0502's and needs an
//! owner-held certificate -- see `coordination/LAST_MILE.md` item 6.

/// The crate version, which is the version everything else derives from.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// The config as the build reads it, parsed once.
    fn config() -> Value {
        let raw = include_str!("../tauri.conf.json");
        serde_json::from_str(raw).expect("tauri.conf.json is not valid JSON")
    }

    #[test]
    fn the_version_is_not_restated_in_the_tauri_config() {
        /*
         * THE WHOLE POINT OF THE ABSENCE. With a `version` key here there are
         * two numbers -- this one and Cargo.toml's -- and nothing compares
         * them. Tauri falls back to the crate version when the key is missing,
         * so removing it does not drop the version, it elects a source.
         */
        assert!(
            config().get("version").is_none(),
            "tauri.conf.json has regained a `version` key. Remove it: Tauri falls back to \
             Cargo.toml's package version, which is the one source this project elected. \
             Restating it here creates a second number that nothing compares."
        );
    }

    #[test]
    fn the_crate_version_is_a_three_part_semver_an_msi_can_carry() {
        /*
         * NOT A STYLE CHECK. A Windows Installer ProductVersion is
         * `major.minor.build`, with a maximum of 255 for the first two fields
         * and 65535 for the third, and a value outside that range fails the
         * BUILD rather than the install. Since the crate version IS that
         * value, the constraint belongs to Cargo.toml and is asserted where
         * somebody bumping it will see the failure.
         */
        let parts: Vec<&str> = super::VERSION.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "CARGO_PKG_VERSION is `{}`; an MSI ProductVersion is major.minor.build",
            super::VERSION
        );

        let bounds = [255u32, 255, 65_535];
        for (part, max) in parts.iter().zip(bounds) {
            let value: u32 = part
                .parse()
                .unwrap_or_else(|_| panic!("`{part}` in version `{}` is not a number", super::VERSION));
            assert!(
                value <= max,
                "`{part}` in version `{}` exceeds the {max} an MSI ProductVersion field allows",
                super::VERSION
            );
        }
    }

    #[test]
    fn the_bundle_states_who_publishes_it_and_what_it_is() {
        /*
         * Every one of these ends up in front of a person: `publisher` is the
         * Manufacturer in Add/Remove Programs, `copyright` and the descriptions
         * are in the file properties dialog, and the absence of any of them
         * leaves Windows to invent something from the identifier string. The
         * assertion is that they are SET and non-empty, not what they say --
         * copy is not this test's business.
         */
        let bundle = config()["bundle"].clone();
        for field in [
            "publisher",
            "copyright",
            "shortDescription",
            "longDescription",
            "homepage",
            "category",
        ] {
            let value = bundle.get(field).and_then(Value::as_str).unwrap_or("");
            assert!(
                !value.trim().is_empty(),
                "bundle.{field} is missing or empty; Windows will substitute something derived \
                 from the identifier and a person will read it"
            );
        }
    }

    #[test]
    fn every_declared_icon_exists_on_disk() {
        /*
         * A DECLARED ICON THAT IS NOT THERE FAILS THE BUNDLE, on the runner,
         * minutes into a Windows job -- which is the most expensive minute this
         * repository spends. It is a `Path::exists` call here instead.
         *
         * The `.ico` is the one that matters most and is the one most easily
         * lost: it is what the installer, the taskbar and the executable's own
         * resource table use, and the PNGs cannot substitute for it.
         */
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let parsed = config();
        let icons = parsed["bundle"]["icon"]
            .as_array()
            .expect("bundle.icon is not an array")
            .iter()
            .map(|entry| entry.as_str().expect("an icon entry is not a string"))
            .collect::<Vec<_>>();

        assert!(
            icons.iter().any(|path| path.ends_with(".ico")),
            "no .ico among {icons:?}; Windows needs one for the executable and the installer"
        );

        for icon in icons {
            let path = here.join(icon);
            assert!(path.exists(), "bundle.icon names {icon}, which is not at {path:?}");
        }
    }

    #[test]
    fn the_bundle_targets_are_the_two_windows_installers() {
        /*
         * MSI and NSIS, both, and the pair is deliberate rather than
         * belt-and-braces. The MSI is what an administrator deploys through
         * group policy and what an enterprise inventory understands; the NSIS
         * exe is what a person downloads and double-clicks, and it is the one
         * that can install per-user without elevation. Dropping either would
         * silently remove an audience.
         */
        let targets = config()["bundle"]["targets"]
            .as_array()
            .expect("bundle.targets is not an array")
            .iter()
            .map(|entry| entry.as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();

        assert!(targets.contains(&"msi".to_string()), "no msi in {targets:?}");
        assert!(targets.contains(&"nsis".to_string()), "no nsis in {targets:?}");
    }
}
