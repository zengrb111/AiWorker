"""One-off: rebuild pollinations cover URLs that use oversized seeds (cause HTTP 500)."""
import urllib.parse
import urllib.request
import sqlite3
import re
import random
import time

conn = sqlite3.connect("prisma/dev.db")
cur = conn.cursor()
cur.execute("SELECT id, title, coverImageUrl FROM ContentItem WHERE coverImageUrl LIKE '%pollinations%'")
rows = cur.fetchall()
fixed = 0
for cid, title, url in rows:
    m = re.search(r"seed=(\d+)", url)
    if not m or int(m.group(1)) <= 999999:
        continue
    prompt = title.replace("'", "").replace('"', "") + ", digital art, professional illustration, high quality, vibrant colors"
    seed = random.randint(1000, 999999)
    new_url = (
        "https://image.pollinations.ai/prompt/"
        + urllib.parse.quote(prompt)
        + "?width=1200&height=630&seed="
        + str(seed)
        + "&nologo=true&model=flux"
    )
    try:
        req = urllib.request.Request(new_url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=90)
        resp.read()
        cur.execute("UPDATE ContentItem SET coverImageUrl=? WHERE id=?", (new_url, cid))
        fixed += 1
        print("FIXED", cid, title[:25], "seed", seed)
    except Exception as e:
        print("SKIP", cid, title[:25], "->", e)
    time.sleep(1)
conn.commit()
print("total fixed:", fixed, "/", len(rows))
