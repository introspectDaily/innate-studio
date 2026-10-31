---
name: innate-studio
description: 通过 Innate Studio 的本地 HTTP 接口生成视频、图片、语音、音效、配乐，并把结果摆到无限画布的指定坐标上。当用户想用命令行/编程方式调用 Innate Studio（本地优先的多模态 AIGC 工作台），或提到 Seedance、Seedream、豆包语音、MiniMax、AiHubMix、无限画布节点布局时使用。
---

# Innate Studio：用 CLI 调用

Innate Studio 是本地优先的多模态创作工作台，能力都通过 `http://127.0.0.1:5178` 的 JSON 接口暴露（端口可被 `PORT` 环境变量改变，默认 5178）。**首选用自带的 CLI 调用**——它自动带鉴权、自动等结果、返回本机绝对路径，比手写 curl 省心；curl 仅作降级参考。

## 0. 准备工作

**命令是 `innate`，不需要 pnpm、也不需要站在项目目录里。** 装一次即可（建的是软链，改了 CLI 不用重装）：

```bash
node <项目目录>/cli/install.mjs        # 装到 PATH 里；可加 --dir <目录> 指定位置，--uninstall 卸载
innate --help                          # 装完就能在任何目录直接用
```

鉴权（Access Token / Agent API Key，`isk_` 开头）记住一次就行；服务地址会自动发现，改了 `PORT` 也不用管：

```bash
innate config set --key isk_xxxxxxxxxxxxxxxx   # 多人模式：前端「设置 → Agent Keys」创建；本机模式：pnpm user token add
innate config show                             # 看当前记住的地址与令牌（令牌只显示前后几位）
innate doctor                                  # 连不上就先跑这个：报地址、连通性、身份和建议
```

- 令牌绑定到某个用户（本机模式为“本地 Agent”），空间隔离、积分、角色全部继承那个用户。
- `scope=read` 的令牌只能发 GET，不能生成/上传；生成要用 `scope=write` 的令牌。
- 配置写在 `~/.innate/config.json`（权限 600），明文令牌只存这一处，用 `innate config clear` 清除。
- 临时换地址/令牌：`innate --api-url http://127.0.0.1:5300 models`，或环境变量 `INNATE_API_URL` / `INNATE_API_KEY`（优先级高于配置文件）。
- 先看服务是否就绪：`innate state`（本机/多人模式、平台 Key 是否配置）、`innate models`（可用模型与比例）。
- 任何命令加 `--json` 打印服务器原始 JSON，方便 `jq` 提取（如 `.items[0].localPath`）。

## 1. 生成（视频 / 图片 / 语音 / 音效 / 配乐）

```bash
# 图片（--wait 让服务端一直轮询到完成再返回，不用自己 sleep）
innate generate image --model seedream-5.0-pro --prompt "一只猫" --ratio 1:1 --wait --json

# 视频（首帧 / 参考图）
innate generate video --model seedance-2.5 --prompt "雨夜街道" --ratio 16:9 --first-frame /media/uploads/f.png --wait

# 语音 / 音效 / 配乐
innate generate speech --text "你好" --voice-id zh_female_qingxin
innate generate sfx    --text "雷声" --duration 5
innate generate music  --text "舒缓钢琴" --duration 30

# 高级：--data 直接传原始 JSON，绕过所有 flag（例如一次出 4 张图）
innate generate image --model seedream-5.0-pro --prompt "风景" --data '{"n":4,"aspect_ratio":"16:9"}'
```

- 提交返回的记录里带 `id`。`--wait` 后返回里 `localPath` 是**结果在本机的绝对文件路径**（如 `/.../data/videos/<id>.mp4`），同机可直接读取、裁剪、拼接或贴回对话。
- 生成前务必先 `models` 看 `unavailable`（缺 Key 时用不了），并按里面的枚举填 `model` / `ratio`，不要自己编。
- 参考图：图片用 `--ref /media/uploads/x.png`；视频用 `--first-frame` / `--last-frame` / `--ref`。参考素材先 `upload`。

## 2. 等结果 / 查状态

```bash
innate wait   <记录id> --timeout 60   # 阻塞等（服务端长轮询）
innate status <记录id>                # 查一次
```

## 3. 上传参考素材

```bash
innate upload ./ref.png               # 返回 /media/uploads/xxx.png，填进上面的 --ref
```

## 4. 无限画布：精确摆放节点

画布是「节点 + 连线」，节点自带画布坐标系里的绝对坐标，**你给什么坐标就画在哪**；后端原样存，不会改写。节点是生成记录的指针（`data.recordId` 指向已完成的记录），所以最稳的流程是：先生成拿 `id`，再把节点摆好指向它们。

**首选 `canvas grid`：一条命令完成「建画布 + 算网格坐标 + 摆节点」**，直接回应“指定位置”的需求：

```bash
# 把 9 条生成记录按 3×3 网格摆好（间距 360），每个节点 data.recordId 指向对应记录
innate canvas grid --name 九宫格分镜 --ids r1,r2,r3,r4,r5,r6,r7,r8,r9 --cols 3 --gap 360
# 加 --chain 还能自动连成顺序箭头
```

需要更自由的布局时，手动写 JSON 再更新：

```bash
innate canvas create --name 分镜        # 拿到画布 id
# 编辑 nodes.json：
# [{"id":"img-1","type":"image","position":{"x":0,"y":0},
#   "data":{"no":1,"recordId":"<图片记录id>","prompt":"…","model":"seedream-5.0-pro","ratio":"1:1"}}]
innate canvas update <画布id> --nodes nodes.json
```

要点：
- `type`：`text` / `image` / `video` / `audio`（外加 `group` 分组框、`stack` 折叠）。
- `position` 是画布坐标，不是屏幕像素，和 `viewport`（缩放/平移）无关；按相对布局给即可。
- 连线 `source`/`target` 必须对应节点 `id`。
- 读取：`canvas list` / `canvas get <id>`；角色库 `GET /api/characters`，提示词技能 `GET /api/skills`（注：这里的 skills 是产品内的“提示词预设”，与 Agent Skill 无关）。

## 5. 成本意识

- 生成按用量**预扣积分**（1 积分 = ¥0.01），失败自动退回。
- `innate history` 看记录和余额；生成前用 `models` 确认平台 Key 可用。
- 不要并发狂刷；同一任务重试用同一份参数，避免重复扣费。

## 6. 一个最小闭环（九宫格分镜）

```bash
innate models                                          # 选模型与比例
# 生成 9 张（循环），记下每个 id
for i in 1 2 3 4 5 6 7 8 9; do
  innate generate image --model seedream-5.0-pro --prompt "第$i张" --ratio 1:1 --wait --json
done
# 取出 9 个 id，一次性网格摆放
innate canvas grid --name 分镜 --ids <id1>,...,<id9> --cols 3
```

## 降级：直接用 curl（不推荐）

若没有 CLI，可用 curl 等价调用：`Authorization: Bearer $INNATE_API_KEY` 打到同样的端点（`POST /api/images`、`POST /api/videos`、`POST /api/history/<id>/refresh?wait=60`、`POST /api/uploads`、`POST /api/canvases` 等）。但 curl 要自己拼 JSON、自己带头、自己等结果——CLI 已经把这些包好了。
