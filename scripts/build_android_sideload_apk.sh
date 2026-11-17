#!/bin/zsh
# Builds the Android sideload package for a local install, signed with the project's debug keystore:
#   mobile-react/build/AgentsDock-<version>-<version code>-sideload.apk
#
# Usage: scripts/build_android_sideload_apk.sh [--no-bump]
#
# Each run takes the next version code in mobile-react/app.json and in the two contract tests that pin it, so two
# packages never share a code; --no-bump builds the current code again. The script does not commit: commit those
# three files once the package is accepted.
#
# It needs the generated project in mobile-react/android (`expo prebuild --platform android --no-install`), a
# JDK 17 and the Android SDK. JAVA_HOME and ANDROID_HOME default to the Homebrew locations.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/mobile-react"
GRADLE_FILE="$PROJECT/android/app/build.gradle"

BUMP=1
case "${1:-}" in
  '') ;;
  --no-bump) BUMP=0 ;;
  *) echo "Usage: $0 [--no-bump]" >&2; exit 64 ;;
esac

[[ -f "$GRADLE_FILE" ]] || {
  echo "mobile-react/android is not generated: run \`expo prebuild --platform android --no-install\` in mobile-react first." >&2
  exit 66
}

cd "$PROJECT"

CODE="$(node -p "require('./app.json').expo.android.versionCode")"
[[ "$CODE" == <-> ]] || { echo "mobile-react/app.json has no numeric expo.android.versionCode: $CODE" >&2; exit 65 }
if (( BUMP )); then
  NEXT=$(( CODE + 1 ))
  /usr/bin/sed -i '' "s/\"versionCode\": $CODE,/\"versionCode\": $NEXT,/" app.json
  /usr/bin/sed -i '' "s/assert.equal(config.android.versionCode, $CODE)/assert.equal(config.android.versionCode, $NEXT)/" \
    tests/android-platform-contract.test.mjs tests/android-updater-contract.test.mjs
  CODE="$(node -p "require('./app.json').expo.android.versionCode")"
  [[ "$CODE" == "$NEXT" ]] || { echo "Could not set expo.android.versionCode to $NEXT in mobile-react/app.json." >&2; exit 65 }
fi
VERSION="$(node -p "require('./app.json').expo.version")"
PACKAGE="$PROJECT/build/AgentsDock-$VERSION-$CODE-sideload.apk"

# load-bearing: gradle reads the version code from the generated build.gradle, which git ignores and a change of
# app.json does not reach. Without this line the package keeps the previous code under the new file name.
/usr/bin/sed -i '' -E "s/^([[:space:]]+versionCode) [0-9]+$/\1 $CODE/" "$GRADLE_FILE"

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
# The debug keystore of the generated project: every local sideload build so far carries its certificate, and
# Android refuses to install a package over one signed with another. Gradle refuses release tasks without the four.
export AGENTSDOCK_ANDROID_KEYSTORE_PATH="$PROJECT/android/app/debug.keystore"
export AGENTSDOCK_ANDROID_KEYSTORE_PASSWORD=android
export AGENTSDOCK_ANDROID_KEY_ALIAS=androiddebugkey
export AGENTSDOCK_ANDROID_KEY_PASSWORD=android

(cd android && ./gradlew --no-daemon -q assembleSideloadRelease)

mkdir -p "$PROJECT/build"
cp "$PROJECT/android/app/build/outputs/apk/sideload/release/app-sideload-release.apk" "$PACKAGE"

BUILD_TOOLS=("$ANDROID_HOME"/build-tools/*(N/))
(( ${#BUILD_TOOLS} )) || { echo "No Android build-tools under $ANDROID_HOME." >&2; exit 69 }
PACKED="$("${BUILD_TOOLS[-1]}/aapt2" dump badging "$PACKAGE" | /usr/bin/sed -n "1s/.*versionCode='\([0-9]*\)'.*/\1/p")"
[[ "$PACKED" == "$CODE" ]] || { echo "$PACKAGE holds version code $PACKED, not $CODE." >&2; exit 1 }
"${BUILD_TOOLS[-1]}/apksigner" verify "$PACKAGE"

echo "Built $PACKAGE"
