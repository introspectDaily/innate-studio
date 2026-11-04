# RunningHub 工作流：接入方式

> 这份说的是**怎么接**（登记表、Key、槽位、机器档位）。平台本身的接口调研在 `docs/runninghub-api.md`。

## 为什么不是「通用接入」

RunningHub 有两类能力：

| | 标准模型 API | 工作流 API |
| :--- | :--- | :--- |
| 入参 | 语义化字段（`prompt`、`duration`、`imageUrl`） | `nodeInfoList`：节点 ID + 字段名 + 字段值 |
| 能不能改结构 | 不能 | **不能** |

还有第三类 **AI 应用**（`ai-app`）：平台把工作流包成带表单的产品页，入参同样是 `nodeInfoList`，
但提交端点、字段值类型和请求体都不一样，见下面「AI 应用」一节。

工作流 API 只能**替换某个节点某个字段的值**，不能增删节点、不能改连线。所以：

- 「原始工作流收 3 张图，我们只想收 2 张」这件事，API 层做不到让第 3 个 `LoadImage` 消失。
  不在 `nodeInfoList` 里传它，它就会用工作流里存着的那张图（通常是你导出时用的测试图）。
- 「这个工作流该开放哪几个参数」平台也不会告诉我们（只有 AI 应用有 `apiCallDemo`，工作流没有）。

结论：**架构通用、登记表手工**。每个要接的工作流，人读一遍它的 API JSON，把该开放的东西登记到
`shared/runninghub.ts` 的 `RH_WORKFLOWS` 里，剩下的（表单、参数面板、画布节点、计费、轮询、落盘）全部复用现有链路。

想让槽位数真的变少，只有三条路：

1. 在 ComfyUI 里把那个位置改成可选分支（`Switch`、`ImpactConditionalBranch` 之类），另存一份，拿新的 `workflowId`；
2. 另存一个精简版工作流，在登记表里多加一条；
3. 用登记表的 `fill` 策略：空着的图片位用已经给的最后一张补上（默认 `last`），或者干脆不传（`skip`，只在那个位置本来可选时才对）。

第 3 条就是现在海螺 H3 那条的做法：`images` 三个槽位、`minImages: 2`、`fill: 'last'`。

## 登记一条工作流

照着现有那条改：

```ts
{
  key: 'hailuo-h3-swap',        // 内部 id，页面上的 uuid 是 rh:hailuo-h3-swap
  name: '海螺 H3 人物替换 v1.5',
  summary: '一句话说明，出现在选择卡片上',
  kind: 'video',                // video / image / audio：决定它出现在哪类节点的模型菜单里
  endpoint: 'workflow',         // workflow（默认，ComfyUI 工作流）/ ai-app（平台包装过的 AI 应用）
  images: [{ nodeId: '215', field: 'image', label: '角色卡' }],   // 素材位，按顺序填
  minImages: 2,                 // 至少要几张（少于这个数不提交）
  fill: 'last',                 // last / skip：空位怎么办
  videos: [{ nodeId: '286', field: 'video', label: '原视频' }],
  prompt: { nodeId: '248', field: 'value' },                     // 提示词写进哪个节点
  params: [ /* 枚举、数字、开关、文字 */ ],
  machines: ['default', 'plus', 'ultra'],
  estimate: { default: 0.5, plus: 1, ultra: 2 },                 // 每档机器的估价（元），预扣用
}
```

`kind` 决定这条工作流出现在哪儿：`image` 的工作流（比如 `text-to-image`）会和普通图片型号并列，出现在
**创作页「图片」类型的模型菜单**和**画布的图片节点**里；`video` / `audio` 同理。创作页选中它之后，提示词仍写在
主文本框，宽高、种子、每次出几张这类参数收进工具栏的「参数」面板，提交走工作流接口（不是 `/api/images`）。
只配了 RunningHub、没有火山图片 Key 的账号，「图片」这一类型也照样能进、能用。

