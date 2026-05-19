#!/usr/bin/env node
// Fetch GitHub rankings (global, by city, by country, trending) and write to data/.
// Usage:
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --all
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --global --trending
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --city "New York"
//   GH_TOKEN=ghp_xxx node scripts/fetch.mjs --country "United States"

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const COUNTRIES_DIR = join(DATA_DIR, 'countries');
const CITIES_DIR = join(DATA_DIR, 'cities');
const CACHE_DIR = join(DATA_DIR, '_cache');
const CACHE_FILE = join(CACHE_DIR, 'users.json');
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const REPOS_PER_USER = 30;  // cap chosen to keep cache file under GitHub's 100MB blob limit
const CACHE_VERSION = 2;    // bump to force re-hydration when payload shape changes

const CITIES = [
  'New York', 'San Francisco', 'Seattle', 'Austin', 'Toronto',
  'London', 'Berlin', 'Paris', 'Amsterdam', 'Tel Aviv',
  'Tokyo', 'Seoul', 'Singapore', 'Bangalore', 'Sydney',
];

const COUNTRIES = [
  'United States', 'United Kingdom', 'Germany', 'France', 'Netherlands',
  'China', 'India', 'Japan', 'South Korea', 'Brazil',
  'Canada', 'Australia',
];

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('Set GH_TOKEN or GITHUB_TOKEN.'); process.exit(1); }

const LOC_USERS = 150;  // top N by followers across all location aliases
const LOC_ORGS = 80;
const GLOBAL_USERS = 100;
const GLOBAL_ORGS = 50;
const TOP_REPOS = 50;
const TRENDING_REPOS = 50;
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
        'User-Agent': 'commits-fyi-fetcher',
      },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
      const waitMs = Math.max(2000, reset - Date.now() + 1000);
      const remaining = res.headers.get('x-ratelimit-remaining');
      console.warn(`Rate-limited (remaining=${remaining}). Waiting ${Math.round(waitMs/1000)}s…`);
      if (waitMs > 60 * 60 * 1000) throw new Error('Rate-limit reset >60min away, aborting.');
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

