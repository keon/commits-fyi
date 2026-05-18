#!/usr/bin/env node
// Refresh the server-side AI-share cache.
// For each user in data/_cache/users.json, hit GitHub Search Commits API once
// per AI tool to count commits with that tool's attribution signature.
// Heavily throttled (search API caps at 30 req/min). Processes MAX_PER_RUN
// users per invocation; subsequent cron runs work through the backlog and
// refresh entries older than AI_TTL_DAYS.
//
// Usage:  GH_TOKEN=ghp_xxx MAX_PER_RUN=100 node scripts/refresh-ai-share.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const CACHE_DIR = join(DATA_DIR, '_cache');
const USERS_CACHE = join(CACHE_DIR, 'users.json');
const AI_CACHE = join(CACHE_DIR, 'ai_share.json');

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('Need GH_TOKEN or GITHUB_TOKEN'); process.exit(1); }

const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '100', 10);
const AI_TTL_DAYS = 7;
const SLEEP_MS = 2500; // ~24 req/min, under the 30/min search limit
const SAVE_EVERY = 5;

// Same signatures as the frontend AI_TOOLS array
const AI_TOOLS = [
  { id: 'claude',    signature: '"noreply@anthropic.com"' },
  { id: 'cursor',    signature: '"cursoragent"' },
  { id: 'devin',     signature: '"devin-ai-integration"' },
  { id: 'aider',     signature: '"noreply@aider.chat"' },
  { id: 'sweep',     signature: '"sweep-ai"' },
  { id: 'openhands', signature: '"openhands-agent"' },
  { id: 'copilot',   signature: '"Copilot <198982749+Copilot@users.noreply.github.com>"' },
];

async function searchCommitsCount(q) {
  const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=1`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'commits-fyi-ai-fetcher',
    },
  });
  if (res.status === 403 || res.status === 429) {
    const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
    const wait = Math.max(5000, reset - Date.now() + 2000);
    console.warn(`  Rate-limited; waiting ${Math.round(wait/1000)}s`);
    if (wait > 30 * 60 * 1000) throw new Error('Rate-limit reset >30min');
    await new Promise(r => setTimeout(r, wait));
    return searchCommitsCount(q);
  }
  if (res.status === 422) return 0; // user has no commits indexed
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.total_count || 0;
}

async function computeAiShare(login) {
  const total = await searchCommitsCount(`author:${login}`);
  await new Promise(r => setTimeout(r, SLEEP_MS));
  const tools = {};
  for (const t of AI_TOOLS) {
    tools[t.id] = await searchCommitsCount(`author:${login} ${t.signature}`);
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }
  return { total, tools };
}

async function main() {
  if (!existsSync(USERS_CACHE)) {
    console.error(`No user cache at ${USERS_CACHE} — run scripts/fetch.mjs first.`);
    process.exit(1);
  }
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });

  const usersCache = JSON.parse(await readFile(USERS_CACHE, 'utf8'));
  let aiCache = { version: 1, entries: {} };
  if (existsSync(AI_CACHE)) {
    try { aiCache = JSON.parse(await readFile(AI_CACHE, 'utf8')); }
    catch (e) { console.warn(`AI cache unreadable, starting fresh: ${e.message}`); }
  }

  const ttlMs = AI_TTL_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Only User accounts — orgs don't author commits via /search/commits
  const allUserLogins = Object.entries(usersCache.entries)
    .filter(([, e]) => e?.payload?.acct?.type === 'User')
    .map(([login]) => login);

  const stale = allUserLogins.filter(login => {
    const existing = aiCache.entries[login];
    if (!existing) return true;
    return (now - new Date(existing.fetched_at).getTime()) > ttlMs;
  });

  console.log(`User accounts in cache: ${allUserLogins.length}`);
  console.log(`Stale/missing AI entries: ${stale.length}`);
  const batch = stale.slice(0, MAX_PER_RUN);
  console.log(`Processing ${batch.length} this run\n`);

  let processed = 0;
  for (const login of batch) {
    try {
      const data = await computeAiShare(login);
      aiCache.entries[login] = { fetched_at: new Date().toISOString(), ...data };
      const aiSum = Object.values(data.tools).reduce((s, n) => s + n, 0);
      const pct = data.total ? ((aiSum / data.total) * 100).toFixed(2) : '0.00';
      console.log(`[${++processed}/${batch.length}] ${login}: total=${data.total} ai_tagged=${aiSum} (${pct}%)`);
    } catch (e) {
      console.warn(`[${++processed}/${batch.length}] ${login} FAILED: ${e.message}`);
    }
    // Save incrementally so workflow-timeout doesn't lose progress.
    if (processed % SAVE_EVERY === 0) {
      aiCache.updated_at = new Date().toISOString();
      await writeFile(AI_CACHE, JSON.stringify(aiCache));
    }
  }

  aiCache.updated_at = new Date().toISOString();
  await writeFile(AI_CACHE, JSON.stringify(aiCache));
  console.log(`\nDone. Cache now has ${Object.keys(aiCache.entries).length} entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
