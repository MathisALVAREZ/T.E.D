# T.E.D.

Compagnon IA avec un visage animé : deux yeux lumineux sur un petit écran, qui réagissent pendant qu'il écoute,
réfléchit et parle. Le cerveau, c'est Claude (API Anthropic) ; la personnalité est définie dans `server.js`.

## Mise en ligne sur le VPS (ted.kratox.fr)

1. Créer l'enregistrement DNS `ted.kratox.fr` (type A) vers l'adresse du VPS.
2. Sur le VPS :

       git clone https://github.com/MathisALVAREZ/T.E.D.git ~/ted
       cd ~/ted && bash deploy/install.sh

   Le script demande la clé API Anthropic (créée sur console.anthropic.com), génère le mot de passe de T.E.D.,
   construit le conteneur et le branche sur le Traefik déjà en place (HTTPS automatique).
3. Ouvrir https://ted.kratox.fr et entrer le mot de passe affiché.

Mise à jour : `cd ~/ted && git pull && docker compose up -d --build`.

## Réglages (`.env`)

| Variable | Rôle |
|---|---|
| `ANTHROPIC_API_KEY` | Clé API (reste sur le serveur, jamais envoyée à la page) |
| `TED_PASSWORD` | Mot de passe pour lui parler (vide = ouvert à tous, déconseillé) |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` par défaut (rapide, peu cher) ; `claude-sonnet-5-5` pour plus de finesse |
| `MAX_TOKENS` | Longueur maximale d'une réponse (400) |
| `TED_CREATOR` | Le nom que T.E.D. donne à son créateur |

Après une modification : `docker compose up -d`.

## Comment il marche

- `public/index.html` : le visage (CSS), les états, la conversation, la voix. Aucune étape de compilation.
- `server.js` : sert la page et relaie la conversation vers l'API en streaming (SSE).
- La réponse contient des balises invisibles `[emotion:joie]`, `[regard:haut]`… que la page applique au fil du texte,
  et phrase par phrase quand il parle à voix haute.
- Voix : synthèse vocale et reconnaissance du navigateur (micro dans Chrome et Safari, HTTPS obligatoire).
- Panneau « marionnette » (bouton réglages) : piloter le regard et les émotions à la main.
- La même page fonctionne aussi comme artefact claude.ai (elle utilise alors les capacités de claude.ai).

## Sécurité

- Clé API uniquement côté serveur ; session par cookie `HttpOnly`, `Secure`, `SameSite=Strict`, signé HMAC.
- 5 mauvais mots de passe bloquent 15 minutes ; 40 messages max par 10 minutes et par IP.
- En-tête obligatoire sur les requêtes POST (anti-CSRF) ; CSP stricte par empreintes SHA-256, sans `unsafe-inline`.
- Conteneur sans privilèges, en lecture seule, n'écoute que sur 127.0.0.1.

## Plus tard : Raspberry Pi

La page tourne telle quelle sur un Pi 4/5 en plein écran :

    chromium-browser --kiosk --noerrdialogs --autoplay-policy=no-user-gesture-required https://ted.kratox.fr

Prochaines étapes prévues : Whisper (écoute) et Piper (voix) sur le VPS pour ne plus dépendre du navigateur,
capteur tactile GPIO sur le haut de la tête relié à l'événement « gratouille ».

## Essai en local

    npm install
    ANTHROPIC_API_KEY=sk-ant-… TED_PASSWORD=test COOKIE_SECURE=0 node server.js
    # puis http://localhost:3000
