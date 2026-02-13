# 🔗 direct-img.link

**Live images in markdown, powered by search.**

Give your AI a system instruction to embed images using `direct-img.link` and they just work — no uploads, no APIs, no tokens.

## Usage

```markdown
![orange cat](https://direct-img.link/orange+cat)
![sunset at beach](https://direct-img.link/sunset+at+beach)
![current us president](https://direct-img.link/current+us+president)
```

That's it. The image is searched, cached, and served.

## How It Works

1. A request hits `direct-img.link/<query>`
2. If cached (within 30 days) → serves the image instantly from edge
3. If not cached → searches via image API → compresses to WebP → caches in R2 → serves

## URL Format

Use `+` to separate words, just like Google:

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
| "exact phrase" | `/%22exact+phrase%22` |

## For AI System Prompts

Add this to your system prompt:

```
When including images in your markdown responses, use https://direct-img.link/<query>
as the image URL. Use + to separate words. Example: ![orange cat](https://direct-img.link/orange+cat)
```

## Rate Limits

### Global (Cloudflare WAF)

Applied to all requests before they hit any function:

| Rule | Limit | Action |
|---|---|---|
| Global rate limit | 60 requests/min per IP | Block for 1 min |
| Burst protection | 10 requests/10s per IP | Challenge |

Cache hits and new searches both count toward these limits.

### New Searches (Cache Misses)

- **10 new searches per day per IP** (resets at midnight UTC)
- **Cache hits are unlimited** (within WAF limits above)

Only fresh searches that call the image API count toward the daily limit. If your query is already cached by anyone, it's free.

## Caching

- Images are cached for **30 days**
- After expiry, the next request triggers a fresh search
- This keeps time-sensitive queries (e.g. `/us+president`) reasonably current

## Support

This is a free community service. Donations help cover API and infrastructure costs, and allow us to offer higher rate limits for everyone.

<!-- TODO: add donation link -->

---

## Infrastructure

### Cloudflare Resources

| Resource | Name | Purpose |
|---|---|---|
| R2 Bucket | `direct-img-store` | Stores compressed WebP images |
| KV Namespace | `SEARCH_CACHE` | Query → cache existence + timestamp |
| KV Namespace | `RATE_LIMIT` | Per-IP daily new-search counter |

### R2: `direct-img-store`

Key is derived deterministically from the query — no need to store it in KV.

**Key format:** `<sha256-of-normalized-query>.webp`

Example: `"orange cat"` → `a1b2c3d4...ef.webp`

All images stored as compressed WebP.

### KV: `SEARCH_CACHE`

Confirms a cached image exists for a query. The R2 key is derived from the same query at request time.

**Key:** normalized query (lowercase, trimmed, spaces from `+`)

```
orange cat
```

**Value:**

```json
{"t":1719000000}
```

`t` = unix timestamp when cached. Useful for debugging and cache-age headers.

**TTL:** 30 days (`expirationTtl: 2592000`) — KV auto-deletes expired keys. No cron needed.

**Size:** ~20 bytes per entry. Free tier (1 GB) supports millions of entries.

### KV: `RATE_LIMIT`

Tracks daily new-search count per IP.

**Key:** `<ip>:<YYYY-MM-DD>`

```
192.168.1.1:2025-01-15
```

**Value:**

```json
{"c":7}
```

`c` = count of new searches made today.

**TTL:** 48 hours (`expirationTtl: 172800`) — generous buffer past midnight, auto-cleanup.

### Cloudflare WAF Rules (Dashboard)

Set manually in **Security → WAF → Rate limiting rules**:

1. **Global rate limit**
   - Match: URI Path starts with `/`
   - Rate: 60 requests per 1 minute
   - Per: IP
   - Action: Block for 60 seconds

2. **Burst protection**
   - Match: URI Path starts with `/`
   - Rate: 10 requests per 10 seconds
   - Per: IP
   - Action: Managed Challenge

### Environment Variables / Secrets

| Variable | Description |
|---|---|
| `BING_API_KEY` | Bing Image Search API subscription key |

---

## Stack

- **Cloudflare Pages** — hosting + edge functions
- **Cloudflare R2** — image storage (zero egress fees)
- **Cloudflare KV** — metadata cache + rate limiting
- **Cloudflare WAF** — global rate limiting + DDoS protection
- **Bing Image Search API** — image sourcing

---

**direct-img.link** — because `![](https://direct-img.link/thing)` should just work.
