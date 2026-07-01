# Normalisation des blocs WordPress importés

## Cause du problème

Les articles WordPress importés conservent principalement le corps dans `Post.contentHtml`. L’API admin expose bien `contentHtml`, `contentJson` et `faqJson`, mais l’import WordPress ne transforme pas les blocs Gutenberg HTML ni les blocs FAQ Yoast en données éditables séparées. Les widgets GetYourGuide restent donc noyés dans le HTML brut et les FAQ restent visibles dans le texte principal.

## Champs utilisés

- `contentHtml` : HTML public principal de l’article. Après normalisation, il reste la source de rendu compatible front et conserve le widget GetYourGuide sans script inline.
- `contentJson` : représentation éditable ajoutée par la normalisation. Format utilisé :

```json
{
  "version": 1,
  "source": "wordpress-normalizer",
  "blocks": [
    { "id": "content-001", "type": "contentHtml", "html": "<p>...</p>", "label": "Contenu WordPress" },
    { "id": "html-gyg-001", "type": "html", "html": "<div data-gyg-...></div>", "label": "Widget GetYourGuide" }
  ]
}
```

- `faqJson` : tableau FAQ compatible avec le module existant :

```json
[{ "question": "Question...", "answer": "Réponse HTML..." }]
```

## Détection GetYourGuide

Le normaliseur détecte les traces suivantes dans `contentHtml` : `getyourguide`, `widget.getyourguide.com`, `data-gyg` et `gyg`. Les éléments `<div>` ou `<iframe>` concernés deviennent des blocs `type: "html"` dans `contentJson.blocks` avec le label `Widget GetYourGuide`.

Les balises `<script>` inline contenues dans ces blocs ne sont pas conservées dans le bloc éditable. Le markup HTML du widget et ses attributs `data-*` restent conservés. Le script global GetYourGuide doit rester chargé côté layout/front, pas dupliqué dans chaque article.

## Extraction des FAQ

La normalisation extrait avec confiance :

- les blocs Gutenberg/Yoast `wp:yoast/faq-block` contenant `jsonQuestion` et `jsonAnswer` ;
- les blocs HTML Yoast avec classes `schema-faq`, `schema-faq-section`, `schema-faq-question` et `schema-faq-answer`.

Quand une FAQ est extraite, le bloc FAQ est retiré de `contentHtml` pour éviter le doublon dans l’éditeur principal et côté public. Si une section ressemble à une FAQ mais ne correspond pas à ces formats fiables, elle reste dans `contentHtml` et le rapport la signale comme ambiguë.

## Commandes

Diagnostic sans modification :

```bash
npm run analyze:wordpress-content
```

Simulation de normalisation, sans écriture en base :

```bash
npm run normalize:wordpress-content:dry-run
```

Normalisation réelle, à lancer sur Render uniquement après validation :

```bash
npm run normalize:wordpress-content
```

## Rapports générés

- `data/import/wordpress-content-blocks-report.md` : rapport de diagnostic.
- `data/import/wordpress-content-normalization-result.md` : rapport de dry-run ou de normalisation réelle.

## Limites

- Les FAQ en listes libres ou en titres/réponses non Yoast sont seulement signalées si elles ne peuvent pas être extraites avec confiance.
- Le repo contient l’API/back et un panneau admin HTML minimal. Si l’admin front principal est dans un autre repo, il doit lire `contentJson.blocks`, afficher les blocs `type: "html"` dans un éditeur HTML contrôlé, et lire/écrire `faqJson` pour le module FAQ.
- La normalisation ne modifie pas `title`, `slug`, `path`, `canonicalUrl`, les dates, les redirections, les URLs d’images ou les liens.