`nodeId` / `field` 从哪来：RunningHub 上「导出 API」下载的那份 JSON，键是节点 ID，`inputs` 里的键是字段名。
注意看**哪个节点的输出是最终结果**，种子之类的参数要挂在最终那一遍采样的节点上（海螺 H3 里是 `205`，
不是预览那一遍的 `182`）。

`params` 的写法：

```ts
{ key: 'aspect_ratio', label: '画幅', nodeId: '209', field: 'aspect_ratio', type: 'enum',
  default: '16:9 (Widescreen)',
  choices: [{ label: '16:9 横屏', value: '16:9 (Widescreen)' }] }   // label 给页面，value 发给节点
{ key: 'steps', label: '采样步数', nodeId: '212', field: 'steps', type: 'int', min: 4, max: 20, default: 6 }
```

枚举一定要写 `value`，并且和原字段的类型完全一致（整数就发整数，字符串就发字符串）。

### AI 应用（`endpoint: 'ai-app'`）

`text-to-image`（文生图）这类不是自己导出的 ComfyUI 工作流，而是平台包装过的「AI 应用」：
提交端点是 `/openapi/v2/run/ai-app/{appId}`，不是 `/openapi/v2/run/workflow/{workflowId}`。
登记表里除了 `endpoint` 之外写法完全一样——`prompt` / `params` 仍然编译成同一套界面规则，
计费、Key 路由、轮询、下载也全部复用。差别由 `server/runninghub.js` 的 `submitWorkflow` 统一处理：

| | ComfyUI 工作流 | AI 应用 |
| :--- | :--- | :--- |
| 提交路径 | `/openapi/v2/run/workflow/{workflowId}` | `/openapi/v2/run/ai-app/{appId}` |
| `nodeInfoList` | 值保持原类型（数字就发数字） | 值一律转字符串、每项带 `description: null`（照平台示例 curl） |
| 额外请求字段 | `instanceType` | `instanceType` + `usePersonalQueue: "false"` |
| V2 挂了退回 V1 | `/task/openapi/create` | **不退回**：V1 要 19 位 `webappId` 的 integer，JS 转数字会丢精度 |

登记时按平台「导出 API」给的 curl 把节点抄进登记表，例如文生图这条：
`5.text` 提示词、`7.width` / `7.height` / `7.batch_size` 出图尺寸与张数、`6.seed` 随机种子；
查询示例里成图来自节点 `2`（`outputType: png`），所以 `outputNodes: ['2']`。

**种子不要写死默认值**：写死会导致每次生成都是同一张图。给参数加 `randomize: true` 且不写 `default`，
`rhPlan` 会在用户没填时现生成一个随机整数并写回 `inputs`（记录里留着，填回来就能复现）。
这条工作流的 `estimate: { default: 0.1 }` 只是未实测的占位估价，跑过几次按平台 `usage.consumeMoney` 校正。

### 工作流 ID 放哪

RunningHub 有**两个站点**：国内站 `runninghub.cn`、海外站 `runninghub.ai`。两个站是独立的产品——账号、
Key、工作流 ID、素材库都不通用，同一个工作流在两边导出的 ID 也不一样。所以 ID 是**按站点**配的。

登记在 `shared/runninghub-workflows.json`，随代码进 git，改了 ID 提交一次就能追溯。不用环境变量，也不用 `config.json`。格式：

```json
{
  "workflows": {
    "hailuo-h3-swap": { "ids": { "cn": "1904…", "ai": "2003…" }, "note": "…" },
    "text-to-image":  { "ids": { "ai": "2083580194556071937" }, "note": "AI 应用 appId" }
  }
}
```

- `key` 必须和 `shared/runninghub.ts` 里 `RH_WORKFLOWS` 的 `key` 一致；代码里用 `idsOf('<key>')` 把它挂到 `workflowId` 上。
- `ids.cn` 是国内站 `runninghub.cn`，`ids.ai` 是海外站 `runninghub.ai`。两站共用同一个 ID 就两个都填。
- `note` 写来源和注意事项，给以后的人看。
- 留空的站点不接单。管理面板「RunningHub 密钥池」里能看到它还缺哪一行（显示的是这个文件的路径）。

