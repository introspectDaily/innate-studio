---
name: innate-studio
description: 用 innate CLI 调用本机的 Innate Studio（本地优先的多模态 AIGC 工作台）：生成视频/图片/语音/音效/配乐，上传参考素材，把结果按坐标摆到无限画布，存取画布工作流与 AutoDL 平台工作流。当用户要用命令行/编程方式调用 Innate Studio、提到 innate 命令、无限画布节点布局，或涉及 Seedance / Seedream / 豆包语音 / MiniMax / AutoDL.art 工作流时使用。
---

# Innate Studio：用 innate CLI 干活

Innate Studio 是本地优先的多模态创作工作台，所有能力都走 `http://127.0.0.1:5178` 的 JSON 接口（`PORT` 可改，CLI 自动发现新地址）。**一律用自带 CLI**：自动带鉴权、自动等结果、返回本机绝对路径；比手写 curl 省心。

命令面以 `innate --help` 为准——本文与 help 不一致时照 help 执行。

## 0. 开工自检（每次都跑，别跳）

| 查什么 | 命令 | 不通过怎么办 |
| --- | --- | --- |
| 装了没 | `innate --help` | `command not found` → 在项目里跑 `node <项目>/cli/install.mjs`（装的是软链，改了 CLI 不用重装；`--dir` 换目录，`--uninstall` 卸） |
| 通不通 | `innate doctor` | 连不上 → 项目目录里起服务：`node server.js`（或 `pnpm start`，会先构建前端）。doctor 会报地址、连通性、身份、下一步建议，还会提示发现到的其它端口 |
| 要不要令牌 | `innate doctor` 的「模式」 | 本机模式：不用令牌。多人模式：必须 `innate config set --key isk_…`——不带令牌会落到本机那份数据上，看不到也动不了自己账号里的空间和积分 |
| 能用什么 | `innate state` / `innate models` / `innate voices` | 平台 Key 没配时，对应模型会出现在 `models` 的「不可用(缺Key)」里 |

令牌来源：界面「设置 → Agent Keys」（本机、多人模式都有），或 `pnpm user token add [--user <名>] --scope read|write`。形如 `isk_…`，明文只在创建时显示一次。

> `--scope read` 的令牌服务端真的拦：只能发 GET（模型、记录、文件），生成/上传/建画布/删除都会返回 403 `read_only_key`。唯一的例外是 `POST /api/history/<id>/refresh`——轮询只是看任务跑完没有，`innate wait` / `--wait` 用只读令牌照样能用。要生成就必须用 write 令牌；不确定手上的 key 是哪种，`pnpm user token list` 看前缀，或直接跑一次 `innate state` 再试生成。

## 1. 模型和参数别自己编

```bash
innate models                 # 每个模型 + 时长/比例/分辨率/档位/参考图上限，缺 Key 的列在最后
innate models --kind image    # 只看图片（video / audio 同理）
innate models --json          # 原始字段：videoSpecs / imageRatios / imageSizes / imageQualities / imageRefs
```

- 模型 id 带日期后缀（`doubao-seedream-5-0-pro-260628`），写错直接 400「不支持图片/视频模型」。参考图上限也按模型不同，别硬塞。
- `--ratio` 填模型支持的比例之一；视频 `--duration` 填该模型时长区间内的秒数；图片 `--resolution` 填 1K/2K 这类档位，`--quality` 只有分画质的模型（GPT Image）才有。
- 音频没有「模型」这回事：音色用 `innate voices`，音效/配乐直接用 `generate sfx|music`。

## 2. 生成

```bash
# 图片（--count N 一次出 N 条记录，每条一个 id）
innate generate image --model doubao-seedream-5-0-pro-260628 --prompt "一只猫" --ratio 1:1 --resolution 1.5K --wait --json

# 视频：可以只给素材不写提示词；首帧/尾帧/参考图都行
innate generate video --model doubao-seedance-2-5-260628 --prompt "雨夜街道" --ratio 16:9 --duration 5 --wait
innate generate video --model doubao-seedance-2-5-260628 --first-frame /media/uploads/f.png --duration 5 --wait

# 语音 / 音效 / 配乐
innate generate speech --text "你好" --voice-id zh_female_vv_uranus_bigtts
innate generate sfx    --text "雷声" --duration 5
innate generate music  --text "舒缓钢琴" --duration 30

# 高级：--data 把原始 JSON 字段合并进请求体，绕过上面所有 flag
innate generate image --model doubao-seedream-5-0-pro-260628 --prompt "风景" --data '{"n":4,"aspect_ratio":"16:9"}'
```

要点：

