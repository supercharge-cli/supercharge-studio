# Store packages

Release files have fixed names, so each store package only needs a new tag in the URL and a new sha256 per release. `SHA256SUMS` on every release lists them.

## Flathub (`packaging/flatpak`)

- App id `in.superchargeai.Studio`. Flathub verifies ownership of `superchargeai.in` after listing (a token served at `https://superchargeai.in/.well-known/org.flathub.VerifiedApps.txt`).
- Runtime: GNOME 51 (webkit2gtk-4.1 + libsoup-3). The tray library comes from Flathub's `shared-modules` (git submodule named `shared-modules`).
- Local build:
  ```
  cd packaging/flatpak
  git clone --depth 1 https://github.com/flathub/shared-modules
  flatpak-builder --user --force-clean --install build in.superchargeai.Studio.yml
  ```
- Start at login is disabled inside the sandbox (see `background.rs`); keep-running/tray still works.
- Submit: fork `flathub/flathub`, branch from `new-pr`, add the manifest, desktop file, metainfo and the `shared-modules` submodule, open a PR against `new-pr`. A real screenshot must exist at the URL in the metainfo first.
- Each release: update `url` + `sha256` in the manifest and add a `<release>` entry to the metainfo, then PR to `flathub/in.superchargeai.Studio`.

## winget (`packaging/winget/<version>`)

- Id `Supercharge.SuperchargeStudio`, MSI installer.
- Each release: copy the folder to the new version, update `PackageVersion`, `InstallerUrl`, `InstallerSha256` and `ProductCode` (`msiinfo export <msi> Property | grep ProductCode`).
- Submit: fork `microsoft/winget-pkgs`, put the files in `manifests/s/Supercharge/SuperchargeStudio/<version>/`, open a PR. `wingetcreate update` can automate later versions.

### Automatic winget updates

The `winget` job in `.github/workflows/release.yml` runs after `publish` and submits the new version with `wingetcreate update`. It skips with a notice when:

- the repo secret `WINGET_TOKEN` is missing, or
- `Supercharge.SuperchargeStudio` isn't merged into winget-pkgs yet (the first version must be merged by hand).

To enable it: from the R3AP3Reditz account, create a classic personal access token (Settings → Developer settings → Personal access tokens → Tokens (classic)) with only the `public_repo` scope, then save it in this repo under Settings → Secrets and variables → Actions as `WINGET_TOKEN`. The update PRs are opened from that account's winget-pkgs fork.
