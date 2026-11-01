# ComfyUI 动态多图输入：API 怎么传 1..N 张

> 验证环境：本机 ComfyUI 0.36.0（`http://127.0.0.1:8188`），2026-11-01 实测。
> 示例工作流：`workflows/base/尝试可选多输入.json`（`BatchImagesNode` + 2 个 `LoadImage` + `PreviewImage`）。
> 配套脚本：`scripts/comfy-run.mjs`（可直接跑，也可 `import` 进服务）。

---

## 0. 结论先行

1. **不需要改工作流，也不需要为每张图加节点。** ComfyUI 的「自动增长输入」（批量图像那种点 `+` 长出来的输入）在 API 里就是**一组带序号的 key**：`images.image0`、`images.image1`、`images.image2`……
2. **传几个 key 就吃几张图。** 保存的工作流里写了 3 个输入，你只传 `images.image0` 就是 1 张，传 `image0..image2` 就是 3 张，传 `image0..image5` 就是 6 张 —— 节点会按传进来的 key 自动调整，实测输出批大小与张数一致，且顺序等于 key 的顺序。
3. **序号规则不统一，必须从 `/object_info` 读，不能写死。** 同样是「批量图像」，`BatchImagesNode` 用的是 **0 起始**的 `image0`，而 Seedream 节点用的是 **1 起始**的 `image_1`。见 §2。
4. 一次调用 = 4 个请求：上传图片 → 提交 prompt → 轮询 history → 下载结果。

---

## 1. 核心：动态输入在 API 里的样子

UI 里点 `+` 加出来的输入，名字本身就是 API key。以 `base/尝试可选多输入` 为例，节点 `BatchImagesNode`（id=1）在 `/prompt` 里长这样：

```json
"1": {
  "class_type": "BatchImagesNode",
  "inputs": {
    "images.image0": ["2", 0],
    "images.image1": ["3", 0]
  }
}
```

`["2", 0]` 是 `[上游节点 id, 上游输出槽位]`，指向两个 `LoadImage`。想要 3 张，就再补一个 `"images.image2": ["4", 0]` 并加一个 `LoadImage` 节点即可 —— **没有 `count` 之类的开关**，key 的个数就是张数。

实测（同一工作流，仅改 key 数量）：

| 传入 key | 提交结果 | 输出张数 |
|---|---|---|
| `image0` | success | 1 |
| `image0..image1` | success | 2 |
| `image0..image2` | success | 3 |
| `image0..image5` | success | 6 |

顺序也验证过：传 红→绿→蓝，输出就是 红、绿、蓝（`PreviewImage`/`SaveImage` 按 batch 顺序存图）。

---

## 2. 名字从哪来：`/object_info` 里的 `COMFY_AUTOGROW_V3`

这类输入的 schema 类型是 `COMFY_AUTOGROW_V3`，两种写法：

**A. 只给前缀（序号从 0 开始）** —— `BatchImagesNode`：

```json
"images": ["COMFY_AUTOGROW_V3", {
  "template": { "input": { "required": { "image": ["IMAGE", {}] } }, "prefix": "image", "min": 1, "max": 50 }
}]
```

→ 名字是 `prefix + 0..max-1`，也就是 `image0` … `image49`。注意 `min: 1` 是「至少 1 个」，**不是起始下标**（Workflow 里第一个就是 `image0`）。

**B. 显式列名字（可以是 1 起始）** —— `ByteDanceSeedreamNodeV3`：

```json
"images": ["COMFY_AUTOGROW_V3", {
  "tooltip": "…Up to 10 images.",
  "template": { "input": {"required": {"image": ["IMAGE", {}]}}, "names": ["image_1","image_2",…,"image_10"], "min": 0 }
}]
```

→ 名字直接用 `names`，`image_1` … `image_10`。

**C. 还可能嵌在动态下拉里** —— Seedream 的这组输入挂在 `model` 这个 `COMFY_DYNAMICCOMBO_V3` 的某个选项下，所以完整 key 是 `model.images.image_1`（前缀是「父级 + 名字」拼出来的）。

推导算法（`scripts/comfy-run.mjs` 的 `findAutogrow`）：递归遍历节点的 `input.required/optional`，
遇到 `COMFY_AUTOGROW_V3` 就取 `template.names`（没有就用 `prefix+序号`，序号从 0 起），
遇到 `COMFY_DYNAMICCOMBO_V3` 就按当前选中的 option 继续往里走，路径用点号拼起来。

---

## 3. 完整调用流程