- `--wait` 让服务端长轮询到出结果再返回（`--timeout` 1–60 秒，默认 60）；不加就立刻返回 `status: queued`，之后用 `wait` 补等。
- 返回 `items[]`（`generate`）或 `item`（`wait`/`status`）。出结果后 `localPath` 是**本机绝对路径**（如 `data/images/img_xxx.jpg`），可直接读取、裁剪、拼接、贴回对话；没落盘时给 `mediaUrl`（`/media/...` 短地址）。
- 参考图：图片用 `--ref /media/uploads/x.png`（可重复），视频用 `--first-frame` / `--last-frame` / `--ref`。素材先用 `upload` 传，别拿本地绝对路径糊进请求。
- 提示词里的模型参数（时长、比例）写在 flag 里，别塞进 `--prompt`。
- 同一任务重试用同一份参数，别并发狂刷——每次提交都预扣积分。

## 3. 等结果 / 查记录

```bash
innate wait   <记录id> --timeout 60    # 阻塞等（服务端长轮询）
innate status <记录id>                 # 查一次
innate history --limit 20              # 最近记录 + 余额（本机模式不记积分）
innate history delete <记录id>         # 删记录，磁盘上的结果文件一起删
```

## 4. 上传参考素材

```bash
innate upload ./ref.png    # → /media/uploads/up_xxx.png，填进 --ref / --first-frame
```

支持 png/jpg/webp/mp4/mov/webm/mp3/wav，单文件 ≤ 64 MB。上传成功还会进素材库。

## 5. 无限画布：按坐标精确摆放

画布是「节点 + 连线」，`position` 就是画布坐标系里的绝对坐标，服务端原样存、不改写。节点是**生成记录的指针**，所以流程永远是：先生成拿到 `id`，再摆节点指向它。

```bash
# 一条命令：建画布 + 算网格坐标 + 摆节点（+ --chain 连成顺序箭头）
innate canvas grid --name 九宫格分镜 --ids r1,r2,r3,r4,r5,r6,r7,r8,r9 --cols 3 --gap 360

# 更自由的布局：手写 nodes.json 再整份替换
innate canvas create --name 分镜          # 拿画布 id
innate canvas update <画布id> --nodes nodes.json
```

节点长这样（`canvas update` 的 `--nodes` 文件是**节点数组**）：

```json
[{"id": "img-1", "type": "image", "position": {"x": 0, "y": 0},
  "data": {"no": 1, "recordId": "<图片记录id>", "prompt": "…"}},
 {"id": "txt-1", "type": "text", "position": {"x": 0, "y": 420},
  "data": {"no": 2, "text": "第一镜：雨夜街道"}}]
```

- `type`：`text` / `image` / `video` / `audio`，另有 `group`（分组框）和 `stack`（折叠一叠）——这两种要在 `data.members` 里写成员节点 id。
- 内容二选一：`data.recordId`（生成记录）或 `data.upload`（`{url, name}` 本机素材）；文本节点用 `data.text`。
- `id` 在画布内必须唯一；连线 `source` / `target` 就是节点 `id`。
- `canvas update` 是**整份替换**给定字段（`nodes`、`edges`、`name`、`viewport`、`cover`），不是追加——要加节点就自己把旧的一起带上。
- `canvas grid` 每次都**新建**一张画布（不能往已有画布上追加），同一批 id 重复摆会得到多张画布；`--type` 决定所有节点类型，`--start-x/--start-y` 定左上角。
- 坐标是画布坐标，跟当前缩放/平移无关；同一列 x 相同，行距用 `--gap`。
- 收尾：`canvas list` / `canvas get <id>` / `canvas delete <id>`。

## 6. 画布工作流：把成套节点存下来复用

「工作流」= 画布上的一组节点和连线，存下来以后整套放回任何一张画布（产品里的分组「存为工作流」就是这个）。

```bash
innate workflow list                                # id / 名字 / 节点数
innate workflow get <工作流id>                       # 节点和坐标
innate workflow save --canvas <画布id> --name 分镜模板   # 把现有画布整套存成工作流
innate workflow create --name 模板 --nodes nodes.json [--edges edges.json]
innate workflow apply <工作流id> --canvas <画布id>     # 放回画布：id 重新分配，接在已有内容下方
innate workflow apply <工作流id> --name 新画布         # 不给 --canvas 就新建一张
innate workflow delete <工作流id>
```

- `apply` 会给所有节点/连线换新 id（避免和画布上已有的撞），位置整体平移到 `--x/--y`；不写就接在现有节点下方 400px。
- 一份工作流最多 200 个节点；节点里指向的 `recordId` 必须还在这个空间里。

## 7. 平台工作流（AutoDL.art）：第三方生成通道

