#!/usr/bin/env bash
# Préparation du serveur, une seule fois : utilisateur système, dossiers, config,
# service. Lancé par `deploy.sh --setup` (sur le serveur, avec sudo). Relançable sans
# risque : n'écrase ni /etc/audio.env ni /var/lib/audio.
set -euo pipefail

admin_email="${1:?usage : setup-server.sh <email admin>}"

id audio &>/dev/null || useradd --system --home-dir /var/lib/audio --shell /usr/sbin/nologin audio
install -d -o audio -g audio -m 700 /var/lib/audio /var/lib/audio/certs

if [[ ! -f /etc/audio.env ]]; then
    install -m 600 /dev/null /etc/audio.env
    cat > /etc/audio.env <<CONF
AUDIO_LISTEN=0.0.0.0:443
ADMIN_EMAIL=$admin_email
CONF
fi

# Cert auto-signé en attendant ACME (TLS-ALPN-01) : le navigateur alertera.
if [[ ! -f /var/lib/audio/certs/cert.pem ]]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
        -subj "/CN=$(hostname)" \
        -keyout /var/lib/audio/certs/key.pem -out /var/lib/audio/certs/cert.pem 2>/dev/null
    chown audio:audio /var/lib/audio/certs/*.pem
    chmod 600 /var/lib/audio/certs/key.pem
fi

install -m 644 /tmp/audio.service /etc/systemd/system/audio.service
systemctl daemon-reload
systemctl enable audio
echo "serveur prêt — 'deploy.sh' pour installer le binaire et démarrer"
