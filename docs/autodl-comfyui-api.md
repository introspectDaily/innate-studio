# AutoDL.art ComfyUI 工作流 API 调研

> 调研日期：2026-10-31。范围：`https://www.autodl.art/large-model/comfyui` 上全部在架工作流的「入参 / 出参 / 接口」。
> 本文件是**调研结论**，不含代码改动。线上数据用 `~/.codex/skills/autodl-art-comfyui` 的 CLI 只读拉取（列表 + 详情，不提交任务，不花钱）。
> 官方文档：<https://autodl.art/docs/comfyui_api/>

---

## 0. 结论先行

1. **全部 25 个工作流共用同一套接口**：`提交任务 → 查结果`。工作流之间只有 `workflow_id`、入参集合、计费配置三处不同。
2. **入参不是硬编码的**：平台通过 `GET /api/v1/comfyui/workflows/{uuid}` 在线下发 `input_rules`（JSON Schema 风格），按规则动态渲染表单 + 校验即可覆盖所有工作流，**不需要为单个工作流写适配代码**。
3. **差异只有三处**：`workflow_id`、`input_rules`（入参集合）、`billing_config`（计费）。`price_type` 当前只有 3 种（`minimax_h3` / `video_sec_cost` / `audio_sec_cost`）、rule `type` 只有 9 种、媒体只有 3 类——这就是系统要支持的全部差异面。
4. 当前在架 25 个：**24 个输出视频（mp4）、1 个输出音频（wav）、0 个输出图片**。所有工作流 `price` 字段都是 `0`，真实价格只在 `billing_config` 里。
5. 已有实现（`shared/autodl.ts` + `server/autodl.js` + `server/routes/autodl.js` + `server/tasks.js`）已覆盖接口、校验、计费、轮询、下载；本文件第 8、9 节列出实测/代码层面的**缺口与待验证点**。

---

## 1. 接口清单

认证：`Authorization: <令牌原文>`（**不加 `Bearer`**），`Content-Type: application/json`。
令牌在 <https://autodl.art/large-model/tokens> 创建，分组选 `ComfyUI`。

返回统一信封：`{ code, data, msg, request_id }`。`code` 为 `Success` / `0` / `200` 才算成功，内容在 `data` 里。
`data` 偶尔不是对象（那时整份返回就是数据）。错误原因在 `msg`（有时 `message`）。

| 用途 | 方法 | 路径 | 备注 |
|---|---|---|---|
| 工作流目录 | POST | `/api/v1/comfyui/workflows` | body `{page_index, page_size}`，`page_index` 从 **1** 开始；返回 `{result_total, workflows[]}` |
| 单个工作流定义 | GET | `/api/v1/comfyui/workflows/{uuid}` | 完整定义：`input_rules`、`billing_config`、示例、`endpoint_info` |
| 提交任务 | POST | `/api/v1/comfyui/comfyui_workflow/{uuid}` | body **就是入参对象本身**（不要包 `{inputs:…}`） |
| 查询任务 | GET | `/api/v1/comfyui/comfyui_workflow/result/{task_id}` | 无 body |

### 1.1 目录接口返回的字段很少（重要）

列表项**只有 4 个字段**：

```json
{ "uuid": "minimax_h3_zm_u22", "name": "H3多图多音频生视频(短剧带货版)",
  "price_type": "minimax_h3", "usage_count_7d": 117 }
```

没有 `input_rules`、没有 `description`、**没有 `cover_image_url`**、没有 `billing_config`、没有 `price`。
所以：想拿封面 / 简介 / 起价 / 必填素材，必须逐个 `GET` 详情（系统里已经有 `withRules()` 做这件事，见 §8.1 的缺口）。

### 1.2 详情接口字段（全部）

`uuid`、`name`、`description`、`content`（一两段 markdown 介绍文案）、`cover_image_url`、`price`（当前恒为 0）、`version`（`latest`）、`billing_interval_seconds`（当前恒为 0）、`input_rules`、`input_example`、`output_example`、`api_reference_url`、`endpoint_info`、`price_type`、`billing_config`、`created_at`、`updated_at`、`usage_count_7d`。

