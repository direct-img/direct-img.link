// New searches (cache misses) allowed per IP per day, reset at 00:00 UTC. Cache hits never count.
// Safe to edit by hand. The homepage reads these automatically; README.md needs a manual update.
// The burst limit (~10 req/10s) is a Cloudflare WAF rule, not set here.
export const DAILY_LIMIT = 35;
export const FREE_DAILY_LIMIT = 100;
