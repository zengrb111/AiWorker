import os, time, datetime
import paramiko

HOST = "39.107.32.151"
PORT = 22
USER = "root"
PASS = os.environ.get("SSHPASS", "")
LOCAL = r"D:\OPCProjects\HG-BOP\website\server.js"
REMOTE = "/opt/hgwx-site/server.js"

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, port=PORT, username=USER, password=PASS, timeout=15)
    sftp = c.open_sftp()

    # 1. 读远端当前 content 行 + 备份
    print("== 远端当前 content 行 ==")
    try:
        with sftp.open(REMOTE, "r") as f:
            remote_src = f.read().decode("utf-8", "replace")
        for ln in remote_src.splitlines():
            if "content: str" in ln:
                print("  远端:", ln.strip())
    except Exception as e:
        print("  读远端失败:", e)

    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    bak = f"{REMOTE}.bak.{stamp}"
    sftp.rename(REMOTE, bak)
    print("== 已备份 ->", bak)

    # 2. 上传本地 server.js
    sftp.put(LOCAL, REMOTE)
    print("== 已上传本地 server.js")

    # 3. 校验远端 content 行
    with sftp.open(REMOTE, "r") as f:
        new_src = f.read().decode("utf-8", "replace")
    for ln in new_src.splitlines():
        if "content: str" in ln:
            print("== 上传后远端 content 行:", ln.strip())
    sftp.close()

    # 4. 重启服务
    ssh = c
    def run(cmd, wait=3.0):
        stdin, stdout, stderr = ssh.exec_command(cmd)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        time.sleep(wait)
        return out + err

    print("== 服务管理探测 ==")
    svc = run("command -v systemctl >/dev/null && (systemctl is-active hgwx-site 2>/dev/null; echo 'SVC_PRESENT') || echo 'no-systemctl'")
    print(svc.strip())
    if "SVC_PRESENT" in svc:
        print(run("systemctl restart hgwx-site", wait=4))
        print("restart 结果:", run("systemctl is-active hgwx-site", wait=3).strip())
    else:
        # 尝试 pm2 / 直接 node 进程
        print(run("command -v pm2 && pm2 restart hgwx-site 2>/dev/null || true", wait=4))
    c.close()
    print("DONE")

if __name__ == "__main__":
    main()
