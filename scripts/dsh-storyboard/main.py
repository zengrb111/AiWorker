"""DSH 分镜规划桥接脚本。

职责极窄：**只把一段 prompt 交给 DeepSeek Harness，取回一段纯文本**。
不写文件、不跑命令、不做编排 —— 渲染由本项目的 Remotion 工程确定性完成。

协议（与 src/lib/dsh.ts 对应）：
  stdin  : {prompt, session_id, cwd, dsh_home, patch, timeout_ms}
  stdout : {ok, final_response?, elapsed_ms?, error?}
  exit   : 永远 0 —— 失败走 ok:false，避免 Python 堆栈污染调用方的错误文案。

API 依据（已对 deepseek-harness-sdk 0.1.5rc1 实测核对，不是按文档推测）：
  HarnessConfig(profile, patches, dsh_home, cwd, env,
                initialize_timeout_seconds, request_timeout_seconds)
  DeepSeekHarness(config).run(prompt, session_id=...) -> RunResult(.final_response)

三处与直觉不一致、容易踩的点：
  1. run() 没有 timeout 参数，执行超时配置在 HarnessConfig.request_timeout_seconds；
  2. profile 默认是 "sdk"（不是 "sdk-minimal"），且自带 tool-bash / tool-fs /
     tool-web / subagent 等一整套工具，必须靠 patches 覆盖层逐个 disabled；
  3. dsh_home 是必填项，SDK 明确不会隐式使用 ~/.dsh。
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback


def _emit(payload: dict) -> None:
    """只往 stdout 写一行 JSON。DSH 运行时的日志都赶到 stderr，保护这个协议。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def main() -> int:
    # 运行时日志赶到 stderr，让本脚本独占真正的 stdout
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    started = time.time()
    try:
        request = json.loads(sys.stdin.read())
        prompt: str = request["prompt"]
        session_id: str | None = request.get("session_id") or None
        cwd: str = request["cwd"]
        dsh_home: str = request["dsh_home"]
        patch: str | None = request.get("patch") or None
        model: str | None = request.get("model") or None
        timeout_ms: int = int(request.get("timeout_ms") or 180_000)
        # 可选：注入到 agent 子进程（tool-bash 等）的环境变量。
        # 出片任务用它把 NODE_BIN / FFMPEG_BIN / FFPROBE_BIN / PATH 传进去，
        # 让 DSH 的 bash 工具能直接调用 node 与 ffmpeg。
        extra_env: dict = request.get("env") or {}

        if not prompt.strip():
            raise ValueError("prompt 为空")

        # 隔离工作目录：DSH 在这里读写会话状态，必须存在
        os.makedirs(cwd, exist_ok=True)
        os.makedirs(dsh_home, exist_ok=True)

        # 延迟 import：DSH_HOME 必须在进程环境里就位
        from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig  # type: ignore

        # agent 子进程的环境：在进程自身环境之上叠加 NO_COLOR 与调用方注入的变量。
        # 必须**合并**而非**替换** —— 否则 tool-bash 会丢掉 PATH，连 `node` / `ffmpeg`
        # 都找不到（分镜任务因 tool-bash 被禁用无所谓，出片任务放开 bash 后才暴露）。
        harness_env: dict = {**os.environ, "NO_COLOR": "1"}
        harness_env.update(extra_env)

        config = DeepSeekHarnessConfig(
            # 用官方 sdk 档 + patch 覆盖层，而不是在 $DSH_HOME 里维护自定义 profile：
            # patch 幂等、不依赖目录里的残留状态，换机器就能复现同样的受限环境。
            profile="sdk",
            patches=(patch,) if patch else (),
            dsh_home=dsh_home,
            # cwd 是 agent 看到的工作目录；runtime_cwd 是运行时子进程自己的目录。
            # 两者都指向隔离空目录 —— 分镜任务不需要读任何项目文件。
            cwd=cwd,
            runtime_cwd=cwd,
            # 直接传 api_key / base_url，比绕环境变量更明确，也不会被子进程继承污染
            api_key=os.environ.get("DEEPSEEK_API_KEY") or None,
            base_url=os.environ.get("DEEPSEEK_BASE_URL") or None,
            # 默认 deepseek-flash；分镜是短 JSON 输出，用 flash 足够且更快
            model=model or "deepseek-v4-flash",
            env=harness_env,
            # 初始化只做插件加载，60s 足够；真正的执行预算是 request_timeout_seconds
            initialize_timeout_seconds=60.0,
            request_timeout_seconds=timeout_ms / 1000.0,
        )

        # 上下文管理器确保 JSON-RPC 子进程一定被回收；不回收会挂住 Node 侧的管道
        with DeepSeekHarness(config) as harness:
            result = harness.run(prompt, session_id=session_id)

        final_response = (getattr(result, "final_response", None) or "").strip()
        if not final_response:
            fr = getattr(result, "finish_reason", None)
            if fr == "error":
                # 多半是 DeepSeek API 连接/鉴权/限流失败（见上面的 TRANSPORT 重试日志），
                # 不是「模型没写东西」，给出能直接定位的文案。
                raise RuntimeError(
                    "DSH 调用失败：DeepSeek API 请求未成功（连接/鉴权/限流）。"
                    "请确认网络可直连 api.deepseek.com，且「系统配置」里的 API Key 有效。"
                )
            raise RuntimeError(
                f"DSH 未返回内容（finish_reason={fr!r}）：模型本轮没有输出文本，可能被截断或返回了空消息。"
            )

        sys.stdout = real_stdout
        _emit(
            {
                "ok": True,
                "final_response": final_response,
                "session_id": getattr(result, "session_id", None),
                "elapsed_ms": int((time.time() - started) * 1000),
            }
        )
        return 0
    except Exception as exc:  # noqa: BLE001 —— 桥接层必须吞掉一切
        detail = f"{type(exc).__name__}: {exc}"
        tb = traceback.format_exc(limit=8)
        sys.stdout = real_stdout
        _emit(
            {
                "ok": False,
                "error": detail,
                # 栈留在 stderr 里，Node 侧只在需要排查时才去读
                "traceback": tb,
                "elapsed_ms": int((time.time() - started) * 1000),
            }
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
