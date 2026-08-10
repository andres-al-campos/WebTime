#!/bin/bash
# build.sh - Build WebTime extension with automatic testing

set -e  # Exit immediately if a command fails

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
    echo "📦 Packaging Firefox extension..."
    npx web-ext build --source-dir extension --artifacts-dir artifacts --overwrite-dest
else
    echo ""
    echo "❌ Tests failed! Build aborted."
    exit 1
fi

# Both loadable directories are now refreshed in place — reload from the
# browser's extensions page to pick up this build. Neither browser can be
# made to reload from out here, so the paths are printed instead.
echo ""
echo "✅ Loadable directories refreshed:"
echo "   Firefox (MV2):  $(pwd)/extension"
echo "   Chrome  (MV3):  $(pwd)/dist-chrome"
echo ""
echo "   Chrome: chrome://extensions → Developer mode → Load unpacked → dist-chrome"
echo ""
echo "   To test a change: hit reload ⟳ on the card. That's all —"
echo "   open tabs get the new content script automatically, no page refresh."
