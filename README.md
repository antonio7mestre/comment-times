# The Comment Times

A private reader for New York Times, Wall Street Journal, and Washington Post comments, presented as a minimal feed. The app can run locally from `data/latest.json`, or remotely with Supabase Auth, Supabase Postgres, and Render cron jobs.

## What Each Account Does

- GitHub stores the code and connects to Render.
- Render hosts the web app and runs the daily scrape.
- Supabase handles real email signup/login, saved likes/bookmarks, and uploaded feed snapshots.
- Resend sends the Supabase magic-link emails through custom SMTP.
- NYT and WSJ subscriber sessions provide the cookies used by the scraper.

Google Cloud, a domain, and Cloudflare are optional and are not required for the first hosted version.

## Local Setup

```sh
cp .env.example .env
npm run scrape -- --force --past-24h --deep
npm run dev
```

Open the printed local URL, usually `http://127.0.0.1:4173/`.

Without Supabase env vars, likes and bookmarks are saved in browser localStorage. With Supabase env vars, the same UI syncs them to your account.

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

Enable email auth in Supabase. For Resend SMTP, use Resend's SMTP credentials in Supabase Auth SMTP settings, then add the local and Render URLs as allowed redirect URLs.

## Render

`render.yaml` defines:

- `comment-times`: the web service.
- `comment-times-daily-scrape-pdt`: 13:00 UTC.
- `comment-times-daily-scrape-pst`: 14:00 UTC.

Both cron jobs run the same guarded command. Only the one that lands at 6 AM in `America/Los_Angeles` actually scrapes, which handles daylight saving time.

Cron command:

```sh
npm run scrape:daily
```

Manual force command:

```sh
npm run scrape:daily:force
```

## GitHub Actions

`.github/workflows/daily.yml` is kept as a fallback remote scheduler. It runs at 13:00 and 14:00 UTC, skips unless the Los Angeles hour is 6, runs the daily scrape/upload, builds, and commits `data/` as a backup.

Add these GitHub secrets if you use Actions:

```txt
NYT_COOKIE
WSJ_COOKIE
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

## Scraper Notes

The daily scrape uses:

```sh
node scripts/scrape.mjs --force --past-24h --deep
```

It scans all candidate articles in the rolling 24-hour window, stores comments from NYT, WSJ, and WaPo, writes `data/YYYY-MM-DD.json`, updates `data/latest.json`, and can upload the latest snapshot to Supabase.

This is intended for private personal use by a logged-in subscriber. Keep publisher cookies in private environment variables only.
