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
npm run db:migrate -w @dsa/api    # prisma migrate deploy — applies the migrations
npm run db:seed   -w @dsa/api     # admin + scoring formula + problem catalogue, then the roster
```

In production (`NODE_ENV=production`) the seed creates **only** the admin account,
scoring formula and problem catalogue — the 60-student demo cohort is never seeded.
It is idempotent and never resets an existing admin's password.

`db:seed` then runs the roster loader, which **skips unless `roster.csv` is present** —
see the next section.

> On the free stack the Render backend build runs `migrate deploy` and the seed
> automatically (see `docs/DEPLOY_RENDER_FREE.md`), so you usually do **not** run these
> by hand — this section is the manual fallback and the "what it does" reference.

## 4. Verify
```bash
# quick connectivity check
node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.\$queryRaw\`SELECT 1\`.then(()=>{console.log('Neon OK');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
```
Or hit the backend's `/api/v1/health/ready` once deployed — it reports `database: up`.

## 5. Load the roster

`apps/api/prisma/roster.csv` is **gitignored** — it holds students' real names and email
addresses and this repository is public. It is therefore not in Render's checkout, and
the deploy build's roster step is a quiet no-op. Load it into Neon yourself, once, and
again whenever the cohort changes:

```bash
# from your machine, with DATABASE_URL pointing at Neon
npm run db:seed:students -w @dsa/api -- --dry-run   # validate the CSV, write nothing
npm run db:seed:students -w @dsa/api                # apply
```

Students are matched on email, so re-running after a roster edit updates them in place
rather than duplicating them. A student who drops off the sheet is **reported, never
deleted** — deleting one cascades away their entire submission mirror, which LeetCode's
20-row history window makes unrecoverable.

Sanity-check afterwards: `/api/v1/students/filters` should list the squads with their
student counts.

## Notes / limits
- **Free tier autosuspend:** Neon suspends a free project after inactivity and wakes on
  the next connection (a few hundred ms). Harmless here.
- **Never commit** the connection string. It is a secret — it lives only in Render's and
  GitHub's encrypted secrets.
