# LinkNest - Link in Bio Mini App

Brz, moderni `link-in-bio` template za male biznise i kreatore.

## Sta dobijas

- Mobile-first dizajn
- Jednostavno uredjivanje kroz `config/profile.json`
- Share dugme (native share + copy fallback)
- Lagane animacije i premium izgled
- Spreman za deploy na Vercel

## Lokalno pokretanje

Najlakse je da pokrenes static server:

```bash
npx serve .
```

## Kako menjas sadrzaj

Uredi fajl:

- `config/profile.json`

Polja:

- `name`, `handle`, `bio`, `avatar`, `updatedAt`
- `links[]` sa `title`, `subtitle`, `url`, `tag`

## Deploy na Vercel

1. Push na GitHub repozitorijum
2. U Vercel izaberi "Add New Project"
3. Importuj repo i klikni Deploy

Za staticki sajt nije potreban poseban build setup.
