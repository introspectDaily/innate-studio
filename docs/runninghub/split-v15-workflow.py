#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把《海螺H3 人物替换专用流 v1.5》里当前激活的「多镜头流程」拆成两个 workflow：

  A) 一采（单采样）：模型加载 + 条件参数 + 一采采样 → 输出 AV latent（SaveLatent）
  B) 二采（精修）  ：读入 AV latent（LoadLatent）→ latent 放大 + 二采采样 → 成片 mp4

规则：
  * 只保留 mode==0（激活）的节点；bypass(mode=4) / mute(mode=2) 全部丢弃，
    下游输入按 ComfyUI 的 pass-through 语义直接接到真正的上游节点。
  * 其它未激活的流程（长镜头视频流程 / 长视频续接模块）不参与。
  * 节点 id 保持不变，方便和原工作流对照。

用法： python3 docs/runninghub/split-v15-workflow.py
"""
import json
import os
import uuid
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_UI = os.path.join(HERE, "workflows", "海螺H3 人物替换专用流v1.5.json")
SRC_API = os.path.join(HERE, "workflows", "海螺H3 人物替换专用流v1.5_api.json")

OUT_UI_A = os.path.join(HERE, "workflows", "海螺H3 人物替换专用流v1.5-一采-输出latent.json")
OUT_UI_B = os.path.join(HERE, "workflows", "海螺H3 人物替换专用流v1.5-二采-latent精修.json")
OUT_API_A = os.path.join(HERE, "workflows", "海螺H3 人物替换专用流v1.5-一采-输出latent_api.json")
OUT_API_B = os.path.join(HERE, "workflows", "海螺H3 人物替换专用流v1.5-二采-latent精修_api.json")

LATENT_A = "latent/minimaxh3_pass1"
LATENT_B = "minimaxh3_pass1_00001_.latent"

# 一采独占：只属于 A
PASS1_ONLY = {196, 205, 191, 181, 212, 337, 277, 276, 619, 186, 187, 300, 271}
# 二采独占：只属于 B（latent 从外部送入，不再在内部采样）
PASS2_ONLY = {200, 198, 199, 301, 207, 182, 183, 184, 185, 580,
              190, 206, 189, 620, 202, 201, 194, 195, 247}


# --------------------------------------------------------------------------- #
# 图工具
# --------------------------------------------------------------------------- #
def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def out_type(node, slot):
    outs = node.get("outputs") or []
    if slot is not None and 0 <= slot < len(outs):
        return outs[slot].get("type")
    return None


def build_resolver(nodes, links):
    def resolve(nid, slot):
        """穿透 bypass(4) 节点，返回真正的上游 (node_id, slot)。"""
        seen = set()
        while True:
            n = nodes.get(nid)
            if n is None:
                return None, None
            if n.get("mode", 0) != 4:
                return nid, slot
            if nid in seen:
                return None, None
            seen.add(nid)
            t = out_type(n, slot)
            ins = [i for i in (n.get("inputs") or []) if i.get("link") in links]
            same = [i for i in ins if i.get("type") == t]
            if same:
                pick = same[min(slot or 0, len(same) - 1)]
            elif ins:
                pick = ins[0]
            else:
                return None, None
            l = links[pick["link"]]
            nid, slot = l[1], l[2]

    return resolve


def collapsed_edges(nodes, links, resolve):
    """仅统计激活节点之间的有效连接： nid -> [(src, src_slot, input_name, type)]"""
    edges = defaultdict(list)
    for nid, n in nodes.items():
        if n.get("mode", 0) != 0:
            continue
        for inp in n.get("inputs") or []:
            lid = inp.get("link")
            if lid is None or lid not in links:
                continue
            l = links[lid]
            src, sslot = resolve(l[1], l[2])
            if src is None or nodes.get(src, {}).get("mode", 0) != 0:
                continue
            edges[nid].append((src, sslot, inp["name"], l[5]))
    return edges


def closure(edges, seeds):
    seen, stack = set(), list(seeds)
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        for src, _s, _nm, _t in edges.get(n, []):
            if src not in seen:
                stack.append(src)
    return seen


def topo_order(edges, keep):
    indeg = {n: 0 for n in keep}
    children = defaultdict(list)
    for n in keep:
        for src, _s, _nm, _t in edges.get(n, []):
            if src in keep:
                indeg[n] += 1
                children[src].append(n)
    ready = sorted(n for n in keep if indeg[n] == 0)
    order, k = {}, 0
    while ready:
        n = ready.pop(0)
        order[n] = k
        k += 1
        for c in children[n]:
            indeg[c] -= 1
            if indeg[c] == 0:
                ready.append(c)
    for n in sorted(keep):
        if n not in order:
            order[n] = k
            k += 1
    return order


def rect(n):
    w, h = (n.get("size") or [300, 120])[:2]
    return n["pos"][0], n["pos"][1], w, h


def inside(n, bounding):
    x, y, w, h = bounding
    return x <= n["pos"][0] <= x + w and y <= n["pos"][1] <= y + h


# --------------------------------------------------------------------------- #
# UI 格式构建
# --------------------------------------------------------------------------- #
def build_ui(src, keep_ids, new_nodes, new_links, note_text):
    """new_nodes: 新增节点列表；new_links: [(src, sslot, dst, in_name, type)]"""
    doc = json.loads(json.dumps(src))
    orig_nodes = {n["id"]: n for n in doc["nodes"]}
    links = {l[0]: l for l in doc["links"]}
    resolve = build_resolver(orig_nodes, links)
    edges = collapsed_edges(orig_nodes, links, resolve)

    keep = set(keep_ids) | {n["id"] for n in new_nodes}

    # 原图里每个输入的原始连线（重置前先快照）
    orig_in_link = {nid: {i["name"]: i.get("link") for i in (n.get("inputs") or [])}
                    for nid, n in orig_nodes.items()}

    out_nodes = []
    for nid in sorted(keep):
        if nid in orig_nodes:
            n = json.loads(json.dumps(orig_nodes[nid]))
            for o in n.get("outputs") or []:
                o["links"] = []
            for i in n.get("inputs") or []:
                i["link"] = None
            out_nodes.append(n)
    out_nodes.extend(json.loads(json.dumps(n)) for n in new_nodes)
    for n in out_nodes:
        for o in n.get("outputs") or []:
            if o.get("links") is None:
                o["links"] = []

    byid = {n["id"]: n for n in out_nodes}
    out_slot = {(n["id"], i): o for n in out_nodes for i, o in enumerate(n.get("outputs") or [])}

    new_link_list = []
    counter = [1]

    def add(src, sslot, dst, in_name, typ, inp_obj):
        o = out_slot.get((src, sslot))
        if o is None:
            raise RuntimeError(f"输出槽不存在: {src}[{sslot}] -> {dst}.{in_name}")
        lid = counter[0]
        counter[0] += 1
        new_link_list.append([lid, src, sslot, dst, 0, typ])
        o["links"].append(lid)
        inp_obj["link"] = lid

    forced = {(d, name): (s, sl, t) for (s, sl, d, name, t) in new_links}

    for n in out_nodes:
        nid = n["id"]
        for inp in n.get("inputs") or []:
            name = inp["name"]
            if (nid, name) in forced:
                s, sl, t = forced[(nid, name)]
                add(s, sl, nid, name, t, inp)
                continue
            ol = orig_in_link.get(nid, {}).get(name)
            if ol is None or ol not in links:
                inp["link"] = None
                continue
            l = links[ol]
            s, sl = resolve(l[1], l[2])
            if s is None or s not in byid:
                inp["link"] = None
                continue
            add(s, sl, nid, name, l[5], inp)

    # order
    order = topo_order(edges, set(byid))
    seq = (max(order.values()) + 1) if order else 0
    for n in out_nodes:
        if n["id"] in order:
            n["order"] = order[n["id"]]
        else:
            n["order"] = seq
            seq += 1

    # groups（用剩余成员重算边界）
    groups = []
    for g in doc["groups"]:
        members = [n for n in out_nodes if n["id"] in orig_nodes and inside(orig_nodes[n["id"]], g["bounding"])]
        if not members:
            continue
        # 新增节点若落在该分组范围内，也纳入（只对已保留的分组生效）
        members += [n for n in out_nodes if n["id"] not in orig_nodes and inside(n, g["bounding"])]
        x0 = min(rect(m)[0] for m in members)
        y0 = min(rect(m)[1] for m in members)
        x1 = max(rect(m)[0] + rect(m)[2] for m in members)
        y1 = max(rect(m)[1] + rect(m)[3] for m in members)
        g = dict(g)
        g["bounding"] = [x0 - 30, y0 - 55, (x1 - x0) + 60, (y1 - y0) + 85]
        groups.append(g)
    for n in new_nodes:
        for g in n.get("groups", []) if isinstance(n.get("groups"), list) else []:
            groups.append(g)

    for n in out_nodes:
        n.pop("groups", None)
        if n["type"] == "MarkdownNote" and note_text:
            n["widgets_values"] = [note_text]
            n["title"] = "说明"

    doc["nodes"] = out_nodes
    doc["links"] = new_link_list
    doc["groups"] = groups
    doc["last_node_id"] = max(byid)
    doc["last_link_id"] = counter[0] - 1
    doc["id"] = str(uuid.uuid4())
    if "extra" in doc:
        doc["extra"].pop("ds", None)
    return doc


def validate_ui(tag, doc):
    byid = {n["id"]: n for n in doc["nodes"]}
    linkby = {l[0]: l for l in doc["links"]}
    used = set()
    for n in doc["nodes"]:
        for inp in n.get("inputs") or []:
            lid = inp.get("link")
            if lid is None:
                continue
            assert lid in linkby, f"{tag}: 节点 {n['id']} 引用了不存在的 link {lid}"
            l = linkby[lid]
            assert l[3] == n["id"], f"{tag}: link {l} 的终点不是 {n['id']}"
            used.add(lid)
    assert used == set(linkby), f"{tag}: 有 link 未被任何输入引用"
    for l in doc["links"]:
        assert l[1] in byid, f"{tag}: link {l} 起点不存在"
        o = byid[l[1]]["outputs"][l[2]]
        assert l[0] in (o.get("links") or []), f"{tag}: link {l} 未登记到起点输出"
    # 每个节点（除 LoadLatent / 纯 widget 节点）必须有输入连上
    dangling = []
    for n in doc["nodes"]:
        ins = n.get("inputs") or []
        need = [i for i in ins if not i.get("widget")]
        if need and all(i.get("link") is None for i in ins):
            dangling.append((n["id"], n["type"]))
    return dangling


# --------------------------------------------------------------------------- #
def main():
    src = load(SRC_UI)
    src_api = load(SRC_API)
    nodes = {n["id"]: n for n in src["nodes"]}
    links = {l[0]: l for l in src["links"]}
    resolve = build_resolver(nodes, links)
    edges = collapsed_edges(nodes, links, resolve)

    a = {n for n in closure(edges, [196]) if nodes[n].get("mode", 0) == 0}
    b = {n for n in (closure(edges, [200]) | {198, 199, 301, 207})
         if nodes[n].get("mode", 0) == 0}
    b -= PASS1_ONLY
    a -= PASS2_ONLY

    print(f"一采 A: {len(a)} 节点 | 二采 B: {len(b)} 节点 | 共用: {len(a & b)}")
    print("A 独有:", sorted(a - b))
    print("B 独有:", sorted(b - a))

    # ---------------- 新增节点 ----------------
    save_latent = {
        "id": 900, "type": "SaveLatent", "pos": [1235.0, 5994.6], "size": [315.0, 126.0],
        "flags": {}, "order": 0, "mode": 0,
        "inputs": [{"label": "samples", "name": "samples", "type": "LATENT", "link": None}],
        "outputs": [],
        "title": "保存一采 latent（交给二采工作流）",
        "properties": {"Node name for S&R": "SaveLatent", "cnr_id": "comfy-core", "ver": "0.30.0"},
        "widgets_values": [LATENT_A],
        "groups": [{"id": 2001, "title": "一采 latent 输出（喂给二采）",
                    "bounding": [1205.0, 5939.6, 375.0, 241.0], "color": "#88a", "flags": {}}],
    }
    load_latent = {
        "id": 901, "type": "LoadLatent", "pos": [891.2, 5990.0], "size": [262.5, 106.0],
        "flags": {}, "order": 0, "mode": 0,
        "inputs": [],
        "outputs": [{"label": "LATENT", "name": "LATENT", "type": "LATENT", "links": [], "slot_index": 0}],
        "title": "读取一采 latent（先在 input 目录选中文件）",
        "properties": {"Node name for S&R": "LoadLatent", "cnr_id": "comfy-core", "ver": "0.30.0"},
        "widgets_values": [LATENT_B],
        "groups": [{"id": 2002, "title": "读取一采 latent",
                    "bounding": [861.2, 5935.0, 322.5, 221.0], "color": "#88a", "flags": {}}],
    }

    note_a = """# 一采工作流（单采样 → 输出 latent）

