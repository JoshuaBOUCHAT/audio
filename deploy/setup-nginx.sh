#!/usr/bin/env bash
# Branche audio derrière le nginx du serveur (cf. nginx-audio.conf). Lancé par
# `deploy.sh --nginx` (sur le serveur, avec sudo). Relançable sans risque.
set -euo pipefail

domain="${1:?usage : setup-nginx.sh <domaine>}"
site=/etc/nginx/sites-available/audio

# 1. Certificat : d'abord un site HTTP seul, le temps que certbot valide le domaine
#    (même méthode webroot que password.*). Renouvelé par le timer certbot, nginx
#    rechargé après chaque renouvellement.
if [[ ! -d "/etc/letsencrypt/live/$domain" ]]; then
    sed -n '/^map /,/^}/p; /^server {/,/^}/{p;/^}/q}' /tmp/nginx-audio.conf | sed "s/DOMAIN/$domain/g" > "$site"
    ln -sf "$site" /etc/nginx/sites-enabled/audio
    nginx -t
    systemctl reload nginx
    certbot certonly --webroot -w /var/www/certbot -d "$domain" \
        --non-interactive --deploy-hook "systemctl reload nginx"
fi

# 2. Site complet.
sed "s/DOMAIN/$domain/g" /tmp/nginx-audio.conf > "$site"
ln -sf "$site" /etc/nginx/sites-enabled/audio
nginx -t
systemctl reload nginx

# 3. audio écoute en local seulement.
sed -i 's/^AUDIO_LISTEN=.*/AUDIO_LISTEN=127.0.0.1:8443/' /etc/audio.env
systemctl restart audio
rm /tmp/nginx-audio.conf /tmp/setup-nginx.sh
echo "audio derrière nginx : https://$domain/"
