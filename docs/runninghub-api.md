# RunningHub API 调研

> 调研日期：2026-10-31。范围：`runninghub.cn` 国内站文档中心全部已发布页面（412 页），其中**标准模型 API 261 个端点**逐页拉取解析；另外对线上接口做了无密钥探活（只发空/假 Key 请求，不产生费用）。
> 本文是**调研结论**，不含任何代码改动。
> 官方文档：<https://www.runninghub.cn/runninghub-api-doc-cn/>　文档原始 markdown：`https://www.runninghub.cn/runninghub-api-doc-cn/llms.txt`

---

## 0. 结论先行

1. RunningHub 是「云端 ComfyUI + 模型聚合」平台，API 分四类：**模型 API、AI 应用 API、工作流 API、LLM API**。前三类都是同一套任务模型：`提交 → taskId → 查询 → 结果 URL`。
2. 对我们价值最大的是两块：
   - **标准模型 API（261 个端点）**：一层薄封装直接调各家的图像/视频/音频/3D 模型，入参是语义化的 `prompt / imageUrl / duration / resolution`，**不需要我们自己搭 ComfyUI 工作流**。一家 Key 就能覆盖我们现在的火山 + MiniMax + AiHubMix 三家的能力面。
   - **工作流 API**：跑自己搭的 ComfyUI 工作流，入参是 `nodeInfoList`（节点 ID + 字段名），和我们已有的 AutoDL 适配器**同构**，可以直接复用现有轮询/下载/积分链路。
3. **两代 API 并存，响应结构完全不同**：V2 是扁平 JSON，V1 是 `{code,msg,data}` 信封。同一个业务概念两套写法，混用一定出错。
4. **HTTP 状态码恒定 200**，成功失败全看 body 里的 `errorCode` / `code`。`res.ok` 完全不能用来判成败。
5. 素材上传走 `POST /openapi/v2/media/upload/binary`，返回 `download_url`（**1 天有效**）+ `fileName`（给 ComfyUI 节点用）。原图 URL 直接喂模型会过期，必须及时下载落盘。
6. 计费按任务扣：查询结果的 `usage` 里有 `consumeMoney`（元）、`consumeCoins`（RH 币）、`taskCostTime`、`thirdPartyConsumeMoney`，**可以直接映射我们「1 积分 = 0.01 元」的核算**，不需要自己估。
7. 最大的坑是**参数类型不统一**：同样是 `duration`，Seedance 是字符串 `"5"`，可灵是整数 `5`，海螺是字符串 `"6"`。`generateAudio` 是字符串 `"true"` 而不是布尔。必须按端点逐个登记，不能抽公共 schema。

---

## 1. 平台与账号体系

### 1.1 个人账户 / 团队账户

- 所有用户都用**个人账户**登录，没有独立的团队登录。
- 团队账户是建在个人账户之上的**结算与协作主体**。切到团队后，API Key 的归属、扣费、账单、LLM 日志都走团队。
- 加入团队不迁移个人资源，只是多了一个可访问的主体。

对我们的影响：如果团队要用一个共享 Key 统一扣费，应该建团队账户而不是发个人 Key。

### 1.2 三种 API Key

| 类型 | 说明 | 能调 |
| :--- | :--- | :--- |
| 消费级-会员 | 个人会员权益，创建 Key 需要基础版及以上会员 | AI 应用 API、工作流 API |
| **企业级-共享** | 按量付费，**唯一能调模型 API 和 LLM API 的 Key** | 全部四类 |
| 企业级-独占 | 买了独占机器才能创建 | AI 应用 API、工作流 API |

Key 在 <https://www.runninghub.cn/enterprise-api/consumerApi> 创建。

> 注意：如果我们主要用标准模型 API，**必须开通企业级-共享 Key**，会员 Key 会直接返回 `1014 Access Denied`。

### 1.3 两个站点

| 站点 | API 域名 | LLM 域名 |
| :--- | :--- | :--- |
| 国内 | `https://www.runninghub.cn` | `https://llm.runninghub.cn` |
| 国际 | `https://www.runninghub.ai` | `https://llm.runninghub.ai` |

实测两站的 `/openapi/v2/query` 行为完全一致（同样的错误体、同样的字段）。文档在两站内容也一致。

> **待验证**：两站的 API Key 是否互通。文档没有明说，推测不互通（账号体系独立）。接入时先固定 `.cn`。

---

## 2. 接口全景

### 2.1 按能力分类

| 能力 | V2（新） | V1（旧、文档主推） |
| :--- | :--- | :--- |
| 提交工作流任务 | `POST /openapi/v2/run/workflow/{workflowId}` ⚠️文档未单列 | `POST /task/openapi/create` |
| 提交 AI 应用任务 | `POST /openapi/v2/run/ai-app/{appId}` ⚠️文档未单列 | `POST /task/openapi/ai-app/run` |
| 提交标准模型任务 | `POST /openapi/v2/{厂商}/{模型}/...` | — |
| 查询任务 | `POST /openapi/v2/query` | `POST /task/openapi/status`（已废弃）<br>`POST /task/openapi/outputs`（已废弃） |
| 取消任务 | — | `POST /task/openapi/cancel` |
| 上传素材 | `POST /openapi/v2/media/upload/binary` | `POST /task/openapi/upload`（已废弃） |
| 上传 LoRA | — | `POST /api/openapi/getLoraUploadUrl` |
| 取工作流 JSON | — | `POST /api/openapi/getJsonApiFormat` |
| 取 AI 应用调用示例 | — | `GET /api/webapp/apiCallDemo` |
| 公共模型（权重）列表 | `POST /openapi/v2/resource/list` | — |
| Webhook 事件详情 | — | `POST /task/openapi/getWebhookDetail` |
| Webhook 重发 | — | `POST /task/openapi/retryWebhook` |
| 账户状态 | `POST /uc/openapi/accountStatus` ⚠️未公开 | — |
| 实时进度 | `netWssUrl`（WebSocket） | 同 |

⚠️ 标记的三个接口在文档站上**没有独立页面**，是我线上探活确认存在的（见 §11.1 的实测记录）。文档没写意味着**没有稳定性承诺**，接入时要包一层兜底。

### 2.2 三种调用流程

**标准模型 API**
```text
POST /openapi/v2/{endpoint}      → {taskId, status:"RUNNING", ...}
POST /openapi/v2/query {taskId}  → {status:"SUCCESS", results:[{url,outputType}]}
GET  results[0].url              → 下载（24h 内）
```

**工作流 / AI 应用 API**
```text
POST /openapi/v2/run/workflow/{id}  → {taskId, ...}
（同上查询）
```

**LLM API**
```text
POST https://llm.runninghub.cn/v1/chat/completions   （OpenAI 协议，可直接流式）
```

---

## 3. 认证与请求约定

### 3.1 认证

| 世代 | 头 | body |
| :--- | :--- | :--- |
| V2（模型 / 上传 / run） | `Authorization: Bearer <API KEY>` | 不需要 apiKey |
| V1（`/task/openapi/*`） | `Authorization: Bearer <API KEY>` | **还要** body 里再带一份 `apiKey` |
| LLM | `Authorization: Bearer <API KEY>` | — |

V1 的重复传参是历史包袱。实测 `/task/openapi/create` 只给 header 不给 body.apiKey，返回 `{"code":301,"msg":"must not be null"}`。

### 3.2 V2 响应结构（扁平，无信封）

```json
{
  "taskId": "2013508786110730241",
  "status": "RUNNING",
  "errorCode": "",
  "errorMessage": "",
  "results": null,
  "clientId": "f828b9af25161bc066ef152db7b29ccc",
  "promptTips": "{\"result\": true, \"error\": null, \"outputs_to_execute\": [\"4\"], \"node_errors\": {}}",
  "failedReason": {},
  "usage": null,
  "parentTaskId": null,
  "taskUsageList": null
}
```

`status` 枚举：`QUEUED` / `RUNNING` / `SUCCESS` / `FAILED`（V1 还多一个 `CREATE`）。

成功时 `results`：
```json
"results": [
  { "url": "https://rh-images-...cos.ap-beijing.myqcloud.com/....mp4", "outputType": "mp4", "text": null }
]
```

`usage`（成功后可读）：
```json
"usage": { "consumeMoney": null, "consumeCoins": null, "taskCostTime": "0", "thirdPartyConsumeMoney": null }
```

### 3.3 V1 响应结构（信封）

```json
{ "code": 0, "msg": "success", "data": { "taskId": "1910246754753896450", "taskStatus": "QUEUED", "clientId": "...", "promptTips": "..." } }
```

查询结果 `POST /task/openapi/outputs` 的 `data` 是一个**数组**：
```json
{ "code": 0, "msg": "success", "data": [ { "fileUrl": "...", "fileType": "png", "taskCostTime": "83", "nodeId": "12", "consumeCoins": "17" } ] }
```

