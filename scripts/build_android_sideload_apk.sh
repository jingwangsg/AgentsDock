#!/bin/zsh
# Builds the Android sideload package for a local install, signed with the project's debug keystore:
#   mobile-react/build/AgentsDock-<version>-<version code>-sideload.apk
#
# Usage: scripts/build_android_sideload_apk.sh [--no-bump]
#
# Each run takes the next version code in mobile-react/app.json and in the two contract tests that pin it, so two
# packages never share a version code; --no-bump builds the current version code again. After a failed build, run
# again with --no-bump. The script does not commit: commit those three files once the package is accepted.
#
# It needs the generated project in mobile-react/android, and Homebrew's openjdk@17 and Android command-line tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/mobile-react"
GRADLE_FILE="$PROJECT/android/app/build.gradle"
TESTS=(tests/android-platform-contract.test.mjs tests/android-updater-contract.test.mjs)

BUMP=1
case "${1:-}" in
  '') ;;
  --no-bump) BUMP=0 ;;
  *) echo "Usage: $0 [--no-bump]" >&2; exit 2 ;;
esac

[[ -f "$GRADLE_FILE" ]] || {
  echo "mobile-react/android is not generated: run \`pnpm exec expo prebuild --platform android\` in mobile-react first." >&2
  exit 2
}

cd "$PROJECT"

CODE="$(node -p "require('./app.json').expo.android.versionCode")"
[[ "$CODE" == <-> ]] || { echo "mobile-react/app.json has no numeric expo.android.versionCode: $CODE" >&2; exit 1 }
if (( BUMP )); then
  NEXT=$(( CODE + 1 ))
  /usr/bin/sed -i '' "s/\"versionCode\": $CODE,/\"versionCode\": $NEXT,/" app.json
  [[ "$(node -p "require('./app.json').expo.android.versionCode")" == "$NEXT" ]] || {
    echo "Could not set the version code to $NEXT: mobile-react/app.json has no line \"versionCode\": $CODE, to rewrite." >&2
    exit 1
  }
  /usr/bin/sed -i '' "s/assert.equal(config.android.versionCode, $CODE)/assert.equal(config.android.versionCode, $NEXT)/" $TESTS
  CODE="$NEXT"
fi
for TEST in $TESTS; do
  grep -qF "assert.equal(config.android.versionCode, $CODE)" "$TEST" || {
    echo "mobile-react/$TEST does not pin version code $CODE: it needs the line assert.equal(config.android.versionCode, $CODE)." >&2
    exit 1
  }
done
VERSION="$(node -p "require('./app.json').expo.version")"

# load-bearing: gradle reads the version code from the generated build.gradle, which git ignores and a change of
# app.json does not reach. Without this line the package keeps the previous version code under the new file name.
/usr/bin/sed -i '' -E "s/^([[:space:]]+versionCode) [0-9]+$/\1 $CODE/" "$GRADLE_FILE"

# Fixed, not taken from the environment: a JAVA_HOME that names another JDK would change the build.
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
# The debug keystore of the generated project: every local sideload build so far carries its certificate, and
# Android refuses to install a package over one signed with another. Gradle refuses release tasks without the four.
export AGENTSDOCK_ANDROID_KEYSTORE_PATH="$PROJECT/android/app/debug.keystore"
export AGENTSDOCK_ANDROID_KEYSTORE_PASSWORD=android
export AGENTSDOCK_ANDROID_KEY_ALIAS=androiddebugkey
export AGENTSDOCK_ANDROID_KEY_PASSWORD=android

(cd android && ./gradlew --no-daemon -q assembleSideloadRelease)

# The package gets its name once checked: gradle takes the version and the version code from build.gradle.
BUILT="$PROJECT/android/app/build/outputs/apk/sideload/release/app-sideload-release.apk"
BUILD_TOOLS=("$ANDROID_HOME"/build-tools/*)
BADGE="$("${BUILD_TOOLS[-1]}/aapt2" dump badging "$BUILT" | /usr/bin/sed -n 1p)"
[[ "$BADGE" == *"versionCode='$CODE' versionName='$VERSION'"* ]] || {
  echo "The built package is not version $VERSION with version code $CODE; mobile-react/android/app/build.gradle sets both. It reports: $BADGE" >&2
  exit 1
}
mkdir -p "$PROJECT/build"
cp "$BUILT" "$PROJECT/build/AgentsDock-$VERSION-$CODE-sideload.apk"

echo "Built $PROJECT/build/AgentsDock-$VERSION-$CODE-sideload.apk"
