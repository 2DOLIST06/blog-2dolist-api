# Rapport de nettoyage des noms visibles des catégories

## Périmètre

Le script `scripts/fix-category-display-names.ts` recherche exclusivement les neuf noms hérités indiqués dans le mapping métier. Pour chaque catégorie trouvée, il présente son identifiant, son nom actuel, son slug, son path, le nom proposé, le nombre d’articles liés et le changement prévu.

## Garanties

- Le mode `--dry-run` n’effectue aucune écriture en base.
- La correction réelle met uniquement à jour `Category.name`.
- `Category.slug`, `Category.path`, `Post.path` et les autres champs des articles restent inchangés.
- Aucune catégorie n’est créée ou supprimée.
- Aucune redirection et aucun préfixe `/fr` ne sont ajoutés.

## Exécution recommandée

1. Exécuter `npm run fix:category-display-names:dry-run` dans l’environnement disposant de `DATABASE_URL` et contrôler le tableau produit dans ce fichier.
2. Après validation manuelle, exécuter `npm run fix:category-display-names`.

La correction réelle n’a pas été lancée lors de la création du script. Ce rapport sera remplacé par le résultat détaillé de chaque exécution.