```bash
# 1. 上传图片（返回的 name 就是 LoadImage 要填的文件名）
curl -s -X POST http://127.0.0.1:8188/upload/image \
  -F "image=@a.png" -F "type=input" -F "overwrite=true"
# → {"name":"a.png","subfolder":"","type":"input"}

# 2. 提交（prompt 里 key 有几个就吃几张）
curl -s -X POST http://127.0.0.1:8188/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt": { ... }}'
# → {"prompt_id":"…","number":1,"node_errors":{}}

# 3. 轮询
curl -s http://127.0.0.1:8188/history/<prompt_id>

# 4. 下载
curl -s "http://127.0.0.1:8188/view?filename=<filename>&subfolder=<subfolder>&type=output" -o out.png
```

两张图的最小 prompt：

```json
{
  "1": {"class_type": "BatchImagesNode", "inputs": {"images.image0": ["2", 0], "images.image1": ["3", 0]}},
  "2": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
  "3": {"class_type": "LoadImage", "inputs": {"image": "b.png"}},
  "4": {"class_type": "PreviewImage", "inputs": {"images": ["1", 0]}}
}
```

一张图就是删掉 `images.image1` 和节点 `3`。

---

## 4. 几个坑

1. **多余的老输入要摘掉。** 保存的工作流里往往已经连着 2 个 `LoadImage`；这次只想传 1 张图，就必须把 `images.image1` 这个 key 删掉，否则那根线还在，等于还是 2 张（还会把上次的图带进来）。
2. **建议从第一个开始连续传。** 实测 `image0 + image2`（跳过 `image1`）也能跑，但顺序依赖实现细节，不要依赖。
3. **上限来自 schema**：`BatchImagesNode` 是 50，Seedream 是 10。超了会校验失败，要么换节点，要么拆批。
4. **UI 格式 ≠ API 格式。** 从 ComfyUI「保存」得到的是 `{nodes, links}`，`/prompt` 要的是 `{id: {class_type, inputs}}`。前端菜单「导出 (API)」可直接拿到后者；脚本里也自带一个转换器（链接 → `[源节点, 槽位]`，控件值按 `inputs[].widget.name` 顺序对位取），够覆盖常规工作流。
5. **转换时要跳过纯前端节点**（`MarkdownNote` / `Note` / `Reroute` / `PrimitiveNode`）和 `mode=2/4`（静音 / 绕过）的节点；`Reroute` 要顺着它的输入继续往上找真来源。
6. **没连到输出节点的节点不会被 ComfyUI 执行**，但留在 prompt 里会误导人（也容易让「残留的图」再次出现），提交前最好剪掉。

---

## 5. 每张图后面还挂着一串节点时（MiniMax H3 那种）

`workflows/base/test-video_minimax_h3_r2v-选择.json` 改造前是另一种形状：**不是 N 张图汇到一个批量节点，而是每张图各有一条独立的后置链**。

```
149 LoadImage → 150 ResizeImagesByLongerEdge ┐
151 LoadImage → 152 ResizeImagesByLongerEdge ├→ 147 MiniMaxH3ReferenceToVideo
153 LoadImage → 154 ResizeImagesByLongerEdge ┘   ref_images.ref_image_0/1/2
```

这个节点上一共有 **四组**自动增长输入：`ref_images`（IMAGE, 0-9）、`ref_videos`（IMAGE, 0-3）、`ref_video_audios`（AUDIO, 0-3）、`ref_audios`（AUDIO, 0-3）。名字来自 `prefix: "ref_image_"` + 序号，所以是 `ref_image_0`（0 起始，注意 prefix 自带下划线）。

这种工作流要"只用 2 张"，光删 key 是不够的，还有两件事：

**① 少传的那张，要连它的链条一起扔掉。**
删掉 `ref_images.ref_image_2` 之后，153/154 变成没人用的死代码。ComfyUI 执行时确实不会跑它们（只跑输出节点需要的东西），但它们还在 prompt 里 —— 而 `/prompt` 会校验**所有**节点，`LoadImage` 指向一个不存在的文件名照样报错。所以：删 key → 剪掉从输出节点回溯不到的节点。实测 1 张时只剩 `150←149`，2 张时只剩 `150←149`、`152←151`。

**② 传图不能直接怼到 key 上，要顺着链找到真正的 `LoadImage` 只改文件名。**
如果把 `ref_images.ref_image_0` 直接改接一个新建的 `LoadImage`，`ResizeImagesByLongerEdge` 就被绕过了 —— 图片尺寸不合规，模型那边可能直接报错或者效果崩掉。正确处理是沿链往上走（`ref_image_0 → 150 → 149`），只把 `149` 的 `inputs.image` 换成新文件。

**③ 张数多于已有链时，复制一条现成的链。**
工作流里只画了 3 条链，要传 5 张，第 4、5 张没有链可走。这时照第一条链的样子整段复制（`Resize` + `LoadImage`，新 id、内部连线重映射），再把新图的文件名填进复制出来的 `LoadImage`，保证所有图走同一套后置处理。实测 5 张 → `155←156`、`157←158` 两组新链，参数与原链一致。

脚本对这三种情况的输出：

