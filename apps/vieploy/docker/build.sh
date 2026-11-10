#!/bin/bash
set -eu

VIEPLOY_IMAGE=${VIEPLOY_IMAGE:-vieploy}
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# Determine the type of build based on the first script argument
BUILD_TYPE=${1:-production}

if [ "$BUILD_TYPE" == "canary" ]; then
    TAG="canary"
else
    VERSION=$(node -p "require('./apps/vieploy/package.json').version")
    TAG="$VERSION"
fi

BUILDER=$(docker buildx create --use)
trap 'docker buildx rm "$BUILDER"' EXIT

docker buildx build --load --pull --rm -t "${VIEPLOY_IMAGE}:${TAG}" -f 'Dockerfile' .
