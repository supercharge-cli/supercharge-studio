#!/usr/bin/env bash
# Generate packaging/aur/out/{PKGBUILD,.SRCINFO} for supercharge-studio-bin.
#   scripts/aur.sh <version> <deb file> [source url]
# Without a URL the deb is referenced locally (used by CI to validate with makepkg).
set -euo pipefail
ver=$1 deb=$2
url=${3:-}
here=$(cd "$(dirname "$0")/.." && pwd)
out=$here/packaging/aur/out
mkdir -p "$out"
sum=$(sha256sum "$deb" | cut -d' ' -f1)
if [ -n "$url" ]; then src="supercharge-studio-$ver.deb::$url"; else cp "$deb" "$out/"; src=$(basename "$deb"); fi
sed -e "s|@VERSION@|$ver|" -e "s|@SHA256@|$sum|" -e "s|@SOURCE@|$src|" "$here/packaging/aur/PKGBUILD.in" > "$out/PKGBUILD"
if command -v makepkg >/dev/null && [ "$(id -u)" != 0 ]; then
  (cd "$out" && makepkg --printsrcinfo > .SRCINFO)
  echo "$out"; exit 0
fi
# Fallback when makepkg is unavailable (CI regenerates it with makepkg).
{
  echo "pkgbase = supercharge-studio-bin"
  echo "	pkgdesc = Lightweight desktop app for the Supercharge coding agent (ACP client)"
  echo "	pkgver = $ver"
  echo "	pkgrel = 1"
  echo "	url = https://github.com/iotserver24/supercharge-studio"
  echo "	arch = x86_64"
  echo "	license = Apache-2.0"
  echo "	depends = webkit2gtk-4.1"
  echo "	depends = gtk3"
  echo "	depends = hicolor-icon-theme"
  echo "	optdepends = supercharge: the Supercharge CLI (the app can also install it)"
  echo "	provides = supercharge-studio"
  echo "	conflicts = supercharge-studio"
  echo "	options = !strip"
  echo "	options = !debug"
  echo "	source = $src"
  echo "	sha256sums = $sum"
  echo ""
  echo "pkgname = supercharge-studio-bin"
} > "$out/.SRCINFO"
echo "$out"