`endpoint_info` 就是这两个地址，无额外信息：

```json
{"endpoints":[{"name":"提交任务","url":"/api/v1/comfyui/comfyui_workflow/{uuid}"},
              {"name":"查询任务","url":"/api/v1/comfyui/comfyui_workflow/result/{task_id}"}]}
```

### 1.3 提交任务的返回

```json
{ "code": "Success",
  "data": { "task_id": "2a25da1d-…", "workflow": "H3文生视频", "status": "QUEUED",
            "client_id": "8c93a8000ef50e05d5314014756bd62c",
            "message": "工作流任务已提交", "created_at": "2026-08-18T11:33:02.456421825+08:00" },
  "msg": "", "request_id": "8c93a8000ef50e05d5314014756bd62c" }
```

`task_id` 是 UUID 字符串（不是数字），后续查询只用它。

### 1.4 查询任务的返回与状态机

```json
{ "code": "Success",
  "data": { "task_id": "363ba3f5-…", "status": "RUNNING", "client_id": "430e8d3d…",
            "created_at": "2026-08-14 10:35:28", "started_at": "2026-08-14 10:35:30",
            "duration": 196, "results": [] } }
```

- `status`：`QUEUED` → `RUNNING` → `SUCCESS` / `FAILED`。
- 平台在 `output_example` 里给的成功样例是**小写** `"completed"`（不是 `SUCCESS`），所以状态必须做归一化（`COMPLETED/COMPLETE/DONE → SUCCESS`，`FAILURE/FAIL/ERROR → FAILED`），再按 `QUEUED/RUNNING` 之外的未知值兜底。
- `results` 只在成功后有内容；`duration` 是平台侧耗时（秒），**不等于产出视频的时长**。
- 失败原因字段文档未写死；按平台惯例取 `data.error`（字符串或 `{message}`）→ `data.message` → `data.msg` 兜底。
- `created_at` 格式不统一：提交返回是 ISO8601 带时区，查询返回是 `YYYY-MM-DD HH:MM:SS`。不要拿来算耗时。
- 结果文件 URL 是对象存储直链、**有效期很短**，取到要立刻下载（系统里 30s 一轮、最多 6 轮重试）。

---

## 2. 目录现状（25 个工作流，2026-10-31 线上核对）

价格单位是**积分（分）**：`price: 50` = 0.50 元。`off_peak_price` 是闲时价，系统一律按 `price`（正常时段）算，因为不保证排在闲时。

