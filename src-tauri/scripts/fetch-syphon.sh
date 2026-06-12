#!/usr/bin/env bash
# Vendor Syphon.framework (macOS GPU texture sharing) into
# src-tauri/vendor/Syphon.framework. build.rs runs this automatically on
# macOS builds when the framework is missing; it is safe to run by hand.
#
# Why build from source? The official prebuilt releases
# (https://github.com/Syphon/Syphon-Framework/releases) stop at SDK 5 (2019),
# which is x86_64-only and predates the Metal server API entirely. We need
# SyphonMetalServer on arm64, so we compile a pinned commit of the framework
# with plain clang (works with Command Line Tools alone — no Xcode needed).
# The one .metal shader normally precompiled into default.metallib needs the
# Metal toolchain we don't have, so the build patches the renderer to compile
# that shader from source at runtime instead (shipped in Resources/).
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="vendor"
FRAMEWORK="$DEST/Syphon.framework"

# Pinned Syphon-Framework commit (post-Metal, universal-buildable).
SYPHON_REPO="https://github.com/Syphon/Syphon-Framework.git"
SYPHON_REF="71351d4b484cd2d1917867f7846a5cdca724552d"
SYPHON_VERSION="5"

if [ -e "$FRAMEWORK/Syphon" ]; then
  echo "Syphon.framework already vendored at src-tauri/$FRAMEWORK"
  exit 0
fi

for tool in git clang codesign python3; do
  command -v "$tool" >/dev/null || {
    echo "error: '$tool' is required to vendor Syphon.framework" >&2
    exit 1
  }
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Fetching Syphon-Framework@${SYPHON_REF:0:12}..."
SRC="$TMP/src"
mkdir -p "$SRC"
git -C "$SRC" init -q
git -C "$SRC" remote add origin "$SYPHON_REPO"
git -C "$SRC" fetch -q --depth 1 origin "$SYPHON_REF" || {
  echo "error: could not fetch Syphon-Framework from GitHub (network down?)" >&2
  exit 1
}
git -C "$SRC" checkout -q FETCH_HEAD

echo "Patching Metal shader loading (runtime compile, no Metal toolchain)..."
python3 - "$SRC/SyphonServerRendererMetal.m" <<'EOF'
import sys
path = sys.argv[1]
src = open(path).read()
old = "        id<MTLLibrary> defaultLibrary = [device newDefaultLibraryWithBundle:bundle error:&error];"
if old not in src:
    sys.exit("error: SyphonServerRendererMetal.m anchor line not found — update the patch in fetch-syphon.sh")
new = """        // Vizzy vendored build: built without the Metal toolchain, so the
        // shader library is compiled at runtime from source in Resources/.
        NSString *syphonShaderPath = [bundle pathForResource:@"SyphonMetalShaders" ofType:@"metal"];
        NSString *syphonShaderSource = syphonShaderPath ? [NSString stringWithContentsOfFile:syphonShaderPath encoding:NSUTF8StringEncoding error:&error] : nil;
        id<MTLLibrary> defaultLibrary = syphonShaderSource ? [device newLibraryWithSource:syphonShaderSource options:nil error:&error] : nil;"""
open(path, "w").write(src.replace(old, new))
EOF

echo "Compiling universal Syphon dylib (arm64 + x86_64)..."
mkdir -p "$SRC/_inc"
ln -sfn "$SRC" "$SRC/_inc/Syphon"
(
  cd "$SRC"
  clang -arch arm64 -arch x86_64 -dynamiclib -fobjc-arc -O2 \
    -DNDEBUG -DSYPHON_CORE_SHARE -DGL_SILENCE_DEPRECATION \
    -Wno-deprecated-declarations \
    -mmacosx-version-min=11.0 \
    -include Syphon_Prefix.pch -I _inc \
    -install_name @rpath/Syphon.framework/Versions/A/Syphon \
    -compatibility_version 1 -current_version "$SYPHON_VERSION" \
    -framework Cocoa -framework Foundation -framework Metal \
    -framework IOSurface -framework OpenGL -framework CoreVideo \
    -o "$TMP/Syphon" ./*.m ./*.c
)

echo "Assembling framework bundle..."
V="$TMP/Syphon.framework/Versions/A"
mkdir -p "$V/Headers" "$V/Resources" "$V/Modules"
cp "$TMP/Syphon" "$V/Syphon"
PUBLIC_HEADERS="Syphon.h SyphonServerDirectory.h SyphonMetalServer.h SyphonMetalClient.h \
  SyphonOpenGLServer.h SyphonOpenGLClient.h SyphonOpenGLImage.h SyphonServerBase.h \
  SyphonClientBase.h SyphonImageBase.h SyphonServer.h SyphonClient.h SyphonImage.h \
  SyphonSubclassing.h"
for h in $PUBLIC_HEADERS; do cp "$SRC/$h" "$V/Headers/"; done
cp "$SRC/Syphon.modulemap" "$V/Modules/module.modulemap"
# Runtime shader compilation cannot resolve relative #includes, so inline the
# one local header into the shipped shader source.
python3 - "$SRC" "$V/Resources/SyphonMetalShaders.metal" <<'EOF'
import sys
src_dir, out = sys.argv[1], sys.argv[2]
shader = open(f"{src_dir}/SyphonMetalShaders.metal").read()
types = open(f"{src_dir}/SyphonServerMetalTypes.h").read()
inc = '#include "SyphonServerMetalTypes.h"'
if inc not in shader:
    sys.exit("error: SyphonMetalShaders.metal include anchor not found — update fetch-syphon.sh")
open(out, "w").write(shader.replace(inc, types))
EOF
sed -e 's/${EXECUTABLE_NAME}/Syphon/' \
    -e 's/${PRODUCT_NAME}/Syphon/' \
    -e 's/$(PRODUCT_BUNDLE_IDENTIFIER)/info.v002.Syphon/' \
    "$SRC/Info.plist" > "$V/Resources/Info.plist"
ln -sfn A "$TMP/Syphon.framework/Versions/Current"
for link in Syphon Headers Resources Modules; do
  ln -sfn "Versions/Current/$link" "$TMP/Syphon.framework/$link"
done

codesign --force --sign - "$TMP/Syphon.framework"

mkdir -p "$DEST"
rm -rf "$FRAMEWORK"
mv "$TMP/Syphon.framework" "$FRAMEWORK"

if [ ! -e "$FRAMEWORK/Syphon" ]; then
  echo "error: vendored framework has no Syphon binary" >&2
  exit 1
fi
echo "Vendored src-tauri/$FRAMEWORK"
