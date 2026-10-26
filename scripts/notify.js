// Sends the deploy's outcome to ntfy: what got promoted, how close the account is to the free plan's limits, and what
// to do when something needs attention. Runs last in .github/workflows/deploy.yml, even when an earlier step failed.
import { readFile } from "node:fs/promises";

const env = process.env;
const r = JSON.parse(await readFile("promoted/report.json", "utf8").catch(() => "{}"));
const fmt = n => Math.round(n).toLocaleString("en-US");
const gb = b => `${(b / 1e9).toFixed(2)} GB`;
const pct = (a, b) => `${Math.round((100 * a) / b)}%`;
const lines = [], actions = [];

if (env.STATUS !== "success") {
  actions.push(`${env.FAILED_STEP || "A step"} failed, so the site still runs the previous deploy. Open the run for the error.`);
}
if (r.ok) {
  lines.push(`Static images: ${fmt(r.promoted)} / ${fmt(r.maxFiles)} slots, ${gb(r.bytes)} / ${gb(r.maxBytes)}`);
  lines.push(`+${fmt(r.added)} promoted, −${fmt(r.removed)} dropped (min ${r.minViews} views in ${r.days} days)`);
  if (r.views?.total) lines.push(`They got ${pct(r.promotedViews, r.views.total)} of ${fmt(r.views.total)} image views in ${r.days} days`);
  // web/1/orange+cat → orange cat, free/2/orange+cat → orange cat i=2 [free]
  const label = id => id.replace(/^(\w+)\/(\d+)\/(.*)$/, (_, f, i, q) => `${q.replaceAll("+", " ")}${i > 1 ? ` i=${i}` : ""}${f !== "web" ? ` [${f}]` : ""}`);
  if (r.top?.length) lines.push(`Top: ${r.top.map(t => `${label(t.id)} (${fmt(t.views)})`).join(", ")}`);
  if (r.notFitted) actions.push(`All ${fmt(r.maxFiles)} static slots are full and ~${fmt(r.notFitted)} more images qualified. Workers Paid ($5/mo) allows 100,000 files.`);
  if (r.skipped.budget) actions.push(`Size budget full: ${fmt(r.skipped.budget)} images left out. Raise MAX_BYTES in deploy.yml (runner disk ~14 GB, Actions cache 10 GB).`);
  if (r.skipped.failed) actions.push(`${fmt(r.skipped.failed)} downloads from R2 failed, e.g. ${r.firstError}. They're retried next run.`);
  if (r.analyticsError) actions.push(`Couldn't read Cloudflare analytics (${r.analyticsError}), so the last run's images were kept. Check the API token's Analytics permission.`);
}
if (r.workers) {
  const { total, byScript } = r.workers;
  const top = Object.entries(byScript).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s} ${fmt(n)}`).join(", ");
  lines.push(`Worker requests yesterday: ${fmt(total)} / 100,000 (${pct(total, 1e5)})${top && `: ${top}`}`);
  if (total >= 8e4) actions.push(`Worker requests hit ${pct(total, 1e5)} of the free 100,000/day; past it, images that aren't static files break until 00:00 UTC. Lower MIN_VIEWS to promote more, or move to Workers Paid ($5/mo).`);
}
if (r.workersError) lines.push(`Couldn't read Worker usage: ${r.workersError}`);

const failed = env.STATUS !== "success";
const body = [...lines, ...actions.map(a => `⚠ ${a}`)].join("\n") || "No report was written.";
console.log(body);
if (!env.NTFY_URL) process.exit(0);
const res = await fetch(env.NTFY_URL.startsWith("http") ? env.NTFY_URL : `https://${env.NTFY_URL}`, {
  method: "POST",
  body,
  headers: {
    Title: failed ? "direct-img deploy failed" : actions.length ? "direct-img deploy needs attention" : `direct-img deployed (${env.TRIGGER || "manual"})`,
    Priority: failed ? "5" : actions.length ? "4" : "2",
    Tags: failed ? "rotating_light,x" : actions.length ? "warning" : "white_check_mark",
    ...(env.RUN_URL && { Click: env.RUN_URL }),
    ...(env.NTFY_TOKEN && { Authorization: `Bearer ${env.NTFY_TOKEN}` }),
  },
});
console.log(`ntfy: HTTP ${res.status}`);
