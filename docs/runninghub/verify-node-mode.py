#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证 RunningHub 是否支持用 nodeInfoList 覆盖节点的 mode（0 正常 / 2 Mute / 4 Bypass）。

思路：把两个输出节点（VHS_VideoCombine）设成 mode=2。
  - 如果平台真的应用了 mode，ComfyUI 会立刻报 "Prompt has no outputs"，任务不会开始跑（几乎零成本）；
  - 如果平台忽略了 mode，任务会正常开始生成视频 —— 脚本会立即取消，避免白烧算力。

用法：
    export RH_API_KEY=你的key
    python3 verify-node-mode.py <workflowId> [--dry]

    --dry   只做第 1 步（免费）：导出 api_format，检查里面有没有 mode 字段
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("RH_BASE", "https://www.runninghub.cn")
HOST = BASE.split("//", 1)[-1].rstrip("/")
KEY = os.environ.get("RH_API_KEY", "")

OUTPUT_TYPES = {"VHS_VideoCombine", "SaveImage", "PreviewImage", "SaveVideo",
                "SaveAudio", "VHS_VideoCombine", "CreateVideo"}


def post(path, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=body, method="POST")
    req.add_header("Host", HOST)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + KEY)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode(errors="replace")[:800]}


def step1(workflow_id):
    print("=" * 64)
    print("第 1 步（免费）：导出 api_format，检查 mode 是否是可见字段")
    print("=" * 64)
    res = post("/api/openapi/getJsonApiFormat",
               {"apiKey": KEY, "workflowId": workflow_id})
    if res.get("code") != 0:
        print("导出失败：", json.dumps(res, ensure_ascii=False)[:600])
        return []
    prompt = res["data"]["prompt"]
    if isinstance(prompt, str):
        prompt = json.loads(prompt)
    has_mode = [nid for nid, n in prompt.items() if "mode" in (n.get("inputs") or {})]
    outs = [(nid, n.get("class_type")) for nid, n in prompt.items()
            if n.get("class_type") in OUTPUT_TYPES]
    print("节点总数:", len(prompt))
    print("输出节点:", outs)
    print("inputs 里带 mode 的节点:", has_mode or "无 —— 说明 mode 不在 API 格式里")
    return [nid for nid, _ in outs]


def step2(workflow_id, out_ids):
    if not out_ids:
        print("没找到输出节点，跳过第 2 步")
        return
    print()
    print("=" * 64)
    print("第 2 步：把输出节点设为 mode=2（Mute），提交一次任务")
    print("=" * 64)
    nodes = [{"nodeId": n, "fieldName": "mode", "fieldValue": 2} for n in out_ids]
    print("nodeInfoList:", json.dumps(nodes, ensure_ascii=False))
    res = post("/task/openapi/create",
               {"apiKey": KEY, "workflowId": workflow_id, "nodeInfoList": nodes})
    print("返回:", json.dumps(res, ensure_ascii=False)[:1200])
    tid = (res.get("data") or {}).get("taskId")
    if res.get("code") == 0 and tid:
        print("\n>>> 提交成功且没有报错 → 平台没有拦截 mode，任务已开始。")
        print(">>> 判定：需要看第 3 步结果（如果视频照常生成，说明 mode 被忽略）。")
        print(">>> 正在取消任务，避免浪费时间……")
        print("取消返回:", json.dumps(post("/task/openapi/cancel",
                                       {"apiKey": KEY, "taskId": tid}),
                                    ensure_ascii=False)[:400])


def main():
    if not KEY:
        print("请先 export RH_API_KEY=你的key")
        return 1
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("用法: python3 verify-node-mode.py <workflowId> [--dry]")
        return 1
    out_ids = step1(args[0])
    if "--dry" not in sys.argv:
        step2(args[0], out_ids)
    print()
    print("判定标准：")
    print("  A. 提交时直接报错（参数不存在 / 节点参数非法 / 803 等）→ 不支持，用 v1.6 惰性开关方案")
    print("  B. 返回 code=0 但 promptTips 里有 'Prompt has no outputs' → 支持！可以做 v1.7 简化版")
    print("  C. 返回 code=0 且任务正常排队 → 不支持（mode 被静默忽略），用 v1.6")
    return 0


if __name__ == "__main__":
    sys.exit(main())
