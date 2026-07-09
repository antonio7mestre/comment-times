# The Comment Times

A private reader for New York Times, Wall Street Journal, and Washington Post comments, presented as a minimal feed. The app can run locally from `data/latest.json`, or remotely with Supabase Auth, Supabase Postgres, and Render cron jobs.

## What Each Account Does

- GitHub stores the code and connects to Render.
- Render hosts the web app on its generated `onrender.com` URL.
- GitHub Actions runs the daily scrape and uploads the feed to Supabase.
- Supabase handles real email signup/login, saved likes/bookmarks, and uploaded feed snapshots.
- Resend is optional later for custom SMTP after you add a domain.
- NYT and WSJ subscriber sessions provide the cookies used by the scraper.

Google Cloud, a domain, and Cloudflare are optional and are not required for the first hosted version.

## Local Setup

```sh
cp .env.example .env
npm run scrape -- --force --past-24h --deep
npm run dev
```

Open the printed local URL, usually `http://127.0.0.1:4173/`.

Supabase env vars are required for the signed-in app. Likes and bookmarks are saved to the logged-in account; browser localStorage is only used for UI preferences like theme, source filters, category filters, and sort mode.

## Environment Variables

Required for scraping:

```txt
NYT_COOKIE
WSJ_COOKIE
```

Required for real login and remote saved posts:

```txt
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_ANON_KEY` is public and goes to the browser. `SUPABASE_SERVICE_ROLE_KEY` is private and must only be set on the server/cron environments.

## Supabase

Run `supabase/schema.sql` in the Supabase SQL editor.

The schema creates:

- `saved_posts`: one row per user like/bookmark, including full article and comment snapshots.
- `feed_runs`: one JSON feed snapshot per scrape run.

Enable email auth in Supabase, then add the local and Render URLs as allowed redirect URLs. Supabase's default email sender is suitable for testing but has tight limits; use custom SMTP, such as Resend, for regular use.

## Render

`render.yaml` defines one web service:

- `comment-times`: the web service.

Use Render's generated `onrender.com` URL. A custom domain is optional.

Set these Render environment variables:

```txt
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

Build command:

```sh
npm run build
```

Start command:

```sh
npm start
```

## GitHub Actions

`.github/workflows/daily.yml` runs the daily remote scrape. It runs at 13:00 and 14:00 UTC, skips unless the Los Angeles hour is 6, runs the daily scrape/upload, builds, and commits `data/` as a backup.

Add these GitHub secrets if you use Actions:

```txt
NYT_COOKIE
WSJ_COOKIE
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Manual force command:

```sh
npm run scrape:daily:force
```

## Scraper Notes

The daily scrape uses:

```sh
node scripts/scrape.mjs --force --past-24h --deep
```

It scans all candidate articles in the rolling 24-hour window, stores comments from NYT, WSJ, and WaPo, writes `data/YYYY-MM-DD.json`, updates `data/latest.json`, and can upload the latest snapshot to Supabase.

This is intended for private personal use by a logged-in subscriber. Keep publisher cookies in private environment variables only.
