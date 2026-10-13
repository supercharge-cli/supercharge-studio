#!/usr/bin/env bash
# Sign the unsigned APKs of a published release with your own keystore and upload the signed
# copies to the same release (for when the signing secrets are not set in GitHub Actions).
#   scripts/sign-release.sh v0.1.3 [keystore] [password-file] [alias]
set -euo pipefail
TAG=${1:?usage: sign-release.sh <tag> [keystore] [password-file] [alias]}
KS=${2:-$HOME/.supercharge-studio-keys/release.jks}
PW=${3:-$HOME/.supercharge-studio-keys/password.txt}
ALIAS=${4:-supercharge-studio}
BT=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* | sort -V | tail -1)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
gh release download "$TAG" --pattern '*-unsigned.apk' --dir "$work"
for f in "$work"/*-unsigned.apk; do
  out="$work/$(basename "${f%-unsigned.apk}").apk"
  "$BT/zipalign" -f -p 4 "$f" "$work/aligned.apk"
  "$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PW" --ks-key-alias "$ALIAS" --out "$out" "$work/aligned.apk"
  "$BT/apksigner" verify "$out"
  echo "signed $(basename "$out") ($(du -h "$out" | cut -f1))"
done
rm -f "$work"/*-unsigned.apk "$work/aligned.apk" "$work"/*.idsig
gh release upload "$TAG" "$work"/*.apk --clobber
