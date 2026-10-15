#!/usr/bin/env node
/**
 * 把仓库里的 issue 编译成静态站点：
 *
 *   dist/index.html           页面列表
 *   dist/index.json           页面列表（404 兜底匹配用）
 *   dist/{slug}/index.html    页面外壳（src/page.html）
 *   dist/{slug}/issue.json    issue 正文 + 元信息，由外壳读取后执行
 *
 * issue 标题决定访问路径，issue 正文就是页面内容本身（HTML 或 JS，见 resolveMode）。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const token = process.env.GITHUB_TOKEN || '';
const repo = process.env.GITHUB_REPOSITORY || detectRepo();
const basePath = toBasePath(process.env.BASE_PATH || '/');
// 默认只发布仓库 owner 自己的 issue，避免任何人都能往站点上写内容；设成空字符串则不限作者。
const authorFilter = (process.env.ISSUE_AUTHOR ?? repo.split('/')[0]).trim().toLowerCase();

const pageShell = await readFile(path.join(srcDir, 'page.html'), 'utf8');
const notFoundShell = (await readFile(path.join(srcDir, '404.html'), 'utf8')).replaceAll('__BASE__', basePath);

// 先拿到 issue 再清理产物目录，拉取失败时不至于留下半成品
const issues = await fetchIssues();

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await writeFile(path.join(distDir, '404.html'), notFoundShell);

const takenSlugs = new Set();
const pages = [];

for (const issue of issues) {
  if (authorFilter && (issue.user?.login || '').toLowerCase() !== authorFilter) {
    console.log(`跳过 #${issue.number}「${issue.title}」：作者 ${issue.user?.login} 不在发布名单内`);
    continue;
  }

  const slug = uniqueSlug(issue.title, issue.number, takenSlugs);
  const dir = path.join(distDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), pageShell);
  await writeFile(
    path.join(dir, 'issue.json'),
    `${JSON.stringify(
      {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        mode: resolveMode(issue),
        slug,
        url: `${basePath}${encodeURIComponent(slug)}/`,
        htmlUrl: issue.html_url,
        updatedAt: issue.updated_at,
        body: issue.body ?? '',
      },
      null,
      2,
    )}\n`,
  );

  pages.push({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    slug,
    url: `${encodeURIComponent(slug)}/`,
    htmlUrl: issue.html_url,
    updatedAt: issue.updated_at,
  });
  console.log(`生成 /${slug}/ ← #${issue.number}「${issue.title}」`);
}

await writeFile(path.join(distDir, 'index.html'), renderIndex(pages, basePath));
await writeFile(path.join(distDir, 'index.json'), `${JSON.stringify({ basePath, pages }, null, 2)}\n`);

console.log(`\n完成：${pages.length} 个页面 → ${path.relative(process.cwd(), distDir)}/`);

/** 分页拉取全部 issue（含已关闭），过滤掉 pull request。 */
async function fetchIssues() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'code-js-bin-with-issue',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${apiBase}/repos/${repo}/issues?state=all&per_page=100&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`拉取 issue 失败：HTTP ${res.status} ${res.statusText} (${url})`);
    const batch = await res.json();
    all.push(...batch.filter((item) => !item.pull_request));
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * 正文按 HTML 还是 JS 执行：开头就是 HTML 标签 / doctype / 注释的按 HTML，否则按 JS
 * （JS 里拼 HTML 字符串很常见，所以只看开头，不看正文里有没有标签）。
 * 打 js / html 标签可以强制指定。
 */
function resolveMode(issue) {
  const labels = (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '').toLowerCase());
  if (labels.includes('js')) return 'js';
  if (labels.includes('html')) return 'html';
  return /^\s*<[a-zA-Z!/]/.test(issue.body ?? '') ? 'html' : 'js';
}

/** 标题 → 目录名：去掉路径分隔符、控制字符，空白折叠成 -。 */
function uniqueSlug(title, number, taken) {
  let slug = String(title ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|#%]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  if (Array.from(slug).length > 80) slug = Array.from(slug).slice(0, 80).join('').replace(/-+$/, '');
  if (!slug) slug = `issue-${number}`;

  let candidate = slug;
  for (let i = 2; taken.has(candidate); i += 1) candidate = `${slug}-${i}`;
  taken.add(candidate);
  if (candidate !== slug) console.log(`路径 ${slug} 已被占用，改用它 ${candidate}`);
  return candidate;
}

function renderIndex(pages, basePath) {
  const cards = pages
    .map(
      (page) => `      <li class="card">
        <a class="title" href="./${page.url}">${escapeHtml(page.title)}</a>
        <p class="meta">
          <span class="badge ${page.state}">${escapeHtml(page.state)}</span>
          <span>#${page.number}</span>
          <span>更新于 ${escapeHtml(page.updatedAt.slice(0, 10))}</span>
          <a href="${escapeHtml(page.htmlUrl)}">GitHub issue</a>
        </p>
      </li>`,
    )
    .join('\n');

  const empty = `<p class="empty">还没有 issue。新建一个 issue，标题就是访问路径，正文就是页面内容。</p>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>code-js-bin-with-issue</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 20px 64px; background: #f6f8fa; color: #1f2328;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 24px; }
  .lead { margin: 0 0 28px; color: #57606a; }
  .lead code { padding: 1px 5px; border-radius: 5px; background: #eff1f3; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
  .card { padding: 14px 18px; border: 1px solid #d1d9e0; border-radius: 10px; background: #fff; }
  .title { font-size: 17px; font-weight: 600; color: #0969da; text-decoration: none; }
  .title:hover { text-decoration: underline; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 8px 0 0; color: #57606a; font-size: 13px; }
  .meta a { color: #57606a; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .badge.open { background: #dafbe1; color: #1a7f37; }
  .badge.closed { background: #f3d8fb; color: #8250df; }
  .empty { padding: 18px; border: 1px dashed #d1d9e0; border-radius: 10px; color: #57606a; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card { background: #151b23; border-color: #3d444d; }
    .lead code { background: #21262d; }
    .title { color: #4493f8; }
    .lead, .meta, .meta a, .empty { color: #9198a1; }
  }
</style>
</head>
<body>
<main>
  <h1>code-js-bin-with-issue</h1>
  <p class="lead">issue 标题即路径（<code>${escapeHtml(basePath)}{标题}/</code>），issue 正文即页面内容。</p>
${pages.length ? `  <ul>\n${cards}\n  </ul>` : `  ${empty}`}
</main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function toBasePath(value) {
  const trimmed = String(value).trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/** 本地运行时从 git remote 推断 owner/repo（Actions 里用 GITHUB_REPOSITORY）。 */
function detectRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) throw new Error(`无法从 ${url} 解析 owner/repo，请设置 GITHUB_REPOSITORY`);
  return `${match[1]}/${match[2]}`;
}
