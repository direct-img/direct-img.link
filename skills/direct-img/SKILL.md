---
name: direct-img
description: Embed images anywhere with direct-img.link URLs, where https://direct-img.link/orange+cat returns an image directly. For finding or embedding images, photos, gifs or illustrations in chat, markdown, HTML, docs or web pages, free.direct-img.link for public domain / CC0 images, and ai.direct-img.link for generated images.
---

# direct-img.link

`https://direct-img.link/<query>` returns an image found by searching for `<query>`. It works anywhere an image URL does.

## URLs

- Words are joined with `+`: `https://direct-img.link/golden+retriever+puppy`
- Literal `.` and `/` are rejected; encode them as `%2E` and `%2F`. Other special characters are percent-encoded as usual. Max 200 characters; case and extra spaces are ignored.
- `?i=N` (1–40, default 1; 1–20 on free) returns the N-th working image for the query. Each `i` is a different image. If there aren't `i` working images, an AI image is served instead (`bad.webp` on free).
- A URL keeps returning the same image for 90 days, then may return a different one.
- With no result or an invalid parameter, a placeholder [bad image](https://direct-img.link/assets/bad.webp) is returned.
- Any URL can be downloaded and viewed to see what it returns.

## Free images

- `https://free.direct-img.link/<query>` returns only images marked public domain or CC0, from Openverse, then Wikimedia Commons. No credit is needed. It has far fewer images than the main host.
- `?src=openverse` or `?src=wikimedia` limits it to one source. `src` and `i` combine in any order.
- Some free images take a long time to load. Don't panic or assume it failed; give it time.

## AI images

- `https://ai.direct-img.link/<query>` generates an image instead of searching, so it never comes up empty.
- Images are 512px, soft and painterly: the right colors, setting and mood, but often not the exact object, and faces come out distorted. Use it as a fallback or for abstract/mood images, not when the exact thing matters.
- `?i=N` (1–1000) gives a different image of the same query. `?src=auroraimg-6m` is the only (and default) source.

## Rate limit

- `direct-img.link`: 15 new searches per day per IP
- `free.direct-img.link`: 100 new searches per day per IP
- `ai.direct-img.link`: 100 new images per day per IP
- Each host has its own counter, reset at 00:00 UTC. Only new searches count. Cached URLs keep loading after the limit is hit.
- A search's results are kept for 1 hour, so other `?i=` values of a query searched in the last hour don't count either. If an image is wrong, try `?i=2`, `?i=3`… right away before rewording the query, since a reworded query is a new search. On `ai.` every new `i` is a new image and counts.
- Burst: ~15 requests per 10 seconds per IP