从《海螺H3 人物替换专用流 v1.5》的「多镜头流程」拆出的**第一段**：只跑一次采样，不解码、不出视频。

## 流程
模型加载 → 条件参数（参考图 / 参考视频 / 提示词）→ 一采采样（6 步）→ **保存 latent**

## 可调参数
1. 一采分辨率 megapixels：0.3~0.5（越低越快）
2. 限制参考图短边：736~1280，928 较平衡
3. 限制参考视频像素：0.6~1.0（越低越快）
4. 提示词：见「输入提示词」节点

## 输出
`SaveLatent` 把「视频+音频」联合 latent（AV latent，未解码）写到
`output/latent/minimaxh3_pass1_XXXXX_.latent`。
把该文件交给二采工作流（`LoadLatent`）继续精修。
"""

    note_b = """# 二采工作流（latent → 高精度精修）

同一流程拆出的**第二段**：直接吃一采的 latent，只跑二采。

## 流程
`LoadLatent`（一采 latent）→ 拆分 AV latent → latent 3D 放大到目标尺寸 →
视频/音频 latent 合并 → **二采采样（Manual Sigmas + Sigma Refiner）** → 解码 → 输出 mp4

## 使用
1. 把一采产出的 `minimaxh3_pass1_XXXXX_.latent` 放进 ComfyUI 的 `input` 目录；
2. 在「读取一采 latent」节点里选中它；
3. 二采步数/噪声见 `Manual Sigmas Final Pass`，精修强度见 `H3 Sigma Refiner`
   （extra_steps / start_at_sigma）。