| workflow_id | 名称 | 计费类型 | 图(必填) | 音(必填) | 视频(必填) | 时长范围 | 必填入参 |
|---|---|---|---|---|---|---|---|
| `minimax_h3_lightx2v_no_pic` | H3文生视频 | minimax_h3 | 0 | 0 | 0 | 1-15 | prompt |
| `minimax_h3_b99_001` | H3文生视频 | minimax_h3 | 0 | 0 | 0 | 1-15 | prompt |
| `minimax_h3_z0901` | H3文生视频（高质量创意直出） | minimax_h3 | 0 | 0 | 0 | 1-15 | prompt |
| `minimax_h3_lightx2v` | H3首尾帧生成视频 | minimax_h3 | 2(2) | 0 | 0 | 1-15 | prompt, first_frame, last_frame |
| `minimax_h3_b99_002` | H3首尾帧生成视频 | minimax_h3 | 2(2) | 0 | 0 | 1-15 | prompt, first_frame, last_frame |
| `minimax_h3_lightx2v_v5` | H3多图参考生视频 | minimax_h3 | 9(1) | 0 | 0 | 1-10 | prompt, ref_image_0 |
| `minimax_h3_lightx2v_v5_15s` | H3多图生视频15秒 | minimax_h3 | 9(1) | 0 | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_b99_003_12s` | H3多图生视频12秒 | minimax_h3 | 9(1) | 0 | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_z0902` | H3六图生视频（多图一致性创作） | minimax_h3 | 6(1) | 0 | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_801` | H3九图15s(无字幕版) | minimax_h3 | 9(1) | 0 | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_802` | H3九图15s(画质增强版) | minimax_h3 | 9(0) | 0 | 0 | 1-15 | prompt |
| `minimax_h3_803` | H3九图三音15s(画质增强版) | minimax_h3 | 9(0) | 3(0) | 0 | 1-15 | prompt |
| `minimax_h3_804` | H3九图15s(多模式版) | minimax_h3 | 9(0) | 0 | 0 | 1-15 | prompt |
| `minimax_h3_805` | H3九图三音15s(多模式版) | minimax_h3 | 9(0) | 3(0) | 0 | 1-15 | prompt |
| `minimax_h3_image_audio_to_video_v2` | H3多图多音频生视频 | minimax_h3 | 9(0) | 3(0) | 0 | 1-10 | prompt |
| `minimax_h3_image_audio_to_video_v2_15s` | H3多图多音频生视频15秒 | minimax_h3 | 9(0) | 3(0) | 0 | 1-15 | prompt |
| `minimax_h3_zm_nono` | H3多图多音频生视频(影视画质) | minimax_h3 | 9(1) | 3(0) | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_zm_u08` | H3多图多音频生视频(高速版) | minimax_h3 | 9(1) | 3(0) | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_zm_u22` | H3多图多音频生视频(短剧带货版) | minimax_h3 | 9(1) | 3(0) | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_zm_u24` | H3多图多音频生视频(升级画质) | minimax_h3 | 9(1) | 3(0) | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_zm_u30` | H3多图多音频生视频(超清画质) | minimax_h3 | 9(1) | 3(0) | 0 | 1-15 | prompt, ref_image_0 |
| `minimax_h3_z0903` | H3六图三音频生视频（高质量音画融合） | minimax_h3 | 6(1) | 3(1) | 0 | 1-15 | prompt, ref_image_0, ref_audio_0 |
| `minimax_h3_image_audio_to_video` | H3图生视频-音频同步(自动对口型) | minimax_h3 | 1(1) | 1(1) | 0 | 1-15 | ref_image_0, ref_audio_0 |
| `wan2.2animate-v4-motion_retargeting` | 动作迁移 | video_sec_cost | 1(1) | 0 | 1(1) | — | ref_image, ref_video |
| `indextts2-v1` | indextts2（音色克隆 TTS） | audio_sec_cost | 0 | 2(1) | 0 | — | prompt_text, prompt_simple, emo_control_method |

「必填」只统计 `required: true`。图片/音频字段普遍是 `ref_image_0..8`、`ref_audio_0..2`，序号从 0 开始，只有 `ref_image_0` / `ref_audio_0` 可能必填。

### 2.1 计费配置（积分）

| workflow_id | 档位 / 单价 |
|---|---|
| `minimax_h3_801` | 480p 50, 768p 60, 1088p 70, 1440p 80 |
| `minimax_h3_802` `_803` `_804` `_805` | 480p 40, 768p 50, 1088p 60, 1440p 70 |
| `minimax_h3_z0901` `_z0902` `_z0903` | 480p 50, 768p 80, 1088p 80, 1440p 90 |
| `minimax_h3_b99_001` `_b99_002` `_b99_003_12s` | 736p 60（单档） |
| `minimax_h3_lightx2v` `_lightx2v_no_pic` `_lightx2v_v5_15s` `_image_audio_to_video_v2_15s` | 480p 40, 768p 50 |
| `minimax_h3_lightx2v_v5` `_image_audio_to_video` | 480p 40, 768p 50, 1080p 100 |
| `minimax_h3_image_audio_to_video_v2` | 480p 40, 768p 50, 1080p 110 |
| `minimax_h3_zm_u08` `_u22` `_u24` | 480p 40, 768p 50 |
| `minimax_h3_zm_u30` | 480p 40, 768p 50, 960p 90 |
| `minimax_h3_zm_nono` | 480p 40, 768p 50, 960p 100 |
| `wan2.2animate-v4-motion_retargeting` | 每秒 40（`video_sec_cost`） |
| `indextts2-v1` | 每秒 1，最低 10（`audio_sec_cost`） |