### 3.4 关键：错误也返回 HTTP 200

实测（假 Key）：
```bash
$ curl -X POST https://www.runninghub.cn/openapi/v2/query \
    -H "Authorization: Bearer invalid-test-key" -d '{"taskId":"1"}'
HTTP/1.1 200
{"taskId":"1","status":"","errorCode":"806","errorMessage":"APIKEY_USER_NOT_FOUND", ...}
```

所以：**判成败只能看 `errorCode === ""`（V2）或 `code === 0`（V1）**，绝不能看 HTTP 状态。

---

## 4. 标准模型 API（重点）

### 4.1 统一风格

- 路径统一前缀 `/openapi/v2/`，按 `厂商/模型/动作` 三段组织，例如 `/openapi/v2/seedance-v1.5-pro/image-to-video`。
- 入参是**语义化字段**（`prompt`、`firstImageUrl`、`duration`、`resolution`、`aspectRatio`），不用懂 ComfyUI 节点。
- 提交后返回的就是 §3.2 的扁平结构，`status` 通常已经是 `RUNNING`。
- 查询统一走 `/openapi/v2/query`，**所有模型共用一个查询接口**——这点很好，意味着只需要一个轮询器。

### 4.2 规模与分布

261 个端点，60 个厂商/产品家族：

| 模态 | 分类 | 数量 |
| :--- | :--- | ---: |
| 视频 | image-to-video | 65 |
| 视频 | text-to-video | 45 |
| 视频 | reference-to-video | 16 |
| 视频 | video-tools / video-edit / motion-control / video-extend / video-to-video / audio-to-video | 8+6+5+2+1+2 |
| 图像 | text-to-image | 41 |
| 图像 | image-to-image | 34 |
| 图像 | image-tools / reference-to-image | 2+1 |
| 音频 | text-to-audio（TTS/克隆） | 11 |
| 音频 | text-to-music（Suno / MiniMax Music） | 6 |
| 音频 | text-to-lyrics / video-to-audio（分轨） | 1+3 |
| 3D | image-to-3D / text-to-3D | 11+1 |

厂商家族前三：`alibaba`（26，万相/千问）、`rhart-image`（22，全能图片系列）、`rhart-video`（19，全能视频系列）。此外有 `kling`（可灵，约 20）、`vidu`（17）、`minimax`（15）、`seedance`/`seedream`、`youchuan`（悠船/Midjourney）、`skyreels`、`pixverse`、`bytedance`（即梦）、`hunyuan3d`/`hitem3d`。

> 完整清单见 §12 附录，每行都有端点、中文名、必填参数。

### 4.3 与我们五模态的对应

| 我们的模态 | 首选候选端点 | 说明 |
| :--- | :--- | :--- |
| 视频（文生） | `rhart-video/sparkvideo-2.0/text-to-video`、`seedance-v1.5-pro/text-to-video`、`kling-v3.0-pro/text-to-video` | Seedance 2.0 已在平台内，和我们直连方舟的型号同源 |
| 视频（首尾帧） | `seedance-v1.5-pro/image-to-video`、`kling-v3.0-pro/image-to-video`、`minimax/hailuo-2.3/i2v-standard` | 都支持 `firstImageUrl` + `lastImageUrl` |
| 视频（全能参考） | `alibaba/wan-2.7/reference-to-video`、`kling-video-o3-pro/reference-to-video`、`rhart-video/sparkvideo-2.0/multimodal-video` | 后者支持图+视频+音频混合，最接近我们的「全能参考」 |
| 图片（文生） | `seedream-v4.5/text-to-image`、`rhart-image-n-pro-official/text-to-image`、`alibaba/qwen-image-2.0/text-to-image` | Seedream 4.5 对应我们现在的 Seedream 5.0 上游 |
| 图片（图生/编辑） | `seedream-v4.5/image-to-image`、`rhart-image-n-pro-official/edit`、`alibaba/qwen-image-2.0/image-edit` | |
| 语音 TTS | `rhart-audio/text-to-audio/speech-2.8-hd` / `speech-2.8-turbo` | MiniMax Speech，17 个系统音色 + 声音克隆 |
| 音效 / 配乐 | `minimax/music-2.6/text-to-music`、`minimax/music-2.6/text-to-instrumental`、`rhart-audio/suno-v5.5/custom` | 纯音乐版正好对音效 |
| 声音克隆 | `rhart-audio/text-to-audio/voice-clone` | 对应我们「角色一致性」的延伸 |

### 4.4 代表性入参

**图生视频（Seedance 1.5 Pro）** `POST /openapi/v2/seedance-v1.5-pro/image-to-video`
```json
{
  "prompt": "基于参考图，人物身份和服装保持完美一致……",
  "firstImageUrl": "https://...",
  "lastImageUrl": "https://...",
  "aspectRatio": "adaptive",
  "duration": "5",
  "resolution": "720p",
  "generateAudio": "true",
  "cameraFixed": "false"
}
```
`aspectRatio`: `16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 / adaptive`；`duration`: `"4"`–`"12"`；`resolution`: `720p / 1080p`。

**文生图（Seedream 4.5）** `POST /openapi/v2/seedream-v4.5/text-to-image`
```json
{ "prompt": "...", "width": 2048, "height": 2048, "resolution": "2k", "maxImages": 4, "sequentialImageGeneration": "disabled" }
```
> 注意这里 `width/height` 是 **integer**，而 `resolution` 是字符串。同一个端点里类型就不统一。

**TTS（MiniMax Speech 2.8 HD）** `POST /openapi/v2/rhart-audio/text-to-audio/speech-2.8-hd`
```json
{
  "text": "Bonjour! How are you today?",
  "voice_id": "Wise_Woman",
  "speed": 1, "volume": 1, "pitch": 0,
  "pronunciation_dict": ["ASAP/As soon as possible"]
}
```
系统音色：`Wise_Woman, Friendly_Person, Inspirational_girl, Deep_Voice_Man, Calm_Woman, Casual_Guy, Lively_Girl, Patient_Man, Young_Knight, Determined_Man, Lovely_Girl, Decent_Boy, Imposing_Manner, Elegant_Man, Abbess, Sweet_Girl_2, Exuberant_Girl`。文本里支持 `(laughs)`、`(sighs)` 等 22 种拟声标记。

**文生音乐（MiniMax Music 2.6）** `POST /openapi/v2/minimax/music-2.6/text-to-music`
```json
{ "prompt": "...", "lyrics": "...", "sampleRate": 44100, "bitrate": 256000, "format": "mp3", "lyricsOptimizer": true }
```
只有 `lyrics` 必填——纯音效场景配 `text-to-music` 的纯音乐端点更合适。

### 4.5 素材怎么进去

标准模型 API 的图片字段（`imageUrl` / `firstImageUrl` / `imageUrls[]` / `images[]`）只接受 **公网可访问的 URL**。两种给法：

1. **我们自己已有公网地址**（TOS / 发布链接）→ 直接塞。
2. **本地素材** → 先 `POST /openapi/v2/media/upload/binary`，拿 `download_url` 塞进去。

```bash
curl -X POST 'https://www.runninghub.cn/openapi/v2/media/upload/binary' \
  -H 'Authorization: Bearer <KEY>' \
  -F 'file=@/path/to/image.png'
```
```json
{ "code": 0, "message": "success",
  "data": { "type": "image", "download_url": "https://rh-images-switch-....png?q-signature=...",
            "fileName": "openapi/61432ac1....png", "size": "3490" } }
```

**关键约束**：
- `download_url` 是带签名的临时地址，**有效期 1 天**。
- 平台明确说「非图床」——不要拿它当我们的素材长期存储。
- 支持：图片 `JPG/PNG/JPEG/WEBP`、图片压缩包 `ZIP`、音频 `MP3/WAV/FLAC`、视频 `MP4/AVI/MOV/MKV`。
- 同一份返回里 `fileName` 给 ComfyUI 节点用（工作流 API），`download_url` 给标准模型 API 用，两个不能混。

---

## 5. 工作流 API（ComfyUI）

### 5.1 提交

**V2**
```
POST /openapi/v2/run/workflow/{workflowId}
Authorization: Bearer <KEY>
{ "nodeInfoList": [ ... ], "instanceType": "default" }
```
实测存在且返回 V2 扁平结构（传空 body 时先报 806 用户不存在，说明参数校验在鉴权之后）。

**V1（文档主推）**
```
POST /task/openapi/create
{ "apiKey": "...", "workflowId": "1904136902449209346", "nodeInfoList": [...], "addMetadata": true }
```
返回 `{code:0, msg:"success", data:{taskId, taskStatus:"QUEUED", clientId, promptTips, netWssUrl}}`。

### 5.2 nodeInfoList —— 它是「节点 + 字段」，不是语义参数

