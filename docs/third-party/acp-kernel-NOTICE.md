# Third-Party Notice — acp-kernel (billion-context)

本产品（MyBuddy / wavealstra_harness）的自动上下文管理使用了 **acp-kernel** ——
[ranxianglei/billion-context](https://github.com/ranxianglei/billion-context) 仓库 `kernel/` 目录中的
纯 TypeScript 上下文压缩引擎（npm 名 `acp-kernel`），作者 **ranxianglei**，许可 **MIT +
附加署名条款**（见下）。

| 项 | 值 |
| --- | --- |
| 上游（当前） | https://github.com/ranxianglei/billion-context （子目录 `kernel/`） |
| 上游（历史独立仓库） | https://github.com/ranxianglei/acp-kernel （已冻结；npm 发布止于 0.0.101） |
| 固定 commit | `dc041dd1ab1a014efa352ba47a6f31fc47f55284` |
| kernel 版本 | `0.0.195` |
| 复制日期 | 2026-11-11 |
| 本仓库内位置 | `vendor/acp-kernel/`（`src/**` 原样副本 + `LICENSE` + `README.md` + `PROVENANCE.md` + `PACKAGE.json.txt`） |
| 来源与升级流程 | [vendor/acp-kernel/SOURCE.md](../../vendor/acp-kernel/SOURCE.md) |
| 许可原文 | [vendor/acp-kernel/LICENSE](../../vendor/acp-kernel/LICENSE) |

## 署名要求（MIT 之上的附加条款，摘要）

使用/嵌入该软件、且产品对终端用户可见或可交互时，须在下列**至少一处**显著署名，说明使用了
acp-kernel（涉及时包括 billion-context），并附仓库链接：

1. 产品首页；
2. 产品文档；
3. “关于 / 致谢 / Acknowledgements”页面。

本产品的落实：应用内 “设置 → 帮助与反馈（关于）”面板的署名行，以及本文件（随安装包发布的文档）。
纯服务端/内嵌无界面用途，随附文档包含上述声明即可。

## MIT License（原文，含附加条款）

Copyright (c) 2026 ranxianglei

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

### Additional Term — Attribution on Product Surfaces

In addition to the conditions above, if you use or incorporate the Software
in a product or service that end users can see or interact with — whether
commercial or open source — you must make attribution clearly visible in at
least one of the following places:

1. the product's home page;
2. its documentation; or
3. its "About" / "Credits" / "Acknowledgements" page.

The attribution must state that the product uses acp-kernel (and
billion-context, where applicable) and include a link to
https://github.com/ranxianglei/acp-kernel (and
https://github.com/ranxianglei/billion-context, where applicable).

For purely server-side or embedded uses with no user-facing surface, carrying
these notices in the shipped documentation satisfies this term.

（附加条款中文：除上述条件外，若将本软件用于任何终端用户可见或可交互的产品或服务（无论商业
或开源），须在产品首页、产品文档、“关于 / 致谢 / Acknowledgements”页面至少一处显著位置标明
出处；署名须说明使用了 acp-kernel（涉及时包括 billion-context），并附指向
https://github.com/ranxianglei/acp-kernel（及 https://github.com/ranxianglei/billion-context，
涉及时）的链接。纯服务端或内嵌、无用户可见界面的用途，随附文档中包含上述声明即可。）

## 复制与升级

- **复制**：2026-11-11 从上述 commit 的 `kernel/` 目录原样复制 `src/**`（87 个文件）、`LICENSE`、
  `README.md`、`PROVENANCE.md`，以及改名为 `PACKAGE.json.txt` 的 `package.json`；逐文件 SHA256
  校验与上游字节一致，未做任何修改。完整清单与 npm 版本不可用的原因见
  [vendor/acp-kernel/SOURCE.md](../../vendor/acp-kernel/SOURCE.md)。
- **升级**：重新 clone → 只读 diff → 整目录全量替换 → 更新本文件与 SOURCE.md 的 SHA/版本/日期 →
  跑 typecheck 与 `pnpm -s test:durable-context-management`。禁止手改 vendor 源文件；不得移除
  版权头或本署名要求。
- **升级流程/文件计数/构建接线**：见 [vendor/acp-kernel/SOURCE.md](../../vendor/acp-kernel/SOURCE.md)。