三种计费类型的确切语义：

- `minimax_h3`：按分辨率档**一次性**计价（与时长无关）。`billing_config.minimax_h3` 是 `[{resolution, price, off_peak_price}]`，`resolution` 只写到档位（`"480p"`、`"960p"`、`"736p"`），而提交的 `resolution` 入参是 label（`"768p竖"`、`"768p竖(768*1376)"`、`"736p(1:1)"`、`"464*832px(竖版)"`）。**匹配方式：取 label 开头的 `\d+p`** 与档位比。当前 25 个里这个正则都能对上（动作迁移是 `video_sec_cost`，`464*832px` 不需要匹配档位）。
- `video_sec_cost`：`{price}` 每秒价 × 时长。时长来自入参 `duration`；**动作迁移没有 duration 入参**，只能靠平台返回值，见 §9.2。
- `audio_sec_cost`：`{price, minimum_price}` 每秒价 × 秒数，再与最低价取大；TTS 没有时长入参，系统按 `prompt_text` 字数 ÷ 4.5 估秒数（近似，见 §9.2）。
- `price` 顶字段当前全为 0，**固定价分支线上没有样本**。`billing_interval_seconds` 全为 0，即没有周期性计费。

---

## 3. `input_rules` 字段字典

每个 key 就是一个提交参数名；值是该参数的规则对象。

| 字段 | 出现于 | 含义 |
|---|---|---|
| `type` | 全部 | `string` / `prompt` / `integer` / `number` / `boolean` / `enum` / `image` / `audio` / `video` |
| `required` | 全部 | 是否必填（`false` 时缺省即不发） |
| `default` | 多数 | 非媒体：真默认值；**媒体：占位串，不能当值提交**（见 §3.2） |
| `min` / `max` | integer/number | 数值范围（`seed` 常见 `1..999999999999999`，个别 `0..`；`emo_*` 是 `0..1.4`） |
| `min_length` / `max_length` | string/prompt | 字符数（prompt 普遍 `1..20000`，TTS `prompt_text` 是 `1..2048`） |
| `options` | enum | `[{label, values}]`；`values` 是 `{ComfyUI节点字段: 值}` 映射 |
| `accept_types` | image/audio/video | MIME 白名单 |
| `node_id` / `field` | 多数 | ComfyUI 内部映射（**对调用方无意义**，只有 `enum.values` 里的同名字段才说明 label 如何落到节点上） |
| `label` / `description` | 实际未出现 | 平台当前不下发，界面上的中文名要自己映射（系统里是 `KNOWN_LABELS`） |

各类型在 25 个工作流里的实际取值：

- `prompt`（视频类）/ `string`（z0901-3、b99、TTS）：只有长度限制。注意同叫 `prompt`，`field` 却分两派：`inputs.prompt`（lightx2v 系列、zm 系列）和 `inputs.text`（801-805、z090x、b99 系列）。**这是平台内部映射，调用方只管发 `prompt` 字符串。**
- `integer`：`duration`（1-10 或 1-15，默认 5）、`audio_duration`（`image_audio_to_video` 的时长，1-15）、`seed`。
- `number`：只有 TTS 的 `emo_happy/angry/sad/afraid/disgusted/melancholic/surprised/calm`，`0..1.4`，默认 0。
- `boolean`：只有 TTS 的 `emo_random`（默认 `false`）。
- `enum`：
  - `resolution`：label 形如 `768p竖`、`768p竖(768*1376)`、`736p(1:1)`、`464*832px(竖版)`；可选面从 3 项（`736p竖/横/(1:1)`）到 8 项；`480p/720p…` 档位 + 横竖 + 可选 1:1。
  - `mode`：`高速模式` / `高质模式`（801/802/803）。
  - `style_preset`：6 种 `文戏模式-真人-文戏…`（804/805）。
  - `emo_control_method`：`与音色参考音频相同` / `使用情感参考音频` / `使用情感向量控制`（TTS，**`required: true` 且有默认值**）。
