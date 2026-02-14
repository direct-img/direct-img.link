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

## How It Works

1. A request hits `direct-img.link/<query>`
2. If cached (within 30 days) → serves the image instantly from R2
3. If not cached → searches via Brave Image Search API → stores in R2 → serves

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
| "exact phrase" | `/%22exact+phrase%22` |

## For AI System Prompts

```
When including images in your markdown responses, use https://direct-img.link/<query>
as the image URL. Use + to separate words. Example: ![orange cat](https://direct-img.link/orange+cat)
```

## Rate Limits

### Global (Cloudflare WAF)

| Rule | Limit | Action |
|---|---|---|
| Global rate limit | 60 requests/min per IP | Block for 1 min |
| Burst protection | 10 requests/10s per IP | Challenge |

### New Searches (Cache Misses)

- **10 new searches per day per IP** (resets at midnight UTC)
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
| KV Namespace | `DIRECT_IMG_RATE` | Per-IP daily search counter |

### 3. Pages Bindings

**Settings → Functions → Bindings:**

| Type | Variable | Resource |
|---|---|---|
| R2 Bucket | `R2_IMAGES` | `direct-img-store` |
| KV Namespace | `DIRECT_IMG_CACHE` | `DIRECT_IMG_CACHE` |
| KV Namespace | `DIRECT_IMG_RATE` | `DIRECT_IMG_RATE` |

### 4. Secrets

**Settings → Environment variables:**

| Variable | Description |
|---|---|
| `BRAVE_API_KEY` | Brave Search API key |

### 5. WAF Rules

**Security → WAF → Rate limiting rules:**

1. **Global** — 60 req/min per IP → Block 60s
2. **Burst** — 10 req/10s per IP → Challenge

### 6. Deploy

Fork this repo, connect to Cloudflare Pages, deploy.

---

## Infrastructure Details

### R2: `direct-img-store`

**Key:** `<sha256-of-normalized-query>` — derived from query, no lookup needed. Stored with original content type from source.

### KV: `DIRECT_IMG_CACHE`

**Key:** normalized query (lowercase, trimmed) → **Value:** `{"t":1719000000,"ct":"image/jpeg"}` — **TTL:** 30 days

### KV: `DIRECT_IMG_RATE`

**Key:** `<ip>:<YYYY-MM-DD>` → **Value:** `{"c":7}` — **TTL:** 48 hours

---

## Stack

- **Cloudflare Pages** — hosting + edge functions
- **Cloudflare R2** — image storage
- **Cloudflare KV** — cache + rate limiting
- **Cloudflare WAF** — rate limiting + DDoS protection
- **Brave Image Search API** — image sourcing

---

**direct-img.link** — because `![](https://direct-img.link/thing)` should just work.
