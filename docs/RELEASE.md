# Releases

`.github/workflows/release.yml` builds every app and publishes them as one GitHub Release.
It runs when you push a `v*` tag, or manually (Actions → Release → Run workflow, with a tag
input that is created if it does not exist).

| Asset | Built on |
|---|---|
| Desktop `.deb`, `.rpm`, `.AppImage` / universal `.dmg` / `.msi` + `-setup.exe` | ubuntu-22.04 / macos / windows |
| `supercharge-studio-server-<target>` (linux x64 + arm64, macOS arm64, Windows x64) + systemd unit | native runners |
| Android APKs: per ABI (arm64, arm, x86_64) + universal | ubuntu |
| `supercharge-studio-ios-simulator.zip` (unsigned simulator `.app`) | macos |
| `SHA256SUMS.txt` | |

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
