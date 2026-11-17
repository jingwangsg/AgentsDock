#!/bin/zsh
# Builds the Apple-silicon installer package for a local install, without a Developer ID and without notarization:
#   electron/dist/AgentsDock-<version>-<build>-mac-arm64.pkg
#
# Usage: scripts/build_electron_local_pkg.sh [--no-bump]
#
# Each run takes the next build number in electron/package.json, so two packages never share a number;
# --no-bump builds the current number again. The script does not commit: commit electron/package.json once the
# package is accepted.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"

BUMP=1
case "${1:-}" in
  '') ;;
  --no-bump) BUMP=0 ;;
  *) echo "Usage: $0 [--no-bump]" >&2; exit 64 ;;
esac

cd "$PROJECT"

BUILD="$(node -p "require('./package.json').build.buildVersion")"
[[ "$BUILD" == <-> ]] || { echo "electron/package.json has no numeric build.buildVersion: $BUILD" >&2; exit 65 }
if (( BUMP )); then
  NEXT=$(( BUILD + 1 ))
  /usr/bin/sed -i '' "s/\"buildVersion\": \"$BUILD\"/\"buildVersion\": \"$NEXT\"/" package.json
  BUILD="$(node -p "require('./package.json').build.buildVersion")"
  [[ "$BUILD" == "$NEXT" ]] || { echo "Could not set build.buildVersion to $NEXT in electron/package.json." >&2; exit 65 }
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

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi
pnpm build:icon
pnpm build

rm -f "$PACKAGE"
# --publish never: the configured publish target is a GitHub draft release.
# load-bearing: resetAdHocDarwinSignature. Without a signing identity electron-builder skips signing, but flipping
# the fuses rewrites a page of Electron Framework: its linker signature becomes invalid and arm64 macOS kills the
# app at launch.
node_modules/.bin/electron-builder --mac pkg --arm64 --publish never \
  -c.pkg.artifactName='${productName}-${version}-${buildVersion}-mac-${arch}.${ext}' \
  -c.electronFuses.resetAdHocDarwinSignature=true

# electron-builder has ended with status 0 after a late failure: the file and what is in it are checked, not the status.
[[ -f "$PACKAGE" ]] || { echo "The build did not produce $PACKAGE." >&2; exit 1 }
/usr/sbin/pkgutil --expand-full "$PACKAGE" "$SCRATCH/expanded"
APPS=("$SCRATCH"/expanded/*.pkg/Payload/AgentsDock.app(N))
(( ${#APPS} == 1 )) || { echo "$PACKAGE does not hold one AgentsDock.app." >&2; exit 1 }
/usr/bin/codesign --verify --deep --strict "${APPS[1]}"
PACKED="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APPS[1]}/Contents/Info.plist")"
[[ "$PACKED" == "$BUILD" ]] || { echo "$PACKAGE holds build $PACKED, not $BUILD." >&2; exit 1 }

echo "Built $PACKAGE"