单个元素：
```json
{ "nodeId": "6", "fieldName": "text", "fieldValue": "1 girl in classroom" }
```

- `nodeId`：工作流画布上节点右上角的数字。
- `fieldName`：该节点 `inputs` 里的 key（如 `text` / `seed` / `steps` / `image`）。
- `fieldValue`：替换值，**类型必须与原字段一致**。

`nodeId` / `fieldName` 从哪来？两种办法：
1. 平台界面「导出工作流 API」下载 JSON，自己找。
2. 调 `POST /api/openapi/getJsonApiFormat {apiKey, workflowId}`，返回 `data.prompt` 是那段 JSON 字符串。

```json
{ "3": { "class_type": "KSampler", "inputs": { "seed": 669816362794144, "steps": 20, ... } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "DreamWork 3D Style, ..." } } }
```

### 5.3 几个必踩的点

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| `810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING` | 工作流没保存或从没手动跑过 | 先在平台保存并手动运行一次 |
| seed 每次都变 | **API 调用强制重置 seed** | 想固定就显式放进 `nodeInfoList` |
| 某个字段改了没生效 | 该字段是纯前端逻辑（如 `control_after_generate`、`group` 相关） | API 格式里没有的就改不了 |
| 改了连线字段导致工作流崩 | `fieldValue` 是 `[]` 包裹的代表连线 | 不要改 |
| `803 APIKEY_INVALID_NODE_INFO` | nodeId / fieldName 与工作流定义不一致 | 用 `getJsonApiFormat` 核对 |

### 5.4 可选参数

| 参数 | 作用 | 备注 |
| :--- | :--- | :--- |
| `instanceType` | `default`(24G) / `plus`(48G) / `ultra`(84G) | 传错档位返回 `435` |
| `retainSeconds` | 10–180 秒，任务结束后保留实例供复用，减少冷启动 | **仅企业级-共享 Key 生效**，会计费 |
| `usePersonalQueue` | 独占 Key 的排队交给平台 | 单用户上限 1000，超了报 `814` |
| `addMetadata` | 是否把提示词写进图片元信息 | 默认 true |
| `accessPassword` | 工作流/AI 应用开了加密访问时的密码 | 2026-04 新增 |
| `webhookUrl` | 完成回调 | 见 §5.5 |

### 5.5 Webhook

设置 `webhookUrl` 后，任务结束平台 POST：
```json
{ "event": "TASK_END",
  "taskId": "1904163390028185602",
  "eventData": "{\"code\":0,\"msg\":\"success\",\"data\":[{\"fileUrl\":\"...\",\"fileType\":\"png\",\"nodeId\":\"9\"}]}" }
```
注意 `eventData` 是**字符串套 JSON**，要二次 parse。

调试用：
- `POST /task/openapi/getWebhookDetail {apiKey, taskId}` → 返回 `callbackStatus`（SUCCESS/FAILED）、`callbackResponse`、`retryCount`、`createTime`。
- `POST /task/openapi/retryWebhook` 重发。

### 5.6 实时进度（WebSocket）

提交返回的 `netWssUrl`（排队阶段可能为空）连上去，能收到 ComfyUI 原生事件：

| `type` | `data` | 含义 |
| :--- | :--- | :--- |
| `progress` | `{node, value, max}` | 当前节点内进度 |
| `executing` | `{node}` | 切换执行节点；`node` 为 null 表示整体结束 |
| `execution_cached` | `{nodes:[...]}` | 这些节点命中缓存，直接算完成 |
| `execution_success` | — | 全部完成 |

`netWssUrl` 不是提交时就有：排队阶段为空，要轮询 `/task/openapi/outputs`，等 `data` 从数组变成含 `netWssUrl` 的对象时才能连。

> 对我们价值有限。现在的轮询器（6 秒一次）已经够用，WebSocket 只适合工作流很长、想给用户看「第几个节点」的场景。

---

## 6. AI 应用 API

「AI 应用」是平台把某个工作流包装成带表单的产品页，有独立的 `webappId`。

**V1（文档）**
```
POST /task/openapi/ai-app/run
{ "apiKey": "...", "webappId": 1877265245566922800, "nodeInfoList": [...], "instanceType": "default", "accessPassword": "..." }
```
`webappId` 是 **integer**，`nodeInfoList` 必填且不能是空数组（实测空数组报 `1101 Node info error`）。

**V2（实测存在）**
```
POST /openapi/v2/run/ai-app/{appId}
{ "nodeInfoList": [...] }
```

**取示例参数**（很实用）：
```
GET /api/webapp/apiCallDemo?apiKey=...&webappId=...
```
返回 `data.curl`（可直接复制的完整 curl）、`data.nodeInfoList`（每个字段的 `fieldType`、`fieldData`、中英文描述）、`covers`、`tags`、`accessEncrypted`。`fieldType` 有 `IMAGE` / `LIST` / `STRING` 等，`fieldData` 里带枚举候选——**这就是这个 AI 应用的入参 schema**，可以用来动态渲染表单，等价于 AutoDL 的 `input_rules`。

> 对我们的意义：如果以后想让用户在界面上「选一个 RunningHub 应用」，`apiCallDemo` 就是元数据来源。但它的字段描述是自然语言不是 JSON Schema，做通用表单会比 AutoDL 麻烦。

---

## 7. LLM API

```
POST https://llm.runninghub.cn/v1/chat/completions
Authorization: Bearer <企业级-共享 KEY>
{ "model": "glm-5.2", "messages": [...], "max_tokens": 2048, "temperature": 1, "reasoning_effort": "none" }
```
- 兼容 OpenAI / Anthropic / Gemini 三套协议（`/v1/chat/completions`、`/v1/messages`、Gemini 风格）。
- 支持流式。
- **只认企业级-共享 Key**，会员 Key 和独占 Key 都不行。
- 实测无 Key 返回 HTTP 401（和其他接口的「200 + body 错误码」不一样，这是唯一遵守 HTTP 语义的一类）。

用途：可以替掉我们现在用豆包 Seed 2.1 做的提示词润色，或者做多模型对比。但同类能力我们已经有了，**优先级低**。

---

## 8. 错误码

### 8.1 通用（V1 信封里的 `code`）

| 码 | 标识 | 含义 | 我们的处理 |
| :--- | :--- | :--- | :--- |
| 301 | PARAMS_INVALID | 参数缺失/类型不符 | 400，提示改参数 |
| 380 | WORKFLOW_NOT_EXISTS | 工作流 ID 无效 | 400 |
| 412 | TOKEN_INVALID | 路径拼错 | 500（我们自己的 bug）|
| 415 | TASK_INSTANCE_MAXED | 独占机器不足 | 重试 30–120 秒 |
| 416 | TASK_CREATE_FAILED_BY_NOT_ENOUGH_WALLET | **余额不足** | 401 提示充值 |
| 421 | TASK_QUEUE_MAXED | **共享并发上限** | 排队重试 |
| 423 / 807 | TASK_NOT_FOUND | 任务 ID 错或已清理 | 标记失败 |
| 433 | VALIDATE_PROMPT_FAILED | 工作流校验未通过 | 400，展示 `msg` |
| 435 | TASK_USER_EXCLAPI_INSTANCE_NOT_FOUND | 传了 plus/ultra 但没这档机器 | 回退 default |
| 801 | APIKEY_UNSUPPORTED_FREE_USER | 免费用户不能调 API | 401 |
| 802 | APIKEY_UNAUTHORIZED | Key 失效 | 401 |
| 803 | APIKEY_INVALID_NODE_INFO | nodeInfoList 不匹配 | 400 |
| 804 | APIKEY_TASK_IS_RUNNING | 任务还在跑 | 继续轮询 |
| 810 | WORKFLOW_NOT_SAVED_OR_NOT_RUNNING | 工作流没保存/没跑过 | 400 + 操作指引 |
| 813 | APIKEY_TASK_IS_QUEUED | 已排队 | 继续轮询 |
| 814 | PERSONAL_QUEUE_COUNT_LIMIT | 个人队列超 1000 | 拒绝提交 |
| 901 | WEBAPP_NOT_EXISTS | AI 应用 ID 错 | 400 |

### 8.2 V2 扁平结构的 `errorCode`

1000–1520 段，语义和上面大致对齐，重点是：

| 码 | 含义 | 处理 |
| :--- | :--- | :--- |
| 1002 | Key 无效 | 401 |
| 1003 | 限流 | 退避重试 |
| 1004 | 任务不存在或过期 | 失败 |
| 1007 | 参数校验失败 | 400 |
| 1008 | 文件超限 | 400 |
| 1013 | 文件处理失败（下载不到 URL） | 400，提示参考图不可访问 |
| **1014** | 仅企业级-共享 Key 可调标准模型 API | 401 + 明确文案 |
| 1015 | 生成失败 | 可重试一次 |
| 1101 | 节点信息异常 | 400 |
| **1501** | 内容审核未通过 | 改成我们已有的「内容未通过审核」提示 |
| 1504 | 模型超时 | 可重试 |
| **1505** | 禁止真人 | 明确提示改提示词/参考图 |
| 1520 | 账号并发上限 | 排队 |