## 可调参数
1. 二采放大像素（百万）：0.8~1.5（4090/5090 可再高）
2. 限制参考图短边、限制参考视频像素：同原流程
3. 提示词必须与一采一致，否则二采会改内容
"""

    ui_a = build_ui(src, a, [save_latent],
                    [(196, 0, 900, "samples", "LATENT")], note_a)
    ui_b = build_ui(src, b, [load_latent],
                    [(901, 0, 190, "av_latent", "LATENT")], note_b)

    for tag, doc in (("A", ui_a), ("B", ui_b)):
        dangling = validate_ui(tag, doc)
        print(f"{tag}: nodes={len(doc['nodes'])} links={len(doc['links'])} groups={len(doc['groups'])} 悬空={dangling}")

    with open(OUT_UI_A, "w", encoding="utf-8") as f:
        json.dump(ui_a, f, ensure_ascii=False, indent=2)
    with open(OUT_UI_B, "w", encoding="utf-8") as f:
        json.dump(ui_b, f, ensure_ascii=False, indent=2)

    # ---------------- API 格式 ----------------
    def build_api(keep, extra, rewire):
        out = {k: json.loads(json.dumps(v)) for k, v in src_api.items() if int(k) in keep}
        out.update(extra)
        for nid, mapping in rewire.items():
            for in_name, ref in mapping.items():
                out[str(nid)]["inputs"][in_name] = list(ref)
        for k, v in out.items():
            for in_name, val in v["inputs"].items():
                if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0].isdigit():
                    if val[0] not in out:
                        raise RuntimeError(f"悬空引用 {k}.{in_name} -> {val}")
        return out

    api_a = build_api(a, {"900": {
        "inputs": {"samples": ["196", 0], "filename_prefix": LATENT_A},
        "class_type": "SaveLatent",
        "_meta": {"title": "Save Latent", "cnr_id": "comfy-core", "ver": "0.30.0"}}}, {})
    api_b = build_api(b, {"901": {
        "inputs": {"latent": LATENT_B},
        "class_type": "LoadLatent",
        "_meta": {"title": "Load Latent", "cnr_id": "comfy-core", "ver": "0.30.0"}}},
        {190: {"av_latent": ("901", 0)}})

    with open(OUT_API_A, "w", encoding="utf-8") as f:
        json.dump(api_a, f, ensure_ascii=False, indent=2)
    with open(OUT_API_B, "w", encoding="utf-8") as f:
        json.dump(api_b, f, ensure_ascii=False, indent=2)
    print(f"API A: {len(api_a)} | API B: {len(api_b)}")

    # UI 与 API 节点集合一致性
    for tag, ui, api in (("A", ui_a, api_a), ("B", ui_b, api_b)):
        ui_ids = {str(n["id"]) for n in ui["nodes"]}
        assert ui_ids == set(api), f"{tag}: UI/API 节点不一致 {ui_ids ^ set(api)}"
        print(f"{tag}: UI 与 API 节点集合一致 ({len(ui_ids)})")


if __name__ == "__main__":
    main()
