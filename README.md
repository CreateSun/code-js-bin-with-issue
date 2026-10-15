# code-js-bin-with-issue

用 GitHub Issue 当编辑器、用 GitHub Pages 当托管的极简「代码 bin」：

- **issue 标题 = 访问路径**，例如标题 `abcd` → `/abcd/`
- **issue 正文 = 页面内容本身**，构建时（SSG）写进该页面的 HTML，运行时不再请求任何数据

站点地址：https://createsun.github.io/code-js-bin-with-issue/

## 怎么用

1. 在仓库里新建 issue，标题写英文路径名（如 `abcd`）。
2. 正文写页面内容。可以是 HTML：

   ```html
   <h1>hello</h1>
   <button onclick="document.body.style.background='#ffe'">点我</button>
   ```

   也可以是纯 JS（会被包进 `<script>` 执行）：

   ```js
   document.body.innerHTML = '<h1>' + new Date() + '</h1>';
   ```

3. 等 Actions 跑完（`opened` 事件会自动触发构建），访问 `https://createsun.github.io/code-js-bin-with-issue/abcd/`。
   改完 issue 正文也会自动重新发布；删除 issue，页面随之消失。

> 页面是整份 HTML，Pages 给了 `cache-control: max-age=600`：刚看过的页面在重新部署后可能还被浏览器/CDN 缓存几分钟，看不到新内容时强刷一次（Cmd/Ctrl+Shift+R）。

## 路径规则

- 标题去掉首尾空白、把空白折成 `-`、剔除 `/\:*?"<>|#%` 与控制字符后作为目录名，如 `Hello World` → `/Hello-World/`。中文标题也可以，浏览器会做百分号编码。
- 归一化后重名的（`a b` 和 `a-b`）第二个会加 `-2` 后缀；标题为空则用 `issue-<编号>`。
- 大小写敏感，链接要和标题完全一致（`404.html` 是纯静态提示页，不做跳转）。
- 改标题会换路径，旧链接失效（可用旧标题再开一个 issue，或在 `404.html` 里自行扩展映射）。

## 正文怎么被执行

**构建时**（SSG）逐个 issue 生成 `dist/{slug}/index.html`，**正文就是页面本身**（没有 iframe）。页面运行时**不请求任何数据**，正文随 HTML 一起下发，直接执行：

- 正文开头就是 HTML 标签 / `<!DOCTYPE` / 注释 → 按 HTML 渲染（带 `<!DOCTYPE`/`<html` 的完整文档原样使用，片段会套上 `src/page.html` 这层外壳，补 `charset` / `viewport` / `title`）。
- 其余情况 → 按 JS 执行（包进 `<script>`；JS 里拼 HTML 字符串很常见，所以只看开头，不看正文里有没有标签）。
- 判定不准时用 issue 标签强制：打 `js` 标签恒按 JS，打 `html` 标签恒按 HTML。
- 片段运行时报错会以红色浮层显示（`Error` / `UnhandledRejection` 都接得住），不至于白屏。

因为正文与站点同源，它的权限和普通页面一样：

| 想做的事 | 支持情况 |
| --- | --- |
| `location.href = …` / `location.replace(…)` | 替换整个标签页，和普通页面一致 |
| 相对路径 `fetch('./data.json')`、`localStorage`、`sessionStorage`、`document.cookie`、`history.pushState` | 都可用 |
| `<a href>`、`<form>`、`window.open` | 按浏览器常规行为 |

片段被包进 `<script>` 时会转义 `</script`、`<!--` 这类会提前闭合标签的序列；HTML 片段则原样输出（它本身就是页面源码）。

## 本地预览

```bash
npm run build      # 拉取 issue 生成 dist/
npm run preview    # 起在 http://localhost:8080
```

本地默认 `BASE_PATH=/`，所以路径是 `http://localhost:8080/abcd/`；线上是项目站点，前面多一层仓库名。

## 目录结构

```
scripts/build.mjs              拉取 issue → 生成 dist/（正文在构建时写进页面）
src/page.html                  片段模式的外壳：__TITLE__ / __CONTENT__ 占位
src/404.html                   未命中路径时的纯静态提示页
.github/workflows/deploy-pages.yml   issue/推送触发构建并发布到 Pages
dist/                          构建产物（不入库）
```

## 构建脚本的环境变量

| 变量 | 说明 |
| --- | --- |
| `GITHUB_REPOSITORY` | `owner/repo`，Actions 自动注入；本地缺失时从 `git remote origin` 推断 |
| `GITHUB_TOKEN` | 可选，仅用于提高 API 速率限制 / 读取私有仓库 issue |
| `BASE_PATH` | 站点前缀，项目站点形如 `/code-js-bin-with-issue/`，默认 `/` |
| `ISSUE_AUTHOR` | 只发布该作者的 issue，默认仓库 owner；设为空字符串则不限作者 |
| `GITHUB_API_URL` | 可选，GitHub Enterprise 时指向自己的 API |

## 安全提示

- 正文与站点同源、拥有整页权限（能跳转、能读写本域存储），所以**只发布 owner 自己写的 issue** 是这里的主要防线：仓库是公开的，任何人都能开 issue，否则别人就能在你的 `github.io` 域名下挂一个页面（钓鱼/诱导下载）。这条由 workflow 里的 `ISSUE_AUTHOR` 保证，默认等于仓库 owner；要把发布权给协作方就改这个变量或删掉那一行。
- 正文来自 issue，属于「你（或你信任的人）自己写的代码」，但它仍然跑在浏览器里：不要在里面放 token、密钥。
- issue 列表页 `index.html` 只列出已发布的 issue。