- 媒体：`ref_image_0..8`、`first_frame` / `last_frame`（首尾帧）、`ref_audio_0..2`、`image_audio_to_video*` 里的 `ref_image_0` / `ref_audio_0`、TTS 的 `prompt_simple`（音色参考音频）和 `emo_ref_audio`、动作迁移的 `ref_image` / `ref_video`。

### 3.1 `enum.options[].values` 的含义（不需要我们处理）

例如 `resolution: 768p竖(768*1376)` 的 values 是：

```json
{"163.inputs.aspect_ratio": "9:16 (Portrait Widescreen)", "163.inputs.megapixels": 0.4}
```

有的是 `{"706.inputs.value": 1}`（整数），有的是 `{"198.inputs.value": 1.5}`（浮点），动作迁移里甚至出现 `{"1001.inputs.value": 468}`、`{"inputs.自定义宽": 480}`（字段名带中文、无节点号）。
**结论：提交时只发 label 字符串，平台自己翻译成节点参数。** 任何试图自己展开 `values` 的做法都是错的。

### 3.2 两个必须避开的坑

1. **媒体默认值是占位串**：`"default_local_path:/blank.png;https://codewithgpu.ks3-…/blank/blank.png"`。字面意思是「什么都不传时平台用 blank.png」，但把它当值发出去不是我们的意图。规则里 `required: true` 且默认值是这个占位串的（`ref_image_0`，见 §2 表格），在系统里必须视为「必填且未填」。
2. **`input_example` 是给人看的说明文案，不是值**：
   ```json
   {"prompt":"视频生成提示词（必填，1-20000个字符，…）","resolution":"输出分辨率（选填，可选值：480p竖、…）"}
   ```
   只能当 placeholder，绝不能当默认值提交。

---

## 4. 媒体输入

- 三种形态都收：**公网 URL**、**data URL**（`data:image/png;base64,…`）、**纯 base64 字符串**（官方 CLI/skill 的默认就是纯 base64）。
- 平台文档的字面要求是「图片 URL」「参考音频 URL」，因此 **data URL / 纯 base64 的可用性是实践共识而非文档承诺**，需要一次真实任务确认（见 §9.3）。
- `accept_types` 实际取值：
  - image：`image/jpeg`、`image/png`、`image/webp`（全部工作流一致，**不收 gif**）
  - audio：`audio/mpeg`、`audio/wav`（多数）、`audio/mpeg`、`audio/wav`、`audio/flac`（801-805、v2 系列、zm_u08/u24/u30）
  - video：`video/mp4`、`video/webm`（只有动作迁移）
- 视频参考输入（动作迁移的 `ref_video`）**必须公网直链**，内嵌不现实；系统当前策略是：图片/音频 < 5MB 内嵌 data URL，视频或超限的传到 TOS 换直链。
- 未在文档中给出、也未在规则里体现的上限：单文件大小上限、音频时长上限、视频时长/分辨率上限、图片边长要求。只能按平台报错反推。

---

## 5. 输出

`results` 是数组，每项结构（25 个工作流的 `output_example` 全部一致）：

```json
{"url":"https://…","type":"video","file_type":"mp4","output_type":"output"}
```

- `type`：`video` / `audio` / `image`（当前在架只有 `video` 24 个、`audio` 1 个）。
- `file_type`：`mp4` / `wav`（将来可能出现 png/jpg/webp）。
- `output_type`：`output`（偶尔出现 `node_id`，动作迁移那一份输出样例里带）。
- **`results` 里没有时长字段**（`duration` 在外层 `data.duration`，是平台耗时）。这对按秒计费的影响见 §9.2。
- 一个任务可能返回多个文件（多图工作流理论上可能出现），系统按数组顺序全部下载，第一个当主文件。
- URL 是对象存储直链、不需要令牌、**有效期很短**。

---

## 6. 逐工作流入参清单（按形态归类）

