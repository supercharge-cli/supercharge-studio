# Releases

`.github/workflows/release.yml` builds every app and publishes them as one GitHub Release.
It runs when you push a `v*` tag, or manually (Actions → Release → Run workflow, with a tag
input that is created if it does not exist).

Every asset has a fixed, versionless name, so the latest build is always at
`https://github.com/supercharge-cli/supercharge-studio/releases/latest/download/<name>`.
The version lives inside the packages (deb/rpm/msi metadata, app bundle) and in the tag.
The publish job fails if any asset name contains a version number.

## Stable download URLs

Base: `https://github.com/supercharge-cli/supercharge-studio/releases/latest/download/`

| Asset | Name | Built on |
|---|---|---|
| Linux AppImage | `Supercharge-Studio-linux-x86_64.AppImage` | ubuntu-22.04 |
| Debian / Ubuntu | `supercharge-studio-linux-amd64.deb` | ubuntu-22.04 |
| Fedora / openSUSE | `supercharge-studio-linux-x86_64.rpm` | ubuntu-22.04 |
| macOS (Apple silicon + Intel) | `Supercharge-Studio-macos-universal.dmg` | macos |
| Windows installer | `Supercharge-Studio-windows-x64-setup.exe` | windows |
| Windows MSI | `Supercharge-Studio-windows-x64.msi` | windows |
| Android (all ABIs) | `supercharge-studio-android-universal.apk` | ubuntu |
| Android per ABI | `supercharge-studio-android-arm64.apk`, `-arm.apk`, `-x86_64.apk` | ubuntu |
| Headless server | `supercharge-studio-server-linux-x86_64`, `-linux-arm64`, `-macos-arm64`, `-windows-x64.exe` | native runners |
| Server systemd unit | `supercharge-studio-server.service` | ubuntu |
| iOS simulator build (unsigned) | `supercharge-studio-ios-simulator.zip` | macos |
| AUR | `PKGBUILD`, `SRCINFO.txt` | archlinux container |
| Checksums | `SHA256SUMS` | |

Without signing secrets the APKs are published as `supercharge-studio-android-<abi>-unsigned.apk`;
`scripts/sign-release.sh` uploads the signed copies under the stable names above.

The AUR `PKGBUILD` pins the tag (`releases/download/vX.Y.Z/supercharge-studio-linux-amd64.deb`)
and saves it as `supercharge-studio-X.Y.Z.deb`, so each AUR version stays reproducible.

## Android signing (optional)

Without these secrets the workflow publishes `*-unsigned.apk`. Add them under
Settings → Secrets and variables → Actions to get signed APKs (zipalign + `apksigner sign`
+ `apksigner verify`):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | `base64 -w0 release.jks` |
| `ANDROID_KEYSTORE_PASS` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (default `supercharge-studio`) |
| `ANDROID_KEY_PASS` | key password (defaults to the keystore password) |

Set them from the machine that holds the keystore (nothing is printed):

```sh
base64 -w0 ~/.supercharge-studio-keys/release.jks | gh secret set ANDROID_KEYSTORE_B64
gh secret set ANDROID_KEYSTORE_PASS < ~/.supercharge-studio-keys/password.txt
gh secret set ANDROID_KEY_ALIAS --body supercharge-studio
```

Until then, sign a published release's APKs locally and upload the signed copies to it with
`scripts/sign-release.sh vX.Y.Z` (uses the keystore in `~/.supercharge-studio-keys/`).

Keep the keystore out of the repository. Losing it means existing installs cannot be updated.

Local signing works the same way:

```sh
BT=$ANDROID_HOME/build-tools/<version>
$BT/zipalign -f -p 4 app-arm64-release-unsigned.apk aligned.apk
$BT/apksigner sign --ks ~/.supercharge-studio-keys/release.jks \
  --ks-pass file:$HOME/.supercharge-studio-keys/password.txt --ks-key-alias supercharge-studio \
  --out supercharge-studio-android-arm64.apk aligned.apk
$BT/apksigner verify supercharge-studio-android-arm64.apk
```
