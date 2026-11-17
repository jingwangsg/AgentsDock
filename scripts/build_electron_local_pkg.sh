#!/bin/zsh
# Builds the Apple-silicon installer package for a local install, without notarization:
#   electron/dist/AgentsDock-<version>-<build number>-mac-arm64.pkg
# electron-builder signs the app only when the keychain holds a "Developer ID Application" identity; without one
# the app carries an ad-hoc signature.
#
# Usage: scripts/build_electron_local_pkg.sh [--no-bump]
#
# Each run takes the next build number in electron/package.json, so two packages never share a number;
# --no-bump builds the current number again. After a failed build, run again with --no-bump. The script does not
# commit: commit electron/package.json once the package is accepted.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"

BUMP=1
case "${1:-}" in
  '') ;;
  --no-bump) BUMP=0 ;;
  *) echo "Usage: $0 [--no-bump]" >&2; exit 2 ;;
esac

cd "$PROJECT"

BUILD="$(node -p "require('./package.json').build.buildVersion")"
[[ "$BUILD" == <-> ]] || { echo "electron/package.json has no numeric build.buildVersion: $BUILD" >&2; exit 1 }
if (( BUMP )); then
  NEXT=$(( BUILD + 1 ))
  /usr/bin/sed -i '' "s/\"buildVersion\": \"$BUILD\"/\"buildVersion\": \"$NEXT\"/" package.json
  [[ "$(node -p "require('./package.json').build.buildVersion")" == "$NEXT" ]] || {
    echo "Could not set the build number to $NEXT: electron/package.json has no line \"buildVersion\": \"$BUILD\" to rewrite." >&2
    exit 1
  }
  BUILD="$NEXT"
fi
VERSION="$(node -p "require('./package.json').version")"
PACKAGE="$PROJECT/dist/AgentsDock-$VERSION-$BUILD-mac-arm64.pkg"

# electron-builder runs `pnpm list` itself: with corepack alone there is no pnpm on PATH, and the build fails at
# its last step with "spawn pnpm ENOENT".
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/agentsdock-local-pkg.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
if ! command -v pnpm >/dev/null; then
  corepack enable --install-directory "$SCRATCH" pnpm
  export PATH="$SCRATCH:$PATH"
fi

pnpm build:icon
pnpm build

# load-bearing: electron-builder has ended with status 0 without writing the package. A package of this build
# number from an earlier run, which --no-bump builds over, would then pass for the new one.
rm -f "$PACKAGE"
# --publish never: the configured publish target is a GitHub draft release.
# load-bearing: resetAdHocDarwinSignature. Without a signing identity electron-builder skips signing, but flipping
# the fuses rewrites a page of Electron Framework: its linker signature becomes invalid and arm64 macOS kills the
# app at launch.
node_modules/.bin/electron-builder --mac pkg --arm64 --publish never \
  -c.pkg.artifactName='${productName}-${version}-${buildVersion}-mac-${arch}.${ext}' \
  -c.electronFuses.resetAdHocDarwinSignature=true
[[ -f "$PACKAGE" ]] || { echo "electron-builder ended without writing $PACKAGE." >&2; exit 1 }

# The package returns to dist/ once checked: a failed check leaves none under this build number.
mv "$PACKAGE" "$SCRATCH/candidate.pkg"
/usr/sbin/pkgutil --expand-full "$SCRATCH/candidate.pkg" "$SCRATCH/expanded"
APP=("$SCRATCH"/expanded/*.pkg/Payload/AgentsDock.app)
/usr/bin/codesign --verify --deep --strict "${APP[1]}"
PACKED="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP[1]}/Contents/Info.plist")"
[[ "$PACKED" == "$BUILD" ]] || { echo "The package holds build number $PACKED, not $BUILD." >&2; exit 1 }
mv "$SCRATCH/candidate.pkg" "$PACKAGE"

echo "Built $PACKAGE"
