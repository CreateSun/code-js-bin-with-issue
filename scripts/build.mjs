#!/usr/bin/env node
/**
 * 把仓库里的 issue 编译成静态站点（SSG：正文在构建时写进 HTML，运行时不再请求任何数据）：
 *
 *   dist/index.html           页面列表
 *   dist/{slug}/index.html    issue 正文即页面本身
 *   dist/404.html             未命中路径的提示页
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
// 站点标题：默认取仓库名，这样 fork 出去自动是对方自己的名字；部署时可用 SITE_NAME 指定品牌名。
const siteName = (process.env.SITE_NAME || repo.split('/')[1] || 'Issue Pages').trim();
// 默认只发布仓库 owner 自己的 issue，避免任何人都能往站点上写内容；设成空字符串则不限作者。
const authorFilter = (process.env.ISSUE_AUTHOR ?? repo.split('/')[0]).trim().toLowerCase();
// 发布审批：名单内的 issue 还要打上这个标签才会上线；设成空字符串则等于没有审批。
const publishLabel = (process.env.PUBLISH_LABEL ?? 'publish').trim().toLowerCase();

const pageTemplate = await readFile(path.join(srcDir, 'page.html'), 'utf8');
const notFoundTemplate = await readFile(path.join(srcDir, '404.html'), 'utf8');
const style = await readFile(path.join(srcDir, 'style.css'), 'utf8');
const footer = await readFile(path.join(srcDir, 'footer.html'), 'utf8');

/** 追加到片段末尾：出错的片段至少给个可见的报错，而不是白屏。 */
const REPORT_BLOCK = `<style>
#__bin_report__{position:fixed;left:0;right:0;bottom:0;max-height:45vh;overflow:auto;margin:0;padding:10px 14px;
background:#fff5f5;color:#cf222e;border-top:1px solid #ffcecb;white-space:pre-wrap;word-break:break-word;
font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;z-index:2147483647}
</style>
<script>
(function () {
  function report(label, message, stack) {
    var box = document.getElementById('__bin_report__');
    if (!box) { box = document.createElement('pre'); box.id = '__bin_report__'; document.body.appendChild(box); }
    box.textContent += label + ': ' + message + (stack ? '\\n' + stack : '') + '\\n';
  }
  window.__binReport = report;
  window.addEventListener('error', function (e) { report('Error', e.message, e.error && e.error.stack); });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    report('UnhandledRejection', (reason && reason.message) || String(reason), reason && reason.stack);
  });
})();
</script>`;

// 先拿到 issue 再清理产物目录，拉取失败时不至于留下半成品
const issues = await fetchIssues();

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await writeFile(
  path.join(distDir, '404.html'),
  notFoundTemplate.replaceAll('__BASE__', basePath).replace('__STYLE__', () => style).replace('__FOOTER__', () => footer),
);

const takenSlugs = new Set();
const pages = [];

for (const issue of issues) {
  if (authorFilter && (issue.user?.login || '').toLowerCase() !== authorFilter) {
    console.log(`跳过 #${issue.number}「${issue.title}」：作者 ${issue.user?.login} 不在发布名单内`);
    continue;
  }
  if (publishLabel && !labelNames(issue).includes(publishLabel)) {
    console.log(`跳过 #${issue.number}「${issue.title}」：还没有 ${publishLabel} 标签（待审批）`);
    continue;
  }

  const slug = uniqueSlug(issue.title, issue.number, takenSlugs);
  const dir = path.join(distDir, slug);
  const html = buildPage(issue, pageTemplate);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html);

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

/** 构建时把 issue 正文拼成一个完整页面：正文就是页面本身，与站点同源。 */
function buildPage(issue, template) {
  const source = String(issue.body ?? '');
  if (!source.trim()) return renderHint(issue);

  if (resolveMode(issue) === 'js') return fillTemplate(template, issue.title, `<script>${escapeScript(source)}</script>`);
  // 本身就是完整文档（带 doctype / <html>）时原样使用，否则套一层片段外壳
  if (/^\s*(?:<!doctype\s|<html[\s>])/i.test(source)) return withFooter(`${source}\n${REPORT_BLOCK}`);
  return fillTemplate(template, issue.title, source);
}

/** 用函数式 replacer：正文里出现 $& 之类的序列时不会被当成替换模式。 */
function fillTemplate(template, title, content) {
  return template
    .replace('__STYLE__', () => style)
    .replace('__TITLE__', () => escapeHtml(title))
    .replace('__CONTENT__', () => `${content}\n${REPORT_BLOCK}`)
    .replace('__FOOTER__', () => footer);
}

/** 完整文档不套外壳（也不注入基础样式，免得和作者自己的 CSS 打架），但页脚还是要补上。 */
function withFooter(html) {
  return `${html}\n${footer}`;
}

/** 正文为空时给个提示，而不是白屏。 */
function renderHint(issue) {
  return fillTemplate(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
__STYLE__
</style>
</head>
<body>
<p>issue #${issue.number} 的正文是空的，<a href="${escapeHtml(issue.html_url)}" rel="noreferrer">去 GitHub 编辑</a></p>
__FOOTER__
</body>
</html>`,
    issue.title,
    '',
  );
}

/**
 * 正文按 HTML 还是 JS 执行：开头就是 HTML 标签 / doctype / 注释的按 HTML，否则按 JS
 * （JS 里拼 HTML 字符串很常见，所以只看开头，不看正文里有没有标签）。
 * 打 js / html 标签可以强制指定。
 */
function resolveMode(issue) {
  const labels = labelNames(issue);
  if (labels.includes('js')) return 'js';
  if (labels.includes('html')) return 'html';
  return /^\s*<[a-zA-Z!/]/.test(issue.body ?? '') ? 'html' : 'js';
}

/** issue 的标签名（小写）。 */
function labelNames(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '').toLowerCase());
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
  const items = pages
    .map((page) => {
      const date = escapeHtml(page.updatedAt.slice(0, 10));
      const state = page.state === 'open' ? '' : ' · 已关闭';
      return `    <li>
      <time datetime="${date}">${date}</time>
      <span><a href="./${page.url}">${escapeHtml(page.title)}</a>
        <span class="meta">#${page.number}${state} · <a href="${escapeHtml(page.htmlUrl)}">编辑</a></span></span>
    </li>`;
    })
    .join('\n');

  const empty = `  <p class="muted">📭 还没有 issue。新建一个 issue，标题就是访问路径，正文就是页面内容，打上 <code>publish</code> 标签后上线。</p>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(siteName)}</title>
<style>
${style}
</style>
</head>
<body>
<h1>📄 ${escapeHtml(siteName)}</h1>
<p class="muted">issue 标题即路径（<code>${escapeHtml(basePath)}{标题}/</code>），正文即页面内容。</p>
<hr>
${pages.length ? `  <ul class="post-list">\n${items}\n  </ul>` : empty}
${footer}
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** 正文若是 JS，包进 script 标签前要拆掉可能提前闭合标签的序列。 */
function escapeScript(code) {
  return String(code).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
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
