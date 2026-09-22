/**
 * 效果数据「按用户」的后台同步状态。
 *
 * 同步改为异步：POST /sync 立即返回，真正同步在服务端后台跑；
 * 状态挂在 globalThis（dev HMR 重载模块也不丢），前端切走菜单再回来
 * 也能通过 GET /sync 读到「同步中 / 已完成 / 失败」。
 */
import { syncAllPlatforms } from "./platform-sync";

export type SyncPlatformResult = { platform: string; ok: boolean; message: string };

export type SyncState = {
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  results?: SyncPlatformResult[];
  error?: string;
};

const store = globalThis as unknown as { __platformSyncState?: Map<string, SyncState> };
const states: Map<string, SyncState> =
  store.__platformSyncState || (store.__platformSyncState = new Map());

/** 读取某用户的同步状态；没有记录返回 null */
export function getSyncState(userId: string): SyncState | null {
  const s = states.get(userId);
  return s ? { ...s } : null;
}

/** 启动后台同步；若该用户已在同步中则不做重复启动，返回 false */
export function startSync(userId: string): boolean {
  const cur = states.get(userId);
  if (cur?.running) return false;

  const state: SyncState = { running: true, startedAt: new Date().toISOString() };
  states.set(userId, state);
  void (async () => {
    try {
      const results = await syncAllPlatforms(userId);
      state.ok = results.every((r) => r.ok);
      state.results = results;
    } catch (e) {
      state.ok = false;
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();
  return true;
}
