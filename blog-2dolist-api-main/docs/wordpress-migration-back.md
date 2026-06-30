# Préparation migration WordPress — compatibilité back/API

Ce document décrit le format recommandé pour préparer un futur import WordPress dans l’API Fastify/Prisma.

L’objectif SEO prioritaire est de conserver les URLs WordPress existantes quand c’est possible. Si un article WordPress était publié sur `/mon-article/`, la donnée importée doit permettre au front de servir cet article exactement sur `/mon-article/`. Si l’URL était `/blog/mon-article/`, le chemin importé doit rester `/blog/mon-article/`.

## Champs recommandés pour un article WordPress

| Champ | Description |
| --- | --- |
| `old_url` | URL WordPress source complète ou chemin historique, conservée comme référence d’audit. |
| `path` | Chemin public relatif exact à conserver côté front, par exemple `/mon-article/`, `/blog/mon-article/` ou `/categorie/mon-article/`. |
| `slug` | Slug technique de l’article, utile pour la compatibilité avec les routes existantes `/api/posts/:slug`. |
| `locale` | Locale de l’article, par exemple `en` ou `fr`. |
| `title` | Titre de l’article. |
| `h1` | H1 souhaité si différent du titre. |
| `excerpt` | Extrait court. |
| `chapoHtml` | Chapô HTML optionnel. |
| `contentHtml` | Contenu HTML principal à afficher. |
| `metaTitle` | Titre SEO importé depuis WordPress/extension SEO. |
| `metaDescription` | Meta description importée depuis WordPress/extension SEO. |
| `canonicalUrl` | URL canonique absolue uniquement si elle est certaine et volontaire. |
| `robots` | Directive robots existante, par exemple `index,follow` ou `noindex,follow`. |
| `publishedAt` | Date de publication d’origine. |
| `updatedAt` | Date de dernière modification d’origine, utile pour l’audit et le sitemap si elle est reprise plus tard. |
| `categorySlug` | Slug de catégorie WordPress ou slug cible côté API. |
| `authorSlug` | Slug auteur WordPress ou slug cible côté API. |
| `coverImageUrl` | URL de l’image mise en avant WordPress ou URL migrée. |
| `coverImageAlt` | Texte alternatif de l’image mise en avant. |
| `faqJson` | FAQ structurée si elle existe dans le contenu ou dans un plugin SEO. |
| `tags` | Liste de tags WordPress à rattacher à l’article. |

## Règles importantes

- `path` doit conserver exactement le chemin WordPress public à préserver, avec le préfixe et le slash final si WordPress l’utilisait.
- `slug` reste utile pour la compatibilité avec les endpoints existants, notamment `GET /api/posts/:slug`.
- `canonicalUrl` doit être renseignée seulement si elle est certaine. En cas de doute, laisser ce champ vide pour que l’API construise la canonique à partir de `path` ou du fallback existant.
- Les images WordPress devront être soit conservées sur leur URL actuelle, soit migrées vers le stockage cible avec un mapping entre anciennes URLs et nouveaux médias.
- Les redirections seront gérées plus tard uniquement pour les URLs qui ne peuvent pas être conservées exactement.

## Ce qui n’est pas couvert par cette étape

Cette étape ne crée pas encore d’importeur WordPress complet et ne définit pas de mapping automatique depuis un export WordPress. Elle rend uniquement l’API compatible avec des chemins publics WordPress exacts via le champ `Post.path` et la route publique `GET /api/posts/by-path`.
