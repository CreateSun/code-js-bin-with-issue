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

3. 核对内容没问题后，给这个 issue 打上 `publish` 标签——**这一下就是审批放行**；没打标签的 issue 不会出现在站点上。
4. 等 Actions 跑完（`labeled` 事件会自动触发构建），访问 `https://createsun.github.io/code-js-bin-with-issue/abcd/`。
   改完 issue 正文会重新发布；**去掉 `publish` 标签，页面下线**；删除 issue，页面随之消失。

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
src/page.html                  片段模式的外壳：__STYLE__ / __TITLE__ / __CONTENT__ / __FOOTER__ 占位
src/style.css                  站点基础样式，构建时内联进每个页面
src/footer.html                每页底部的页脚（博客链接），构建时注入
src/404.html                   未命中路径时的纯静态提示页
.github/workflows/deploy-pages.yml   issue/推送触发构建并发布到 Pages
dist/                          构建产物（不入库）
```

## 外观

样式集中在 `src/style.css`，构建时内联进每个页面（不额外发请求），默认是一套参考 [bearblog](https://bearblog.dev/) 的极简排版：800px 窄栏居中、Verdana 字体栈、`line-height 1.6`、无卡片无圆角，跟随系统深浅色。要改站点的样子就改这一个文件。

内容片段里的 `<style>` 排在基础样式之后，所以能给单页覆盖字体、间距等；想完全自控就写成带 `<!DOCTYPE` 的完整文档，那会原样输出、不套外壳。

页脚放在 `src/footer.html`（现在是博客链接），构建时注入到每一页。两个已知边界：

- 完整文档不注入基础样式（避免和作者自己的 CSS 打架），但页脚仍会追加到文档末尾。
- 正文里的 JS 如果整体重写 `document.body.innerHTML`，会把页脚一起覆盖掉——想保留就改成 `insertAdjacentHTML('beforeend', …)` 之类的追加写法。

## 构建脚本的环境变量

| 变量 | 说明 |
| --- | --- |
| `GITHUB_REPOSITORY` | `owner/repo`，Actions 自动注入；本地缺失时从 `git remote origin` 推断 |
| `GITHUB_TOKEN` | 可选，仅用于提高 API 速率限制 / 读取私有仓库 issue |
| `BASE_PATH` | 站点前缀，项目站点形如 `/code-js-bin-with-issue/`，默认 `/` |
| `ISSUE_AUTHOR` | 只发布该作者的 issue，默认仓库 owner；设为空字符串则不限作者 |
| `PUBLISH_LABEL` | 发布审批标签，默认 `publish`：issue 要有这个标签才上线；设为空字符串则不审批 |
| `GITHUB_API_URL` | 可选，GitHub Enterprise 时指向自己的 API |

## 发布审批

一个 issue 要上线，得同时满足两个条件；不满足就跳过，原因会打在构建日志里：

1. **作者在名单里**（`ISSUE_AUTHOR`，默认等于仓库 owner）。
2. **打了 `publish` 标签**（`PUBLISH_LABEL`）。

于是流程变成：写 issue（此时线上还没有这一页）→ 自己核对／本地 `npm run preview` 看效果 → 打上 `publish` 标签 → 自动发布。改正文会重新发布，去掉标签页面就下线。删除 issue 也一样会撤掉页面。

标签这层能当审批用，是因为**打标签需要仓库的 triage 或 write 权限**：外部投稿人没有这个权限，无法自己批准自己的内容，只能等你来打标签。

想要更强的、GitHub 原生的审批（每次部署前都要人工点一次「Approve」）：仓库 **Settings → Environments → `github-pages`** 里加 **Required reviewers**（公开仓库各套餐都可用）。两个注意点：

- 它拦的是**每一次部署**，包括你自己改 issue 触发的那种，每次都要点一下批准。
- 「Prevent self-review」默认是关闭的。打开之后发起部署的人不能批准自己的部署——如果你只有自己一个 reviewer，那就没人能批了，需要再加一个人。

想关掉标签这层审批：把 `PUBLISH_LABEL` 设成空字符串（workflow 里那一行，或本地跑构建时的环境变量），就回到「名单内的 issue 一律发布」。

## 安全提示

- 正文与站点同源、拥有整页权限（能跳转、能读写本域存储），所以**两道发布门**是主要防线：仓库是公开的，任何人都能开 issue，但他们既进不了 `ISSUE_AUTHOR` 名单、也打不了 `publish` 标签，内容上不了线。反过来说，只要你给某个人的 issue 打上了 `publish`，那内容就和你自己写的一样有整页权限。
- 正文来自 issue，属于「你（或你信任的人）自己写的代码」，但它仍然跑在浏览器里：不要在里面放 token、密钥。
- issue 列表页 `index.html` 只列出已发布的 issue。