> 1505「禁止生成真人」是这类平台的硬约束，比我们现在的审核提示更需要单独文案。

---

## 9. 计费

- 提交即按 SKU 预扣；失败退款（`416` 直接拒，不扣）。
- 查询结果 `usage` 字段：
  - `consumeMoney`：平台消耗金额（元）
  - `consumeCoins`：平台消耗点数（RH 币）
  - `thirdPartyConsumeMoney`：第三方消耗金额
  - `taskCostTime`：任务耗时（秒）
- V1 的 `/task/openapi/outputs` 里也有 `consumeCoins` / `consumeMoney` / `taskCostTime`。

**对我们的价值**：现在的积分核算是「提交时按目录价预估预扣 → 完成后按实际用量多退少补」。RunningHub 直接回真实金额，可以让「结算」这一步从估算变成对账，比自己维护价格表更准。

> 文档里没有逐端点的价目数字（只在平台页面上有）。要做预扣，仍需要我们自己登记一份价格表；或者干脆改成「先扣预估、完成后用 `usage.consumeMoney` 覆盖」。

---

## 10. 接入设计（只给方案，不改代码）

现有链路的形状（`server/tasks.js` 的 `PLATFORMS`）天然支持再加一家：

```
PLATFORMS = { ark, minimax, autodl, ... }
query(id) → 统一成 { status, usage, results[] }
applyTaskState() 消费这个统一形状
```

RunningHub 和 **AutoDL 几乎同构**：都是「提交 → taskId → 查 → results 数组 → 下载」。所以可以照抄 AutoDL 那一套。

### 10.1 需要新增/改动的地方

| 位置 | 动作 |
| :--- | :--- |
| `shared/models.ts` | 加 `RUNNINGHUB = { label: 'RunningHub', keysUrl: ... }`；登记模型（`provider: 'runninghub'`） |
| `shared/runninghub.ts`（新） | 模型登记表：端点路径、必填参数、枚举、参数类型（**逐端点写，不能抽公共 schema**）、预估价格 |
| `server/runninghub.js`（新） | 照 `server/autodl.js`：`call()` 封 Bearer、**V2 判 `errorCode === ''`**、`submit()`、`query()`、`upload()` |
| `server/keys.js` + `server/config.js` | 加 `RUNNINGHUB_API_KEY` |
| `server/tasks.js` | `PLATFORMS.runninghub = { query }`，把 V2 扁平结构映射成统一形 |
| `server/routes/*` | 提交接口按模型分发到 runninghub |
| `server/billing.js` | 可选：用 `usage.consumeMoney` 替代预估 |

### 10.2 适配器要点（照 AutoDL 的坑改）

1. **不要看 HTTP 状态**。`call()` 里判 `payload.errorCode`（V2）或 `payload.code`（V1）。
2. **下载不带令牌**。`results[].url` 是对象存储签名地址，直接 fetch；只有平台自有域名才用原 Key。
3. **状态映射**：`QUEUED→queued`、`RUNNING→in_progress`、`SUCCESS→completed`、`FAILED→failed`。
4. **失败原因**：`errorMessage` + `failedReason`（对象，可能含 `exception_type` / `traceback`）。展示用我们自己的中文文案，原话进 `detail`。
5. **超时**：视频类任务 5–10 分钟很正常，`MAX_PENDING_MS` 要放宽到 15–20 分钟。
6. **结果 URL 24h 失效**：`applyTaskState` 拿到 URL 后必须立刻进下载队列，和现在 AutoDL 的处理一致。

### 10.3 素材上传策略

我们本地素材 → RunningHub 有两条路：

```
本地文件
  ├── 标准模型 API：upload/binary → download_url → 塞进 imageUrl 字段
  └── 工作流 API ：upload/binary → fileName    → 塞进 nodeInfoList.fieldValue
```

注意：
- `download_url` 只有 1 天有效期，**不能进 `publications.json` 的长期缓存**（现在是永久复用，会踩坑）。
- 建议按「文件 hash → RunningHub URL + 过期时间」单独缓存，过期就重传。
- 我们已有 TOS 公网地址的素材，可以直接给 URL，省一次上传。

### 10.4 积分映射

- 现状：`1 积分 = 0.01 元`，提交预扣、完成多退少补。
- RunningHub：`usage.consumeMoney` 是元 → `积分 = consumeMoney * 100`。
- 若 `consumeMoney` 为 null（部分模型只回 `consumeCoins`），回退到我们登记的预估价。

### 10.5 与 AutoDL 的取舍

| 维度 | AutoDL.art | RunningHub |
| :--- | :--- | :--- |
| 形态 | 只有自建 ComfyUI 工作流 | 工作流 + **261 个现成模型端点** |
| 入参 | `input_rules`（JSON Schema 风格，可动态渲染） | 工作流是 `nodeInfoList`；模型 API 是固定字段 |
| 计价 | `billing_config` 里明确 | 只在平台页面，接口回实际消耗 |
| 计费单位 | 积分 | 元 + RH 币 |
| 输出 | 视频为主 | 视频/图片/音频/3D 全覆盖 |

建议：**标准模型 API 优先**（覆盖快、维护成本低），自建工作流作为「现有模型满足不了」的补充。

---

## 11. 实测记录与待验证项

### 11.1 已实测（2026-10-31，无 Key 探活，零费用）

| 端点 | 结果 |
| :--- | :--- |
| `POST /openapi/v2/query` | HTTP 200，扁平结构，`errorCode=806` |
| `POST /openapi/v2/run/ai-app/{id}` | HTTP 200，空 nodeInfoList → `1101`；有 nodeInfoList → `901 webapp not exists` |
| `POST /openapi/v2/run/workflow/{id}` | HTTP 200，`errorCode=806`（证明端点存在） |
| `POST /openapi/v2/media/upload/binary` | HTTP 200，`{code:1,msg:"API Key不存在"}` |
| `POST /task/openapi/create` | HTTP 200，`{code:301,msg:"must not be null"}` |
| `POST /uc/openapi/accountStatus` | HTTP 200，`{code:806,...}`（证明端点存在，需 body.apiKey） |
| `POST https://www.runninghub.ai/openapi/v2/query` | 与 .cn 完全一致 |
| `POST https://llm.runninghub.cn/v1/chat/completions` | HTTP 401（唯一遵守 HTTP 语义的接口） |

### 11.2 待验证（拿到 Key 后优先做）

1. **价格**：每个候选端点的实际 `consumeMoney`，用来建我们的预估价格表。
2. **并发**：企业级-共享 Key 的实际并发上限（文档只说要联系扩容）。
3. ~~`/uc/openapi/accountStatus` 的成功返回结构~~ ✅ 已实测（2026-11-01，海外站）：
   `POST /uc/openapi/accountStatus`，header `Authorization: Bearer <API Key>` + body `{apiKey}`（body 必须带，缺了不认），
   返回 `{"code":0,"msg":"success","data":{"remainCoins":"10351","currentTaskCounts":"0","remainMoney":null,"currency":null,"apiType":"NORMAL"}}`。
   `currentTaskCounts` 是该账号此刻在跑的任务数（含别人用同一个 Key 跑的），`remainCoins` 是剩余 RH 币（账户积分）。
   两者都已接入（`server/runninghub.js` 的 `rhLiveUsage`）：前者给管理面板显示真实并发，后者既给管理面板显示余额，
   也作为「余额多的 Key 优先」路由的依据（`rankKeys`）；用时读的是后台刷新的内存快照，不会在提交任务时额外打这个接口。
   顺带实测：网页端的 `POST /api/billing/usage/wideDetails` 用 API Key 调返回 `{"code":412,"msg":"TOKEN_INVALID"}`，它只认浏览器登录 token。
4. **模型 API 是否支持 `webhookUrl`**（文档只在工作流 API 提到）。
5. **`.cn` / `.ai` 的 Key 是否互通**。
6. **参考素材上限**：多图参考端点（`imageUrls[]`）最多几张、单张多大。
7. **`/openapi/v2/run/workflow/{id}` 是否支持 `retainSeconds` / `webhookUrl`**（V2 未文档化）。
8. **审核口径**：`1505 禁止真人` 的触发边界（我们的产品大量涉及真人参考图，这条最可能挡路）。

---

## 12. 附录：标准模型 API 全量端点（261）

> 数据来源：2026-10-31 逐页拉取 `runninghub-api-doc-cn` 的 261 个模型 API 页面并解析 OpenAPI 定义。`必填参数` 取自各端点的 `required` 数组，超过 8 个的截断。
> 路径省略公共前缀 `https://www.runninghub.cn/openapi/v2/`。