// Build a query object with both API + UI URLs (for show-the-query display).
function queryObj(label, apiPath, uiUrl) {
  return {
    label,
    api_url: apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`,
    ui_url: uiUrl,
  };
}

async function searchUsers(qStr, count, { userTypeForUi = 'Users' } = {}) {
  const perPage = Math.min(100, count);
  const out = [];
  const encoded = encodeURIComponent(qStr);
  let page = 1;
  while (out.length < count) {
    const data = await gh(`/search/users?q=${encoded}&sort=followers&order=desc&per_page=${perPage}&page=${page}`);
    if (!data.items?.length) break;
    out.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }
  return out.slice(0, count);
}

async function searchRepos(qStr, count, { sort = 'stars' } = {}) {
  const perPage = Math.min(100, count);
  const out = [];
  const encoded = encodeURIComponent(qStr);
  let page = 1;
  while (out.length < count) {
    const data = await gh(`/search/repositories?q=${encoded}&sort=${sort}&order=desc&per_page=${perPage}&page=${page}`);
    if (!data.items?.length) break;
    out.push(...data.items);
    if (data.items.length < perPage) break;
    page++;
  }
  return out.slice(0, count);
}

// ----- GraphQL: hydrate a user/org + their top repos in ONE call -----

async function ghGraphQL(query, variables = {}, { retry = 3 } = {}) {
  for (let attempt = 0; attempt < retry; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'commits-fyi-fetcher',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 403 || res.status === 429) {
      const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
      const waitMs = Math.max(2000, reset - Date.now() + 1000);
      console.warn(`GraphQL rate-limited. Waiting ${Math.round(waitMs/1000)}s…`);
      if (waitMs > 60 * 60 * 1000) throw new Error('GraphQL rate-limit reset >60min away.');
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.status >= 500 && attempt < retry - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GraphQL ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.errors) {
      const msg = json.errors.map(e => e.message).join('; ');
      // GraphQL returns 200 OK with a "rate limit already exceeded" error in
      // the body. Wait for reset rather than dropping the candidate.
      if (/rate limit/i.test(msg)) {
        const resetAtStr = json.data?.rateLimit?.resetAt;
        const resetAt = resetAtStr ? new Date(resetAtStr).getTime() : (Date.now() + 60_000);
        const waitMs = Math.max(5000, resetAt - Date.now() + 2000);
        console.warn(`GraphQL rate-limited (in body). Waiting ${Math.round(waitMs/1000)}s until reset…`);
        if (waitMs > 60 * 60 * 1000) throw new Error('GraphQL rate-limit reset >60min away.');
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      // Common: user account suspended / not found. Treat as null result.
      if (/Could not resolve to|not exist|suspended/i.test(msg)) return { data: { repositoryOwner: null } };
      throw new Error(`GraphQL errors: ${msg}`);
    }
    return json;
  }
  throw new Error(`GraphQL failed after ${retry} retries`);
}

const HYDRATE_QUERY = `
query($login: String!, $first: Int!) {
  repositoryOwner(login: $login) {
    __typename
    login
    avatarUrl(size: 88)
    url
    ... on User {
      name
      bio
      company
      location
      followers { totalCount }
      following { totalCount }
      repositories(first: $first, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
        totalCount
        nodes {
          nameWithOwner
          url
          description
          stargazerCount
          forkCount
          primaryLanguage { name }
          createdAt
          pushedAt
        }
      }
    }
    ... on Organization {
      name
      description
      location
      websiteUrl
      repositories(first: $first, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
        totalCount
        nodes {
          nameWithOwner
          url
          description
          stargazerCount
          forkCount
          primaryLanguage { name }
          createdAt
          pushedAt
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

async function hydrateOneViaGraphQL(login) {
  const { data } = await ghGraphQL(HYDRATE_QUERY, { login, first: REPOS_PER_USER });
  const owner = data?.repositoryOwner;
  if (!owner) return null;
  const reposNode = owner.repositories || { totalCount: 0, nodes: [] };
  const isUser = owner.__typename === 'User';

  // GraphQL Organization has no followers field (and membersWithRole requires
  // admin:org). For orgs, hit REST /users/<login> to get the real followers.
  let orgFollowers = 0;
  if (!isUser) {
    try {
      const restOrg = await gh(`/users/${encodeURIComponent(login)}`);
      orgFollowers = restOrg?.followers || 0;
    } catch (e) {
      // Suspended/removed org — leave 0
    }
  }

  const acct = {
    login: owner.login,
    type: isUser ? 'User' : 'Organization',
    avatar_url: owner.avatarUrl,
    html_url: owner.url,
    name: owner.name || null,
    bio: isUser ? (owner.bio || null) : (owner.description || null),
    company: isUser ? (owner.company || null) : null,
    location: owner.location || null,
    followers: isUser ? (owner.followers?.totalCount || 0) : orgFollowers,
    following: isUser ? (owner.following?.totalCount || 0) : 0,
    public_repos: reposNode.totalCount || 0,
  };

  // Approximate totalStars from the top REPOS_PER_USER (sorted desc).
  // For users whose top repo dominates (Pareto), this is essentially exact.
  // Stripped to the minimum fields the leaderboard renders, since this list
  // is cached for thousands of users and the cache file has a 100MB GitHub
  // blob limit. Trending uses a separate live query, not these cached repos.
  const repos = (reposNode.nodes || []).map(r => ({
    full_name: r.nameWithOwner,
    html_url: r.url,
    description: r.description ? r.description.slice(0, 140) : null,
    stargazers_count: r.stargazerCount || 0,
    forks_count: r.forkCount || 0,
    language: r.primaryLanguage?.name || null,
    owner_login: owner.login,
    owner_avatar_url: owner.avatarUrl,
    owner_type: acct.type,
    fork: false,
  }));
  const totalStars = repos.reduce((s, r) => s + r.stargazers_count, 0);
  return { acct, repos, totalStars };
}

// ----- Per-user cache: avoid re-hydrating accounts that haven't aged out -----

const _cache = { entries: new Map(), hits: 0, misses: 0, written: 0 };

async function loadCache() {
  if (!existsSync(CACHE_FILE)) { console.log('Cache: cold start (no file).'); return; }
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    if ((raw.version || 1) !== CACHE_VERSION) {
      console.log(`Cache: version ${raw.version || 1} ≠ ${CACHE_VERSION}, ignoring (cold start).`);
      return;
    }
    for (const [login, entry] of Object.entries(raw.entries || {})) {
      _cache.entries.set(login.toLowerCase(), entry);
    }
    console.log(`Cache: loaded ${_cache.entries.size} entries from ${CACHE_FILE}`);
  } catch (e) {
    console.warn('Cache: failed to load:', e.message);
  }
}

function cacheGet(login) {
  const key = login.toLowerCase();
  const e = _cache.entries.get(key);
  if (!e) return null;
  if (Date.now() - new Date(e.fetched_at).getTime() > CACHE_TTL_MS) return null;
  _cache.hits++;
  return e.payload;
}

function cachePut(login, payload) {
  const key = login.toLowerCase();
  _cache.entries.set(key, { fetched_at: new Date().toISOString(), payload });
  _cache.written++;
}

async function saveCache() {
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
  // Prune entries older than 30 days so the file doesn't grow forever.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [k, e] of _cache.entries) {
    if (new Date(e.fetched_at).getTime() < cutoff) { _cache.entries.delete(k); pruned++; }
  }
  const out = { version: CACHE_VERSION, updated_at: new Date().toISOString(), entries: Object.fromEntries(_cache.entries) };
  await writeFile(CACHE_FILE, JSON.stringify(out));
  console.log(`Cache: saved ${_cache.entries.size} entries (hits=${_cache.hits} misses=${_cache.misses} written=${_cache.written} pruned=${pruned})`);
}

function compactAccount(a, totalStars) {
  return {
    login: a.login,
    name: a.name || null,
    avatar_url: a.avatar_url,
    html_url: a.html_url,
    followers: a.followers || 0,
    following: a.following || 0,
    public_repos: a.public_repos || 0,
    location: a.location || null,
    bio: a.bio || null,
    company: a.company || null,
    total_stars: totalStars,
  };
}

function compactRepo(r) {
  return {
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description ? r.description.slice(0, 200) : null,
    stargazers_count: r.stargazers_count || 0,
    forks_count: r.forks_count || 0,
    watchers_count: r.watchers_count || 0,
    language: r.language || null,
    owner_login: r.owner?.login,
    owner_avatar_url: r.owner?.avatar_url,
    owner_type: r.owner?.type,
    created_at: r.created_at,
    pushed_at: r.pushed_at,
  };
}

async function hydrateAndRank(searchResults) {
  // Dedupe by login first (case-insensitive). Pages overlap; pool + search overlap.
  const uniq = new Map();
  for (const a of searchResults) {
    if (!a?.login) continue;
    const key = a.login.toLowerCase();
    if (!uniq.has(key)) uniq.set(key, a);
  }
  const candidates = Array.from(uniq.values());

  const enriched = await pmap(candidates, CONCURRENCY, async (a) => {
    const cached = cacheGet(a.login);
    if (cached) return cached;
    _cache.misses++;
    const fresh = await hydrateOneViaGraphQL(a.login);
    if (fresh) cachePut(a.login, fresh);
    return fresh;
  });
  return enriched.filter(Boolean);
}

function dedupeByLogin(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const key = (x.login || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

function aggregateRepos(enriched, limit) {
  const m = new Map();
  for (const { repos } of enriched) {
    for (const r of repos) {
      if (r.fork) continue;
      if (!m.has(r.full_name)) m.set(r.full_name, compactRepo(r));
    }
  }
  return Array.from(m.values())
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, limit);
}

// ----- Builders -----

async function buildOwnerPool() {
  console.log('\n=== owner pool discovery (shared across global/cities/countries) ===');
  // Search API caps results at 1000 per query, and there are ~1500 repos with
  // >25k stars. Use range queries so we capture the long tail too (e.g.
  // keon/algorithms at 25k stars sits below the top-1000 stars:>5000 cutoff
  // which lands around 31k).
  const ranges = ['stars:>50000', 'stars:25000..50000', 'stars:10000..25000', 'stars:5000..10000'];
  const seenOwners = new Set();
  const seenRepos = new Set();
  const candidates = [];
  for (const q of ranges) {
    console.log(`Pulling repos (${q})…`);
    const repos = await searchRepos(q, 1000);
    console.log(`  ${repos.length} repos`);
    for (const r of repos) {
      if (seenRepos.has(r.full_name)) continue;
      seenRepos.add(r.full_name);
      const login = r.owner?.login;
      if (!login || seenOwners.has(login)) continue;
      seenOwners.add(login);
      candidates.push({ login, type: r.owner.type, avatar_url: r.owner.avatar_url });
    }
  }
  console.log(`Total: ${candidates.length} unique owners across ${seenRepos.size} repos`);
  console.log('Hydrating owner pool…');
  const enriched = await hydrateAndRank(candidates);
  console.log(`  ${enriched.length} hydrated`);
  return enriched;
}

// Curated aliases so high-star/low-follower accounts get pulled into the right
// city/country bucket even when their self-reported location uses a city name,
// state abbreviation, native script, etc.
const LOCATION_ALIASES = {
  // Countries
  'United States': [
    'united states', 'usa', 'u.s.a', 'u.s.', ' us ', 'america',
    'new york', 'nyc', 'brooklyn', 'manhattan', 'queens', 'bronx',
    'san francisco', 'bay area', 'silicon valley', 'palo alto', 'menlo park',
    'mountain view', 'sunnyvale', 'cupertino', 'oakland', 'berkeley',
    'seattle', 'redmond', 'bellevue', 'austin', 'boston', 'cambridge, ma',
    'chicago', 'los angeles', 'san diego', 'portland', 'denver', 'atlanta',
    'miami', 'houston', 'dallas', 'philadelphia', 'pittsburgh', 'minneapolis',
    'washington, dc', 'washington dc', 'd.c.', 'detroit', 'salt lake', 'phoenix',
    ', ca', ', ny', ', wa', ', tx', ', il', ', ma', ', co', ', or', ', ga',
    ', fl', ', pa', ', mi', ', oh', ', nc', ', va', ', md', ', dc', ', nj',
    ', az', ', mn', ', wi', ', in', ', tn', ', sc', ', ky', ', ct', ', mo',
    ', nv', ', ut',
  ],
  'United Kingdom': ['united kingdom', 'uk', 'u.k.', 'england', 'britain', 'great britain',
    'london', 'manchester', 'edinburgh', 'glasgow', 'bristol', 'cambridge, uk',
    'oxford', 'birmingham', 'leeds', 'liverpool', 'scotland', 'wales',
    'northern ireland', 'belfast', 'cardiff'],
  'Germany': ['germany', 'deutschland', ', de', 'berlin', 'munich', 'münchen', 'hamburg',
    'frankfurt', 'cologne', 'köln', 'stuttgart', 'düsseldorf', 'leipzig', 'dresden',
    'bonn', 'karlsruhe', 'nuremberg', 'nürnberg', 'bremen', 'hannover'],
  'France': ['france', 'paris', 'lyon', 'marseille', 'toulouse', 'bordeaux', 'nantes',
    'strasbourg', 'nice', 'lille', 'rennes'],
  'Netherlands': ['netherlands', 'holland', 'amsterdam', 'utrecht', 'rotterdam',
    'eindhoven', 'the hague', "'s-hertogenbosch", 'groningen', 'leiden', 'delft'],
  'China': ['china', '中国', 'beijing', '北京', 'shanghai', '上海', 'shenzhen', '深圳',
    'guangzhou', '广州', 'hangzhou', '杭州', 'chengdu', '成都', 'wuhan', 'xi\'an',
    'nanjing', 'tianjin', 'chongqing'],
  'India': ['india', 'bharat', 'bangalore', 'bengaluru', 'mumbai', 'bombay', 'delhi',
    'new delhi', 'hyderabad', 'pune', 'chennai', 'kolkata', 'ahmedabad', 'noida',
    'gurgaon', 'gurugram'],
  'Japan': ['japan', '日本', 'tokyo', '東京', 'osaka', '大阪', 'kyoto', '京都',
    'yokohama', '横浜', 'fukuoka', '福岡', 'nagoya', '名古屋', 'sapporo'],
  'South Korea': ['korea', 'south korea', '한국', '대한민국', 'seoul', '서울',
    'busan', '부산', 'incheon', '인천', 'daegu'],
  'Brazil': ['brazil', 'brasil', 'são paulo', 'sao paulo', 'rio de janeiro',
    'belo horizonte', 'porto alegre', 'curitiba', 'recife', 'salvador',
    'florianópolis', 'florianopolis', 'brasília', 'brasilia'],
  'Canada': ['canada', 'toronto', 'vancouver', 'montreal', 'montréal', 'ottawa',
    'calgary', 'edmonton', 'waterloo', 'quebec', 'québec', 'winnipeg', 'halifax'],
  'Australia': ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
    'canberra', 'gold coast'],

  // Cities
  'New York': ['new york', 'nyc', 'new york city', 'brooklyn', 'manhattan', 'queens',
    'bronx', 'staten island', 'ny, ny', 'new york, ny'],
  'San Francisco': ['san francisco', ' sf ', 'sf,', 'sf bay', 'bay area',
    'silicon valley', 'palo alto', 'menlo park', 'mountain view', 'sunnyvale',
    'cupertino', 'oakland', 'berkeley', 'san francisco bay area'],
  'Seattle': ['seattle', 'redmond', 'bellevue', 'kirkland', ', wa'],
  'Austin': ['austin', 'austin, tx', 'austin tx'],
  'Toronto': ['toronto', 'gta', 'greater toronto'],
  'London': ['london', 'greater london'],
  'Berlin': ['berlin'],
  'Paris': ['paris'],
  'Amsterdam': ['amsterdam'],
  'Tel Aviv': ['tel aviv', 'tel-aviv', 'telaviv', 'tlv'],
  'Tokyo': ['tokyo', '東京'],
  'Seoul': ['seoul', '서울'],
  'Singapore': ['singapore'],
  'Bangalore': ['bangalore', 'bengaluru'],
  'Sydney': ['sydney'],
};

function aliasesFor(name) {
  return LOCATION_ALIASES[name] || [name.toLowerCase()];
}

function locationMatches(loc, name) {
  if (!loc) return false;
  const lower = ' ' + loc.toLowerCase() + ' '; // pad so " us " word-boundary tokens work
  return aliasesFor(name).some(a => lower.includes(a));
}

// Build a GitHub search query of the form
//   location:"new york" location:nyc location:brooklyn ... type:<type>
// Repeating `location:` qualifiers in a search query yields OR semantics
// (verified: `location:tokyo location:paris` total = paris-only + tokyo-only).
function buildMultiLocationQuery(name, type) {
  const aliases = aliasesFor(name)
    .map(a => a.trim())
    .filter(a => a.length > 2 && !a.startsWith(',')) // skip suffix tokens like ", ca"
    .slice(0, 14); // keep the query under GitHub's length budget
  const clauses = aliases.map(a => /\s|[.'"]/.test(a) ? `location:"${a}"` : `location:${a}`);
  return `${clauses.join(' ')} type:${type}`;
}

async function buildLocation(name, kind, outDir, ownerPool = []) {
  const slug = slugify(name);
  console.log(`\n=== ${kind}: ${name} (${slug}) ===`);
  const userQ = buildMultiLocationQuery(name, 'user');
  const orgQ  = buildMultiLocationQuery(name, 'org');

  console.log('Searching users by followers (multi-location)…');
  const userSearch = await searchUsers(userQ, LOC_USERS);
  console.log(`  found ${userSearch.length}`);
  console.log('Searching orgs by followers (multi-location)…');
  const orgSearch = await searchUsers(orgQ, LOC_ORGS);
  console.log(`  found ${orgSearch.length}`);

  // Reuse owner-pool hydration where logins overlap
  const poolByLogin = new Map(ownerPool.map(p => [p.acct.login, p]));
  const newCandidates = [...userSearch, ...orgSearch].filter(c => !poolByLogin.has(c.login));
  const reused = (userSearch.length + orgSearch.length) - newCandidates.length;
  console.log(`Hydrating ${newCandidates.length} new candidates (${reused} reused from owner pool)…`);
  const newEnriched = await hydrateAndRank(newCandidates);

  // Pool entries whose self-reported location matches this city/country
  const poolMatches = ownerPool.filter(p => locationMatches(p.acct.location, name));
  console.log(`  + ${poolMatches.length} additional candidates from owner pool (location match)`);

  // Pool entries that were ALSO in the location-followers search
  const searchLogins = new Set([...userSearch, ...orgSearch].map(s => s.login));
  const poolViaSearch = [];
  for (const login of searchLogins) if (poolByLogin.has(login)) poolViaSearch.push(poolByLogin.get(login));

  // Dedupe by login
  const merged = new Map();
  for (const e of [...newEnriched, ...poolViaSearch, ...poolMatches]) {
    if (e?.acct?.login) merged.set(e.acct.login, e);
  }
  const enriched = Array.from(merged.values());
  console.log(`Total ${enriched.length} unique accounts ranked.`);

  // Default ranking is by followers — that's what the Search Users API
  // natively sorts on, and it gives a stable, intuitive "social" ranking
  // without the noisy 2-star tail problem.
  const MAX_PER_LIST = 100;
  const users = dedupeByLogin(
    enriched
      .filter(x => x.acct.type === 'User' && (x.acct.followers || 0) > 0)
      .map(x => compactAccount(x.acct, x.totalStars))
      .sort((a, b) => b.followers - a.followers)
  ).slice(0, MAX_PER_LIST);

  const orgs = dedupeByLogin(
    enriched
      .filter(x => x.acct.type === 'Organization' && (x.acct.followers || 0) > 0)
      .map(x => compactAccount(x.acct, x.totalStars))
      .sort((a, b) => b.followers - a.followers)
  ).slice(0, MAX_PER_LIST);

  const repos = aggregateRepos(enriched, TOP_REPOS);

  const totals = {
    user_followers: users.reduce((s, u) => s + u.followers, 0),
    org_followers: orgs.reduce((s, o) => s + o.followers, 0),
    user_stars: users.reduce((s, u) => s + u.total_stars, 0),
    org_stars: orgs.reduce((s, o) => s + o.total_stars, 0),
  };

  const queries = [
    queryObj(
      `Top ${LOC_USERS} users in ${name}`,
      `/search/users?q=${encodeURIComponent(userQ)}&sort=followers&order=desc&per_page=${LOC_USERS}`,
      `https://github.com/search?q=${encodeURIComponent(userQ)}&type=users&s=followers&o=desc`,
    ),
    queryObj(
      `Top ${LOC_ORGS} orgs in ${name}`,
      `/search/users?q=${encodeURIComponent(orgQ)}&sort=followers&order=desc&per_page=${LOC_ORGS}`,
      `https://github.com/search?q=${encodeURIComponent(orgQ)}&type=users&s=followers&o=desc`,
    ),
    queryObj(
      `Plus owners from the global top-starred-repo pool whose self-reported location contains "${name}"`,
      '/search/repositories?q=stars:>5000&sort=stars&order=desc',
      'https://github.com/search?q=stars%3A%3E5000&type=repositories&s=stars&o=desc',
    ),
    queryObj(
      'Per-account hydration via GraphQL — user/org details + top 100 repos by stars in one request',
      'POST /graphql  query { repositoryOwner(login: "...") { __typename ... on User { name location followers { totalCount } repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner stargazerCount } } } ... on Organization { name location membersWithRole { totalCount } repositories(first: 100, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner stargazerCount } } } } }',
      null,
    ),
  ];

  const payload = {
    kind, name, slug,
    generated_at: new Date().toISOString(),
    counts: { users: users.length, orgs: orgs.length, repos: repos.length },
    totals, queries,
    users, orgs, repos,
  };

  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}.json`);
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outPath}`);
  return { kind, name, slug, generated_at: payload.generated_at, counts: payload.counts };
}

async function buildGlobal(ownerPool = []) {
  console.log('\n=== global ===');
  const userQ = 'followers:>1000';
  const orgQ = 'followers:>500 type:org';
  const repoQ = 'stars:>1000';

  console.log('Searching top users by followers…');
  const userSearch = await searchUsers(userQ, GLOBAL_USERS * 2);
  console.log(`  found ${userSearch.length}`);
  console.log('Searching top orgs by followers…');
  const orgSearch = await searchUsers(orgQ, GLOBAL_ORGS * 2);
  console.log(`  found ${orgSearch.length}`);
  console.log('Searching top repos for display…');
  const repoSearch = await searchRepos(repoQ, TOP_REPOS);
  console.log(`  found ${repoSearch.length}`);

  // Hydrate follower-based candidates that aren't already in the owner pool.
  const poolByLogin = new Map(ownerPool.map(p => [p.acct.login.toLowerCase(), p]));
  const newCandidates = [...userSearch, ...orgSearch]
    .filter(c => c.login && !poolByLogin.has(c.login.toLowerCase()));
  const reused = (userSearch.length + orgSearch.length) - newCandidates.length;
  console.log(`Hydrating ${newCandidates.length} follower-based new candidates (${reused} reused from owner pool)…`);
  const newEnriched = await hydrateAndRank(newCandidates);

  // Union all enriched entries (owner pool + freshly hydrated), keyed case-insensitively.
  const enrichedMap = new Map();
  for (const e of [...ownerPool, ...newEnriched]) {
    if (e?.acct?.login) enrichedMap.set(e.acct.login.toLowerCase(), e);
  }
  const enriched = Array.from(enrichedMap.values());
  console.log(`Total unique enriched accounts: ${enriched.length}`);

  const users = dedupeByLogin(
    enriched
      .filter(x => x.acct.type === 'User' && (x.acct.followers || 0) > 0)
      .map(x => compactAccount(x.acct, x.totalStars))
      .sort((a, b) => b.followers - a.followers)
  ).slice(0, GLOBAL_USERS);

  const orgs = dedupeByLogin(
    enriched
      .filter(x => x.acct.type === 'Organization' && (x.acct.followers || 0) > 0)
      .map(x => compactAccount(x.acct, x.totalStars))
      .sort((a, b) => b.followers - a.followers)
  ).slice(0, GLOBAL_ORGS);

  const repos = repoSearch.map(compactRepo);

  const totals = {
    user_followers: users.reduce((s, u) => s + u.followers, 0),
    org_followers: orgs.reduce((s, o) => s + o.followers, 0),
    user_stars: users.reduce((s, u) => s + u.total_stars, 0),
    org_stars: orgs.reduce((s, o) => s + o.total_stars, 0),
    top_repo_stars: repos.reduce((s, r) => s + r.stargazers_count, 0),
  };

  const queries = [
    queryObj(`Candidate pool A — top users by followers`,
      `/search/users?q=${encodeURIComponent(userQ)}&sort=followers&order=desc`,
      `https://github.com/search?q=${encodeURIComponent(userQ)}&type=users&s=followers&o=desc`),
    queryObj(`Candidate pool A — top orgs by followers`,
      `/search/users?q=${encodeURIComponent(orgQ)}&sort=followers&order=desc`,
      `https://github.com/search?q=${encodeURIComponent(orgQ)}&type=users&s=followers&o=desc`),
    queryObj(`Candidate pool B — owners of most-starred repos (top 1,000)`,
      `/search/repositories?q=${encodeURIComponent('stars:>5000')}&sort=stars&order=desc`,
      `https://github.com/search?q=${encodeURIComponent('stars:>5000')}&type=repositories&s=stars&o=desc`),
    queryObj(`Top ${TOP_REPOS} repos by stars (for the Repositories tab)`,
      `/search/repositories?q=${encodeURIComponent(repoQ)}&sort=stars&order=desc&per_page=${TOP_REPOS}`,
      `https://github.com/search?q=${encodeURIComponent(repoQ)}&type=repositories&s=stars&o=desc`),
    queryObj(
      'Per-account hydration via GraphQL — user/org details + top 100 repos by stars in one request',
      'POST /graphql  query { repositoryOwner(login: "...") { __typename ... on User { name location followers { totalCount } repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner stargazerCount } } } ... on Organization { name location membersWithRole { totalCount } repositories(first: 100, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner stargazerCount } } } } }',
      null,
    ),
  ];

  const payload = {
    kind: 'global', name: 'Global', slug: 'global',
    generated_at: new Date().toISOString(),
    counts: { users: users.length, orgs: orgs.length, repos: repos.length },
    totals, queries,
    users, orgs, repos,
  };

  await writeFile(join(DATA_DIR, 'global.json'), JSON.stringify(payload, null, 2));
  console.log('Wrote data/global.json');
}

async function buildTrending() {
  console.log('\n=== trending (past 24h + past 6 months) ===');
  const since      = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sixMoAgo   = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createdQ   = `created:>${since}`;
  const pushedQ    = `pushed:>${since} stars:>100`;
  const surgingQ   = `created:>${sixMoAgo} stars:>500`;

  console.log(`New repos created since ${since}…`);
  const newRepos = await searchRepos(createdQ, TRENDING_REPOS);
  console.log(`  found ${newRepos.length}`);

  console.log(`Active repos pushed since ${since} (>100 stars)…`);
  const activeRepos = await searchRepos(pushedQ, TRENDING_REPOS);
  console.log(`  found ${activeRepos.length}`);

  console.log(`Surging — repos created since ${sixMoAgo} (>500 stars)…`);
  const surgingRepos = await searchRepos(surgingQ, TRENDING_REPOS);
  console.log(`  found ${surgingRepos.length}`);

  const payload = {
    kind: 'trending', name: 'Trending', slug: 'trending',
    generated_at: new Date().toISOString(),
    window: { since, since_long: sixMoAgo, until: new Date().toISOString() },
    counts: { new: newRepos.length, active: activeRepos.length, surging: surgingRepos.length },
    queries: [
      queryObj(`Most-starred repos pushed since ${since} (stars:>100)`,
        `/search/repositories?q=${encodeURIComponent(pushedQ)}&sort=stars&order=desc&per_page=${TRENDING_REPOS}`,
        `https://github.com/search?q=${encodeURIComponent(pushedQ)}&type=repositories&s=stars&o=desc`),
      queryObj(`Most-starred repos created since ${since}`,
        `/search/repositories?q=${encodeURIComponent(createdQ)}&sort=stars&order=desc&per_page=${TRENDING_REPOS}`,
        `https://github.com/search?q=${encodeURIComponent(createdQ)}&type=repositories&s=stars&o=desc`),
      queryObj(`Surging — repos created since ${sixMoAgo} with >500 stars (catches new makers the leaderboard misses)`,
        `/search/repositories?q=${encodeURIComponent(surgingQ)}&sort=stars&order=desc&per_page=${TRENDING_REPOS}`,
        `https://github.com/search?q=${encodeURIComponent(surgingQ)}&type=repositories&s=stars&o=desc`),
    ],
    new_repos: newRepos.map(compactRepo),
    active_repos: activeRepos.map(compactRepo),
    surging_repos: surgingRepos.map(compactRepo),
  };

  await writeFile(join(DATA_DIR, 'trending.json'), JSON.stringify(payload, null, 2));
  console.log('Wrote data/trending.json');
}

async function rebuildIndex() {
  const index = { generated_at: new Date().toISOString(), global: null, trending: null, cities: [], countries: [] };

  const tryRead = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

  const g = await tryRead(join(DATA_DIR, 'global.json'));
  if (g) index.global = { generated_at: g.generated_at, counts: g.counts };

  const t = await tryRead(join(DATA_DIR, 'trending.json'));
  if (t) index.trending = { generated_at: t.generated_at, counts: t.counts, window: t.window };

  for (const city of CITIES) {
    const slug = slugify(city);
    const d = await tryRead(join(CITIES_DIR, `${slug}.json`));
    if (d) index.cities.push({ name: city, slug, generated_at: d.generated_at, counts: d.counts });
  }
  for (const country of COUNTRIES) {
    const slug = slugify(country);
    const d = await tryRead(join(COUNTRIES_DIR, `${slug}.json`));
    if (d) index.countries.push({ name: country, slug, generated_at: d.generated_at, counts: d.counts });
  }

  index.cities.sort((a, b) => a.name.localeCompare(b.name));
  index.countries.sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Wrote data/index.json (${index.cities.length} cities, ${index.countries.length} countries)`);
}

// ----- CLI -----

function parseArgs(argv) {
  const args = { cities: [], countries: [], global: false, trending: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--global') args.global = true;
    else if (a === '--trending') args.trending = true;
    else if (a === '--city') args.cities.push(argv[++i]);
    else if (a === '--country') args.countries.push(argv[++i]);
    else { console.error('Unknown arg:', a); process.exit(2); }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv.length ? argv : ['--all']);

  if (args.all) {
    args.global = true;
    args.trending = true;
    args.cities = CITIES.slice();
    args.countries = COUNTRIES.slice();
  }

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  await loadCache();

  // Shared owner pool: discovered from top-starred repos. Reused across global
  // and every city/country to catch high-star/low-follower accounts.
  let ownerPool = [];
  if (args.global || args.cities.length || args.countries.length) {
    try { ownerPool = await buildOwnerPool(); }
    catch (e) { console.error('owner pool FAILED:', e.message); }
  }

  if (args.global)   { try { await buildGlobal(ownerPool); }   catch (e) { console.error('global FAILED:', e.message); } }
  if (args.trending) { try { await buildTrending(); }          catch (e) { console.error('trending FAILED:', e.message); } }

  for (const city of args.cities) {
    try { await buildLocation(city, 'city', CITIES_DIR, ownerPool); }
    catch (e) { console.error(`city ${city} FAILED:`, e.message); }
  }
  for (const country of args.countries) {
    try { await buildLocation(country, 'country', COUNTRIES_DIR, ownerPool); }
    catch (e) { console.error(`country ${country} FAILED:`, e.message); }
  }

  await rebuildIndex();
  await saveCache();
  await writeUsersDetail();
  console.log('\nDone.');
}

// Derive a slim public users-detail.json that the frontend can serve directly.
// Only top 6 repos per user, no created_at/pushed_at, so the file is a few MB
// instead of the 60+MB cache. Loaded once per session for the click-to-profile
// drawer.
async function writeUsersDetail() {
  const out = {};
  for (const [, entry] of _cache.entries) {
    const p = entry?.payload;
    if (!p?.acct?.login) continue;
    out[p.acct.login] = {
      login: p.acct.login,
      type: p.acct.type,
      name: p.acct.name,
      bio: p.acct.bio,
      avatar_url: p.acct.avatar_url,
      html_url: p.acct.html_url,
      location: p.acct.location,
      company: p.acct.company,
      followers: p.acct.followers || 0,
      public_repos: p.acct.public_repos || 0,
      total_stars: p.totalStars || 0,
      top_repos: (p.repos || []).slice(0, 6).map(r => ({
        full_name: r.full_name,
        html_url: r.html_url,
        description: r.description,
        stargazers_count: r.stargazers_count,
        forks_count: r.forks_count,
        language: r.language,
      })),
    };
  }
  await writeFile(join(DATA_DIR, 'users-detail.json'), JSON.stringify(out));
  const count = Object.keys(out).length;
  const bytes = JSON.stringify(out).length;
  console.log(`Wrote data/users-detail.json: ${count} accounts, ${(bytes/1024/1024).toFixed(2)} MB`);
}

main().catch(e => { console.error(e); process.exit(1); });
