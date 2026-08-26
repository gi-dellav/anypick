#!/usr/bin/env bash
#
# publish.sh — build and publish both the TS (npm) and Python (PyPI) packages.
#
# Prereqs:
#   - npm logged in:   npm adduser --registry https://registry.npmjs.org/
#                      (or ~/.npmrc has //registry.npmjs.org/:_authToken=...)
#   - twine installed: python -m pip install build twine
#   - PyPI token:      python -m twine login   (or ~/.pypirc)
#
# Usage:
#   ./publish.sh            # build + publish both to the public registries
#   ./publish.sh --dry-run  # build and show what WOULD be published, upload nothing
#   ./publish.sh --test     # dry-run build, then upload to Test PyPI (no live npm push)
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

# Optional overrides (also settable via env vars):
#   NPM_PACKAGE   scoped/renamed package, e.g. "@yourname/anypick"
#                 (bare 'anypick' is ALREADY taken on npm by someone else)
#   NPM_TAG       dist-tag to publish under (default: latest)
#   PYPI_REPO     PyPI upload target (default: pypi, or testpypi with --test)
NPM_PACKAGE="${NPM_PACKAGE:-anypick-ts}"
PYPI_REPO="${PYPI_REPO:-}"

DRY_RUN=false
TEST=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --test)    TEST=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# 1) Validate prerequisites
# ---------------------------------------------------------------------------
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found" >&2; exit 1; }
command -v python >/dev/null 2>&1 || { echo "ERROR: python not found" >&2; exit 1; }

if [ "$TEST" = "true" ]; then
  REPO="${PYPI_REPO:-testpypi}"
else
  REPO="${PYPI_REPO:-pypi}"
fi

# If testing or a PR/pre-release build, publish npm under a non-latest tag so we
# don't fight over the existing higher 'latest' version already on the registry.
if [ "$REPO" != "pypi" ]; then
  NPM_TAG="${NPM_TAG:-beta}"
else
  NPM_TAG="${NPM_TAG:-latest}"
fi

# ---------------------------------------------------------------------------
# 2) Publish the TypeScript / npm package
# ---------------------------------------------------------------------------
echo "==> npm: publishing $NPM_PACKAGE (from anypick-ts)..."
cd "$ROOT/anypick-ts"

# `prepare` runs `npm run build` automatically before publishing.
CMD=(npm publish --tag "$NPM_TAG")
if [ "$NPM_PACKAGE" != "anypick-ts" ]; then
  CMD+=(--name "$NPM_PACKAGE")
fi

# Warn if the name is already taken by someone else.
if npm view "$NPM_PACKAGE" maintainers >/dev/null 2>&1; then
  OWNER="$(npm view "$NPM_PACKAGE" maintainers 2>/dev/null)"
  echo "WARNING: npm name '$NPM_PACKAGE' is already registered by: $OWNER"
  if [ "$DRY_RUN" != "true" ] && [ "$TEST" != "true" ]; then
    echo "Aborting npm publish as a safety measure (set NPM_PACKAGE to a name you own)." >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" = "true" ]; then
  # Build and print what would be published, without actually publishing.
  npm run build
  npm publish --dry-run
  echo "==> [npm] dry-run complete — nothing was published."
elif [ "$TEST" = "true" ]; then
  echo "[npm --test] would run: ${CMD[*]}"
elif [ "$DRY_RUN" = "false" ]; then
  "${CMD[@]}"
  VERSION="$(node -p "require('./package.json').version")"
  echo "==> npm: published $NPM_PACKAGE@$VERSION (tag: $NPM_TAG)"
fi

# ---------------------------------------------------------------------------
# 3) Publish the Python / PyPI package
# ---------------------------------------------------------------------------
echo
echo "==> Publishing PyPI package (anypick-python)..."
cd "$ROOT/anypick-python"

# Build sdist + wheel (and put them in a fresh dist/).
rm -rf dist build *.egg-info
python -m build

# Show the files we are about to upload.
echo "Built artifacts:"
ls -1 dist/

# Sanity-check the built metadata.
python -m twine check dist/* || {
  echo "ERROR: twine check failed. Fix metadata before publishing." >&2
  exit 1
}

if [ "$DRY_RUN" = "true" ]; then
  echo "==> [dry-run] would upload: dist/*"
else
  if [ "$REPO" = "testpypi" ]; then
    python -m twine upload --repository testpypi dist/*
    echo "==> uploaded to Test PyPI (test.pypi.org)"
  else
    python -m twine upload --repository pypi dist/*
    echo "==> uploaded to PyPI (pypi.org)"
  fi
fi

echo
echo "Done."