### 6.1 纯文生视频（无必填素材）
`prompt` + `duration` + `resolution` + `seed`。
- `minimax_h3_lightx2v_no_pic`、`minimax_h3_b99_001`（`resolution` 只有 736p 三档）、`minimax_h3_z0901`。其中 `b99_001`/`z0901` 的 `prompt` 类型是 `string`，lightx2v 系列是 `prompt`。

### 6.2 首尾帧
`first_frame` + `last_frame`（都必填，无默认值）+ `prompt` + `duration` + `resolution` + `seed`。
- `minimax_h3_lightx2v`、`minimax_h3_b99_002`。

### 6.3 多图参考 / 九图
`ref_image_0`（必填，个别为可选）+ `ref_image_1..8` + `prompt` + `duration` + `resolution` + `seed`。
- 必填 `ref_image_0`：`lightx2v_v5`、`lightx2v_v5_15s`、`b99_003_12s`、`z0902`、`801`、`zm_*` 全部。
- `ref_image_0` 也可选：`802`、`803`、`804`、`805`、`image_audio_to_video_v2`、`v2_15s` → **这些工作流可以不带任何图片提交**。
- 分辨率 8 档（480p/768p/1088p/1440p × 横竖）出现在 801-805、z090x；lightx2v 系列是 480p/768p(/1080p) 与横竖/1:1 组合。

### 6.4 多图 + 多音频（音画融合）
在 6.3 基础上加 `ref_audio_0..2`（多数可选，`z0903` 的 `ref_audio_0` 必填）。音频同时作为对口型/节奏参考。
- `image_audio_to_video_v2`（时长 1-10）、`v2_15s`（1-15）、`803` 与 `805`（九图三音）、`zm_nono/u08/u22/u24/u30`、`z0903`。
- **没有 `seed` 规则的工作流**：`indextts2-v1`、`minimax_h3_image_audio_to_video`、`minimax_h3_zm_nono`。其余 22 个都有 `seed`（`integer`，`1..999999999999999` 或 `0..`）。

### 6.5 对口型（图 + 音）
`minimax_h3_image_audio_to_video`：`ref_image_0`（必填）+ `ref_audio_0`（必填）+ `audio_duration` + `resolution`。
**没有 `prompt`、没有 `seed`**，时长参数名是 `audio_duration` 而不是 `duration` —— 任何按 key 名硬编码「prompt/duration」的逻辑在这里会失效。

### 6.6 TTS 音色克隆
`indextts2-v1`：`prompt_text`（1-2048 字，必填）+ `prompt_simple`（音色参考音频，必填）+ `emo_control_method`（必填，有默认）+ 8 个 `emo_*` 浮点 + `emo_random` + `emo_ref_audio`（可选）。
- **跨字段依赖不在规则里**：`emo_ref_audio` 只在 `emo_control_method = 使用情感参考音频` 时才有意义，8 个 `emo_*` 只在 `使用情感向量控制` 时有意义。规则对象里没有任何条件表达式，平台侧校验；系统界面若不做联动，会把用不上的参数照样发出去（平台是否报错未知）。
- 输出是 `wav`，时长由文本/参考音频决定，**无时长入参**。

### 6.7 动作迁移
`wan2.2animate-v4-motion_retargeting`：`ref_image`（必填）+ `ref_video`（必填）+ `resolution`（`464*832px(竖版)` / `832*464px(横版)`）+ `seed`。
**没有 `prompt`、没有时长入参**，按 `video_sec_cost` 计费。

---

## 7. 在系统内的落地（现有实现概览）

| 文件 | 职责 |
|---|---|
| `shared/autodl.ts` | 纯函数：规则→表单（`formValues`/`ruleKind`/`ruleLabel`）、校验（`cleanInputs`）、计费（`stepPrice`/`workflowCost`）、占位默认值过滤（`ruleDefault`） |
| `server/autodl.js` | 4 个接口的客户端：`listWorkflows` / `getWorkflow` / `submitWorkflow` / `getResult` + 信封拆解 + 状态归一化 |
| `server/routes/autodl.js` | `GET /api/autodl/workflows`（60s 目录缓存 + 并发 4 逐个补 `input_rules`）、`GET /api/autodl/workflows/{uuid}`、`POST /api/autodl/submit`（校验 → 预扣积分 → 媒体转 data URL/TOS → 提交 → 建记录） |
| `server/tasks.js` | 统一轮询：6s 一轮、最多 6h、`results` 全量下载到本地、失败原因翻译 |
| `web/src/composer/*` | 按 `input_rules` 渲染表单、选工作流、估积分 |

