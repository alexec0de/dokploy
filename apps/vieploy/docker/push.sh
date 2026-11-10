#!/bin/bash
set -eu

: "${VIEPLOY_IMAGE:?Set VIEPLOY_IMAGE to your Docker Hub namespace/repository}"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# Determine the type of build based on the first script argument
BUILD_TYPE=${1:-production}

BUILDER=$(docker buildx create --use)
trap 'docker buildx rm "$BUILDER"' EXIT

if [ "$BUILD_TYPE" == "canary" ]; then
    TAG="canary"
    echo PUSHING CANARY
        docker buildx build --platform linux/amd64,linux/arm64 --pull --rm -t "${VIEPLOY_IMAGE}:${TAG}" -f 'Dockerfile' --push .
else
    echo  "PUSHING PRODUCTION"
    VERSION=$(node -p "require('./apps/vieploy/package.json').version")
    docker buildx build --platform linux/amd64,linux/arm64 --pull --rm -t "${VIEPLOY_IMAGE}:latest" -t "${VIEPLOY_IMAGE}:${VERSION}" -f 'Dockerfile' --push .
fi