```bash
$ node scripts/comfy-run.mjs --workflow "base/test-video_minimax_h3_r2v-选择" \
    --images a.png b.png c.png
注入节点：#147 MiniMaxH3ReferenceToVideo → ref_images（IMAGE，最多 9 张）
  这个节点还有别的输入组：ref_videos(IMAGE)、ref_video_audios(AUDIO)、ref_audios(AUDIO)，用 --input 指定
  ref_image_0←a.png（复用链 #149）
  ref_image_1←b.png（复用链 #151）
  ref_image_2←c.png（复用链 #153）
```

> 这个工作流后来被改造成了 `BatchImagesNode` 的"可选数量"试验田（见 §6），三条 `LoadImage → ResizeImagesByLongerEdge` 链还在，所以本节的处理方式依然适用。另外它现在接的是 `PreviewImage`，可以真跑。

---

## 6. 常见误区：用 LogicBypasser / 开关节点去「关掉」多余的图片槽

很多人（包括这个仓库里的 `test-video_minimax_h3_r2v-选择.json`）会想：**"我不想用第 3 张图，就在第 3 条链上加个旁路/开关节点把它掐掉"**。这条路走不通，不是接线没接好，是模型本身不允许。

实测三种写法的真实结果：

| 写法 | 结果 |
|---|---|
| `LogicBypasser` 处于 bypass 状态、没给 `bypass_value`（只接到一个 `PrimitiveBoolean`） | 提交通过，执行炸：`BatchImagesNode → 'NoneType' object has no attribute 'shape'` |
| 删掉第 3 条链的 `LoadImage`，但 `images.image2` 还挂在那个旁路节点上 | 同上，旁路节点没有输入就输出 `None` |
| 直接把 `images.image2` 这个 key 删掉 | 正常，批大小 = 2 |

原因就一句话：**「槽里是 None」和「根本没有这个槽」是两件不同的事。**

- `LogicBypasser` 的 `bypass_value` 官方 tooltip 写得很清楚：*"Value to use when bypassing (if not provided, uses None)"* —— 它只能输出某个值或 `None`，没法让下游那个输入**消失**。
- `ComfySwitchNode` 也一样：两个分支都得有值，选哪个是"值"的问题，不是"有没有"的问题。
- 前端右键的 **Bypass / Mute（mode=2/4）更不行**：那是纯前端概念，服务端根本没有 `mode` 字段；前端在导出 prompt 时是靠**改接线**实现 bypass 的，本质还是"接上一个有值的东西"。

所以可选数量只能落在**图结构**这一层：

| 想改数量 | 改哪里 |
|---|---|
| API 调用 | 改 prompt 里 `images.imageN` 的**个数**（不写就是不参与），工作流文件不用动 |
| ComfyUI 界面 | 用槽位上的 `+ / -` 增删输入（autogrow 自带），保存下来就是新的槽数 |

这也就是为什么一张固定 6 槽的工作流，`--images a.png b.png` 只有 2 张时能跑出 2 张 —— 少的那些 key 是**不存在**，不是 `None`。

> 已按这个结论存了一张干净模板：`workflows/base/可选输入1到6-模板.json`（6 组 `LoadImage → ResizeImagesByLongerEdge` → `BatchImagesNode` → `PreviewImage`，没有任何旁路/开关）。实测 1 / 3 / 6 张分别出 1 / 3 / 6 张图。

---

## 7. 配套脚本

```bash
# 1 张、2 张、3 张、6 张都行，张数完全由命令行决定
node scripts/comfy-run.mjs --workflow "base/可选输入1到6-模板" \
  --images ./a.png ./b.png ./c.png --out ./out

# 每张图带后置链的工作流，自动找吃图片的那一组输入
node scripts/comfy-run.mjs --workflow "base/test-video_minimax_h3_r2v-选择" \
  --images ./ref1.png ./ref2.png --input ref_images --bind 158 --dry-run

# 本来就有 API 格式的 JSON，直接喂
node scripts/comfy-run.mjs --workflow-file ./api_prompt.json --images ./a.png ./b.png

# 只想看看会拼出什么 prompt，不真提交
node scripts/comfy-run.mjs --workflow "base/尝试可选多输入" --images ./a.png --dry-run

# 指到别的机器 / 指定注入节点
node scripts/comfy-run.mjs --workflow ... --images ... --host http://10.0.0.5:8188 --bind 35
```

服务里要复用它：

```js
import { runComfy } from './scripts/comfy-run.mjs';
const { outputs } = await runComfy({ workflow: 'base/尝试可选多输入', images: [a, b], out: '/tmp/out' });
```

脚本做的事正好对应上面几节：拿 `/object_info` 推 key 名 → 上传图片 → 复用/新建 `LoadImage` 并接到 `image0..N-1` → 剪掉多余 key 和不可达节点 → 提交 → 轮询 → 下载。
