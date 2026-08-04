# Database — Neon PostgreSQL (Free)

Neon provides the production database. Prisma talks to it through `DATABASE_URL` with
**no code changes** — it is standard PostgreSQL.

## 1. Create the project
1. Sign up at <https://neon.tech> (free tier — no card required).
2. **Create a project**. Pick the region closest to your Render backend region to keep
   latency low. Name it e.g. `dsa-tracker`.
3. Neon creates a default database (e.g. `neondb`) and a role for you.

## 2. Get the connection string
1. Project → **Dashboard → Connection Details**.
2. Choose the **Pooled connection** (labelled *"Pooled connection"* / host contains
   `-pooler`). Pooling matters on a free backend that may open many short-lived
   connections.
3. Copy the string. It looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
   ```
   Keep `?sslmode=require` — Neon requires TLS. This whole string is your `DATABASE_URL`.

> Prisma note: the pooled endpoint works for the app at runtime. `prisma migrate deploy`
> also works against it. If you ever hit a migration advisory-lock issue on the pooler,
> use the **unpooled** ("Direct connection") string just for migrations — same project,
> host without `-pooler`.

## 3. Apply the schema and seed (once)
From your machine (or the Render Shell), with `DATABASE_URL` set to the Neon string:

```bash
npm ci
npm run build:shared
npm run db:generate -w @dsa/api
npm run db:migrate -w @dsa/api    # prisma migrate deploy — applies the migration
npm run db:seed   -w @dsa/api     # creates the admin, scoring formula, problem catalogue
```

In production (`NODE_ENV=production`) the seed creates **only** the admin account,
scoring formula and problem catalogue — the 60-student demo cohort is never seeded.
It is idempotent and never resets an existing admin's password.

> On the free stack the Render backend build runs `migrate deploy` and the seed
> automatically (see `docs/DEPLOY_RENDER_FREE.md`), so you usually do **not** run these
> by hand — this section is the manual fallback and the "what it does" reference.

## 4. Verify
```bash
# quick connectivity check
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.\$queryRaw\`SELECT 1\`.then(()=>{console.log('Neon OK');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
```
Or hit the backend's `/api/v1/health/ready` once deployed — it reports `database: up`.

## Notes / limits
- **Free tier autosuspend:** Neon suspends a free project after inactivity and wakes on
  the next connection (a few hundred ms). Harmless here.
- **Never commit** the connection string. It is a secret — it lives only in Render's and
  GitHub's encrypted secrets.
