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
3. If not cached → searches via Google Custom Search API → compresses to WebP → caches in R2 → serves

## URL Format

Use `+` to separate words:

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
- **Google API quota:** 100 free queries/day, then $5/1k

## Caching

- Images are cached for **30 days**
- After expiry, the next request triggers a fresh search

## Support

Free community service. Donations help cover API and infrastructure costs.

**BTC:** `bc1qkqdmhk0we49qn74ua9752ysfxzd7uxqettymhv`

---

## Self-Hosting

### 1. Google Programmable Search Engine

1. Go to [programmablesearchengine.google.com](https://programmablesearchengine.google.com/) → **Add**
2. Toggle **Image search** to **On**
3. Under **Sites to search**, add the sites from [`assets/sites-to-search.xml`](assets/sites-to-search.xml)
4. **Save** and copy your **Search Engine ID** (`cx`)
5. You can edit this site list anytime from the control panel

### 2. Google Custom Search API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → **APIs & Services → Library**
3. Enable **Custom Search API**
4. **APIs & Services → Credentials → Create Credentials → API Key**

### 3. Cloudflare Resources

Create in your Cloudflare dashboard:

| Resource | Name | Purpose |
|---|---|---|
| R2 Bucket | `direct-img-store` | Stores compressed WebP images |
| KV Namespace | `DIRECT_IMG_CACHE` | Cache existence + timestamp |
| KV Namespace | `DIRECT_IMG_RATE` | Per-IP daily search counter |

### 4. Pages Bindings

**Settings → Functions → Bindings:**

| Type | Variable | Resource |
|---|---|---|
| R2 Bucket | `R2_IMAGES` | `direct-img-store` |
| KV Namespace | `DIRECT_IMG_CACHE` | `DIRECT_IMG_CACHE` |
| KV Namespace | `DIRECT_IMG_RATE` | `DIRECT_IMG_RATE` |

### 5. Secrets

**Settings → Environment variables:**

| Variable | Description |
|---|---|
| `GOOGLE_API_KEY` | Custom Search API key |
| `GOOGLE_CSE_ID` | Search Engine ID (`cx`) |

### 6. WAF Rules

**Security → WAF → Rate limiting rules:**

1. **Global** — 60 req/min per IP → Block 60s
2. **Burst** — 10 req/10s per IP → Challenge

### 7. Deploy

Fork this repo, connect to Cloudflare Pages, deploy.

---

## Infrastructure Details

### R2: `direct-img-store`

**Key:** `<sha256-of-normalized-query>.webp` — derived from query, no lookup needed.

### KV: `DIRECT_IMG_CACHE`

**Key:** normalized query (lowercase, trimmed) → **Value:** `{"t":1719000000}` — **TTL:** 30 days

### KV: `DIRECT_IMG_RATE`

**Key:** `<ip>:<YYYY-MM-DD>` → **Value:** `{"c":7}` — **TTL:** 48 hours

---

## Stack

- **Cloudflare Pages** — hosting + edge functions
- **Cloudflare R2** — image storage
- **Cloudflare KV** — cache + rate limiting
- **Cloudflare WAF** — rate limiting + DDoS protection
- **Google Custom Search API** — image sourcing

---

**direct-img.link** — because `![](https://direct-img.link/thing)` should just work.