`endpoint: 'ai-app'` 时这个字段填的是 **AI 应用 id（webappId）**，不是工作流 id；管理面板会给这类工作流标一个「AI 应用」。
文生图那条的海外站 appId 已经登记在上面。国内站要另存一份应用，把 ID 填进 `cn`。

**一个站点配好就能用**：只有 `cn` 有 ID 的工作流只派给国内站的 Key，只有 `ai` 有 ID 的只派给海外站的 Key，两个都填就两边都能排。
全都没配的工作流不会出现在页面的工作流列表里，但在「管理 → RunningHub 密钥池」里能看到它还缺哪一行。

## 多个 Key 怎么配

环境变量 `RUNNINGHUB_KEYS_FILE` 指向一个 JSON 文件（格式见 `deploy/runninghub-keys.example`）：

```json
[
  { "title": "国内主账号", "key": "rh-xxx", "site": "cn", "concurrency": 2 },
  { "title": "海外备用号", "key": "rh-yyy", "site": "ai" },
  "rh-zzz"
]
```

- 三种写法都行，也可以混着写：字符串数组、`{title, key, site, concurrency}` 数组、`{"keys": [...]}`。
- **`site` 是枚举 `ai` / `cn`**，表示这个 Key 来自 `https://www.runninghub.ai` 还是 `https://www.runninghub.cn`。
  请求（含素材上传、任务查询）都按它打到对应域名。不写就用 `RUNNINGHUB_SITE`（默认 `cn`，照顾原来只配国内站的部署）；
  写了别的值（比如 `us`）这条 Key 会被跳过，并在管理面板里标出原因。
- 没写 `title` 的按顺序叫 `Key 1`、`Key 2`；没写 `concurrency` 的默认 **1**；`"enabled": false` 可以临时下线一个 Key。
- 改了文件不用重启：最多 5 秒后生效。
- 也可以不建文件，用 `RUNNINGHUB_KEYS`（一段 JSON 文本）或 `RUNNINGHUB_API_KEY`（单个，按默认站点）。

路由规则：每次提交先挑还有空位的 Key；**优先用剩余 RH 币最多的账号**，让高余额先被消耗、各账号的余额慢慢趋近；
分数相同时（或还没查到余额时）按原来的轮转，一个占满就换下一个。
**只挑「这个站点上配了该工作流 ID」的 Key**——两个站的工作流调不到对方那边，挑错了会在提交时报 380。
全满时最多等 `RUNNINGHUB_QUEUE_WAIT_MS`（默认 15 秒），等不到就报「都在忙，请稍后重试」。

余额来自 `/uc/openapi/accountStatus` 的 `remainCoins`，服务端后台按 `RUNNINGHUB_COINS_REFRESH_MS`（默认 60 秒）
拉回来存成内存快照，提交任务时**只读内存**，不会为了算优先级再打一次平台接口。细节：
- 同一批并发提交会给刚派过单的 Key 记一笔虚拟消耗（`RUNNINGHUB_ROUTE_SPEND`，默认 1 币），免得全挤到余额最高的那一个；拿到新快照后这笔虚拟账作废。
- 查不到余额的 Key 按「已知余额里最低的那个」参与排序，不会饿死；只要还有别的 Key 有余额，余额耗尽的就不派单（省得吃平台的 416）。
- 设 `RUNNINGHUB_ROUTE_BY_COINS=0` 可关掉整套余额路由，回到纯轮转。

占位是按**任务**算的，不是按请求算的：提交成功后那一个位子一直占着，直到任务在平台上跑完（成功或失败）才还回去。
服务重启时用历史记录把占位还原回来，不会因为重启就把同一个 Key 的超额任务又派上去。
任务记录里同时存了 Key 的 id 和站点，轮询会回到提交时的那个站点查（两个站的任务 ID 互不相通）。

