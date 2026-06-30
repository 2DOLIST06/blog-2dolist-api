# Rapport import WordPress

## Analyse du CSV
- Fichier source : `data/Articles-Export-2026-juin-30-1157.csv`
- Nombre total de lignes : 53
- Articles avec `Status = publish` : 51
- Brouillons / statuts non publiés ignorés : 2

## Présence des champs
- Permalink : 53/53 lignes renseignées
- Slug : 51/53 lignes renseignées
- Title : 53/53 lignes renseignées
- Content : 53/53 lignes renseignées
- Date : 53/53 lignes renseignées
- Post Modified Date : 53/53 lignes renseignées
- Catégories : 53/53 lignes renseignées
- Author : 53/53 lignes renseignées
- Images : 52/53 lignes renseignées
- Yoast meta description : 49/53 lignes renseignées
- Yoast title : 37/53 lignes renseignées
- Yoast canonical : 45/53 lignes renseignées

## Résultat prêt à importer
- Articles publiés prêts à importer : 51
- Brouillons ignorés : 2
- Catégories/rubriques à créer : 11
  - `Aquatique` → `aquatique`
  - `Aérien>Avion` → `aerien-avion`
  - `Aérien>Hélicoptére` → `aerien-helicoptere`
  - `Aérien>Montgolfière` → `aerien-montgolfiere`
  - `Aérien>Parachutisme` → `aerien-parachutisme`
  - `Aérien>Planeur` → `aerien-planeur`
  - `Aérien>ULM` → `aerien-ulm`
  - `Aérien>parapente` → `aerien-parapente`
  - `Montagne` → `montagne`
  - `Pilotage` → `pilotage`
  - `Uncategorized` → `uncategorized`
- Auteurs à créer : 1
  - `nicolas braun` → `nicolas-braun`

## Contrôles qualité
- Doublons de path : 0
- Doublons de slug par locale : 0
- Contenus vides : 0
- URLs invalides : 0
- Articles sans meta description : 0
- Articles sans image : 0
- Articles sans alt image : 1
  - https://blog.2dolist.fr/2025/01/01/vol-dinitiation-au-pilotage-en-helicoptere-en-france-decouvrez-les-secrets-du-ciel/

## Erreurs bloquantes éventuelles
- Aucune erreur bloquante détectée.

## Conservation des URLs
- Le champ `path` est extrait du `pathname` de `Permalink` et conserve le slash final quand il existe dans l’URL WordPress source.