链路：`目录(缓存 60s) → 用户填表单 → 提交前现取详情并 cleanInputs → holdCredits → 媒体转公网可读形态 → POST 提交 → 记录 queued → 每 6s GET result → SUCCESS 后下载 results → syncCredits 对账`。

> 状态说明：`shared/autodl.ts`、`server/autodl.js`、`server/routes/autodl.js`、`test/autodl.test.js` 在工作区里已写好（`server.js` 已引入路由），但**尚未提交**（git 里是 untracked）。本文件描述的是这份工作区的实现。

**关键设计点（对「支持各个 workflow」直接相关）**：
- 规则与表单不落库。`POST /api/autodl/submit` 总是现取一次工作流详情再校验，平台改规则后不会用旧规则提交。
- 每条记录里快照了 `billing` + `inputs` + `rules`，平台调价/下架不影响历史对账。
- 计费、校验、表单三处共用 `shared/autodl.ts`，前端与后端不各写一份。

---

## 8. 覆盖度评估

| 能力 | 状态 |
|---|---|
| 目录发现（分页、25 个全量） | ✅ 已支持 |
| 规则→表单（9 种 type，含 enum/媒体） | ✅ 已支持 |
| 入参校验（必填、范围、长度、未知 key、默认值） | ✅ 已支持 |
| 媒体提交（图片/音频内嵌、视频走 TOS） | ✅ 已支持，⚠️ data URL 未实测（§9.3） |
| 提交 / 轮询 / 状态归一化 | ✅ 已支持 |
| 结果多文件下载与本地归档 | ✅ 已支持 |
| 计费：`minimax_h3` 按档 | ✅ 已支持（档位取 `\d+p`） |
| 计费：`audio_sec_cost` | ⚠️ 用字数估算秒数（§9.2） |
| 计费：`video_sec_cost` | ❌ 动作迁移预扣 0、结算 0（§9.2） |
| 计费：固定价 `price` | ⚠️ 无线上样本 |
| 目录卡片封面 / 简介 | ❌ 全部为空（§9.1） |
| 图片类输出工作流 | ⚠️ 当前无样本，分支未验证 |
| 跨字段条件（TTS 情感控制） | ⚠️ 未做联动，靠平台校验 |
| 平台限流 / 并发上限 | ❓ 未知 |

---

## 9. 缺口与待验证点（按优先级）

**9.1 目录卡片没有封面和简介（确定的问题）**
`POST /api/v1/comfyui/workflows` 的列表项只有 `uuid/name/price_type/usage_count_7d`。`server/routes/autodl.js` 的 `withRules()` 补详情时只合并了 `input_rules`/`input_example`/`output_example`/`billing_config`，**没有合并 `description` 和 `cover_image_url`**，所以目录里 `description` 恒为 `''`、`cover` 恒为 `null`。修法：在 `withRules()` 里再带上这两个字段（成本为零，详情已经取回来了）。

**9.2 按秒计费的两处不准（确定的问题）**
- 动作迁移（`video_sec_cost`）：`durationOf(inputs)` 找不到 `duration/audio_duration/seconds/video_seconds` → 返回 0 → `workflowCost` 返回 `null` → `holdCredits` 按 0 预扣；结算时 `opts.seconds` 取 `results[0].duration`，而 **`results` 里没有 duration 字段**（外层 `data.duration` 才是平台耗时，且不是视频时长）→ 结算也拿不到 → 最终按 `quote`（0）记账，等于免费。修法：要么结算时用外层 `data.duration`（平台耗时，偏保守），要么用别的办法取视频真实时长。
- TTS（`audio_sec_cost`）：秒数用 `prompt_text.length / 4.5` 估；实际扣费应以平台返回为准，当前只能在平台侧对账。

