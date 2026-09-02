#!/bin/bash
# release.sh - Tag a version and publish its build to GitHub Releases.
#
# Reads the version from extension/manifest.json (single source of truth),
# refuses to run on a dirty/unpushed tree, refuses to clobber an existing
# release, builds fresh, and attaches both store packages (Firefox MV2 and
# Chrome MV3 -- the two stores need different manifests, so two zips).

set -euo pipefail

cd "$(dirname "$0")"

# --- Version: the one source of truth is the manifest ---
VERSION=$(node -e "console.log(require('./extension/manifest.json').version)")
TAG="v${VERSION}"
ARTIFACT_FF="artifacts/web_time-${VERSION}.zip"
ARTIFACT_CHROME="artifacts/web_time-chrome-${VERSION}.zip"

echo "🔖 Releasing version ${VERSION} (tag ${TAG})"

# --- Refuse to release uncommitted work ---
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working tree is dirty. Commit or stash your changes first," >&2
  echo "   so the release tag matches exactly what is committed." >&2
  exit 1
fi

# --- Refuse to release work that isn't on GitHub yet ---
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch origin "$BRANCH" --quiet
if [ -n "$(git log "origin/${BRANCH}..HEAD" --oneline)" ]; then
  echo "❌ Local commits are not pushed to origin/${BRANCH}." >&2
  echo "   Run: git push origin ${BRANCH}" >&2
  exit 1
fi

# --- Refuse to clobber an existing release ---
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "❌ Release ${TAG} already exists. Bump the version in" >&2
  echo "   extension/manifest.json (and package.json) before releasing." >&2
  exit 1
fi

# --- Build fresh (typecheck + tests + package) ---
# WEBTIME_DEBUG=0 compiles out the debug trace. A normal ./build.sh leaves it on
# for development, so without this the published add-on would log every tab
# switch and tick to users' consoles.
echo ""
echo "🏗  Building a fresh artifact..."
WEBTIME_DEBUG=0 ./build.sh

for artifact in "$ARTIFACT_FF" "$ARTIFACT_CHROME"; do
  if [ ! -f "$artifact" ]; then
    echo "❌ Expected artifact not found: ${artifact}" >&2
    echo "   The build did not produce the file release.sh expects." >&2
    echo "   Check the packaging steps at the end of build.sh." >&2
    exit 1
  fi
done

# --- Tag and publish ---
echo ""
echo "🚀 Creating GitHub release ${TAG}..."
gh release create "$TAG" "$ARTIFACT_FF" "$ARTIFACT_CHROME" \
  --title "WebTime ${VERSION}" \
  --generate-notes

echo ""
echo "✅ Released ${TAG} → $(gh release view "$TAG" --json url -q .url)"
