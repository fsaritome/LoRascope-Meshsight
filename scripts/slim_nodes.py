#!/usr/bin/env python3
"""Turn the MeshCore map node dump into a small list of repeaters and room servers.

Usage: python3 scripts/slim_nodes.py nodes_raw.json data/nodes.json
"""
import json, sys, datetime

src, dst = sys.argv[1], sys.argv[2]
nodes = json.load(open(src, encoding="utf-8"))
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=60)).strftime("%Y-%m-%d")
out = []
for n in nodes:
    if n.get("type") not in (2, 3):  # 2 = repeater, 3 = room server
        continue
    la, lo = n.get("adv_lat"), n.get("adv_lon")
    if not la or not lo or abs(la) > 90 or abs(lo) > 180:
        continue
    upd = (n.get("updated_date") or n.get("last_advert") or "")[:10]
    if upd < cutoff:
        continue
    p = n.get("params") or {}
    out.append([n.get("adv_name") or "?", round(la, 5), round(lo, 5), n["type"], upd,
                n["public_key"][:8], p.get("freq"), p.get("sf"), p.get("bw")])
out.sort(key=lambda r: (r[1], r[2]))
json.dump({"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "nodes": out},
          open(dst, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(out)} nodes written to {dst}")