页面上只看得到头尾（`rh-x…abcd`）和站点：`/api/runninghub/keys` 只有管理员能调，返回的是 `hint` 不是 `key`。

管理面板上每个 Key 的「在跑 N/M」和「剩余 X 币」问的都是 **RunningHub 平台**，不是本地计数。原因：这份 Key 文件里的 Key 可能同时给
别的项目、别的人用，本地只知道自己派出去几单，界面会显得比实际空。取数走 `POST /uc/openapi/accountStatus`
（网页端在用的账号接口，文档没公开，实测可用）：body 带 `apiKey`，回 `currentTaskCounts` —— 这个账号此刻在跑的任务数，
别人跑的也算在内；以及 `remainCoins` —— 剩余 RH 币。结果缓存 20 秒，Key 多了也只并发问 4 个。
某个 Key 问到失败（失效、超时）时，那一行退回本地计数并标「本地」，余额沿用上次查到的值并标出来，不影响别的 Key。
面板上的「刷新」带 `?refresh=1`，会跳过这 20 秒缓存，立刻再问一次平台。页脚的「极差」（最多减最少）越小，说明各账号用得越均衡。

> 另一条 `GET/POST /api/billing/usage/wideDetails`（网页端「账单明细」）**用 API Key 打不通**，只认浏览器里的登录 token，
> 用 API Key 会返回 `{"code":412,"msg":"TOKEN_INVALID"}`，所以没用它。

## 素材怎么进工作流

节点里的图片、视频字段要的是 RunningHub 上的 **fileName**，不是 URL。所以提交前每个素材都走一遍
`POST /openapi/v2/media/upload/binary`：

```
本机文件（/media/...）/ 公网链接 / data URL  →  读成 Buffer  →  上传  →  fileName  →  nodeInfoList
```

上传打到**这次任务用的那个 Key 的站点**（两个站的素材库不通用）。同一份文件（按内容 hash + 站点）在
20 小时内只传一次，因为平台给的地址只有 1 天有效期。

> 想临时把所有 Key 都指向同一个域名（自建代理、调试），设 `RUNNINGHUB_BASE_URL`，它会盖住站点表。

## 计费

- 提交时按登记表 `estimate` 里那档机器的估价预扣积分；
- 任务完成后平台会回 `usage.consumeMoney`（元），那时以它为准多退少补；没回就用估价。
  也就是说：**跑过几次之后，把 `estimate` 换成实际金额**，预扣才准。

## 排查

| 现象 | 多半是 |
| :--- | :--- |
| 工作流选择里没有这一条 | 工作流 ID 没配（看「管理 → RunningHub 密钥池」，注意要按站点配） |
| `runninghub_380`（工作流不存在） | 这个工作流的 ID 配到了另一个站点上：`.cn` 的 ID 不能拿到 `.ai` 用 |
| `runninghub_1` / `runninghub_802`（Key 无效） | Key 的 `site` 写错了：`.ai` 的 Key 拿去打 `.cn` 就会这样 |
| `runninghub_803` / `runninghub_1101` | `nodeId` 或 `field` 和工作流定义对不上，或者字段类型不一致 |
| `runninghub_810` | 工作流在平台上没保存，或者从没手动跑过一次 |
| `runninghub_901`（AI 应用不存在） | `ai-app` 的 id 配成了工作流 id，或者这个应用只存在于另一个站点（文生图目前只有海外站） |
| 文生图每次都出同一张图 | 种子写死了：留空即可，登记表的 `randomize: true` 会每次现生成 |
| `runninghub_435` | 选了账号没有的机器档位（两个站的机器档位也不通用） |
| `runninghub_1505` | 平台禁止生成真人，换素材 |
| 提交时 429 | 所有 Key 都在忙：加 Key、把 `concurrency` 调大，或者等一会儿 |
