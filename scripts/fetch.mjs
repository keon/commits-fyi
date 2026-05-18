#!/usr/bin/env node
// Fetch GitHub city rankings and write to data/<slug>.json.
// Usage: GH_TOKEN=ghp_xxx node scripts/fetch.mjs "New York" ["San Francisco" ...]
// Or:    GH_TOKEN=ghp_xxx node scripts/fetch.mjs --all

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');

const CITIES = [
  'New York',
  'San Francisco',
  'Seattle',
  'Austin',
  'Toronto',
  'London',
  'Berlin',
  'Paris',
  'Amsterdam',
  'Tel Aviv',
  'Tokyo',
  'Seoul',
  'Singapore',
  'Bangalore',
  'Sydney',
];

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('Set GH_TOKEN or GITHUB_TOKEN env var.');
  process.exit(1);
}

const TOP_USERS = 50;
const TOP_ORGS = 30;
const TOP_REPOS = 50;
const CONCURRENCY = 8;

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function gh(path, { retry = 3 } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  for (let attempt = 0; attempt < retry; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'githubranking-fetcher',
      },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
      const waitMs = Math.max(2000, reset - Date.now() + 1000);
      const remaining = res.headers.get('x-ratelimit-remaining');
      console.warn(`Rate-limited (remaining=${remaining}). Waiting ${Math.round(waitMs/1000)}s…`);
      if (waitMs > 15 * 60 * 1000) throw new Error('Rate-limit reset >15min away, aborting.');
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.status >= 500 && attempt < retry - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} ${url}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`Failed after ${retry} retries: ${url}`);
}

async function pmap(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) {
        console.warn(`item ${idx} failed: ${e.message}`);
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function searchAccounts(city, type, count) {
  const perPage = Math.min(100, count);
  const q = encodeURIComponent(`location:"${city}" type:${type}`);
  const out = [];
  let page = 1;
  while (out.length < count) {
    const data = await gh(`/search/users?q=${q}&sort=followers&order=desc&per_page=${perPage}&page=${page}`);
    if (!data.items?.length) break;
    out.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }
  return out.slice(0, count);
}

async function fetchAccountDetails(login) {
  return gh(`/users/${encodeURIComponent(login)}`);
}

async function fetchTopRepos(login) {
  const data = await gh(`/users/${encodeURIComponent(login)}/repos?per_page=100&type=owner&sort=updated`);
  return data || [];
}

async function buildCity(city) {
  const slug = slugify(city);
  console.log(`\n=== ${city} (${slug}) ===`);

  console.log('Searching users…');
  const userSearch = await searchAccounts(city, 'user', TOP_USERS);
  console.log(`  found ${userSearch.length} users`);

  console.log('Searching orgs…');
  const orgSearch = await searchAccounts(city, 'org', TOP_ORGS);
  console.log(`  found ${orgSearch.length} orgs`);

  const all = [...userSearch, ...orgSearch];
  console.log(`Hydrating ${all.length} accounts…`);
  const hydrated = await pmap(all, CONCURRENCY, async (a) => {
    const d = await fetchAccountDetails(a.login);
    return { ...a, ...d };
  });

  console.log(`Fetching repos for ${hydrated.length} accounts…`);
  const enriched = await pmap(hydrated.filter(Boolean), CONCURRENCY, async (a) => {
    const repos = await fetchTopRepos(a.login);
    const ownRepos = repos.filter(r => !r.fork);
    const totalStars = ownRepos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
    return { acct: a, repos: ownRepos, totalStars };
  });

  const valid = enriched.filter(Boolean);

  const compact = (a, totalStars) => ({
    login: a.login,
    name: a.name || null,
    avatar_url: a.avatar_url,
    html_url: a.html_url,
    followers: a.followers || 0,
    following: a.following || 0,
    public_repos: a.public_repos || 0,
    location: a.location || null,
    bio: a.bio || null,
    total_stars: totalStars,
  });

  const users = valid
    .filter(x => x.acct.type === 'User')
    .map(x => compact(x.acct, x.totalStars))
    .sort((a, b) => b.followers - a.followers);

  const orgs = valid
    .filter(x => x.acct.type === 'Organization')
    .map(x => compact(x.acct, x.totalStars))
    .sort((a, b) => b.followers - a.followers);

  const repoMap = new Map();
  for (const { repos } of valid) {
    for (const r of repos) {
      if (r.fork) continue;
      repoMap.set(r.full_name, {
        full_name: r.full_name,
        html_url: r.html_url,
        description: r.description ? r.description.slice(0, 200) : null,
        stargazers_count: r.stargazers_count || 0,
        forks_count: r.forks_count || 0,
        language: r.language || null,
        owner_login: r.owner?.login,
        owner_avatar_url: r.owner?.avatar_url,
        owner_type: r.owner?.type,
      });
    }
  }
  const repos = Array.from(repoMap.values())
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, TOP_REPOS);

  const totals = {
    user_followers: users.reduce((s, u) => s + u.followers, 0),
    org_followers: orgs.reduce((s, o) => s + o.followers, 0),
    user_stars: users.reduce((s, u) => s + u.total_stars, 0),
    org_stars: orgs.reduce((s, o) => s + o.total_stars, 0),
  };

  const payload = {
    city,
    slug,
    generated_at: new Date().toISOString(),
    counts: { users: users.length, orgs: orgs.length, repos: repos.length },
    totals,
    users,
    orgs,
    repos,
  };

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, `${slug}.json`);
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outPath}`);
  return { city, slug, generated_at: payload.generated_at, counts: payload.counts };
}

async function updateIndex(cityResults) {
  const indexPath = join(DATA_DIR, 'index.json');
  let existing = { cities: [] };
  if (existsSync(indexPath)) {
    try { existing = JSON.parse(await readFile(indexPath, 'utf8')); } catch {}
  }
  const byCity = new Map((existing.cities || []).map(c => [c.slug, c]));
  for (const r of cityResults) if (r) byCity.set(r.slug, r);
  const merged = {
    generated_at: new Date().toISOString(),
    cities: Array.from(byCity.values()).sort((a, b) => a.city.localeCompare(b.city)),
  };
  await writeFile(indexPath, JSON.stringify(merged, null, 2));
  console.log(`Updated ${indexPath} (${merged.cities.length} cities)`);
}

async function main() {
  const args = process.argv.slice(2);
  let cities;
  if (args.length === 0 || args[0] === '--all') {
    cities = CITIES;
  } else {
    cities = args;
  }
  console.log(`Refreshing ${cities.length} cities: ${cities.join(', ')}`);

  const results = [];
  for (const city of cities) {
    try {
      results.push(await buildCity(city));
    } catch (e) {
      console.error(`FAILED ${city}: ${e.message}`);
    }
  }
  await updateIndex(results);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
