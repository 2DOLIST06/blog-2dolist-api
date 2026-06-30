# Personnalisation du backend blog

Ce backend est désormais prévu comme base générique Fastify/TypeScript/Prisma pour migrer un blog WordPress, sans dépendre d’un ancien domaine ou d’une thématique métier codée en dur.

## Valeurs configurables

La configuration centrale du site est exposée par `src/config/site.ts` :

- `SITE_NAME` : nom public du site.
- `SITE_URL` : domaine canonique utilisé pour les URLs absolues, sitemap, robots, canonical et hreflang.
- `DEFAULT_LOCALE` : locale par défaut utilisée pour les chemins publics.
- `SUPPORTED_LOCALES` : liste de locales supportées, séparées par des virgules dans l’environnement.
- `DEFAULT_META_TITLE` : titre SEO par défaut neutre.
- `DEFAULT_META_DESCRIPTION` : description SEO par défaut neutre.

## Variables d’environnement

Variables ajoutées ou utilisées pour la personnalisation :

```env
SITE_NAME="Mon blog"
APP_URL="https://example.com"
PUBLIC_SITE_URL="https://example.com"
DEFAULT_LOCALE="en"
SUPPORTED_LOCALES="en,fr"
DEFAULT_META_TITLE="Mon blog"
DEFAULT_META_DESCRIPTION=""
SEED_DEMO_CONTENT="false"
```

Priorité du domaine canonique :

1. `APP_URL` si elle est définie.
2. `PUBLIC_SITE_URL` si `APP_URL` n’est pas définie.
3. fallback local neutre `http://localhost:3000`.

`CORS_ORIGIN`, `DATABASE_URL` et `JWT_SECRET` restent indépendantes et ne doivent pas être modifiées pour changer le domaine canonique public.

## Changer le nom du site

Définir `SITE_NAME` dans l’environnement. Si `DEFAULT_META_TITLE` n’est pas fourni, le titre par défaut reprend `SITE_NAME`.

## Changer le domaine canonique

Définir `APP_URL` avec l’URL publique du front Next.js. Si cette variable est réservée à un autre usage dans un environnement donné, définir `PUBLIC_SITE_URL` et ne pas définir `APP_URL`.

Le domaine configuré est utilisé par :

- sitemap XML ;
- robots.txt ;
- canonical URLs ;
- hreflang ;
- builders d’URLs publics ;
- serializers d’articles, catégories, auteurs et pages SEO.

## Éviter les anciens contenus dans les seeds

Par défaut, `prisma/seed.ts` crée uniquement l’utilisateur admin. Il ne crée plus automatiquement d’auteur, catégorie, tag, média ou article d’exemple thématique.

Pour créer un contenu de démonstration neutre en développement local :

```env
SEED_DEMO_CONTENT=true
```

Le contenu de démonstration est volontairement générique et ne doit pas être utilisé comme contenu éditorial définitif.

## Points à vérifier avant migration WordPress

- Définir `SITE_NAME`, `APP_URL` ou `PUBLIC_SITE_URL`, `DEFAULT_LOCALE` et `SUPPORTED_LOCALES`.
- Importer les auteurs, catégories, tags, médias et articles depuis WordPress avant d’indexer le site.
- Vérifier `path`, `canonicalUrl`, `isActive`, `isIndexable`, `status` et `publishedAt` pour chaque article importé.
- Vérifier les métadonnées SEO de pages dans l’admin (`/admin-api/seo/page/:key`).
- Contrôler `/sitemap.xml`, `/fr/sitemap.xml`, `/robots.txt` et `/fr/robots.txt` après import.
- Vérifier que les anciennes URLs WordPress nécessaires sont gérées côté front ou infrastructure, sans redirections massives ajoutées ici.

## Limites restantes

- Les contenus déjà présents en base de production ne sont pas modifiés par ce changement.
- Les libellés, textes et fallbacks côté front Next.js externe doivent être audités séparément.
- Les données importées depuis WordPress peuvent contenir leur propre wording métier ; elles doivent être nettoyées dans le processus d’import si nécessaire.