### 图像生成与处理/text-to-image（41）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/qwen-image-2.0-pro/text-to-image` | 千问2.0Pro-文生图 | prompt |
| `alibaba/qwen-image-2.0/text-to-image` | 千问2.0-文生图 | prompt |
| `alibaba/wan-2.5-preview/text-to-image` | 万相2.5 Preview 文生图 | prompt, size |
| `alibaba/wan-2.7/text-to-image` | 万相2.7-文生图 | prompt |
| `alibaba/wan-2.7/text-to-image-pro` | 万相2.7-文生图Pro | prompt |
| `bytedance/jimeng-4.6/text-to-image` | 即梦图片 4.6 文生图 | prompt |
| `rhart-image-g-1.5-official/text-to-image` | 全能图片G-1.5-文生图-官方稳定版 | prompt, size, quality |
| `rhart-image-g-1.5/text-to-image-[Deprecated]` | 全能图片G-1.5-文生图-低价渠道版-(已下架) 可用全能图片G-2 模型代替 | prompt, aspectRatio |
| `rhart-image-g-2-official/text-to-image` | 全能图片G-2-文生图-官方稳定版 | prompt, resolution, quality |
| `rhart-image-g-2/text-to-image` | 全能图片G-2.0-文生图-低价渠道版 | prompt |
| `rhart-image-g/text-to-image` | 全能图片X-文生图-低价渠道版 | model, prompt |
| `rhart-image-n-g31-flash-official/text-to-image` | 全能图片V2-文生图-官方稳定版 | prompt, resolution |
| `rhart-image-n-g31-flash/text-to-image` | 全能图片V2-文生图-低价渠道版 | prompt, resolution |
| `rhart-image-n-pro-official/text-to-image` | 全能图片PRO-文生图-官方稳定版 | resolution, prompt |
| `rhart-image-n-pro-official/text-to-image-ultra` | 全能图片PRO-文生图Ultra-官方稳定版 | prompt, resolution |
| `rhart-image-n-pro/text-to-image` | 全能图片PRO-文生图-低价渠道版 | prompt, resolution |
| `rhart-image-v1-official/text-to-image` | 全能图片V1-文生图-官方稳定版 | prompt, aspectRatio |
| `rhart-image-v1/text-to-image` | 全能图片V1-文生图-低价渠道版 | prompt, aspectRatio |
| `rhart-image-x-official/text-to-image` | 全能图片X-文生图片-官方稳定版 | prompt, outputFormat |
| `rhart-image/f-2-dev/text-to-image` | f-2-dev/text-to-image | — |
| `rhart-image/f-2-dev/text-to-image-lora` | f-2-dev/text-to-image-lora | — |
| `rhart-image/f-2-klein-4b/text-to-image` | f-2-klein-4b/text-to-image | — |
| `rhart-image/f-2-klein-4b/text-to-image-lora` | f-2-klein-4b/text-to-image-lora | — |
| `rhart-image/f-2-klein-9b/text-to-image` | f-2-klein-9b/text-to-image | — |
| `rhart-image/f-2-klein-9b/text-to-image-lora` | f-2-klein-9b/text-to-image-lora | — |
| `rhart-image/f-dev` | f-dev | — |
| `rhart-image/f-dev-lora` | f-dev-lora | — |
| `rhart-image/f-krea-dev-lora` | f-krea-dev-lora | — |
| `rhart-image/qwen-image/text-to-image-2512` | qwen-image/text-to-image-2512 | — |
| `rhart-image/qwen-image/text-to-image-2512-lora` | qwen-image/text-to-image-2512-lora | — |
| `rhart-image/z-image/turbo` | z-image/turbo | — |
| `rhart-image/z-image/turbo-lora` | z-image/turbo-lora | — |
| `rhart-imagine-image-quality/text-to-image` | 全能图片X-高质量文生图-官方稳定版 | prompt, resolution, numImages |
| `rhart-video/wan-2.2/text-to-image-lora` | wan-2.2/text-to-image-lora | — |
| `seedream-v4.5/text-to-image` | seedream-v4.5-文生图 | prompt |
| `seedream-v4/text-to-image` | seedream-v4-文生图 | prompt |
| `seedream-v5-lite/text-to-image` | seedream-v5-lite-文生图 | prompt |
| `youchuan/text-to-image-niji6` | 悠船文生图-niji6 | prompt |
| `youchuan/text-to-image-niji7` | 悠船文生图-niji7 | prompt |
| `youchuan/text-to-image-v61` | 悠船文生图-v61 | prompt |
| `youchuan/text-to-image-v7` | 悠船文生图-v7 | prompt |

### 图像生成与处理/image-to-image（34）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/qwen-image-2.0-pro/image-edit` | 千问2.0Pro-图像编辑 | imageUrls |
| `alibaba/qwen-image-2.0/image-edit` | 千问2.0-图像编辑 | imageUrls, prompt |
| `alibaba/wan-2.5-preview/image-to-image` | 万相2.5 Preview 图生图 | prompt, imageUrls |
| `bytedance/jimeng-4.6/image-to-image` | 即梦图片 4.6 图生图 | prompt, imageUrls |
| `rhart-image-g-1.5-official/image-to-image` | 全能图片G-1.5-图生图-官方稳定版 | prompt, imageUrls, size, quality |
| `rhart-image-g-1.5/edit-[Deprecated]` | 全能图片G-1.5-图生图-低价渠道版-(已下架) 可用全能图片G-2 模型代替 | prompt, imageUrls, aspectRatio |
| `rhart-image-g-2-official/image-to-image` | 全能图片G-2-图生图-官方稳定版 | prompt, imageUrls, resolution, quality |
| `rhart-image-g-2/image-to-image` | 全能图片G-2.0-图生图-低价渠道版 | prompt, imageUrls |
| `rhart-image-g/image-to-image` | 全能图片X-图生图-低价渠道版 | model, prompt |
| `rhart-image-n-g31-flash-official/image-to-image` | 全能图片V2-图生图-官方稳定版 | imageUrls, prompt, resolution |
| `rhart-image-n-g31-flash/image-to-image` | 全能图片V2-图生图-低价渠道版 | imageUrls, prompt, resolution |
| `rhart-image-n-pro-official/edit` | 全能图片PRO-图生图-官方稳定版 | imageUrls, prompt, resolution |
| `rhart-image-n-pro-official/edit-ultra` | 全能图片PRO-图生图Ultra-官方稳定版 | imageUrls, prompt, resolution |
| `rhart-image-n-pro/edit` | 全能图片PRO-图生图-低价渠道版 | imageUrls, prompt, resolution |
| `rhart-image-v1-official/edit` | 全能图片V1-图生图-官方稳定版 | prompt, aspectRatio, imageUrls |
| `rhart-image-v1/edit` | 全能图片V1-图生图-低价渠道版 | prompt, aspectRatio, imageUrls |
| `rhart-image-x-official/edit` | 全能图片X-图片编辑-官方稳定版 | prompt, image |
| `rhart-image/f-2-dev/edit` | f-2-dev/edit | — |
| `rhart-image/f-2-dev/edit-lora` | f-2-dev/edit-lora | — |
| `rhart-image/f-2-klein-4b/edit` | f-2-klein-4b/edit | — |
| `rhart-image/f-2-klein-4b/edit-lora` | f-2-klein-4b/edit-lora | — |
| `rhart-image/f-2-klein-9b/edit` | f-2-klein-9b/edit | — |
| `rhart-image/qwen-image/edit-2511` | qwen-image/edit-2511 | — |
| `rhart-image/qwen-image/edit-2511-lora` | qwen-image/edit-2511-lora | — |
| `rhart-image/z-image-turbo/image-to-image` | z-image-turbo/image-to-image | — |
| `rhart-image/z-image-turbo/image-to-image-lora` | z-image-turbo/image-to-image-lora | — |
| `rhart-imagine-image-quality/edit` | 全能图片X-高质量图片编辑-官方稳定版 | prompt, imageUrl, resolution, numImages |
| `rhart-video/f-kontext/dev-lora` | f-kontext-dev-lora | — |
| `rhart-video/wan-2.2/image-to-image` | wan-2.2/image-to-image | — |
| `seedream-v4.5/image-to-image` | seedream-v4.5-图生图 | prompt, imageUrls |
| `seedream-v4/image-to-image` | seedream-v4-图生图 | prompt, imageUrls |
| `seedream-v5-lite/image-to-image` | seedream-v5-lite-图生图 | prompt, imageUrls |
| `youchuan/text-to-image-v6` | 悠船文生图-v6 | prompt |
| `youchuan/text-to-image-v81` | 悠船文生图-v8.1 | prompt, hd |

