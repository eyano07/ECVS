#!/usr/bin/env bash
#
# Construit et publie l'image du gateway sur Docker Hub.
#
# Usage :
#   ./publish.sh            # publie le tag "latest"
#   ./publish.sh 1.2.0      # publie les tags "1.2.0" ET "latest"
#
# Prérequis : être connecté à Docker Hub (docker login -u eyano3535).

set -euo pipefail

IMAGE="eyano3535/avi-server"
VERSION="${1:-}"

# Répertoire du script (permet de lancer publish.sh depuis n'importe où)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT="${SCRIPT_DIR}/gateway"

echo ">> Build de ${IMAGE}:latest depuis ${CONTEXT}"
docker build -t "${IMAGE}:latest" "${CONTEXT}"

if [[ -n "${VERSION}" ]]; then
    echo ">> Tag supplémentaire : ${IMAGE}:${VERSION}"
    docker tag "${IMAGE}:latest" "${IMAGE}:${VERSION}"
fi

echo ">> Push de ${IMAGE}:latest"
docker push "${IMAGE}:latest"

if [[ -n "${VERSION}" ]]; then
    echo ">> Push de ${IMAGE}:${VERSION}"
    docker push "${IMAGE}:${VERSION}"
fi

echo ">> Termine. Sur le VPS : docker compose pull gateway && docker compose up -d"
