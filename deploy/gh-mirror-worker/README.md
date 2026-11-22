# gh-mirror-worker

自建的 GitHub release 镜像（Cloudflare Worker），线上地址 `https://gh.hao3039032.work`。
URL 形式与 ghproxy 相同，应用的 `updateMirrors` 直接可用：

```
https://gh.hao3039032.work/https://github.com/hao3039032/pi-agent-desktop/releases/download/<tag>/<file>
```

## 放行范围（其余一律 403）

只放行 `ALLOWED_REPOS`（`wrangler.toml`）里列出的仓库，而且只允许以下形式：

| 请求 | 上游 |
|---|---|
| `api.github.com/repos/<repo>/releases/latest` | API（边缘缓存 5 分钟） |
| `github.com/<repo>/releases/latest/download/<file>` | API 查资产 → API 资产下载 |
| `github.com/<repo>/releases/download/<tag>/<file>` | API 查资产 → API 资产下载 |
| `github.com/<repo>/archive/[refs/(heads\|tags)/]<ref>.zip\|.tar.gz` | codeload |

- 仅允许 GET 和 HEAD；访问者的 Cookie 和 Authorization 一律不转发，只转发 `Range`（支持断点续传）。
- 上游的重定向由 Worker 自己跟随，只允许跳到 GitHub 自家的下载域名。
- `GITHUB_TOKEN` 只发给 api.github.com，跳转到 CDN 时不会带上。
- 按 IP 限速：每分钟 120 次（`RATE_LIMITER`）。
- release 资产不走 github.com 下载：github.com 会对 Cloudflare 共享的出口 IP 返回 429，所以改走 API。

应用本身不信任镜像：更新信息会再校验一遍，安装包要通过 minisign 签名校验。镜像最多只能拖慢或拒绝更新，改不了装进来的内容。

## 部署与维护

```bash
cd deploy/gh-mirror-worker
npx wrangler login          # 首次使用：浏览器授权
npx wrangler deploy         # 发布（同时创建自定义域名的 DNS 记录和证书）
npx wrangler secret put GITHUB_TOKEN   # 推荐：见下文
npx wrangler tail           # 查看实时日志
node --test index.test.mjs  # 单元测试（npm test 也会跑）
```

**GITHUB_TOKEN**：不带 token 时，API 的配额是每个出口 IP 每小时 60 次，而 Cloudflare 的出口 IP 是很多人共用的，随时可能被打满。推荐在 GitHub → Settings → Developer settings → Fine-grained tokens 新建一个 token：Repository access 选 “Public repositories (read-only)”，不勾选任何权限。这样即使泄露也只能读公开仓库。token 过期后要重新执行 `secret put`。

想换域名或增加放行的仓库，就改 `wrangler.toml` 后重新 deploy。换了域名的话，还要同步改 `distro/distro.json` 的 `updateMirrors`：安装器读的是构建时编译进去的列表，所以要发一个新版本才会生效。
