#!/bin/bash
# build.sh - Build WebTime extension with automatic testing

set -e  # Exit immediately if a command fails

# ./build.sh check: the tests (which hold the laws, e.g. the clock-gate order)
# and the doctor (the built extension loads and its clock runs). Builds nothing,
# so run plain ./build.sh first after a change.
if [ "${1:-}" = "check" ]; then
    npm test
    npm run drive -- --doctor
    exit
fi

# extension/manifest.json is the single source of truth for the version;
# manifest-chrome.mjs derives the MV3 manifest from it, so both zips below
# carry the same number without it being written down twice.
VERSION=$(node -e "console.log(require('./extension/manifest.json').version)")

echo "🔷 Compiling TypeScript..."
npm run build

# Archive any previously-built zips into old_versions/ so artifacts/
# only ever holds the build we're about to make.
echo ""
echo "🗄  Archiving previous builds to old_versions/..."
mkdir -p artifacts/old_versions
shopt -s nullglob
for zip in artifacts/*.zip; do
    mv "$zip" artifacts/old_versions/
    echo "   moved $(basename "$zip")"
done
shopt -u nullglob

echo ""
echo "🧪 Running tests..."
echo ""
npm test

if [ $? -eq 0 ]; then
    echo ""
    echo "📦 Packaging Firefox extension (MV2)..."
    npx web-ext build --source-dir extension --artifacts-dir artifacts --overwrite-dest

    # Chrome gets its own zip. The stores take different packages -- Chrome
    # rejects MV2 outright, and extension/manifest.json carries Firefox-only
    # keys -- so one artifact cannot serve both. Same version, from the same
    # source of truth, with -chrome in the name to tell them apart.
    echo ""
    echo "📦 Packaging Chrome extension (MV3)..."
    CHROME_ZIP="web_time-chrome-${VERSION}.zip"
    # -x excludes junk Finder leaves behind; the store rejects a zip whose
    # top level is a wrapper directory, so this zips from inside dist-chrome.
    (cd dist-chrome && zip -r -q "../artifacts/${CHROME_ZIP}" . -x '.DS_Store' -x '__MACOSX/*')
    echo "   Your extension is ready: artifacts/${CHROME_ZIP}"
else
    echo ""
    echo "❌ Tests failed! Build aborted."
    exit 1
fi

# Both loadable directories are now refreshed in place — reload from the
# browser's extensions page to pick up this build. Neither browser can be
# made to reload from out here, so the paths are printed instead.
echo ""
echo "✅ Store packages:"
echo "   Firefox (MV2):  artifacts/web_time-${VERSION}.zip"
echo "   Chrome  (MV3):  artifacts/web_time-chrome-${VERSION}.zip"
echo ""
echo "✅ Loadable directories refreshed:"
echo "   Firefox (MV2):  $(pwd)/extension"
echo "   Chrome  (MV3):  $(pwd)/dist-chrome"
echo ""
echo "   Chrome: chrome://extensions → Developer mode → Load unpacked → dist-chrome"
echo ""
echo "   To test a change: hit reload ⟳ on the card. That's all —"
echo "   open tabs get the new content script automatically, no page refresh."