### 图像生成与处理/image-tools（2）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/wan-2.7/image-edit` | 万相2.7-图像编辑 | imageUrls, prompt |
| `alibaba/wan-2.7/image-edit-pro` | 万相2.7-图像编辑Pro | imageUrls, prompt |

### 图像生成与处理/reference-to-image（1）

> 平台把这个端点归到了图像类，实际是视频端点，属于上游分类错误，以路径为准。

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `vidu/reference-to-video-q2-pro` | Vidu-参考生视频-q2-pro | prompt |

### 视频生成与处理/text-to-video（45）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/happyhorse-1.0/text-to-video` | happyhorse-1.0/text-to-video | prompt, resolution, duration |
| `alibaba/wan-2.5-preview/text-to-video` | 万相2.5 Preview 文生视频 | prompt, duration, size |
| `alibaba/wan-2.6/text-to-video` | 万相2.6-文生视频 | prompt, duration, resolution, shotType |
| `alibaba/wan-2.7/text-to-video` | 万相2.7-文生视频 | prompt, duration, resolution, aspectRatio |
| `kling-v2.5-turbo-pro/text-to-video` | 可灵文生视频2.5-turbo-pro | prompt, duration, aspectRatio |
| `kling-v2.5-turbo-std/text-to-video` | 可灵文生视频2.5-turbo-std | prompt, duration, aspectRatio |
| `kling-v2.6-pro/text-to-video` | 可灵文生视频2.6-pro | prompt, sound, aspectRatio, duration |
| `kling-v3-4k/text-to-video` | 可灵文生视频v3-4k | prompt, duration |
| `kling-v3.0-pro/text-to-video` | 可灵文生视频3.0-pro | prompt, duration, sound |
| `kling-v3.0-std/text-to-video` | 可灵文生视频3.0-std | prompt, duration, sound |
| `kling-video-o1/text-to-video` | 可灵文生视频o1 | aspectRatio, duration, mode |
| `kling-video-o3-4k/text-to-video` | 可灵文生视频o3-4k | prompt, duration |
| `kling-video-o3-pro/text-to-video` | 可灵文生视频o3-pro | prompt, sound, duration |
| `kling-video-o3-std/text-to-video` | 可灵文生视频o3-std | prompt, sound, duration |
| `minimax/hailuo-02/pro` | 海螺-02-pro | prompt, enablePromptExpansion, duration |
| `minimax/hailuo-02/t2v-pro` | 海螺-02-文生视频-pro | prompt, enablePromptExpansion |
| `minimax/hailuo-02/t2v-standard` | 海螺-02-文生视频-标准 | prompt, enablePromptExpansion, duration |
| `minimax/hailuo-2.3/t2v-pro` | 海螺-2.3-文生视频-pro | prompt, enablePromptExpansion |
| `minimax/hailuo-2.3/t2v-standard` | 海螺-2.3-文生视频-标准 | prompt, enablePromptExpansion, duration |
| `pixverse-v6/text-to-video` | PixVerse V6 文生视频 | prompt, resolution, duration, generateAudioSwitch |
| `rhart-video-g-official/text-to-video` | 全能视频X-文生视频-官方稳定版 | prompt, aspectRatio, resolution, duration |
| `rhart-video-g/text-to-video` | 全能视频X-文生视频-低价渠道版-v1.5 | prompt, aspectRatio, resolution, duration |
| `rhart-video-s-official/text-to-video` | 全能视频S-文生视频-官方稳定版 | prompt, size, duration |
| `rhart-video-s/text-to-video` | 全能视频S-文生视频-低价渠道版 | duration, prompt, aspectRatio |
| `rhart-video-s/text-to-video-pro-deprecated` | 全能视频S-文生视频-pro-低价渠道版-已下架 | prompt, duration, aspectRatio |
| `rhart-video-v3.1-fast-official/text-to-video` | 全能视频V3.1-fast-文生视频-官方稳定版 | prompt, duration, resolution, generateAudio |
| `rhart-video-v3.1-fast-official/video-extend` | 全能视频V3.1-fast-视频扩展-官方稳定版 | video, resolution |
| `rhart-video-v3.1-fast/text-to-video` | 全能视频V3.1-fast-文生视频-低价渠道版 | prompt, aspectRatio, resolution |
| `rhart-video-v3.1-lite-official/start-end-to-video` | 全能视频V3.1-Lite首尾帧生视频-官方稳定版 | prompt, firstImageUrl, lastImageUrl, resolution |
| `rhart-video-v3.1-lite-official/text-to-video` | 全能视频V3.1-Lite文生视频-官方稳定版 | prompt, resolution, duration |
| `rhart-video-v3.1-pro-official/text-to-video` | 全能视频V3.1-pro-文生视频-官方稳定版 | prompt, duration, resolution, generateAudio |
| `rhart-video-v3.1-pro-official/video-extend` | 全能视频V3.1-pro-视频扩展-官方稳定版 | video, resolution |
| `rhart-video-v3.1-pro/text-to-video` | 全能视频V3.1-pro-文生视频-低价渠道版 | prompt, aspectRatio, resolution |
| `rhart-video/ltx-2.3/text-to-video` | ltx-2.3/text-to-video | — |
| `rhart-video/ltx-2.3/text-to-video-lora` | ltx-2.3/text-to-video-lora | — |
| `rhart-video/sparkvideo-2.0-fast/text-to-video` | seedance2.0-Fast/文生视频 | prompt, resolution, duration |
| `rhart-video/sparkvideo-2.0/text-to-video` | seedance2.0/文生视频 | prompt, resolution, duration |
| `rhart-video/wan-2.2/text-to-video` | 万相2.2-文生视频 | — |
| `seedance-v1.5-pro/text-to-video` | seedance-v1.5-pro-text-to-video | prompt, aspectRatio, duration, resolution, generateAudio, cameraFixed |
| `seedance-v1.5-pro/text-to-video-fast` | seedance-v1.5-pro-text-to-video-fast | prompt, aspectRatio, duration, resolution, generateAudio, cameraFixed |
| `skyreels-v4/text-to-video-fast` | SkyReels V4 文生视频-fast | prompt, promptOptimizer, resolution |
| `skyreels-v4/text-to-video-std` | SkyReels V4 文生视频-std | prompt, sound, promptOptimizer, resolution |
| `vidu/text-to-video` | Vidu-文生视频-q2 | prompt, style, aspectRatio, resolution, movementAmplitude, duration |
| `vidu/text-to-video-q3-pro` | Vidu-文生视频-q3-pro | prompt, style, aspectRatio, resolution, duration, audio |
| `vidu/text-to-video-q3-turbo` | Vidu-文生视频-q3-turbo | prompt, style, aspectRatio, resolution, duration, audio |

