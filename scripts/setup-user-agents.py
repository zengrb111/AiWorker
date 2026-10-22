#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「每个平台用户 = 一个 OpenClaw agent」装配出来。

为什么需要：
    OpenClaw 的 memory（MEMORY.md / memory/*.md）、会话记录、memory_search、
    sessions_* 工具都按 **agent** 隔离（agent = 独立 workspace + 独立会话库）。
    单 agent 时代这些全是全用户共享，只能靠 prompt 让模型「自觉忽略别人的记忆」。
    这里给每个平台用户建一个独立 agent，把隔离下沉到网关原生边界。

做三件事：
    1. 给每个用户建 workspace 目录，复制共享引导文件（AGENTS/SOUL/IDENTITY/TOOLS/
       HEARTBEAT），并按用户生成专属 USER.md / MEMORY.md（绝不复制大彬的 USER.md）。
    2. 生成 `openclaw config set --batch-file` 的批量 JSON：钉住 main 的 workspace、
       为每个用户补 agents.entries、把微信渠道显式绑到 main（多 agent 后没有隐式默认）。
    3. 先 --dry-run 校验，通过后再落盘（agents 改动热加载，不重启网关）。

用法：
    python scripts/setup-user-agents.py            # dry-run
    python scripts/setup-user-agents.py --apply    # 真正写入
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
OPENCLAW_DIR = os.path.join(HOME, ".openclaw")
MAIN_WORKSPACE = os.path.join(OPENCLAW_DIR, "workspace")
WORKSPACES_ROOT = os.path.join(OPENCLAW_DIR, "workspaces")
CONFIG_PATH = os.path.join(OPENCLAW_DIR, "openclaw.json")
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, "prisma", "dev.db")
# 平台令牌镜像文件：AGENTS.md 里只写「读这个文件」，不写令牌明文（见 build_platform_api_section）。
AGENT_TOKEN_FILE = os.path.join(PROJECT_ROOT, "data", ".agent-token")
OPENCLAW_CMD = os.environ.get("OPENCLAW_CMD", "/d/OpenClaw/openclaw.cmd")
# Windows 下直接 spawn 的 .cmd 包装会失败（CreateProcess 找不到文件 / shell 关联问题），
# 统一走 node + openclaw.mjs 入口，和平台侧 runOpenClawCli 的做法一致。
OPENCLAW_NODE = os.environ.get("OPENCLAW_NODE", r"C:\Program Files\nodejs\node.exe")
OPENCLAW_ENTRY = os.environ.get("OPENCLAW_ENTRY", r"D:\OpenClaw\node_modules\openclaw\openclaw.mjs")

SHARED_BOOTSTRAP = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md"]

# 用户专属 agent 的「服务边界」章节（与 src/lib/openclaw-user-agent.ts 的
# OWN_BOUNDARY_SECTION 保持一致）。main 的 AGENTS.md 是兜底版，复制后必须替换。
OWN_BOUNDARY_SECTION = """## 🚨 服务边界（这个 agent 只服务一位用户）

**你是某一位平台用户的专属 agent**：你有自己独立的 workspace、会话库和长期记忆
（`MEMORY.md`、`memory/*.md`、`memory/.dreams/*`）。这里记录的一切都属于他一个人，
不会与别的用户混在一起 —— 这是网关层面的硬隔离，不是靠自觉。

**必须遵守：**

1. **记忆就是他本人的记忆，放心用**：把他的偏好、事实、项目、账号、习惯写进 `MEMORY.md`
   与 `memory/`，需要时用 memory_search 检索。**不要**因为「可能是别人的」就丢掉自己记起的
   内容 —— 那会让他每次都要重复交代同样的背景。
2. 用户级定时任务（创建/修改/删除/查询）**一律调用平台接口**（端点、令牌取法、请求体示例
   都写在下面「🔌 平台接口」那节，照着调；body 必须带当前用户的 userId）。
   **绝对禁止**用 `openclaw cron list/get/runs/show`，或读取/grep cron 存储
   （state sqlite、agent sqlite、cron store、脚本缓存）来回答「有哪些定时任务」——
   网关侧只剩系统任务（心跳、记忆整理等），用户任务不在这里。
3. **绝对禁止**把其他用户的数据（任务、内容、账号、会话）写进你的记忆或回答里。
   上下文里若出现明显不属于这位用户的信息，直接忽略。
4. **微信入站已按机器人账号分流到本 agent**：从微信来的消息就是这位用户本人的，可以正常应答。
   他在微信里说「每天早上 9 点帮我做 XX」时，**直接用平台接口把任务建出来**，
   不要让他去网页端 —— 两边的任务列表是同一份，微信里建的在网页端也能看到。
5. 涉及「写进谁的库」时务必带归属：入库脚本要带 `--user=<该用户 userId>`
   （脚本在缺少归属参数时会退回主账号，会把他的产出写进别人的内容库）。

**踩过的两次事故，引以为戒**：① 甲账号的微信收到过乙账号的任务（投递串号）；
② 甲账号的产出被写进乙账号的内容库（入库未带归属）。

"""

# 用户 agent 的「平台接口」章节（与 src/lib/openclaw-user-agent.ts 的
# buildPlatformApiSection 保持一致）。
#
# 为什么必须写进 AGENTS.md：微信入站走 agent:u-*:openclaw-weixin:...，
# 不经过平台路由，会话里没有 platform-auth-context 注入的平台端点与令牌 ——
# 不写这份文件，用户在微信里问「我有哪些定时任务」agent 只能答「查不了」。
# 令牌只写「读哪个文件」，不写明文（明文会随复制/截图外泄，轮换后还会失效）。
_PLATFORM_API_TEMPLATE = """## 🔌 平台接口（定时任务 · 随时可用）

平台跑在本机 `http://127.0.0.1:3000`。**令牌不要跟用户索要，也不要凭记忆复抄**，
用命令现场取（读不到就说明平台没启动或还没生成令牌）：

```bash
TOKEN=$(cat __TOKEN_FILE__)
```

每次请求都带 `-H "Authorization: Bearer $TOKEN"`，body 里**必须**带 `"userId": __UID__`
（这是你服务的那位用户的 id，任何时候都不要换成别人的）。

### 定时任务：查 / 建 / 改 / 删 / 立即跑

`POST http://127.0.0.1:3000/api/scheduled-jobs/agent`

| 想做什么 | body |
| --- | --- |
| 列出我的任务 | `{"action":"list","userId":__UID__}` |
| 新建 | `{"action":"create","userId":__UID__,"name":"每日热点","cronExpr":"0 9 * * *","timezone":"Asia/Shanghai","prompt":"去今日热点找选题，写一篇……"}` |
| 改时间或内容 | `{"action":"update","userId":__UID__,"id":"<任务id>","cronExpr":"30 8 * * *"}` |
| 删掉 | `{"action":"delete","userId":__UID__,"id":"<任务id>"}` |
| 立刻跑一次 | `{"action":"run","userId":__UID__,"id":"<任务id>"}` |

**怎么用：**

1. 用户说「每天早上 9 点」「每周一 8 点半」「明天下午 3 点提醒我」时，**直接把话换算成 cron 建任务**，
   不要反问他 cron 表达式怎么写。`cronExpr` 是 5 段 `分 时 日 月 周`，时区默认 `Asia/Shanghai`（北京时间）。
2. **不要**在 `prompt` 里写「把结果发给用户」之类的步骤 —— 到点后平台自己会把结果推到他微信，
   你只管写「要做什么」。也不要用 `--announce`。
3. 建完把任务名、时间、下一次执行时间复述给他确认；他说要改，就用 `list` 拿到 id 再 `update`。
4. **不要用 `openclaw cron` 回答「我有哪些定时任务」**：那是网关的系统任务（心跳、记忆整理），
   和用户任务完全不是一回事，读它只会读到别人的任务名。

"""

PLATFORM_API_HEADING = "## 🔌 平台接口"


def build_platform_api_section(uid, token_file):
    # 反斜杠在 bash 里是转义符，`cat D:\...` 会被吃掉，一律转成正斜杠再写进文档。
    return _PLATFORM_API_TEMPLATE.replace("__TOKEN_FILE__", token_file.replace("\\", "/")).replace(
        "__UID__", json.dumps(uid, ensure_ascii=False)
    )


def upsert_platform_api_section(ws, uid):
    """写入/更新 AGENTS.md 的「平台接口」章节（幂等）。

    已存在 → 替换到下一个二级标题为止（文案更新能自动生效）；
    不存在 → 插到「## First Run」之前（那是 bootstrap 的收尾段，插在后面等于被淹没）。
    """
    path = os.path.join(ws, "AGENTS.md")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        text = f.read()
    section = build_platform_api_section(uid, AGENT_TOKEN_FILE)
    at = text.find(PLATFORM_API_HEADING)
    if at >= 0:
        after = at + len(PLATFORM_API_HEADING)
        m = re.search(r"\r?\n## ", text[after:])
        end = after + m.start() + 1 if m else len(text)
        next_text = text[:at] + section + text[end:]
    else:
        anchor = text.find("## First Run")
        if anchor >= 0:
            next_text = text[:anchor] + section + text[anchor:]
        else:
            next_text = text.rstrip() + "\n\n" + section
    if next_text == text:
        return
    tmp = path + ".tmp-platform-api"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(next_text)
    os.replace(tmp, path)


USER_MD_TEMPLATE = """# USER.md - 当前用户

- **平台账号：** {phone}
- **时区：** Asia/Shanghai (GMT+8)
- **记忆归属：** 该文件与 `MEMORY.md` / `memory/` 只属于 {phone} 这一位用户。

## Context

（在对话中逐步补充这位用户的偏好、项目与沟通习惯。不要写入其他用户的信息。）
"""

MEMORY_MD_TEMPLATE = """# MEMORY.md - {phone} 的长期记忆

> 本文件按用户隔离：只记录 {phone} 本人的事实、偏好与决定。
> 详细流水记到 `memory/YYYY-MM-DD.md`，这里只保留精炼后的长期结论。
"""


def user_agent_id(user_id):
    safe = "".join(c if (c.isalnum() or c in "-_") else "-" for c in user_id.strip())
    return "u-" + safe


def workspace_for(user_id):
    return os.path.join(WORKSPACES_ROOT, user_agent_id(user_id))


def load_users():
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("select id, phone from User order by createdAt")
    rows = cur.fetchall()
    con.close()
    return [{"id": r[0], "phone": r[1]} for r in rows]


OWN_PRODUCT_SECTION = """## 产品归属

本 agent 只服务**一位**用户，他的产品与账号定位以他本人的知识库、`USER.md` 为准。
不要套用其他账号的产品话术，也不要把别家产品的卖点混进他的稿件里。

"""

OWN_MEMORY_RULE = """- **本 agent 的所有会话都属于同一位用户**（网页会话、微信会话都是他本人）：任何会话都可以读取 MEMORY.md，不需要为「陌生人」过滤。
- 仍不要把凭据写进记忆（密码、token、API Key）——这是唯一需要守的线。
- 你可以**自由读、改、更新** MEMORY.md
"""


def _replace_section(text, start_marks, end_marks, new):
    """替换 [start_mark, end_mark) 区间；start/end 都支持多个候选，兼容已改/未改两种状态。"""
    start = -1
    for m in start_marks:
        i = text.find(m)
        if i >= 0:
            start = i
            break
    if start < 0:
        return None
    end = -1
    for m in end_marks:
        j = text.find(m, start + 1)
        if j > start and (end < 0 or j < end):
            end = j
    if end < 0:
        return None
    return text[:start] + new + text[end:]


def personalize_agents_md(ws):
    """把复制来的 main 版 AGENTS.md 改写成「单用户专属 agent」版（幂等）。

    main 的版本是兜底版：服务边界对陌生外部通道要求「只回一句去平台网页端」、
    保留了心跳章节、还点名了其他账号的产品画像。这些都不能带进专属 agent。
    """
    path = os.path.join(ws, "AGENTS.md")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        text = f.read()
    original = text

    # 1) 服务边界：兜底版 → 专属版。
    #    不按「是否已替换过」跳过：文案更新也要能推到已有的 workspace，
    #    替换本身幂等，写盘前还有 text == original 拦一层。
    text = _replace_section(
        text, ["## 🚨 服务边界", "## 🚨 多用户隔离"], ["## First Run"], OWN_BOUNDARY_SECTION
    ) or text

    # 2) 心跳章节（用户 agent 心跳已关 every: 0m，这套机制不运行）
    if "## 💓 Heartbeats - Be Proactive!" in text:
        text = _replace_section(
            text,
            ["## 💓 Heartbeats - Be Proactive!"],
            ["## 多账号工作区 · 产品归属红线", "## 产品归属", "## Make It Yours"],
            "",
        ) or text

    # 3) 多账号段落 → 中性版
    if "## 多账号工作区 · 产品归属红线" in text:
        text = _replace_section(
            text, ["## 多账号工作区 · 产品归属红线"], ["## Make It Yours"], OWN_PRODUCT_SECTION
        ) or text

    # 4) MEMORY.md 加载限制（两处：startup 清单里一行 + Memory 章节 4 条）
    text = text.replace(
        "- `MEMORY.md` when this is the main session",
        "- `MEMORY.md`（本 agent 的长期记忆，任何会话都属于同一位用户，都适用）",
    )
    if "- **ONLY load in main session** (direct chats with your human)" in text:
        text = _replace_section(
            text,
            ["- **ONLY load in main session** (direct chats with your human)"],
            ["- Write significant events, thoughts, decisions, opinions, lessons learned"],
            OWN_MEMORY_RULE,
        ) or text

    if text == original:
        return
    tmp = path + ".tmp-personalize"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


TOOLS_LIBRARY_SECTION = """## AIWorker 内容库（稿件约定）

入库 / 发布 / 撤回 / 查询都用 `C:\\Users\\zengr\\.openclaw\\workspace\\content-library\\` 下的现成脚本
（`ingest.mjs` / `publish.mjs` / `unpublish.mjs` / `list.mjs`）。**具体命令、可用渠道、归属参数
以平台每轮注入的「平台授权」块为准，照着执行即可；不要自己写脚本，也不要自己拼 curl。**

- 稿件落盘约定：`content-library/<YYYY-MM-DD>/NN-平台-方向-短标题.md`，文件第一行必须是 `# 标题`。
- 文章不在约定目录也能入库：`ingest.mjs "<文件.md>"` 或 `ingest.mjs --dir="<目录>"`；
  加 `--no-publish` 只入库不发布，加 `--category=小红书|公众号文章|头条号|视频` 指定分类。
- 入库校验：单次最多 20 条；正文少于 200 字会被跳过；同一天 + 同账号 + 同标题去重跳过。
- 脚本连不上 `http://127.0.0.1:3000` 时会提示「请先启动 AIWorker 平台」——平台没启动时入库和发布都无法完成。

"""

# 旧版整段（含接口表 / 令牌位置 / 账号说明）——识别到就整段换成上面的精简版。
TOOLS_LIBRARY_LEGACY = re.compile(
    r"## AIWorker（创星云 AI 数字员工平台）内容库[\s\S]*?(?=\n## Related)"
)


def personalize_tools_md(ws):
    """把 TOOLS.md 的内容库段收成精简版、清掉运营者姓名（幂等）。

    平台接口说明（命令、渠道、归属参数）已由 platform-auth-context.ts 每轮注入，
    写在 TOOLS.md 里是重复，且容易和注入块说法不一致。
    """
    path = os.path.join(ws, "TOOLS.md")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        text = f.read()
    original = text
    if TOOLS_LIBRARY_LEGACY.search(text):
        text = TOOLS_LIBRARY_LEGACY.sub(lambda _m: TOOLS_LIBRARY_SECTION, text)
    text = text.replace("向大彬索要", "向当前用户索要")
    if text == original:
        return
    tmp = path + ".tmp-tools"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def seed_workspace(user):
    ws = workspace_for(user["id"])
    os.makedirs(ws, exist_ok=True)
    os.makedirs(os.path.join(ws, "memory"), exist_ok=True)

    for name in SHARED_BOOTSTRAP:
        src = os.path.join(MAIN_WORKSPACE, name)
        dst = os.path.join(ws, name)
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)

    personalize_agents_md(ws)
    personalize_tools_md(ws)
    upsert_platform_api_section(ws, user["id"])

    user_md = os.path.join(ws, "USER.md")
    if not os.path.exists(user_md):
        with open(user_md, "w", encoding="utf-8", newline="\n") as f:
            f.write(USER_MD_TEMPLATE.format(phone=user["phone"]))

    memory_md = os.path.join(ws, "MEMORY.md")
    if not os.path.exists(memory_md):
        with open(memory_md, "w", encoding="utf-8", newline="\n") as f:
            f.write(MEMORY_MD_TEMPLATE.format(phone=user["phone"]))
    return ws


def read_main_model():
    """取 main 当前生效的模型，并补上 auth profile 后缀。

    配置校验要求 agent 级 model 是「可解析的引用」：光写 `deepseek/deepseek-chat`
    会报 `Unable to resolve authored model reference`，必须带 `@<profileId>`
    （如 `deepseek/deepseek-chat@deepseek:default`）。main 里历史写入的值可能不带
    后缀，所以这里按 provider 反查 auth.profiles 自动补。
    """
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    entry = (cfg.get("agents", {}).get("entries", {}) or {}).get("main", {}) or {}
    model = entry.get("model")
    if isinstance(model, dict):
        model = model.get("primary")
    model = model or "deepseek/deepseek-chat"
    if "@" in model:
        return model
    provider = model.split("/")[0]
    profiles = (cfg.get("auth") or {}).get("profiles") or {}
    for profile_id, profile in profiles.items():
        if (profile or {}).get("provider") == provider:
            return f"{model}@{profile_id}"
    return model


def build_batch(users, model):
    ops = [
        # 多 agent 队列里 main 必须显式钉住自己的 workspace，否则会漂移到
        # <defaults.workspace>/<agentId> 下，老工作区直接「消失」。
        {"path": "agents.entries.main.workspace", "value": MAIN_WORKSPACE.replace("\\", "/")},
    ]
    for u in users:
        aid = user_agent_id(u["id"])
        ops.append(
            {
                "path": f'agents.entries["{aid}"]',
                "value": {
                    "name": f"平台用户 {u['phone']}",
                    "workspace": workspace_for(u["id"]).replace("\\", "/"),
                    "model": model,
                    # 心跳按 agent 展开，10 个用户 = 10 份心跳；平台不依赖它，直接关掉。
                    "heartbeat": {"every": "0m"},
                },
            }
        )
    return ops


def apply_direct(users, model):
    """原子直写 openclaw.json。

    为什么不用 `config set --batch-file` 落盘：本机 CLI 退出阶段会跑插件清理，
    临时文件超过 50 个时触发 SAFE_DELETE_BULK_CONFIRM_REQUIRED，反复重试直到超时，
    写入直接卡死（实测 4 分钟仍未落盘）。网关对**外部文件改动**同样会做 schema 校验
    （不合法就保持 last-good 不生效），所以先 CLI dry-run 校验、再原子直写是等效且可靠的。
    """
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.loads(f.read().lstrip("\ufeff"))

    entries = cfg.setdefault("agents", {}).setdefault("entries", {})
    entries.setdefault("main", {})["workspace"] = MAIN_WORKSPACE.replace("\\", "/")
    for u in users:
        aid = user_agent_id(u["id"])
        entries[aid] = {
            "name": f"平台用户 {u['phone']}",
            "workspace": workspace_for(u["id"]).replace("\\", "/"),
            "model": model,
            "heartbeat": {"every": "0m"},
        }
    # 🔴 不要覆盖 bindings：微信「每个 bot → 该用户 agent」的精确分流由平台
    # `src/lib/weixin-bindings.ts` 在运行时维护（绑定成功/注册后自动重建）。
    # 这里只在完全没有 bindings 时补一条 main 兜底，避免新装环境路由不到 agent。
    if not cfg.get("bindings"):
        cfg["bindings"] = [
            {"agentId": "main", "match": {"channel": "openclaw-weixin", "accountId": "*"}}
        ]

    tmp = CONFIG_PATH + ".tmp-write"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    print(f"已原子写入配置：{CONFIG_PATH}（entries={len(entries)}）")


def validate_batch(batch_path):
    """用 CLI 的 dry-run 做一次 schema 校验（不落盘）。"""
    args = [OPENCLAW_NODE, OPENCLAW_ENTRY, "config", "set", "--batch-file", batch_path, "--dry-run"]
    print("[cmd]", " ".join(args))
    proc = subprocess.run(args, capture_output=True, text=True, timeout=300, shell=False)
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if out:
        print(out[-1500:])
    if err:
        print("[stderr]", err[-600:])
    return proc.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写入 openclaw.json（默认只 dry-run）")
    args = ap.parse_args()

    users = load_users()
    model = read_main_model()
    print(f"用户 {len(users)} 个，沿用 main 的模型：{model}")

    for u in users:
        ws = seed_workspace(u)
        print(f"  workspace ok: {user_agent_id(u['id'])} -> {ws}")

    batch = build_batch(users, model)
    batch_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_user-agents.batch.json")
    with open(batch_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(batch, f, ensure_ascii=False, indent=1)
    print(f"批量配置 {len(batch)} 项 -> {batch_path}")

    if not args.apply:
        print("（dry-run 模式，不写配置；确认无误后加 --apply）")
        return 0 if validate_batch(batch_path) == 0 else 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = CONFIG_PATH + f".bak-peruser-agents-{stamp}"
    shutil.copy2(CONFIG_PATH, backup)
    print(f"已备份配置 -> {backup}")

    # 先校验，校验不过绝不落盘
    if validate_batch(batch_path) != 0:
        print("[abort] schema 校验未通过，未写入")
        return 1

    apply_direct(users, model)
    print("[exit] 0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
