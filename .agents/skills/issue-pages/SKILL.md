---
name: issue-pages
display-name: Issue Pages 部署
description: 帮用户把 Issue Pages（用 GitHub Issue 当内容源的静态发布工具）部署成一套自己的站点：fork 仓库、开通 Actions 与 Pages、建 publish 标签、发布第一张页面，并验证最终网址真的能打开。当用户说「帮我部署一套 Issue Pages」「fork 这个仓库跑起来」「把这几个 HTML 发布到我自己的 GitHub Pages」「用 issue 发布网页」时使用。
---

# Issue Pages 部署

帮用户把自己的一份 Issue Pages 跑起来。上游仓库默认是 `CreateSun/code-js-bin-with-issue`，用户要 fork 的是它。

## 先确认三件事

1. `gh auth status` 显示已登录，且 token 有 `repo` scope（没有就先让用户 `gh auth login`，不要代替用户登录）。
2. 部署到哪个账号/仓库：默认是当前登录用户 fork 上游仓库；用户已有 fork 时直接用它，不要重复创建。
3. 是否要保留发布审批：默认保留（`ISSUE_AUTHOR` = 仓库 owner，`PUBLISH_LABEL` = `publish`）。用户说「不用审批」就让他把工作流里的 `PUBLISH_LABEL` 改成空字符串。

下面的命令把 `$OWNER` 换成用户的账号名、`$REPO` 换成 fork 出来的仓库名。

## 部署步骤

### 1. Fork 并克隆

```bash
gh repo fork CreateSun/code-js-bin-with-issue --clone --default-branch-only
```

`gh` 已经 fork 过会报错，此时改成克隆已有的那个 fork。克隆目录里 `git remote origin` 就是用户的 fork。

### 2. 打开工作流开关

GitHub 不会在新 fork 上自动运行工作流，必须显式打开：

```bash
gh api -X PUT "repos/$OWNER/$REPO/actions/permissions" -f enabled=true
```

失败（403 等）就告诉用户在仓库 Actions 页点 “I understand my workflows, go ahead and enable them”，不要跳过这步——跳过会表现为「部署一直没跑」。

### 3. 启用 GitHub Pages（构建源 = GitHub Actions）

```bash
gh api -X POST "repos/$OWNER/$REPO/pages" -f build_type=workflow
```

已存在会返回 409，可以忽略。**不要依赖工作流自己开通 Pages**：`GITHUB_TOKEN` 没有创建 Pages 站点的权限，没启用就运行会以 “先打开 …/settings/pages” 的报错失败——这是预期行为，不是配置坏了。

### 4. 建发布标签

```bash
gh label create publish --repo "$OWNER/$REPO" --color 0E8A16 \
  --description "打上这个标签才发布到站点（审批通过）"
```

标签名要和 `PUBLISH_LABEL` 一致。**没有这个标签时所有 issue 都会被跳过**，站点会是空的——这是最常见的「部署成功但页面 404」原因。

### 5. 换成用户自己的信息

- `src/footer.html`：把博客链接和源码链接换成用户自己的，或整段删掉。
- 首页标题默认取仓库名，想改就设工作流里的 `SITE_NAME`。
- 想改站点样式：`src/style.css`。

改完提交推送：

```bash
git add -A && git commit -m "chore: 改成我自己的站点信息" && git push
```

推送会触发一次构建，你也可以顺便确认工作流能跑通。

### 6. 发布第一张页面

把页面源码写进一个文件（HTML 片段、完整 HTML 或纯 JS 都可以），然后：

```bash
gh issue create --repo "$OWNER/$REPO" --title hello --body-file /tmp/hello.html --label publish
```

`--title` 就是访问路径，用英文小写和连字符。

### 7. 等部署完成并**验证网址真的能打开**

```bash
gh run list --repo "$OWNER/$REPO" --limit 3
run=$(gh run list --repo "$OWNER/$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$run" --repo "$OWNER/$REPO" --exit-status
```

工作流成功**不等于**网站可访问。必须再验证一次，直到拿到 200 或超时：

```bash
host="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
url="https://$host.github.io/$REPO/hello/"
for i in $(seq 1 20); do
  code=$(curl -s -o /tmp/page.html -w '%{http_code}' "$url")
  [ "$code" = "200" ] && break
  sleep 10
done
echo "$code $url"
grep -q "页面正文里的某个特征字符串" /tmp/page.html && echo "内容已上线"
```

首次部署 Pages 可能有几十秒到几分钟的传播延迟，属正常。最后把 `url` 报给用户。

## 排查

| 现象 | 原因与处理 |
| --- | --- |
| 完全没有工作流运行 | fork 的 Actions 没开（步骤 2）；或 issue 事件没触发，手动 `gh workflow run deploy-pages.yml --repo "$OWNER/$REPO"` |
| 运行失败并提示「先打开 …/settings/pages」 | Pages 还没启用，按步骤 3 做完再重跑；如果是在启用 Pages 之前推的代码，这次失败属正常 |
| 构建日志里全是「跳过 #N … 还没有 publish 标签」 | 标签名与 `PUBLISH_LABEL` 不一致，或 issue 没打标签 |
| 构建日志里「作者 xxx 不在发布名单内」 | `ISSUE_AUTHOR` 是别人；要放开发布就把它设为空字符串 |
| 构建成功但访问 404 | Pages 没启用 / 构建源不是 GitHub Actions（步骤 3）；或路径拼错、大小写不符 |
| 页面是旧的 | Pages 对 HTML 有 `cache-control: max-age=600`，强刷一次 |
| `gh: Not Found` / `Resource not accessible` | token 缺 `repo` scope 或不是仓库 admin |

## 不要做的事

- 不要在没 curl 到 200 的情况下告诉用户「已经部署好了」。工作流 success 只说明构建和部署动作完成。
- 不要替用户改仓库名、转让或删除仓库；改名会让全部旧链接失效，要由用户决定。
- 不要把 token、密码写进任何文件或命令参数里让用户看到。
- 只有在用户明确要求时才关闭审批门或放开作者名单——这两项是防止别人往他的域名上发内容的主要手段。
