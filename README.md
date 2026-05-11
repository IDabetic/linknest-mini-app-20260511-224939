# LinkNest SaaS (Multi-user Link in Bio)

Ovo je pravi mini-SaaS:

- korisnik kreira nalog
- korisnik uredjuje svoj profil i linkove
- javna stranica je dostupna na `/u/{slug}`
- admin panel je dostupan na `/admin`

## Tech stack

- React + Vite
- Supabase Auth
- Supabase Postgres + RLS
- Vercel deploy

## 1) Pokretanje lokalno

```bash
npm install
cp .env.example .env.local
npm run dev
```

## 2) Supabase setup

1. Kreiraj Supabase projekat.
2. U SQL editor-u pokreni [supabase/schema.sql](/Users/idabetic/Documents/New%20project%207/supabase/schema.sql).
3. U `.env.local` upisi:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_ADMIN_EMAILS=admin@tvojdomen.com,drugiadmin@tvojdomen.com
```

## 3) Kako app radi

- Landing: registracija / login
- Dashboard (`/dashboard`):
  - display name, bio, avatar URL
  - custom slug
  - dodavanje/izmena/brisanje/reorder linkova
- Public page (`/u/:slug`): prikaz profila i linkova
- Admin page (`/admin`):
  - pregled svih korisnickih profila i broja linkova
  - pretraga korisnika
  - u demo rezimu i brisanje korisnika

## 4) Deploy na Vercel

- Push na GitHub
- Import repo u Vercel
- Dodaj env varijable iz `.env.local`
- Deploy

## Napomena

Ako je u Supabase ukljucen Email Confirmation, korisnik posle sign-up treba da potvrdi email pa tek onda login.

Ako `VITE_SUPABASE_*` varijable nisu podesene, app radi u demo rezimu (podaci ostaju samo u browseru).