### 视频生成与处理/image-to-video（65）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/happyhorse-1.0/image-to-video` | happyhorse-1.0/image-to-video | imageUrl, resolution, duration |
| `alibaba/wan-2.5-preview/image-to-video` | 万相2.5 Preview 图生视频 | imageUrl, duration, resolution |
| `alibaba/wan-2.6/image-to-video` | 万相2.6-图生视频 | imageUrl, resolution, duration, shotType |
| `alibaba/wan-2.6/image-to-video-flash` | 万相2.6-图生视频Flash | prompt, imageUrl, resolution, duration, shotType, enablePromptExpansion, enableAudio |
| `alibaba/wan-2.6/reference-to-video` | 万相2.6-参考生视频 | prompt, size, duration |
| `alibaba/wan-2.6/reference-to-video-flash` | 万相2.6-参考生视频Flash | prompt, size, duration, audio |
| `alibaba/wan-2.7/image-to-video` | 万相2.7-图生视频 | firstImageUrl, resolution, duration |
| `kling-elements` | kling-elements | name, description, imageUrl, elementReferList |
| `kling-v2.5-turbo-pro/image-to-video` | 可灵图生视频2.5-turbo-pro | duration, firstImageUrl |
| `kling-v2.5-turbo-std/image-to-video` | 可灵图生视频2.5-turbo-std | prompt, duration, firstImageUrl |
| `kling-v2.6-pro/image-to-video` | 可灵图生视频2.6-pro | prompt, imageUrl, sound, duration |
| `kling-v3-4k/image-to-video` | 可灵图生视频v3-4k | imageUrl, duration |
| `kling-v3.0-pro/image-to-video` | 可灵图生视频3.0-pro | prompt, firstImageUrl, duration, sound |
| `kling-v3.0-std/image-to-video` | 可灵图生视频3.0-std | prompt, firstImageUrl, duration, sound |
| `kling-video-o1/image-to-video` | 可灵图生视频o1 | aspectRatio, duration, firstImageUrl, mode |
| `kling-video-o1/start-to-end` | 可灵首尾帧生视频o1 | aspectRatio, duration, firstImageUrl, lastImageUrl, mode |
| `kling-video-o3-4k/image-to-video` | 可灵图生视频o3-4k | prompt, firstImageUrl, duration |
| `kling-video-o3-pro/image-to-video` | 可灵图生视频o3-pro | prompt, firstImageUrl, duration, sound |
| `kling-video-o3-std/image-to-video` | 可灵图生视频o3-std | prompt, firstImageUrl, duration, sound |
| `minimax/hailuo-02/fast` | 海螺-02-fast | enablePromptExpansion, imageUrl, duration |
| `minimax/hailuo-02/i2v-pro` | 海螺-02-图生视频-pro | enablePromptExpansion, firstImageUrl |
| `minimax/hailuo-02/i2v-standard` | 海螺-02-图生视频-标准 | enablePromptExpansion, firstImageUrl, duration |
| `minimax/hailuo-02/standard` | 海螺-02-标准 | prompt, enablePromptExpansion, duration |
| `minimax/hailuo-2.3-fast-pro/image-to-video` | 海螺-2.3-fast-pro-图生视频 | prompt, enablePromptExpansion, imageUrl, duration |
| `minimax/hailuo-2.3-fast/image-to-video` | 海螺-2.3-fast-图生视频 | prompt, enablePromptExpansion, imageUrl, duration |
| `minimax/hailuo-2.3/i2v-standard` | 海螺-2.3-图生视频-标准 | enablePromptExpansion, imageUrl, duration |
| `minimax/hailuo-2.3/image-to-video-pro` | 海螺-2.3-图生视频-pro | enablePromptExpansion, imageUrl |
| `pixverse-v6/image-to-video` | PixVerse V6 图生视频 | imageUrl, prompt, resolution, duration, generateAudioSwitch |
| `rhart-video-g-official/image-to-video` | 全能视频X-图生视频-官方稳定版 | prompt, imageUrl, resolution, duration |
| `rhart-video-g/image-to-video` | 全能视频X-图生视频-低价渠道版-v1.5 | prompt, aspectRatio, resolution, duration |
| `rhart-video-s-official/image-to-video` | 全能视频S-图生视频-官方稳定版 | prompt, duration, imageUrl |
| `rhart-video-s-official/image-to-video-pro` | 全能视频S-图生视频-pro-官方稳定版 | prompt, resolution, duration, imageUrl |
| `rhart-video-s-official/image-to-video-realistic` | 全能视频S-图生视频-支持真人-官方稳定版 | prompt, duration, imageUrl |
| `rhart-video-s-official/text-to-video-pro` | 全能视频S-文生视频-pro-官方稳定版 | prompt, size, duration |
| `rhart-video-s/image-to-video` | 全能视频S-图生视频-低价渠道版 | imageUrl, duration, aspectRatio, prompt |
| `rhart-video-s/image-to-video-pro-deprecated` | 全能视频S-图生视频-pro-低价渠道版-已下架 | prompt, imageUrl, duration, aspectRatio |
| `rhart-video-v3.1-fast-official/image-to-video` | 全能视频V3.1-fast-图生视频-官方稳定版 | prompt, imageUrl, resolution, duration, generateAudio |
| `rhart-video-v3.1-fast/image-to-video` | 全能视频V3.1-fast-图生视频-低价渠道版 | prompt, aspectRatio, imageUrls, resolution |
| `rhart-video-v3.1-fast/start-end-to-video` | 全能视频V3.1-fast-首尾帧生视频-低价渠道版 | prompt, firstFrameUrl, aspectRatio, resolution |
| `rhart-video-v3.1-lite-official/image-to-video` | 全能视频V3.1-Lite图生视频-官方稳定版 | prompt, imageUrl, duration, resolution |
| `rhart-video-v3.1-pro-official/image-to-video` | 全能视频V3.1-pro-图生视频-官方稳定版 | prompt, imageUrl, resolution, duration, generateAudio |
| `rhart-video-v3.1-pro-official/reference-to-video` | 全能视频V3.1-pro-参考生视频-官方稳定版 | prompt, imageUrls, resolution, generateAudio |
| `rhart-video-v3.1-pro/image-to-video` | 全能视频V3.1-pro-图生视频-低价渠道版 | prompt, aspectRatio, imageUrl, resolution |
| `rhart-video-v3.1-pro/start-end-to-video` | 全能视频V3.1-pro-首尾帧生视频-低价渠道版 | prompt, firstFrameUrl, aspectRatio, resolution |
| `rhart-video/ltx-2.3/image-to-video` | ltx-2.3/image-to-video | — |
| `rhart-video/ltx-2.3/image-to-video-lora` | ltx-2.3/image-to-video-lora | — |
| `rhart-video/sparkvideo-2.0-fast/image-to-video` | seedance2.0-Fast/图生视频 | resolution, duration, firstFrameUrl |
| `rhart-video/sparkvideo-2.0/image-to-video` | seedance2.0/图生视频 | resolution, duration, firstFrameUrl |
| `rhart-video/wan-2.2/image-to-video` | 万相2.2-图生视频 | — |
| `rhart-video/wan-2.2/start-to-end` | 万相2.2-首尾帧生视频 | — |
| `seedance-v1.5-pro/image-to-video` | seedance-v1.5-pro-image-to-video | prompt, firstImageUrl, aspectRatio, duration, resolution, generateAudio, cameraFixed |
| `seedance-v1.5-pro/image-to-video-fast` | seedance-v1.5-pro-image-to-video-fast | prompt, firstImageUrl, aspectRatio, duration, resolution, generateAudio, cameraFixed |
| `skyreels-v4/image-to-video-fast` | SkyReels V4 图生视频-fast | prompt, firstImageUrl, promptOptimizer, resolution |
| `skyreels-v4/image-to-video-std` | SkyReels V4 图生视频-std | prompt, firstImageUrl, sound, promptOptimizer, resolution |
| `vidu/image-to-video-q2-pro` | Vidu-图生视频-q2-pro | prompt, imageUrl, duration, resolution, movementAmplitude, bgm |
| `vidu/image-to-video-q2-pro-fast` | Vidu-图生视频-q2-pro-fast | prompt, imageUrl, duration, resolution, movementAmplitude, bgm |
| `vidu/image-to-video-q2-turbo` | Vidu-图生视频-q2-turbo | prompt, imageUrl, duration, resolution, movementAmplitude, bgm |
| `vidu/image-to-video-q3-pro` | Vidu-图生视频-q3-pro | prompt, imageUrl, duration, resolution, audio |
| `vidu/image-to-video-q3-turbo` | Vidu-图生视频-q3-turbo | prompt, imageUrl, duration, resolution, audio |
| `vidu/start-end-to-video-q2-pro` | Vidu-首尾帧生视频-q2-pro | prompt, firstImageUrl, lastImageUrl, duration, resolution, movementAmplitude, bgm |
| `vidu/start-end-to-video-q2-pro-fast` | Vidu-首尾帧生视频-q2-pro-fast | prompt, firstImageUrl, lastImageUrl, duration, resolution, movementAmplitude, bgm |
| `vidu/start-end-to-video-q2-turbo` | Vidu-首尾帧生视频-q2-turbo | prompt, firstImageUrl, lastImageUrl, duration, resolution, movementAmplitude, bgm |
| `vidu/start-end-to-video-q3-pro` | Vidu-首尾帧生视频-q3-pro | prompt, firstImageUrl, lastImageUrl, duration, resolution, movementAmplitude, audio |
| `vidu/start-end-to-video-q3-turbo` | Vidu-首尾帧生视频-q3-turbo | prompt, firstImageUrl, lastImageUrl, duration, resolution, movementAmplitude, audio |
| `youchuan/image-to-video` | 悠船图生视频 | prompt, firstImageUrl, resolution |

### 视频生成与处理/reference-to-video（16）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/happyhorse-1.0/reference-to-video` | happyhorse-1.0/reference-to-video | prompt, imageUrls, resolution, duration |
| `alibaba/wan-2.7/reference-to-video` | 万相2.7-参考生视频 | prompt, resolution, duration, aspectRatio |
| `kling-video-o1-std/refrence-to-video` | 可灵参考生视频o1 | mode, prompt, aspectRatio, duration, keepOriginalSound |
| `kling-video-o3-4k/reference-to-video` | 可灵参考生视频o3-4k | prompt, duration |
| `kling-video-o3-pro/reference-to-video` | kling-video-o3-pro/reference-to-video | prompt, keepOriginalSound, duration |
| `kling-video-o3-std/reference-to-video` | kling-video-o3-std/reference-to-video | prompt, keepOriginalSound, duration |
| `rhart-video-g-official/reference-to-video` | 全能视频X-多图参考生视频-官方稳定版 | imageUrls, prompt, duration, resolution |
| `rhart-video-v3.1-fast-official/reference-to-video` | 全能视频V3.1-fast-参考生视频-官方稳定版 | prompt, imageUrls, resolution |
| `rhart-video/sparkvideo-2.0-fast/multimodal-video` | seedance2.0-Fast/多模态视频 | prompt, resolution, duration |
| `rhart-video/sparkvideo-2.0/multimodal-video` | seedance2.0/多模态视频 | prompt, resolution, duration |
| `seedance-v1-lite/reference-to-video` | seedance-v1-lite-reference-to-video | prompt, imageUrls, duration, cameraFixed, resolution, aspectRatio |
| `skyreels-v4/omni-reference-fast` | SkyReels V4 Omni 参考视频-fast | prompt, resolution |
| `skyreels-v4/omni-reference-std` | SkyReels V4 Omni 参考视频-std | prompt, sound, resolution |
| `vidu/reference-to-video-q2` | Vidu-参考生视频-q2 | prompt, imageUrls, aspectRatio, resolution, duration, movementAmplitude |
| `vidu/reference-to-video-q3` | Vidu-参考生视频-q3 | prompt, imageUrls, duration, resolution |
| `vidu/reference-to-video-q3-mix` | Vidu-参考生视频-q3-mix | prompt, imageUrls, duration, resolution |

