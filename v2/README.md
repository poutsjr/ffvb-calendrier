# Calendrier club volley (FFVB) — v2

Le calendrier de la v1, mais **alimenté par le serveur** : les matchs sont récupérés chaque jour sur ffvbbeach.org,
stockés en base, et les réglages (salles à domicile, noms d'équipes, dates de la Coupe de France) sont **partagés et
modifiables par des administrateurs** connectés avec Google. La page reste **publique** pour consulter.

- Clubs suivis au départ : **Harnes VB** (0622126, club de référence) et **VC Harnes** (0628929).
- Hébergement : **Vercel (offre Hobby)** + base **Neon Postgres** (offre gratuite) — **0 €**.
- Pas de framework : une page statique (`public/`), quelques fonctions serveur (`api/`), deux dépendances (`jose`, `@neondatabase/serverless`).

## Ce que fait chaque partie

| Fichier | Rôle |
|---|---|
| `public/index.html` | Le calendrier (grille, liste, mobile, filtres, réservations Coupe de France…). Charge `/api/data`. |
| `public/admin.html` | Page d'administration : salles, équipes, Coupe de France, synchronisation, clubs, comptes, journal. |
| `api/data.js` | `GET /api/data` — clubs, réglages, dates réservées et matchs (sans noms d'arbitres). |
| `api/sync.js` | Synchronisation FFVB : tâche quotidienne (cron) et bouton « Synchroniser maintenant » (admin). |
| `api/auth.js` | Connexion Google (OpenID Connect + PKCE), session, déconnexion. |
| `api/admin.js` | Modification des réglages et des comptes, selon le rôle. |
| `lib/` | Base de données et schéma, lecture de l'export FFVB, synchronisation, sessions et rôles. |
| `test/` | 18 tests (base PGlite en mémoire, FFVB et Google simulés). |

**Identité d'un match = saison + entité (la poule) + n° de match.** À chaque synchronisation, les matchs d'un club et d'une
saison sont mis à jour ; ceux qui ont disparu de l'export FFVB sont retirés. Si l'export est vide ou illisible, **rien n'est
modifié** (l'erreur apparaît dans l'onglet Synchronisation).

**Rôles :** *admin* (tout), *éditeur* (salles, équipes, Coupe de France), *lecteur* (aucun droit d'édition). Seuls les comptes
autorisés par un admin peuvent se connecter ; une personne inconnue est refusée **sans que son adresse soit enregistrée**.

## Développer en local

```bash
npm install
npm test            # 18 tests, aucune connexion externe
npm run dev         # http://localhost:3000  (base PGlite en mémoire)
```

Sans configuration, le serveur local utilise une base en mémoire (vide au démarrage) et un secret de session de développement.
Pour tester l'administration sans Google, lancer avec `DEV_LOGIN=1 ADMIN_EMAILS=moi@exemple.fr npm run dev`, puis ouvrir
`http://localhost:3000/api/auth/login?dev=moi@exemple.fr&next=/admin.html` (la connexion de test est **désactivée sur Vercel**,
quelle que soit la configuration). Cliquer ensuite sur « Synchroniser maintenant » pour récupérer les vrais matchs.

> Si votre réseau impose un proxy et que la récupération FFVB échoue, essayez `NODE_USE_ENV_PROXY=1 npm run dev`.

## Déployer (≈ 20 minutes, 0 €)

1. **Dépôt GitHub** : ce projet vit dans le sous-dossier `v2/` du dépôt `ffvb-calendrier` (la v1, à la racine, reste servie par
   GitHub Pages). Le fichier `package-lock.json` est volontairement ignoré par git ; Vercel installera les dépendances depuis le
   registre public npm.
2. **Vercel** : *Add New… → Project*, importez le dépôt, offre **Hobby**. **Root Directory : `v2`**. Framework : *Other* ; ne définissez
   ni commande de build ni dossier de sortie. Ne mettez pas de domaine personnalisé (le `…vercel.app` est gratuit). Notez l'adresse du site.
3. **Base Neon** : dans le projet Vercel, *Storage → Create/Connect → Neon* (offre gratuite). Vercel ajoute `DATABASE_URL`
   automatiquement. Les tables et les réglages de départ sont créés au premier appel.
4. **Connexion Google** (https://console.cloud.google.com) :
   - créez un projet, puis *API et services → Écran de consentement OAuth* : type **Externe**, nom de l'application, votre e-mail ;
   - **publiez l'application** (« Mettre en production ») : tant que vous ne demandez que `openid`, `email` et `profile`, aucune
     vérification Google n'est nécessaire ;
   - *Identifiants → Créer des identifiants → ID client OAuth → Application Web* ; **URI de redirection autorisé** :
     `https://VOTRE-SITE.vercel.app/api/auth/callback` ; notez l'ID client et le secret.
5. **Variables d'environnement** (Vercel → *Settings → Environment Variables*, voir `.env.example`) :
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` (l'adresse du site, sans « / » final), `SESSION_SECRET`
   (32 caractères aléatoires minimum : `openssl rand -base64 48`), `CRON_SECRET` (`openssl rand -base64 32`),
   `ADMIN_EMAILS` (votre adresse Google, plusieurs possibles séparées par des virgules). **Redéployez** ensuite.
6. **Premier démarrage** : ouvrez `…/admin.html`, connectez-vous avec Google, onglet *Synchronisation → Synchroniser maintenant*.
   La tâche quotidienne (05:00 UTC, voir `vercel.json`) prend ensuite le relais. Ajoutez vos éditeurs dans l'onglet *Utilisateurs*.

## Sécurité

- **Aucun secret dans le dépôt** : tout passe par les variables d'environnement Vercel (`.env` est ignoré par git).
- Requêtes SQL **toutes paramétrées** ; aucune construction de SQL à partir de données saisies.
- Sessions : cookie `HttpOnly`, `Secure`, `SameSite=Lax`, JWT signé (7 jours). Le **rôle est relu en base à chaque requête** :
  retirer un compte coupe l'accès immédiatement.
- Écritures : en-tête anti-CSRF obligatoire + contrôle de l'origine. Droits vérifiés côté serveur pour chaque action.
- Connexion Google : `state`, `nonce` et PKCE vérifiés, jeton d'identité validé (signature, émetteur, audience, e-mail vérifié).
  Redirection après connexion limitée aux chemins internes.
- En-têtes de sécurité (CSP, `X-Frame-Options`, `nosniff`…) dans `vercel.json`.
- Tâche quotidienne protégée par `CRON_SECRET` (comparaison à temps constant) ; synchronisation manuelle limitée à une fois toutes les 2 minutes.
- Données : **les noms d'arbitres ne sont ni lus ni stockés**. Les seules données personnelles conservées sont les adresses
  e-mail des comptes autorisés par un admin.

## Rester à 0 €

- **Vercel Hobby** : usage non commercial (un outil de club sans revenu convient) ; tâche planifiée une fois par jour.
- **Neon gratuit** : 1 Go et un quota de calcul mensuel ; au-delà, les écritures échouent au lieu d'être facturées. Un club tient
  dans quelques centaines de Ko par saison.
- Ne souscrivez à aucun plan payant, n'ajoutez pas de domaine personnalisé. Les offres gratuites évoluent : vérifiez leurs pages
  de tarifs de temps en temps.
- La page publique est mise en cache 5 minutes par Vercel : une modification de réglages peut mettre jusqu'à 5 minutes à apparaître.

## Limites connues

- Le pilote Neon, la connexion Google réelle et l'environnement Vercel ne peuvent pas être testés hors ligne : les tests couvrent la
  logique sur une base locale équivalente (PGlite). Vérifiez le premier déploiement avec l'onglet *Synchronisation* de l'administration.
- Les libellés de compétitions (table `COMP` dans `public/index.html`) sont ceux de la saison 2026-2027 ; un nouveau code de
  compétition s'affiche avec son code tant qu'il n'a pas été ajouté à cette table.
