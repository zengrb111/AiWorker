"use client";

import { FormEvent, useState, useEffect } from "react";

type UserRow = { index: number; phone: string; createdAt: string };
type UsersResponse = { total: number; page: number; pageSize: number; items: UserRow[] };

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: string }
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload && "error" in payload ? payload.error || "请求失败" : `请求失败（HTTP ${response.status}）`);
  }
  return (payload as { ok: true; data: T }).data;
}

export function AdminLoginForm() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await adminApi("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      window.location.href = "/admin/users";
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setLoading(false);
    }
  }

  return (
    <div className="op-admin-login-wrap">
      <form className="op-admin-login-card" onSubmit={submit}>
        <div className="op-admin-login-mark">◈</div>
        <h1>创星云 · 运营后台</h1>
        <p>请使用管理员账号登录</p>
        <label className="op-admin-field">
          <span>账号</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="请输入管理员账号"
          />
        </label>
        <label className="op-admin-field">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入密码"
          />
        </label>
        {error && <div className="op-admin-error">{error}</div>}
        <button className="op-admin-primary" type="submit" disabled={loading}>
          {loading ? "登录中..." : "登录"}
        </button>
        <div className="op-admin-login-foot">op-aiworker.aimemory.cafe</div>
      </form>
    </div>
  );
}

export function AdminUsersPanel() {
  const [phone, setPhone] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function fetchUsers(targetPage: number) {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ page: String(targetPage), pageSize: "20" });
    if (phone.trim()) query.set("phone", phone.trim());
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    try {
      const result = await adminApi<UsersResponse>(`/api/admin/users?${query.toString()}`);
      setData(result);
      setPage(targetPage);
    } catch (err) {
      const message = err instanceof Error ? err.message : "查询失败";
      if (message.includes("未登录")) {
        window.location.href = "/admin/login";
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchUsers(1);
    // 首次进入只拉一次，后续由搜索 / 分页显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void fetchUsers(1);
  }

  function resetFilters() {
    setPhone("");
    setFrom("");
    setTo("");
    setError("");
    const query = new URLSearchParams({ page: "1", pageSize: "20" });
    setLoading(true);
    adminApi<UsersResponse>(`/api/admin/users?${query.toString()}`)
      .then((result) => {
        setData(result);
        setPage(1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "查询失败"))
      .finally(() => setLoading(false));
  }

  async function logout() {
    try {
      await adminApi("/api/admin/logout", { method: "POST", body: "{}" });
    } finally {
      window.location.href = "/admin/login";
    }
  }

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="op-admin-shell">
      <aside className="op-admin-side">
        <div className="op-admin-brand">
          <span className="op-admin-brand-mark">◈</span>
          <div>
            <strong>创星云</strong>
            <small>运营后台</small>
          </div>
        </div>
        <div className="op-admin-menu-label">管理菜单</div>
        <nav className="op-admin-nav">
          <a className="op-admin-nav-item active" href="/admin/users">▦&nbsp;&nbsp;用户管理</a>
        </nav>
        <div className="op-admin-side-foot">op-aiworker.aimemory.cafe</div>
      </aside>

      <div className="op-admin-main">
        <header className="op-admin-topbar">
          <div className="op-admin-crumb">首页 <span>/</span> 用户管理</div>
          <div className="op-admin-account">
            <span>管理员：admin</span>
            <button type="button" onClick={() => void logout()}>退出登录</button>
          </div>
        </header>

        <main className="op-admin-content">
          <section className="op-admin-card">
            <div className="op-admin-card-head">
              <h2>注册用户</h2>
              <p>按注册手机号、注册时间查询平台注册用户</p>
            </div>

            <form className="op-admin-filters" onSubmit={onSearch}>
              <input
                className="op-admin-input op-admin-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="注册手机号（支持模糊搜索）"
              />
              <div className="op-admin-date-range">
                <span>注册时间</span>
                <input className="op-admin-input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                <em>至</em>
                <input className="op-admin-input" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </div>
              <button className="op-admin-primary" type="submit" disabled={loading}>搜索</button>
              <button className="op-admin-ghost" type="button" onClick={resetFilters} disabled={loading}>重置</button>
            </form>

            {error && <div className="op-admin-error">{error}</div>}

            <div className="op-admin-table-wrap">
              <table className="op-admin-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>序号</th>
                    <th>注册手机号</th>
                    <th style={{ width: 240 }}>注册时间</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr><td colSpan={3} className="op-admin-empty">加载中...</td></tr>
                  )}
                  {!loading && data?.items?.length === 0 && (
                    <tr><td colSpan={3} className="op-admin-empty">没有符合条件的用户</td></tr>
                  )}
                  {!loading && data?.items?.map((row) => (
                    <tr key={`${row.phone}-${row.index}`}>
                      <td>{row.index}</td>
                      <td className="op-admin-phone-cell">{row.phone}</td>
                      <td>{row.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="op-admin-pager">
              <span>共 {total} 条 · 第 {page} / {maxPage} 页</span>
              <div>
                <button type="button" disabled={loading || page <= 1} onClick={() => void fetchUsers(page - 1)}>上一页</button>
                <button type="button" disabled={loading || page >= maxPage} onClick={() => void fetchUsers(page + 1)}>下一页</button>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
