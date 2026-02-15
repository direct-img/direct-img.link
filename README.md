# 🔗 direct-img.link

**Live images in markdown, powered by search.**

Give your AI a system instruction to embed images using `direct-img.link` and they just work — no uploads, no APIs, no tokens.

## Usage

![orange cat](https://direct-img.link/orange+cat)

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
| **Slashes rejected** | `wp-admin/setup.php` | `bad.webp` served |
| **Max length: 200 characters** | — | 400 error if exceeded |

### Characters that work fine

- **Letters, numbers, spaces** — standard queries
- **Hyphens** (`spider-man`), **dots** (`node.js`), **apostrophes** (`90's`) — passed through
- **Unicode** (`café`, `日本`) — supported via URL encoding

### Slashes must be encoded

Literal slashes (`/`) in the URL path are **rejected** to prevent bot abuse (e.g. `wp-admin/setup-config.php` probes). If your query genuinely contains a slash, encode it as `%2F`:

| Query | URL |
|---|---|
| AC/DC | `/AC%2FDC` ✅ |
| AC/DC | `/AC/DC` ❌ (rejected) |

### Things to know

- **Query parameters (`?...`)** are ignored — `/orange+cat?size=large` → `orange cat`
- **Fragments (`#...`)** are never sent to the server by browsers
- **Double-encoded values** are decoded once — `%2520` becomes `%20` (literal), not a space
- Two queries that normalize to the same string share the same cached image

## For AI System Prompts

Add this to your system instructions:

```
When writing markdown, you can embed relevant images using direct-img.link — a free image search proxy that returns images directly from a URL.

Format:
![alt text](https://direct-img.link/<search+query>)

Examples:
![panda eat](https://direct-img.link/panda+eat)
![US president](https://direct-img.link/u.s.+president)
![90's fashion](https://direct-img.link/90%27s+fashion)

Use images sparingly to complement your responses — not every message needs one.
```

## Rate Limits

### WAF Protection (Cloudflare Free)

| Rule | Limit | Action |
|---|---|---|
| Rate Limit | 10 requests/10s per IP | Block for 10s |

### New Searches (Cache Misses)

- **15 new searches per day per IP** (resets at midnight UTC)
- **Cache hits are unlimited** (within WAF limits above)
- **Brave API quota:** $5 free monthly credits (1,000 queries), then $5/1k requests

## Caching

- Images are cached for **30 days**
- After expiry, the next request triggers a fresh search
- Images are stored in their original format as fetched from source

## Support

Free community service. Donations help cover API and infrastructure costs.

**BTC:** `bc1qkqdmhk0we49qn74ua9752ysfxzd7uxqettymhv`

---

## Self-Hosting

### 1. Brave Search API Key

1. Go to [brave.com/search/api](https://brave.com/search/api/)
2. Click **Get Started**
3. Create a Brave account or sign in
4. Subscribe — you get **$5 in free monthly credits** (covers 1,000 queries/month)
5. Go to your [API dashboard](https://api.search.brave.com/app/#/subscriptions)
6. Copy your **API key** (starts with `BSA...`)

### 2. Cloudflare Resources

Create in your Cloudflare dashboard:

| Resource | Name | Purpose |
|---|---|---|
| R2 Bucket | `direct-img-store` | Stores cached images |
| KV Namespace | `DIRECT_IMG_CACHE` | Cache existence + content type + timestamp |
| KV Namespace | `DIRECT_IMG_RATE` | Per-IP daily search tracking |

### 3. Pages Bindings

**Settings → Functions → Bindings:**

| Type | Variable | Resource |
|---|---|---|
| R2 Bucket | `R2_IMAGES` | `direct-img-store` |
| KV Namespace | `DIRECT_IMG_CACHE` | `DIRECT_IMG_CACHE` |
| KV Namespace | `DIRECT_IMG_RATE` | `DIRECT_IMG_RATE` |

### 4. Secrets

**Settings → Environment variables:**

| Variable | Description | Required |
|---|---|---|
| `BRAVE_API_KEY` | Brave Search API key | Yes |
| `NTFY_URL` | ntfy.sh topic URL for traffic/error alerts | Optional |

### 5. WAF Rules

**Security → WAF → Rate limiting rules:**

1. **Rate Limit** — 10 req/10s per IP → Block 10s

### 6. Deploy

Fork this repo, connect to Cloudflare Pages, deploy.

---

## Infrastructure Details

### R2: `direct-img-store`

**Key:** `<sha256-of-normalized-query>` — derived from query, no lookup needed. Stored with original content type from source.

### KV: `DIRECT_IMG_CACHE`

**Key:** normalized query (lowercase, trimmed, max 200 chars) → **Value:** `{"t":1719000000,"ct":"image/jpeg"}` — **TTL:** 30 days

### KV: `DIRECT_IMG_RATE`

Each new search writes a unique key to avoid race conditions with concurrent requests:

**Key:** `<ip>:<YYYY-MM-DD>:<timestamp>-<uuid>` → **Value:** `"1"` — **TTL:** 48 hours

To check usage, `list({ prefix: "<ip>:<YYYY-MM-DD>:" })` counts the keys. No read-modify-write, no race condition.

---

## Stack

- **Cloudflare Pages** — hosting + edge functions
- **Cloudflare R2** — image storage
- **Cloudflare KV** — cache + rate limiting
- **Cloudflare WAF** — rate limiting + DDoS protection
- **Brave Image Search API** — image sourcing

---

**direct-img.link** — because `![](https://direct-img.link/thing)` should just work.
