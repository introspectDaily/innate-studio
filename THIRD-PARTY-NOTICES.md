# 第三方内容

## Hugeicons 免费图标

界面里的图标取自 [Hugeicons](https://hugeicons.com) 的免费图标（Stroke Rounded 风格，`@hugeicons/core-free-icons` 4.3.5），路径数据在 `web/src/ui/icons.ts` 的 `ICONS` 里。播放、暂停和喇叭的轮廓填成了实心，其余没有改动。

这里只用了免费图标。Hugeicons Pro 的图标不能随源码公开分发，不要加进这个仓库。

免费图标按 MIT 许可发布，原文如下：

```
MIT License

Copyright (c) 2025 Hugeicons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## Lucide 图标

侧栏「技能」的图标（wand-sparkles）取自 [Lucide](https://lucide.dev)（`lucide-static` 1.54.0），路径数据同样在 `web/src/ui/icons.ts` 里，没有改动。按 ISC 许可发布，原文如下：

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## React Flow

画布页用的是 [React Flow](https://reactflow.dev)（`@xyflow/react`，MIT 许可，版权归 webkid GmbH），通过 pnpm 安装，没有改动它的源码。许可全文在 `node_modules/@xyflow/react/LICENSE`。画布右下角保留了它的署名。

## 官方技能的规则

`shared/skills.ts` 里三个官方技能的规则取自团队自己的两个项目，只去掉了原项目流程里才有意义的句子：

- 「角色设定图」「分镜首帧」来自小云雀（XiaoYunQue）的提示词。小云雀按 MIT 许可发布，版权归 Video-Claw / FilmAgent（<https://github.com/HITsz-TMG/FilmAgent>）和 XiaoYunQue（Innate Labs）。
- 「多镜头成片」来自 FRW 导演工作台里给 Seedance 2 写的提示词规则和范例。这个项目是团队内部的，仓库里没有许可证文件；把这个应用的源码公开之前，先确认这部分可以一起公开。
