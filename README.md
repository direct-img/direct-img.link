# 🔗 direct-img.link

**Live images in markdown, powered by search.**

Give your AI a system instruction to embed images using `direct-img.link` and they just work — no uploads, no APIs, no tokens.

## Usage

![orange cat](https://free.direct-img.link/orange+cat)

```markdown
![orange cat](https://direct-img.link/orange+cat)
![sunset at beach](https://direct-img.link/sunset+at+beach)
![current us president](https://direct-img.link/current+us+president)
```

That's it. The image is searched, cached, and served.

## URL Format

Use `+` to separate words, like Google:

```
https://direct-img.link/orange+cat
https://direct-img.link/new+york+city
```

| Query | URL |
|---|---|
| orange cat | `/orange+cat` |
| spider-man | `/spider-man` |
| u.s. president | `/u.s.+president` |
| 90's fashion | `/90%27s+fashion` |

### Picking a Result

Add `?i=` to serve a later search result instead of the first, e.g. when the first image isn't the one you want:

```
https://direct-img.link/orange+cat?i=2
```

- `i` is `1`–`40`, default `1`. Higher values serve `max-i.webp`, which lists each site's range, and other invalid values serve `bad.webp`
- Leading zeros are ignored (`?i=02` = `?i=2`)
- Only images that download count, so broken links and deleted photos are skipped and every `i` is a different image. `?i=2` is the 2nd working image
- Higher `i` values take a little longer the first time, since the working images before it are downloaded to count them
- If there aren't `i` working images, an [AI image](#ai-images) is served instead (except on [free.](#free-images) with a `src`, which serves `bad.webp`)
- Each `i` is cached separately. A search's results are kept for **1 hour**, so other `i` values of the same query within that hour don't search again and **don't count toward the limit**. One that was already counted downloads only its own image

## Query Normalization

All queries are normalized before caching and searching:

| Rule | Example | Result |
|---|---|---|
| `+` and `%20` are treated as spaces | `orange+cat`, `orange%20cat` | `orange cat` |
| Lowercased | `Orange+Cat` | `orange cat` |
| Trimmed | `+orange+cat+` | `orange cat` |
| Multiple spaces collapsed | `orange++cat` | `orange cat` |
| Trailing slashes stripped | `orange+cat/` | `orange cat` |
| Control characters removed | `orange\x00cat` | `orangecat` |
| **Slashes & Dots rejected** | `info.php`, `wp-admin/` | `bad.webp` served |
| **Max length: 200 characters** | — | 400 error if exceeded |

### Characters that work fine

- **Letters, numbers, spaces** — standard queries
- **Hyphens** (`spider-man`), **apostrophes** (`90's`) — passed through
- **Unicode** (`café`, `日本`) — supported via URL encoding

### Slashes and Dots must be encoded

Literal slashes (`/`) and dots (`.`) in the URL path are **rejected** to prevent bot abuse (e.g. `info.php` or `wp-admin/` probes). If your query genuinely contains these characters, you must encode them:

| Query | URL |
|---|---|
| AC/DC | `/AC%2FDC` ✅ |
| node.js | `/node%2Ejs` ✅ |
| info.php | `/info.php` ❌ (rejected) |
| AC/DC | `/AC/DC` ❌ (rejected) |

### Things to know

- **Query parameters (`?...`)** other than `i` (and `src` on [free.](#free-images) and [ai.direct-img.link](#ai-images)) serve `bad.webp` — `/orange+cat?size=large` ❌
- **Fragments (`#...`)** are never sent to the server by browsers
- **Double-encoded values** are decoded once — `%2520` becomes `%20` (literal), not a space
- Two queries that normalize to the same string share the same cached image
- **Nothing found?** If a search finds no image (or fewer than `i` working ones), an [AI image](#ai-images) of the query is served instead of `bad.webp`, and cached like any other image. `bad.webp` is only served if the AI image fails too, or on [free.](#free-images) with a `src`
- **Out of searches?** If Brave refuses (e.g. its monthly spending limit is reached), Bing is searched instead. If Bing is blocking us too, `donate.webp` is served instead of an AI image, and nothing is cached, so the query works again once either is back

## Free Images

Need images you can publish? `free.direct-img.link` only serves images marked **free of restrictions** (public domain or CC0), so no credit is needed. Same URL format, plus an optional `src`:

```markdown
![orange cat](https://free.direct-img.link/orange+cat)
![orange cat](https://free.direct-img.link/orange+cat?i=2)
![orange cat](https://free.direct-img.link/orange+cat?src=wikimedia&i=2)
```

| Param | Values | Default |
|---|---|---|
| `src` | `openverse`, `wikimedia` (case-insensitive) | Openverse's results, then Wikimedia's |
| `i` | `1`–`20` — works the same as [on the main site](#picking-a-result) | `1` |

- Both are optional and can be used alone or together, in any order (`?i=2&src=wikimedia` = `?src=wikimedia&i=2`)
- `i` above `20` serves `max-i.webp`, which lists each site's range. Other invalid values serve `bad.webp`
- With a `src`, only that source's images are served: if it has no image (or fewer than `i` working ones), `bad.webp` is served (remembered for 24h) instead of an AI image. Without one, an AI image is served like on the main site
- Each `src` + `i` + query combination is cached separately. Like the main site, other `i` values within an hour of a search reuse its results and don't count as searches

**Sources:**

- [Openverse](https://openverse.org) — searched with `license=cc0,pdm`, JPG/PNG/GIF/WebP only. Made using the Openverse API, but not endorsed or certified by Openverse.
- [Wikimedia Commons](https://commons.wikimedia.org) — searched with `filetype:bitmap haslicense:unrestricted` (Commons' own "no restrictions" filter). Served at up to 1920px wide.

Licenses come from each source's metadata and can be wrong. Check the original before publishing anything important.

## AI Images

`ai.direct-img.link` generates an image of anything instead of searching, so it never comes up empty. Same URL format, plus an optional `src`:

```markdown
![frog wizard](https://ai.direct-img.link/frog+wizard)
![frog wizard](https://ai.direct-img.link/frog+wizard?i=2)
![frog wizard](https://ai.direct-img.link/frog+wizard?src=auroraimg-6m&i=2)
```

| Param | Values | Default |
|---|---|---|
| `src` | `auroraimg-6m` (case-insensitive) | `auroraimg-6m` |
| `i` | `1`–`1000` — each is a different image of the same query | `1` |

- The same query, `src` and `i` always give the same image
- `i` above `1000` serves `max-i.webp`, which lists each site's range. Other invalid values serve `bad.webp`
- Images come from [AuroraIMG-6M](https://github.com/direct-img/AuroraIMG-6M), a tiny 6.8M-parameter model running on our own server. They're 512px, soft and painterly: the right colors, setting and mood, but often not the exact object, and faces come out distorted
- The same model makes the fallback images for searches that find nothing

## For AI System Prompts

Add this to your system instructions:

```
When writing markdown, embed relevant images/gifs using direct-img.link — a free image search proxy that returns images directly from a URL. But keep it entertaining, for example use it to show reaction faces, girl, or fun, not technical.
Example structure:
![Cat Gif](https://direct-img.link/cat+gif)
Use images to complement your responses, powered by Brave.
```

## Rate Limits

Limits change over time, so they aren't listed here. **Check the Rate Limits section on [direct-img.link](https://direct-img.link) for the current limits.**

- **New searches (cache misses)** are limited per IP per day, then `limit.webp` is served. `direct-img.link`, `free.direct-img.link` and `ai.direct-img.link` have separate counters, all reset at midnight UTC
- **Cache hits are unlimited** (within the burst limit)
- Other `?i=` values of a query searched in the last hour reuse its results, so they don't count (except on `ai.`, where each `i` is a new image)
- If Brave's spending limit is hit, searches use Bing; if Bing also blocks us, `donate.webp` is served (not cached)
- Searches that find nothing count toward the limit. If the AI image served instead fails too (or there's none, on `free.` with a `src`), the failure is remembered for 24h (`bad.webp`)
- A Cloudflare WAF burst limit applies to all requests (HTTP 429). Its counters are approximate (not shared perfectly across Cloudflare servers), so bursts may slip slightly past it

## Caching

- Images are cached for **90 days**, including AI images
- After expiry, the next request triggers a fresh search
- A search's list of results is kept for **1 hour** (in SurrealDB), so the query's other `?i=` values don't search again
- Images are stored in their original format as fetched from source (AI images are WebP)
- A matching R2 lifecycle rule deletes stored objects after 90 days

## Support

Free community service. Donations help cover API and infrastructure costs.

**GitHub Sponsors:** [github.com/sponsors/multipleof4](https://github.com/sponsors/multipleof4)

**BTC:** `bc1q3d975cd57205dx6mz05s2g27xujxsc3q0nlv59`

---

## Self-Hosting

### 1. Brave Search API Key

1. Go to [brave.com/search/api](https://brave.com/search/api/)
2. Click **Get Started**
3. Create a Brave account or sign in
4. Subscribe — you get **$5 in free monthly credits** (covers 1,000 queries/month)
5. Go to your [API dashboard](https://api.search.brave.com/app/#/subscriptions)
6. Copy your **API key** (starts with `BSA...`)
7. Optional: set a monthly spending limit there so you never pay past the credit. Once it's reached, searches fall back to Bing

### 2. Openverse API Credentials (Optional)

Free images work without credentials, but anonymous Openverse requests are limited to 200/day. Register once to get higher limits:

```bash
curl -X POST -H "Content-Type: application/json" -d '{"name":"<unique app name>","description":"<what you use it for>","email":"<your email>"}' https://api.openverse.org/v1/auth_tokens/register/
```

1. Save the returned `client_id` and `client_secret` — they can't be retrieved later
2. Click the verification link Openverse emails you (until then, anonymous limits apply)
3. Add them as the `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET` secrets below

The function exchanges them for an access token (valid ~12h) and caches it in KV, fetching a new one automatically when it expires.

### 3. Cloudflare Resources

Create in your Cloudflare dashboard:

| Resource | Name | Purpose |
|---|---|---|
| R2 Bucket | `direct-img-store` | Stores cached images |
| KV Namespace | `DIRECT_IMG_CACHE` | Cache existence + content type + timestamp |

### 4. Pages Bindings

**Settings → Functions → Bindings:**

| Type | Variable | Resource |
|---|---|---|
| R2 Bucket | `R2_IMAGES` | `direct-img-store` |
| KV Namespace | `DIRECT_IMG_CACHE` | `DIRECT_IMG_CACHE` |

### 5. Secrets

**Settings → Environment variables:**

| Variable | Description | Required |
|---|---|---|
| `BRAVE_API_KEY` | Brave Search API key | Yes |
| `OPENVERSE_CLIENT_ID` | Openverse app client ID (free images) | Optional |
| `OPENVERSE_CLIENT_SECRET` | Openverse app client secret (free images) | Optional |
| `SURREAL_URL` | SurrealDB URL (e.g. `https://db.site.com`) | Yes |
| `SURREAL_USER` | SurrealDB username | Yes |
| `SURREAL_PASS` | SurrealDB password | Yes |
| `NTFY_URL` | ntfy.sh topic URL for alerts | Optional |
| `GOATCOUNTER_URL` | GoatCounter site URL for image hit analytics (e.g. `https://direct-img.goatcounter.com`) | Optional |
| `GOATCOUNTER_TOKEN` | GoatCounter API token with "Record pageviews" permission | Optional |
| `AURORA_API_KEY` | Key for the [AuroraIMG-6M API](https://github.com/direct-img/AuroraIMG-6M) (AI images and the nothing-found fallback). Without it, `ai.` serves `bad.webp` and searches that find nothing serve `bad.webp` | Optional |

### 6. WAF Rules

**Security → WAF → Rate limiting rules:**

1. **Rate Limit** — 10 req/10s per IP → Block 10s

### 7. Deploy

Fork this repo, connect to Cloudflare Pages, deploy.

### 8. Free and AI Images Domains

**Pages project → Custom domains → Set up a domain:** add `free.<your-domain>` and `ai.<your-domain>`. Any hostname starting with `free.` serves free images, and any starting with `ai.` serves AI images; everything else serves regular search.

---

## Infrastructure Details

### R2: `direct-img-store`

**Key:** `<sha256-of-KV-key>` (see below) — for a plain query with no `i`, that's the SHA-256 of the normalized query. Free images use `free/<sha256-of-KV-key>`, AI images `ai/<sha256-of-KV-key>`. Derived from the request, no lookup needed. Stored with original content type from source.

Add an object lifecycle rule in **R2 → direct-img-store → Settings** that applies to all prefixes and deletes uploaded objects after **90 days**. This removes expired objects even when their query is never requested again.

### KV: `DIRECT_IMG_CACHE`

**Key:** normalized query (lowercase, trimmed, max 200 chars) → **Value:** `{"t":1719000000,"ct":"image/jpeg"}` — **TTL:** 90 days

Other keys share the namespace. They use uppercase prefixes, which can never collide with normalized (always lowercase) queries:

| Key | Value | TTL |
|---|---|---|
| `WEB:<i>:<query>` — main site with `i` > 1 (e.g. `WEB:2:orange cat`) | Same as above | 90 days |
| `FREE:<src or auto>:<i>:<query>` (e.g. `FREE:wikimedia:2:orange cat`) | Same as above | 90 days |
| `AI:<src>:<i>:<query>` (e.g. `AI:auroraimg-6m:2:frog wizard`) | Same as above | 90 days |
| `OPENVERSE_TOKEN` | Openverse access token | Token lifetime minus 10 min |
| `SURREAL_TOKEN` | SurrealDB access token, sent instead of the password, which SurrealDB takes ~50ms to check on every request | Token lifetime minus 10 min |

An AI image served because a search found nothing is stored under the search's own key, like any other image. A search where that also fails, or a `free.` search with a `src` (which gets no AI image), stores `{"t":…,"err":true}` for 24h.

### Database: `SurrealDB` (Rate Limiting, Search Locks + Result Lists)

Using atomic database transactions over HTTP to track per-IP/per-day search frequencies securely and rapidly.

The same transaction also claims a per-query lock (`lock:<sha256-of-KV-key>`, expires after 45s), so when several requests miss the cache for the same query at once (on any Cloudflare server), only one searches. The others wait for it to finish, then serve the image it stored in R2, and aren't counted toward the daily limit. The lock is deleted as soon as the result is stored.

Each search also saves its result URLs as `results:<sha256 of site, src and query>` for 1 hour, with the indexes of the images that worked so far (`pos`) and the first URL not yet tried (`next`). The transaction returns that record when it exists, and then doesn't count the request. A `?i=` already in `pos` downloads only its own image, and a new one carries on from `next`, extending the record. Expired records are deleted by the same occasional cleanup as old rate counters.

**Note:** This implementation is tested and verified for **SurrealDB v2.6.5**.

After deploying, visit `https://<your-domain>/_setup` once. It creates the `direct_img` namespace, `rate_limit` database, `rate` table, an `updated_at` index (used by the cleanup query), the `lock` table and the `results` table. It's idempotent, so visiting again is harmless, and it returns `{"ok":true}` on success.

---

## Stack

- **Cloudflare Pages** — hosting + edge functions
- **Cloudflare R2** — image storage
- **Cloudflare KV** — generic lookups
- **SurrealDB (v2.6.5)** — atomic rate limiting, search locks + cached result lists
- **Cloudflare WAF** — layer 7 mitigation
- **Brave Image Search API** — image sourcing, with Bing as the fallback
- **Openverse API + Wikimedia Commons API** — free image sourcing
- **[AuroraIMG-6M](https://github.com/direct-img/AuroraIMG-6M) on Dokploy** — AI images and the nothing-found fallback

---

**direct-img.link** — because `![](https://direct-img.link/thing)` should just work.
