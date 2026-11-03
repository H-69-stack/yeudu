# Claude Code 子代理后端不可用（事实记录）

> 时间：2026-11-03 22:3x（Asia/Shanghai）· 主理人实测

## 结论

本机**无法启动 Claude Code 子代理**，因此本轮评审的 15 个子代理全部由 DSH 子代理后端承担，
Claude 侧要求的"独立第三方复核"改由**同后端的对抗式核验代理**替代（见终稿 §校验方式）。

## 证据（两次尝试，均为最小化提示）

| # | 提示内容 | 结果 |
|---|---|---|
| 1 | 读 `03-code/package.json` 并回报依赖与测试脚本 | `product: Claude Code; stage: query-run; category: invalid-result; exit code: 1`，无收尾消息 |
| 2 | 单字提示 `Reply with exactly: OK` | 同上，`exit code: 1`，无收尾消息 |

## 根因排查

| 检查项 | 结果 |
|---|---|
| `Get-Command claude / claude-code / claude.exe` | 0 个命中 |
| `%APPDATA%\npm\claude.cmd` | 不存在 |
| `%LOCALAPPDATA%\Programs\claude\claude.exe` | 不存在 |
| `%USERPROFILE%\.local\bin\claude.exe` | 不存在 |
| `%USERPROFILE%\.claude\` | 存在（backups/ide/sessions/skills + settings.json 35B + `.last-cleanup`），**无 `.credentials.json`** |
| `ANTHROPIC_*` 环境变量 | 一个都没有 |
| `CLAUDE_AGENT_SDK_VERSION` | 存在（SDK 随宿主打包，但缺可执行体/凭据） |

判断：宿主内嵌了 Claude Agent SDK，但**没有安装 `claude` 可执行文件，也没有任何认证凭据**，
所以 query-run 阶段拉不起来 → `invalid-result` + `exit 1`。这不是提示词问题（单字提示同样失败），也不是瞬时故障（两次一致）。

## 若要启用，需要做的事（供用户决策）

1. 安装 Claude Code CLI（`npm i -g @anthropic-ai/claude-code` 或官方安装包），确认 `claude --version` 可用；
2. 配置认证：`ANTHROPIC_API_KEY` 环境变量，或 `claude` 登录后生成 `~/.claude/.credentials.json`；
3. 重跑本轮的 Claude 复核任务即可（`05-review/` 下的产物与提示词可直接复用）。

> 未做：没有尝试 `npm install`（本机 registry 返回 404，装不上），也没有尝试用第三方中转绕过认证。
