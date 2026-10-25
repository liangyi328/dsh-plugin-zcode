# dsh-plugin-zcode

把 **ZCode Start Plan** 的 GLM-5.3 / GLM-5.3-Flash 接入 [DeepSeek Harness (DSH)](https://deepseek.com)。

**零 API Key、零配置、无需 ZCode 客户端常开**：直接读本机 ZCode 客户端已登录的凭据。

## 前提

本机装过 ZCode 桌面客户端，并**至少登录过一次**。之后客户端不用保持运行。

## 工作原理

```
DSH  →  https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages  （Anthropic Messages 协议）
```

**凭据**：读 `credentials.json` 的 `enc:v1:` 字段（AES-256-GCM）：

```
key = sha256( ZCODE_CREDENTIAL_SECRET
              ?? `zcode-credential-fallback:${platform}:${homedir}:${username}` )
```

取出 `zcodejwttoken`（业务 JWT，无 exp）与 `oauth:zai:access_token`。客户端和 CLI 可能用不同的数据目录，
插件会自动搜索并选**最新**的那份——旧文件也能解密，但 JWT 已失效，用它会 401。

**指纹**：网关用顶层 `system` 原文做客户端指纹校验。`lib/system-template.json` 是客户端真实的 3 段 prompt，
必须原样发送（后两段带 `cache_control: {type:"ephemeral"}`）。压成字符串、改短或改一个字符 → `405 code 3012`。

**续期**：`401/403` 时用 OAuth access token 调 `POST /api/auth/z/login` 换新 JWT 并重试一次。

**限流**：上游 `429`（code 3008/3009/3010）映射为 `RATE_LIMIT`，由 DSH 重试策略兜底。

## 模型

| 模型 | 上下文 | 最大输出 |
| --- | --- | --- |
| GLM-5.3 | 1,000,000 | 128,000 |
| GLM-5.3-Flash | 1,000,000 | 128,000 |

## 安装

DSH 的 profile 是 pnpm workspace，**两处声明缺一不可**：

1. `C:/Users/<user>/.dsh/profiles/desktop/package.json`
   - `dependencies` 加 `"dsh-plugin-zcode": "link:<本仓库路径>"`
   - `dsh.profile.bundles` 数组追加 `"dsh-plugin-zcode"`
2. 安装并重启 DSH：

   ```powershell
   cd C:/Users/<user>/.dsh/profiles/desktop
   node "<DSH>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install --offline
   ```

重启后模型选择器出现 **ZCode (GLM Start Plan)** 分组。

## 配置（可选）

一般不需要。在 `cordis.patch.yml` 里用 id-targeted 覆盖（`- id: llm-zcode / config: {...}`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `credentialsPath` | 自动搜索 | 显式指定 `credentials.json` 或其目录 |
| `fingerprintPath` | 内置 | 显式指定 `system-template.json` |
| `clientVersion` | `3.15.3` | 覆盖 `X-Client-Version` 等头 |
| `displayName` | `ZCode (GLM Start Plan)` | 模型选择器里的分组名 |
| `debugLogPath` | 未设置 | 诊断日志文件；不设置则静默 |

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `无法读取 ZCode 凭据` | 没登录过，或数据目录在别处 | 打开 ZCode 客户端登录一次；或用 `credentialsPath` 指定 |
| `凭据失效`（401/403） | JWT 过期且 access token 也失效 | 在 ZCode 客户端重新登录一次 |
| `客户端指纹被网关拒绝`（3012） | `system-template.json` 被改动 | 还原该文件，必须逐字节一致 |
| `忙或额度不足`（429） | 当日额度用尽或网关繁忙 | 换 Flash，或等额度重置 |

## 说明

请求体会把 DSH 的 system 提示转成一条前置的 `role:"system"` 消息，因为顶层 `system` 槽位要留给指纹。
实测这种形式被网关接受，且不影响模型对指令的理解。

## 参考

机制参考了同生态的 [dsh-zcode-connect](https://github.com/luoluo-up/dsh-zcode-connect) 与
[zcode-api](https://github.com/TriDefender/zcode-api)。本插件为独立实现，走 DSH 原生 provider/adapter 接口，
不需要本地反代进程。

## 兼容性

DSH `>=0.2.0-rc.2`。MIT License。