**9.3 data URL / 纯 base64 是否被平台接受（待实测）**
系统对 <5MB 的图片/音频发 `data:<mime>;base64,…`，官方文档只写「URL」。虽然 skill 的 CLI 一直用纯 base64 且可用，但 **data URL 前缀这一形态没有实测记录**。需要一次真实任务（图片输入的工作流，例如 `lightx2v_v5` 带一张小图）确认；若平台拒收，降级方案是统一走 TOS 直链（`publishLocalMedia`，已是视频的默认路径）。

**9.4 固定价分支无线上样本**
25 个工作流 `price` 全为 0、`billing_interval_seconds` 全为 0，`stepPrice`/`workflowCost` 里的 fixed 分支从未被真实数据验证。若平台后续上新「按次固定价」工作流，需要复核。

**9.5 图片输出工作流不存在**
当前 24 视频 + 1 音频。`outputKind()` 的 image 分支、`FILE_KINDS` 里的 png/jpg/webp、`fileNameFor` 的图片目录都无真实样本。平台一旦上图片工作流（ComfyUI 上很常见），需要跑一遍确认下载、缩略图、卡片展示。

**9.6 TTS 的跨字段条件**
`emo_control_method` 与 `emo_ref_audio` / 8 个 `emo_*` 的联动规则不在 `input_rules` 里。系统当前把非必填项只在用户填了才发，因此默认行为基本安全；但如果用户填了 `emo_ref_audio` 却选了「与音色参考音频相同」，会发一个平台可能忽略或报错的组合。建议将来在界面上按 `emo_control_method` 显示/隐藏对应字段（这不是 API 层面的问题）。

**9.7 时长/大小上限未知**
音频参考多长、参考视频多长/多大、图片边长限制都没有文档。失败时只能靠 `data.error`/`msg` 文案反推，且系统里 `ERROR_HINTS` 只覆盖少数 code。

**9.8 状态与时间的边界**
- 成功状态可能是小写 `completed`（已在 `output_example` 里观测到），另外 `SUCCESS/COMPLETED/COMPLETE/DONE` 都要认；`FAILURE/FAIL/ERROR` 归为失败。未知值应当当作「还在跑」而不是失败。
- `created_at` 两种格式（ISO8601 / `YYYY-MM-DD HH:MM:SS`），不要用来算耗时或排序。
- 轮询频率未知上限。系统按 6s 一轮、有多个任务时并发轮询；若平台严格限流，需要退避。

**9.9 域名**
文档与示例用 `autodl.art`，系统 `AUTODL.baseUrl` 默认 `https://www.autodl.art`，两者都通。注意 `AUTODL_BASE_URL` 可覆盖。

---

## 10. 复核方法（不提交任务、不花钱）

```bash
CLI=/Users/doit/.codex/skills/autodl-art-comfyui/scripts/autodl_comfyui.py
$CLI list --all                      # 25 个 uuid / 名称 / price_type / 7 日用量
$CLI get <uuid> --full               # 完整定义：input_rules、billing_config、output_example
$CLI template <uuid> --defaults      # 按规则默认值生成一份可提交的骨架（媒体占位已被过滤）
```

令牌在 macOS Keychain 的 `autodl-art-comfyui`，不写进任何文件/日志。

需要真实任务才能确认的项（要花钱，须先得到授权，逐个单独跑）：

1. data URL 形态的图片是否被接受（`minimax_h3_lightx2v_v5` + 1 张 512px PNG，480p 档）。
2. 动作迁移的 `results[0]` 里到底有没有时长；外层 `data.duration` 与成片时长差多少。
3. 失败任务（例如超范围 `duration`，或不传必填媒体）的 `data` 里错误字段长什么样，用来补 `ERROR_HINTS`。
4. `ref_image_0` 为可选的工作流（`802`）完全不带图提交是否正常出片。
