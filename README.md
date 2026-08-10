# codex-image

在**没有原生 `image_gen` 工具**的 agent 会话里生成、参考生成和编辑图片。

名字里的 "codex" 指的是**它怎么生成**，不是**谁能用**：它复用 Codex 生态的配置形态（`base_url` + Key）和 Codex CLI 这条通路，但 Skill 本身在 **Codex 和 Claude Code 两个宿主里都可用**。

> **委托路径（`codex exec`）尚未经过真实验收。** 它按 OpenAI 官方文档实现，并有完整的离线桩测试覆盖，但还没有在账号登录的 Codex 环境里跑过端到端。HTTP 路径不受此限。

## 它解决什么问题

用第三方自定义 Base URL 的新版 Codex 时，网关本身能生图，但当前会话不一定暴露原生 `image_gen` 工具——内置的 imagegen Skill 会报告"从未成功调用过 image_gen"。同一个网关经 `POST /responses` 的服务端 `image_generation` 工具却能正常出图。

Claude Code 里则根本没有原生图片工具。而 ChatGPT 订阅用户通常也没有独立 API Key，不该为了生图单开一份按量计费账单。

## 两条路径

| 路径 | 触发条件 | 计费 | 上限 |
|---|---|---|---|
| `http` | 解析出完整 Base URL + API Key | 你自己的 API 账单 | 单次运行最多 4 次请求（自动重试） |
| `codex-cli` | 无可用 Key，且本机 Codex CLI 为账号登录 | ChatGPT 订阅额度 | 单次运行 1 次 `codex exec`，600 秒 |

两条都不可行时，Skill 会报告本机状态并引导配置，而不是丢一句"无法生成图片"。

## 安装

`SKILL.md` 遵循 [Agent Skills](https://agentskills.io) 开放标准，同一份文件双端通用。把本目录挂到你的 skills 目录即可（推荐 symlink，实体只保留一份）：

```bash
# Claude Code
ln -s "$PWD/codex-image" ~/.claude/skills/codex-image
# Codex
ln -s "$PWD/codex-image" ~/.agents/skills/codex-image
```

运行时只需要 Node.js 18+，没有 npm 或 Python 依赖。平台支持 macOS 与 Linux。

## 配置

```bash
export CODEX_IMAGE_BASE_URL="https://your-gateway.example/v1"
export CODEX_IMAGE_API_KEY="sk-..."
export CODEX_IMAGE_MODEL="<顶层模型>"
export CODEX_IMAGE_OUTPUT_DIR="./codex-image/output"   # 可选
```

每个字段独立按这个顺序取第一个非空值：进程环境变量 → `$PWD/.env.local` → `$PWD/.env` → `~/.config/codex-image/.env`（需 `--use-local-key`）→ 当前 Codex 配置（需 `--use-codex-config`，读 `config.toml` 的 `base_url`/`model` 与 `auth.json` 的 `OPENAI_API_KEY`）。

前三层只读脚本被调用时的工作目录，不向父目录递归。后两层必须每轮显式授权，不会被继承。

## 直接用脚本

```bash
# 执行：离线校验全部通过后直接发起请求
node scripts/generate-image.mjs --prompt "白色背景上的红色陶瓷杯，不要文字" --json

# dry-run：只校验并输出计划摘要，绝不联网
node scripts/generate-image.mjs --prompt "白色背景上的红色陶瓷杯，不要文字" --preflight --json

node scripts/generate-image.mjs --help
```

三种模式：`generate`（0 张图）、`reference`（参考图生成新图）、`edit`（改指定图）。有 `--image` 时必须显式给 `--mode`，脚本不会从 prompt 猜。

## 设计取舍

- **单命令直接执行，不设付费授权门**。脚本先离线校验配置、路由、输入图和输出目标，全部通过才发起请求；不落任何跨轮状态。`--preflight` 提供纯离线 dry-run。
- **API Key 永不作为命令行参数**，也不写进 stdout、stderr、JSON 或日志。只显示 SHA-256 前 12 位短指纹。
- **绝不读取或转发账号登录的 OAuth token**。账号形态一律通过本机 Codex CLI 自己完成鉴权。
- **失败不静默换路**：不会自动改用 Images API、换 provider、换模型、换 Key，也不会退回原生工具。
- **重试范围窄且提前披露**：只有窄类别的快速失败（<45 秒且未收到图片）才自动重试，最多 4 次总请求，`response.failed` 和所有 4xx 一律不重试。
- **图片先验后落盘**：按 magic bytes 判定格式、读出真实宽高，写临时文件校验通过后才原子重命名，从不覆盖已有文件。

## 测试

```bash
node --test
```

全部离线：provider 由本地 mock HTTP server 扮演，Codex CLI 由 PATH 上的桩程序扮演，配置读写在隔离的临时 HOME 里进行。测试从不访问真实 provider，也不产生任何费用。

## 许可

见 [LICENSE](LICENSE)。
