import net from "node:net";
import { jsonOk } from "@/lib/http";
import {
  classifyGatewayError,
  describeGatewayCredentials,
  probeGatewayHandshake,
  type GatewayDiagnosis,
} from "@/lib/openclaw";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/openclaw/health —— 网关健康检查。
 *
 * 存在的理由：此前网关出问题时，界面只能显示「OpenClaw Gateway 连接失败：」，
 * 冒号后为空，既分不清是「没启动」还是「鉴权失败」，也不知道该去看哪里。
 * 这个接口把失败分层摊开，让排查有据可依。
 *
 * 分三层探测，逐层收敛：
 *   1. 端口是否监听（net.connect，最便宜，200ms 内出结论）
 *   2. 能否完成真实握手（复用 connectGateway 的握手流程）
 *   3. 设备凭据是否就绪（只读检查，不写入模块缓存）
 *
 * 始终返回 HTTP 200：体检接口不应以状态码表达「不健康」——
 * 状态码用来表达「体检本身失败了」，那才是真正的异常。
 */

/** 端口探测超时。局域网回环通常 <5ms，200ms 足够且不会拖慢页面。 */
const TCP_TIMEOUT_MS = 200;

/** 握手探测超时。 */
const HANDSHAKE_TIMEOUT_MS = 2000;

/** 总预算。任何环节超预算就返回已有信息，绝不让体检接口挂住页面。 */
const TOTAL_BUDGET_MS = 3000;

/** 从 OPENCLAW_BASE_URL 解析出主机与端口，配置异常时返回 null。 */
function resolveEndpoint(): { host: string; port: number; label: string } | null {
  const raw = process.env.OPENCLAW_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      label: url.origin,
    };
  } catch {
    return null;
  }
}

/** 裸 TCP 探测：只确认「有人在这个端口上听着」，不涉及任何协议。 */
function probePort(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonOk({
      ok: false,
      portOpen: false,
      handshakeOk: false,
      kind: "unknown" as const,
      userMessage: "未登录。",
      detail: "",
      credentials: null,
      checkedAt: new Date().toISOString(),
    });
  }

  const startedAt = Date.now();
  const endpoint = resolveEndpoint();

  // ---- 配置层 ----
  if (!endpoint) {
    const diagnosis: GatewayDiagnosis = classifyGatewayError(
      new Error("OPENCLAW_BASE_URL 未配置或格式非法")
    );
    return jsonOk({
      ok: false,
      portOpen: false,
      handshakeOk: false,
      kind: "not_running" as const,
      userMessage: "未配置 OPENCLAW_BASE_URL，无法定位网关地址。",
      detail: diagnosis.detail,
      hint: "在 .env.local 中设置 OPENCLAW_BASE_URL（形如 http://localhost:18789）后重启。",
      credentials: null,
      checkedAt: new Date().toISOString(),
    });
  }

  // ---- 凭据层（与握手并发：纯本地读文件，不占网络预算）----
  const credentials = describeGatewayCredentials();

  // ---- 端口层 ----
  const portOpen = await probePort(endpoint.host, endpoint.port);

  if (!portOpen) {
    return jsonOk({
      ok: false,
      portOpen: false,
      handshakeOk: false,
      kind: "not_running" as const,
      userMessage: `网关端口 ${endpoint.host}:${endpoint.port} 无人监听，网关未启动或已退出。`,
      detail: `TCP 探测 ${endpoint.label} 失败`,
      hint: "用 openclaw gateway run --port " + endpoint.port + " 启动网关；日志见 openclaw-gateway.out.log。",
      credentials,
      checkedAt: new Date().toISOString(),
    });
  }

  // ---- 握手层 ----
  // 剩余预算不足时不再尝试握手，直接给出「端口通但未验证」的有界结论，
  // 避免体检接口本身超时。
  const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
  if (remaining <= 400) {
    return jsonOk({
      ok: false,
      portOpen: true,
      handshakeOk: false,
      kind: "challenge_timeout" as const,
      userMessage: "端口可达，但剩余时间预算不足，未能完成握手验证。",
      detail: `已用 ${Date.now() - startedAt}ms / 预算 ${TOTAL_BUDGET_MS}ms`,
      hint: "稍后重试；若持续出现，请用 scripts/diagnose-openclaw.mts 做完整诊断。",
      credentials,
      checkedAt: new Date().toISOString(),
    });
  }

  const diagnosis = await probeGatewayHandshake(Math.min(HANDSHAKE_TIMEOUT_MS, remaining));

  if (!diagnosis) {
    return jsonOk({
      ok: true,
      portOpen: true,
      handshakeOk: true,
      kind: "ok" as const,
      userMessage: "网关正常，握手与鉴权均通过。",
      detail: `${endpoint.label} 握手成功，耗时 ${Date.now() - startedAt}ms`,
      credentials,
      checkedAt: new Date().toISOString(),
    });
  }

  return jsonOk({
    ok: false,
    portOpen: true,
    handshakeOk: false,
    kind: diagnosis.kind,
    userMessage: diagnosis.userMessage,
    detail: diagnosis.detail,
    hint: diagnosis.hint ?? "用 scripts/diagnose-openclaw.mts 做完整诊断。",
    credentials,
    checkedAt: new Date().toISOString(),
  });
}