和上面不是一回事：这里的参数由平台给规则，出图出视频都可能，按平台的计费走。

```bash
innate flow list                       # uuid / 名字 / 输出类型 / 起价 / 必填素材
innate flow get <uuid>                 # 参数规则：key、类型、是否必填、可选项
innate flow run <uuid> --input prompt="雨夜街道" --input duration=5 --input ref_image_0=/media/uploads/x.png --wait
innate flow run <uuid> --inputs inputs.json --wait
```

- 先 `flow get` 看清必填项，再按规则拼 `--input`；值一律按字符串传，服务端按平台规则校验。
- 媒体类参数填 `/media/uploads/...`（先 `upload`）或公网 https；大文件、视频会自动转存 TOS 换直链。
- 没配 AutoDL 令牌时 `flow list` 会提示目录不可用。
- 计费：`fromCredits` 只是起价，按秒/按张计费的另算；失败自动退回。

## 8. 成本

- 生成按用量**预扣积分**（1 积分 = ¥0.01），失败自动退回；`history`、`cost` 看余额和记录数。
- 生成前用 `models` 确认平台 Key 可用，别等 400 才发现缺 Key。
- 别并发狂刷；重试沿用同一份参数，避免重复扣费。试错留下的记录用 `history delete` 清掉。

## 9. 出错怎么读

- 退出码：`1` = 请求/业务失败（stderr 一行 `✗ 消息 (code)`）；`2` = 命令不存在；`0` = 成功。
- 常见 `code`：`no_api_key`（去界面「管理」配平台 Key）、`invalid_request`（参数/枚举不对，按提示改）、`not_found`（记录/画布/工作流 id 不对）、`unsupported_media_type`（上传格式不对）。
- 连不上：`✗ fetch failed` → 先 `innate doctor`，再确认服务在跑。
- 生成失败会在 `error.message` 里带平台原因；同一个提示词反复失败先换模型或简化提示词，别原地重试。

## 10. 最小闭环（九宫格分镜）

```bash
innate doctor                                     # 服务在不在、要不要令牌
innate models --kind image                        # 选模型 + 比例
for i in 1 2 3 4 5 6 7 8 9; do
  innate generate image --model doubao-seedream-5-0-pro-260628 --prompt "第${i}镜：雨夜街道" --ratio 1:1 --wait --json
done                                              # 记下 9 个 id（.items[0].id）
innate canvas grid --name 分镜 --ids <id1>,...,<id9> --cols 3 --gap 360 --json
```

## 11. CLI 没覆盖的，直接打接口

`innate` 只包了生成、上传、画布、工作流这几块。下面这些只有 HTTP 接口（鉴权头 `Authorization: Bearer isk_…`），需要时用 curl，参数看 `server/routes/*.js`：

| 能力 | 接口 |
| --- | --- |
| 角色库（名字 + 描述 + 参考图） | `GET/POST /api/characters`、`PUT/DELETE /api/characters/<id>` |
| 提示词技能（产品内的「技能」= 提示词预设，与 Agent Skill 无关） | `GET/POST /api/skills`、`POST /api/skills/expand` |
| 素材库 | `GET /api/materials`、`POST /api/materials/publish` |
| 文本：润色 / 按技能扩写 / 画布文本节点 | `POST /api/polish`、`POST /api/skills/expand`、`POST /api/text` |
| 令牌管理 | `GET/POST /api/agent-keys`、`DELETE /api/agent-keys/<id>` |
| TOS 对象存储 | `GET/PUT/DELETE /api/tos/config`、`GET/POST/PUT/DELETE /api/tos/objects` |

## 12. 配置与优先级

- 地址：`--api-url` > `INNATE_API_URL` > `~/.innate/config.json` > 服务启动时写进 `data/server.json` 的地址（自动发现，改了 `PORT` 不用管）> `http://127.0.0.1:5178`。
- 令牌：`--api-key` > `INNATE_API_KEY` > 配置文件。
- `innate config show` 看当前生效的地址/令牌（令牌只显示首尾）；`config path` 看文件位置；`config clear` 清空。配置文件里是明文令牌，权限 600，别提交到仓库。`INNATE_CLI_CONFIG` 可换配置文件位置。

## 降级：直接用 curl（不推荐）

没有 CLI 时可用 curl 等价调用同样的端点（`POST /api/images`、`POST /api/videos`、`POST /api/audio/*`、`POST /api/history/<id>/refresh?wait=60`、`POST /api/uploads`、`POST /api/canvases`、`POST /api/workflows`、`POST /api/autodl/submit`）。但 curl 要自己拼 JSON、自己带头、自己轮询——CLI 已经把这些包好了。
