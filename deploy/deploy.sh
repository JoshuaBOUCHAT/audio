#!/usr/bin/env bash
# Déploiement en une commande : construit le front et le back-end ICI, pour le
# processeur du serveur (Intel N150, cœurs Gracemont ; Key Locker absent de son
# /proc/cpuinfo), copie le binaire (front inclus) et redémarre le service.
#
#   deploy/deploy.sh                      # construire + installer + redémarrer
#   deploy/deploy.sh --setup <email>      # première fois : prépare le serveur
#   deploy/deploy.sh --nginx              # première fois : site nginx + certificat
#
# AUDIO_HOST pour viser une autre machine. Le binaire demande glibc ≥ 2.38.
set -euo pipefail

host="${AUDIO_HOST:-joshua@mini-pc.home}"
domain="${AUDIO_DOMAIN:-audio.joshua-bouchat.fr}"
root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--setup" ]]; then
    email="${2:?usage : deploy.sh --setup <email admin>}"
    scp "$root/deploy/audio.service" "$root/deploy/setup-server.sh" "$host:/tmp/"
    ssh -t "$host" "sudo bash /tmp/setup-server.sh '$email'"
    exit 0
fi

if [[ "${1:-}" == "--nginx" ]]; then
    scp "$root/deploy/nginx-audio.conf" "$root/deploy/setup-nginx.sh" "$host:/tmp/"
    ssh -t "$host" "sudo bash /tmp/setup-nginx.sh '$domain'"
    exit 0
fi

cd "$root/front"
npm run proto:gen
npm run build

cd "$root/back-end"
# Dossier de build séparé : ne pas mélanger avec les builds natifs de dev.
RUSTFLAGS="-C target-cpu=gracemont -C target-feature=-kl,-widekl" \
    cargo build --release --target-dir target/deploy
version="$(git -C "$root" describe --always --dirty)"

scp target/deploy/release/back-end "$host:/tmp/audio.new"
# Renommage atomique : le binaire en cours d'exécution n'est jamais écrasé en place.
ssh -t "$host" "sudo install -m 755 /tmp/audio.new /usr/local/bin/audio.new \
    && sudo mv -f /usr/local/bin/audio.new /usr/local/bin/audio \
    && rm /tmp/audio.new \
    && sudo systemctl restart audio \
    && systemctl --no-pager --lines=5 status audio"
echo "déployé : $version"