### 视频生成与处理/video-edit（6）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/happyhorse-1.0/video-edit` | happyhorse-1.0/video-edit | videoUrl, prompt, resolution |
| `alibaba/wan-2.7/video-edit` | 万相2.7-视频编辑 | prompt, imageUrls, resolution, duration, aspectRatio |
| `kling-video-o1-std/edit-video` | 可灵视频编辑o1 | mode, prompt, videoUrl, keepOriginalSound |
| `kling-video-o3-pro/video-edit` | kling-video-o3-pro/video-edit | prompt, videoUrl, keepOriginalSound |
| `kling-video-o3-std/video-edit` | kling-video-o3-std/video-edit | prompt, videoUrl, keepOriginalSound |
| `rhart-video-g-official/edit-video` | 全能视频X-编辑视频-官方稳定版 | prompt, videoUrl, resolution |

### 视频生成与处理/video-extend（2）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `alibaba/wan-2.7/video-extend` | 万相2.7-视频续写 | videoUrl, resolution, duration |
| `rhart-video-g-official/video-extend` | 全能视频X-视频续写-官方稳定版 | videoUrl, prompt, duration |

### 视频生成与处理/video-tools（8）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `kling-elements-advanced` | 可灵 o3 创建主体 | elementName, elementDescription, referenceType |
| `pixverse-v6/extend` | PixVerse V6 视频续写 | prompt, videoUrl, resolution, duration, generateAudioSwitch |
| `pixverse-v6/transition` | PixVerse V6 转场 | prompt, firstImageUrl, endImageUrl, resolution, duration, generateAudioSwitch, generateMultiClipSwitch |
| `rhart-video-s/sora-upload-character` | 全能视频S-角色上传-低价渠道版 | videoUrl |
| `rhart-video/video-fps-increaser` | RH视频帧率增强 | videoUrl |
| `rhart-video/video-upscaler` | RH视频超分 | videoUrl, targetResolution |
| `volc-subtitle-erase-pro/video` | 火山字幕擦除-视频字幕擦除（精细化版） | videoUrl |
| `volc-subtitle-erase/video` | 火山字幕擦除-视频字幕擦除（标准版） | videoUrl |

### 视频生成与处理/motion-control（5）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `bytedance/dreamactor-v2` | 即梦/动作模仿2.0 | imageUrl, videoUrl |
| `kling-v2.6-pro/motion-control` | kling-v2.6-pro-动作控制 | imageUrl, videoUrl, characterOrientation |
| `kling-v2.6-std/motion-control` | kling-v2.6-std-动作控制 | imageUrl, videoUrl, characterOrientation |
| `kling-v3.0-pro/motion-control` | 可灵动作控制V3.0-pro | imageUrl, videoUrl, characterOrientation |
| `kling-v3.0-std/motion-control` | 可灵动作控制V3.0-std | imageUrl, videoUrl, characterOrientation |

### 视频生成与处理/video-to-video（1）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `rhart-video/wan2.2/character-motion-transfer` | 万相 2.2 角色动作迁移 | — |

### 视频生成与处理/audio-to-video（2）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `kling-lip-sync/identify-face` | 可灵对口型-人脸识别 | — |
| `kling-lip-sync/lip-sync-video` | 可灵对口型-视频生成 | sessionId, faceId, soundStartTime, soundEndTime, soundInsertTime |

### 音频生成与处理/text-to-audio（11）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `kling-lip-sync/tts` | 可灵对口型-语音合成 | text, voiceId, voiceLanguage |
| `minimax/music-2.6/text-to-instrumental` | MiniMax Music 2.6 纯音乐生成 | prompt |
| `minimax/music-2.6/text-to-music` | MiniMax Music 2.6 文生音乐 | lyrics |
| `rhart-audio/text-to-audio/music-2.5` | minimax/music-2.5 | prompt, lyrics |
| `rhart-audio/text-to-audio/speech-02-hd` | minimax/speech-02-hd | text, voice_id, enable_base64_output, english_normalization |
| `rhart-audio/text-to-audio/speech-02-turbo` | minimax/speech-02-turbo | text, voice_id, enable_base64_output, english_normalization |
| `rhart-audio/text-to-audio/speech-2.6-hd` | minimax/speech-2.6-hd | text, voice_id, enable_base64_output, english_normalization |
| `rhart-audio/text-to-audio/speech-2.6-turbo` | minimax/speech-2.6-turbo | text, voice_id, enable_base64_output, english_normalization |
| `rhart-audio/text-to-audio/speech-2.8-hd` | minimax/speech-2.8-hd | text, voice_id, enable_base64_output, english_normalization |
| `rhart-audio/text-to-audio/speech-2.8-turbo` | minimax/speech-2.8-turbo | text, voice_id, enable_base64_output, english_normalization |
| `rhart-audio/text-to-audio/voice-clone` | minimax/voice-clone | audio, custom_voice_id, text, need_noise_reduction, need_volume_normalization, model |

### 音频生成与处理/text-to-music（6）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `rhart-audio/suno-v4.5/custom` | suno-custom-v4.5 | title, prompt, tags |
| `rhart-audio/suno-v4.5/single` | suno-single-v4.5 | description |
| `rhart-audio/suno-v5.5/custom` | suno-custom-v5.5 | title, prompt, tags |
| `rhart-audio/suno-v5.5/single` | suno-single-v5.5 | description |
| `rhart-audio/suno-v5/custom` | suno-custom-v5 | title, prompt, tags |
| `rhart-audio/suno-v5/single` | suno-single-v5 | description |

### 音频生成与处理/text-to-lyrics（1）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `rhart-audio/suno/lyrics` | suno-歌词生成 | prompt |

### 音频生成与处理/video-to-audio（3）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `rhart-audio/extract-background` | 分离音频-Other | — |
| `rhart-audio/extract-vocal` | 分离音频-Vocals | — |
| `rhart-audio/source-separation` | 分离音频 | — |

### 3D 生成与处理/text-to-3D（1）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `hunyuan3d-v3.1/text-to-3d` | 混元文生3D模型v3.1 | prompt, enablePbr, generateType |

### 3D 生成与处理/image-to-3D（11）

| 端点 | 名称 | 必填参数 |
| :--- | :--- | :--- |
| `hitem3d-portrait-v15/image-to-3d` | hitem3d-portrait-v15/image-to-3d | requestType, imageUrl, resolution |
| `hitem3d-portrait-v15/multi-image-to-3d` | hitem3d-portrait-v15/multi-image-to-3d | requestType, frontImageUrl, resolution |
| `hitem3d-portrait-v20/image-to-3d` | hitem3d-portrait-v20/image-to-3d | requestType, imageUrl, resolution |
| `hitem3d-portrait-v20/multi-image-to-3d` | hitem3d-portrait-v20/multi-image-to-3d | requestType, frontImageUrl, resolution |
| `hitem3d-portrait-v21/image-to-3d` | hitem3d-portrait-v21/image-to-3d | requestType, imageUrl, resolution |
| `hitem3d-portrait-v21/multi-image-to-3d` | hitem3d-portrait-v21/multi-image-to-3d | requestType, frontImageUrl, resolution |
| `hitem3d-v15/image-to-3d` | hitem3d-v15/image-to-3d | requestType, imageUrl, resolution |
| `hitem3d-v15/multi-image-to-3d` | hitem3d-v15/multi-image-to-3d | requestType, frontImageUrl, resolution |
| `hitem3d-v2/image-to-3d` | hitem3d-v2/image-to-3d | requestType, imageUrl, resolution |
| `hitem3d-v2/multi-image-to-3d` | hitem3d-v2/multi-image-to-3d | requestType, frontImageUrl, resolution |
| `hunyuan3d-v3.1/image-to-3d` | 混元图生3D模型v3.1 | enablePbr, generateType, imageUrl |