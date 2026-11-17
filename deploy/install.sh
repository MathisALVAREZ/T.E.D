#!/usr/bin/env bash
# Installe (ou met à jour) T.E.D. sur le VPS, branché sur le Traefik déjà en place.
# À lancer depuis le dossier du projet :  bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Fichier .env (créé une seule fois)
if [ ! -f .env ]; then
  echo "Première installation."
  read -rsp "Colle ta clé API Anthropic (sk-ant-…), elle ne s'affichera pas : " KEY; echo
  [ -n "$KEY" ] || { echo "Clé vide, abandon."; exit 1; }
  read -rp "Adresse du site [ted.kratox.fr] : " DOM; DOM="${DOM:-ted.kratox.fr}"
  PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)
  cat > .env <<ENV
ANTHROPIC_API_KEY=${KEY}
TED_PASSWORD=${PASS}
SESSION_SECRET=$(openssl rand -hex 32)
ANTHROPIC_MODEL=claude-haiku-5-5
MAX_TOKENS=400
TED_CREATOR=Kratox
DOMAIN=${DOM}
INSTANCE=ted
PORT_LOCAL=3081
ENV
  chmod 600 .env
  echo "Mot de passe de T.E.D. (à noter) : ${PASS}"
fi

envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
INSTANCE="$(envval INSTANCE)"; INSTANCE="${INSTANCE:-ted}"
DOMAIN="$(envval DOMAIN)"; DOMAIN="${DOMAIN:-ted.kratox.fr}"

# 2. Réglages Traefik repris d'un service qui marche déjà (Nous, par exemple)
labels_of() { docker inspect "$1" --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' 2>/dev/null | grep -i '^traefik\.' || true; }
REF="${REF:-}"
if [ -z "$REF" ]; then
  for c in $(docker ps --format '{{.Names}}'); do
    [ "$c" = "$INSTANCE" ] && continue
    if labels_of "$c" | grep -qi 'tls\.certresolver='; then REF="$c"; break; fi
  done
fi
L=""; [ -n "$REF" ] && L="$(labels_of "$REF")"
pick() { echo "$L" | grep -i -m1 "$1" | cut -d= -f2- || true; }
ENTRY="${ENTRY:-$(pick '\.entrypoints=')}";           ENTRY="${ENTRY:-websecure}"
RESOLVER="${RESOLVER:-$(pick 'tls\.certresolver=')}"; RESOLVER="${RESOLVER:-letsencrypt}"
NET="${NET:-$(pick '^traefik\.docker\.network=')}"
if [ -z "$NET" ]; then
  tn="$(docker inspect traefik --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null || true)"
  if [ -n "$REF" ]; then
    rn="$(docker inspect "$REF" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}')"
    NET="$(comm -12 <(echo "$tn" | sort) <(echo "$rn" | sort) | grep -v '^$' | head -1 || true)"
  fi
  NET="${NET:-$(echo "$tn" | grep -v '^$' | head -1)}"
fi
[ -n "$NET" ] || { echo "Réseau Traefik introuvable. Relance avec NET=<réseau> bash deploy/install.sh"; exit 1; }

echo "Modèle : ${REF:-aucun} · réseau : $NET · entrée : $ENTRY · certificats : $RESOLVER · domaine : $DOMAIN"

cat > docker-compose.override.yml <<YML
# Généré par deploy/install.sh — relancer le script plutôt que modifier à la main.
services:
  ted:
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.docker.network=${NET}
      - traefik.http.routers.${INSTANCE}.rule=Host(\`${DOMAIN}\`)
      - traefik.http.routers.${INSTANCE}.entrypoints=${ENTRY}
      - traefik.http.routers.${INSTANCE}.tls=true
      - traefik.http.routers.${INSTANCE}.tls.certresolver=${RESOLVER}
      - traefik.http.services.${INSTANCE}.loadbalancer.server.port=3000
networks:
  proxy:
    name: ${NET}
    external: true
YML

# 3. Construction et démarrage
docker compose up -d --build
echo "Attente du certificat…"; sleep 12
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/health" || true)"
if [ "$code" = "200" ]; then echo "T.E.D. est en ligne : https://${DOMAIN}"
else echo "Pas encore de réponse (code ${code:-aucun}). Vérifie que le DNS de ${DOMAIN} pointe vers le VPS, puis : docker logs traefik --tail 30 ; docker logs ${INSTANCE} --tail 30"; fi
