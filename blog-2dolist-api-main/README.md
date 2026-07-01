# The Muscle Temple — Backend + Admin

Backend + admin **Node.js / TypeScript** pour alimenter un front Next.js externe (repo séparé), avec PostgreSQL + Prisma et déploiement Render.

## Stack
- API: Fastify
- ORM: Prisma
- DB: PostgreSQL
- Validation: Zod
- Auth admin: JWT Bearer
- Admin panel: `/admin` (V1 simple)

## Structure
```txt
.
├─ prisma/
│  ├─ schema.prisma
│  └─ seed.ts
├─ src/
│  ├─ config/env.ts
│  ├─ db/client.ts
│  ├─ lib/
│  ├─ routes/
│  │  ├─ public/index.ts
│  │  └─ admin/{api.ts,panel.ts}
│  ├─ validation/
│  └─ server.ts
├─ .env.example
├─ render.yaml
└─ package.json
```

## Variables d’environnement
Copier `.env.example` en `.env`.

Variables nécessaires:
- `DATABASE_URL` (PostgreSQL)
- `JWT_SECRET` (>= 32 chars)
- `CORS_ORIGIN` (une ou plusieurs origines, séparées par virgule)
- `AUTH_DEBUG` (`true`/`false`, optionnel pour logs détaillés de rejet login admin)
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `AWS_S3_BUCKET_NAME` / `AWS_CLOUDFRONT_URL` pour les uploads d’images S3 via CloudFront
- `AWS_S3_UPLOAD_MAX_BYTES` (par défaut `5242880`, soit 5 Mo)
- `PORT` (par défaut 4000)
- `APP_URL`
- `ADMIN_EMAIL` (seed)
- `ADMIN_PASSWORD` (seed)
- `SMTP_SERVER` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `MAIL_FROM` pour envoyer les notifications SMTP de newsletter
- `SMTP_EHLO_DOMAIN` (optionnel, par défaut `blog-api`)
- `NEWSLETTER_RECIPIENT_EMAIL` (par défaut `contact@2dolist.fr`)

Exemple multi-origines:
```env
CORS_ORIGIN="http://localhost:3000,https://my-blog.vercel.app"
```

## Scripts
- `npm run dev`: lance l’API en mode watch
- `npm run build`: compile TypeScript -> `dist/`
- `npm run start`: démarre `dist/server.js`
- `npm run prisma:generate`
- `npm run prisma:migrate`
- `npm run prisma:deploy`
- `npm run seed`

## Local setup
```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run seed
npm run dev
```

## Endpoints publics (`/api`)
- `GET /api/health`
- `POST /api/newsletter` avec `{ "email": "abonne@example.com", "source": "footer" }` : enregistre l’adresse en base puis envoie une notification d’inscription à `NEWSLETTER_RECIPIENT_EMAIL` via le serveur SMTP configuré (reprise automatique si une notification précédente a échoué)
- `GET /api/posts`
- `GET /api/posts/:slug`
- `GET /api/categories`
- `GET /api/categories/:slug/posts`
- `GET /api/authors`
- `GET /api/authors/:slug/posts`
- `GET /api/seo/pages/:key`

## Endpoints admin (`/admin-api`)
- Auth: `POST /admin-api/auth/login` (legacy alias: `POST /admin-api/login`)
- Dashboard: `GET /admin-api/dashboard`
- Newsletter: `GET /admin-api/newsletter-subscribers` pour récupérer la liste des inscrits enregistrés en base
- CRUD: posts / categories / authors
- Supporting: CRUD tags / CRUD media / upload media S3 (`POST /admin-api/media/upload`) / page SEO (GET, PUT, DELETE)

Toutes les routes admin hors login exigent un header:
```http
Authorization: Bearer <jwt>
```

## Déploiement Render (Node Web Service)
**Root Directory**:
```txt
.
```

**Build Command**:
```bash
npm ci && npm run prisma:generate && npm run build
```

**Start Command**:
```bash
npm run prisma:deploy && npm run start
```

> Si tu utilises Yarn sur Render (`yarn install; yarn build`), c’est aussi compatible:
> - `yarn build` lance `prisma generate` automatiquement avant `tsc`.

**Health Check Path**:
```txt
/api/health
```

Variables Render obligatoires:
- `DATABASE_URL`
- `JWT_SECRET`
- `APP_URL`
- `CORS_ORIGIN`
- `SMTP_SERVER` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `MAIL_FROM`

## Notes de solidité
- `dotenv/config` est chargé au boot serveur et pour le seed.
- CORS valide explicitement les origines autorisées (front Next.js externe).
- Seed idempotent pour éviter les duplications majeures.
- Schéma Prisma avec slugs uniques, statuts de publication, SEO unifié, relations tags et articles liés.
