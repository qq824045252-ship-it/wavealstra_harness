## ② 流程停点 + 档位默认 + 块地图速查

**执行前先定位自己在哪个阶段、这一步是不是停点、走哪个档、这阶段要不要先查块。** 完整流程 S0–S6 / P0–P10
见 [`references/design-flow.md`](../references/design-flow.md);非平凡板(>~10 件或要交付/排 PCB)一律走它的 gated flow。
这里是执行时扫读用的顶层速查。

### 何时必须停手交回用户(里程碑档 = 真实用户默认)

| 停点 | 触发 | 要点 |
|---|---|---|
| ① S0 方案书 | 进 S1 前 | 架构/叠层/地策略/接口取向每条摊选项+坑+推荐让用户拍板;**必须落成磁盘文件**才算过门,不能停在对话里 |
| ② sch→PCB 前 | 原理图完成 | 逐页 **`easyeda sch gate --strict --doc <page>` 出 `verdict=pass`**(一条命令跑完 layout-lint→check→bridge-check→drc 四关,顺序与阻塞判据固定在代码里,别自己拼)+ pin→net 黄金表对齐(gate 判不了「接对没有」,只判「接得合不合法」);**`verdict=blocked` 是检查器没跑成,不是板子有问题——先修 health/doc 再重跑,别去改电路**;DRC 聚合 WARN 必须审阅并报告；**多页/多模块板还需确认分区框+区名标注已画**(`sch zones status` 看认领、`sch zone-draw` 补画——手工摆放路径不会像 `autolayout --apply` 那样自动画,容易漏)**+每模块电路说明已放**(`sch note` 放、`sch text-list` 核——分区框只命名,说明才让人读懂) → design-flow S5 |
| ③ 发板/交付前 | 导出制造 | 交付摘要说清偏差(降级决策/遗留 WARN) |
| S2/S3 `page-too-small` | 块/组比整页可用区还大 | 工具只停手不建页:摊给用户拍板 ①独立成页 ②继续分页 ③改标签朝向收小组(A4-only 不换纸)→ design-flow S3 |
| P2 摆放前 | 布局起手 | 先问单/双面布局 + 焊接工艺;立即用 `pcb stage set-assembly` 落盘,手焊默认 `min-gap=40mil`/大焊盘通道 `60mil` |
| P2 边缘接口件 | 端子/USB/SD/排针/按键/IPEX | 朝向 + 边序 = 装配体验,agent 猜不了,**必须用户确认**;先 `blocks show` 读块 placement 摊给用户 |
| P2 分档落状态 | 每档摆完确认后 | **`pcb stage confirm-tier <1-4> --parts …` 逐档落盘**(#125 机械化):档1孔→档2边缘件→档3主芯片+RF→档4卫星(缺省=其余);跳档被拒、动某档件只作废该档及其后;四档未齐 `confirm-layout` 拒绝封章 |
| P7 稠密板布线 | 见下档位 + P7 迷你清单 | **停下请用户在 EasyEDA 菜单点「布线→自动布线」**;交出去前必做两步见下方 P7 迷你清单,跑完再接手 |
| 破坏性操作 / 门禁失败 | clear/delete/bulk;`pcb new-board --force`(已绑板会搬走原理图=旧板原理图丢失);layout-lint ERROR / DRC fatal | 停在失败数据,不带病往下 |

里程碑档**只有这几处停**,不是每步都停(逐步档才每步停);全自动仅用于回归/CI/operator/录制。

### 档位默认(别自作主张改)

| 维度 | 默认 | 备注 |
|---|---|---|
| 交互模式 | **milestone(里程碑)** | 非逐步、非全自动 |
| 布线档 | 按 layout-lint ratsnest 密度选 | 稀疏(交叉<100)→ `route-short`;**稠密 → 请用户点原生自动布线(默认)**;全 headless 才 Freerouting(`pcb autoroute`,兜底,**不顶替默认**)。交出去前先跑 ↓P7 迷你清单 |
| 摆放优先级 | 孔 → 边缘件 → 主芯片+RF → 卫星件 | 只有卫星件交 auto-place;孔最先放 + 锁定 |
| 图纸 / 板框 | A4 / compact | 无尺寸信息时 compact;compact 时主芯片按**紧凑网格**播种(模块中心距≈包络+300~400mil,别撒 2000mil 外),摆位/判尺寸**只信 `pcb list --include-bbox` 实测 bbox**(含 courtyard,常比封装大 40%+),不猜标称 → design-flow P1/P2 |
| 原理图组织 | **分页+区框+说明,见铁律 15** | 分页 = 每页一个功能域(电源/主控/接口…),跨页 `net_port` 同名同网;`autolayout --apply` 自动画框;说明写作用+关键参数(「LDO: 5V→3V3 1A」「BOOT: GPIO0 拉低进烧录」),放模块框下/旁不压电路 → design-flow S1–S3 · schematic-layout-conventions.md |
| GND 内层 | `power-planes --gnd-plane` → 终态 PLANE | SIGNAL 铺→翻 PLANE→rebuild,不停在 SIGNAL |
| `pour-fit --replace` | **true(会清跨层同网 pour)** | 顶/底 GND pour 要显式 `--replace=false` |
| 线宽档(net-class) | 按角色:信号=live默认 / 支线(3V3/1V8)10 / 主干(+5V)15 / 大电流(VBUS/VIN)20mil | `pcb net-classes` 查当前表;`route-short` 自动按角色给宽;偏细电源线被 `pcb check` **width-under-spec** 逮(§7.8) |
| 电源走铺铜 | **2层 `power-pour` / 4层 `power-planes`** | 电源走铜面不走细线(#1 DRC 源);别拿细线穿焊盘阵布电源,裸电源网被 `pcb check` **power-not-poured** 逮 |
| 布局质量档 | **门=`layout-lint --gate`(唯一);质量表=`pcb layout-score --spec <s0>`(诊断,不落确认)** | 只有一个门,别跑成两个。layout-score 九维各 0-100+逐器件归因;**默认不设 `--min-score`**(只有 blocking=短路/重叠/出板框才非零退出),要当门用才显式给(建议 75=good 档下沿)。带 `--spec` 才解锁 flow-order 与 internal 连接器判定,否则这两维 **skipped(「没测」≠「满分」)** → design-flow P6。原理图侧对应 **`sch layout-score`**(五维:标签折叠/标签反向/外围贴核心/长链挤压/版面整洁)——同样诊断视角,**每条归因带填好真实位号坐标的 fix 命令,照抄执行即可修**;门仍是 `sch layout-lint`+`sch check` |

### P7 交自动布线前必做两步(常被遗忘,已实测踩坑)

稠密板停手交用户点原生自动布线**之前**,这两步不做完就交出去 = 关键网被路由器冲掉或整个交给它不擅长的活:

1. **关键网先自布并锁定** — 一条命令 **`pcb route-critical`**(#127:电源按层数 planes/pour → 差分对双源识别+成对布线+skew 实测 → 自动 `track-lock`);单步手工同旧法(`pcb fill`/`power-planes`/`pcb track-lock`)
   锁死(否则自动布线器 / `pour-rebuild` 会把手布的关键线冲掉)。
2. **停手时必念「自动布线对话框」4 条**(漏一条毁掉第 1 步):① 「已有导线/过孔」选**保留**、绝不选「移除」
   ② 「布线图层」只勾**顶层+底层**、取消内层 1/2 ③ 「忽略网络」加**已在平面的电源网**(GND、3V3/VDD)
   ④ 其余默认。→ 细节 design-flow P7.0 + 自动布线对话框清单

### 块地图速查(块携带多维知识,按阶段读对应 map)

命中块后,不同阶段读块里不同的 map;每行统一**先 `easyeda blocks show <id>` 读对应 map**:

| 阶段 | 读块的 map | 内容 |
|---|---|---|
| S0 / S3 | `internal_nets` · `ports` · `parts` | 照抄拓扑(引脚用功能名零改号)/ 重绑边界网络 / 选型免做(parts 指回 standard-parts) |
| P2 | `placement` | 板边 / 朝向(edge/side/orientation,**须用户确认**) |
| P2 / P8 | `pcb_layout`(`*-adjacency` / `ep-*`) | 去耦·晶振贴脚距离(P2)/ EP 热过孔·接地缝合(P8) |
| P4 | `pcb_layout`(`rf-keepout` / `balun-mirror`) | RF 禁布 / 巴伦镜像(severity=must) |
| P7.0 | `signals` | 差分对 / 阻抗(`impedance_ohm`+`impedance_kind`)/ 等长(`length_match_mm`) |
| P9 | `silk` | 逐脚标注(`pins`/`label`/`note`) |

**搜索策略**:`blocks search` 命中 id/desc/category/port/part——按**功能**(rs485/buck/gnss)、**芯片**(ch340/cc1101)、
**端口网**(5V/USB_DP)三维轮换搜;一词没中换维度别急着手接;或 `blocks ls --category <power|usb|usb-serial|rf|comms|storage|sensing|mcu|mcu-support|indicator|button|audio|display>` 浏览整类(类目以 `blocks ls` 实际输出为准,别信这里的枚举过期与否)。
