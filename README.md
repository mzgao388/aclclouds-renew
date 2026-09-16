# ACLClouds Auto-Renew

自动续期 ACLClouds 免费服务器（Discord Bot / Minecraft）。

## 工作原理

使用 Playwright 浏览器自动化：
1. 登录 dash.aclclouds.com（自动过行为验证码）
2. 查询所有服务器
3. 对可续期的服务器执行续期操作

## GitHub Actions 设置

1. Fork 或创建仓库，上传代码
2. 在仓库 Settings → Secrets and variables → Actions 中添加：
   - `ACL_EMAIL` — 你的 ACLClouds 邮箱
   - `ACL_PASSWORD` — 你的 ACLClouds 密码
   - `TG_BOT_TOKEN` — 你的 Telegram TOKEN
   - `TG_CHAT_ID` — 你的 Telegram ID
   - `PROXY_URL` — 代理节点
3. Workflow 会每2天自动运行一次

## 手动触发

在 GitHub Actions 页面点击 "Run workflow" 即可手动运行。
