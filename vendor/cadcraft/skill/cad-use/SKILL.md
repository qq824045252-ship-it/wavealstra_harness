---
name: cad-use
description: 在 MyBuddy 中创建、查看、修改、测量核对和转换 DWG、DXF 二维图纸。适用于 CAD 图、工程图、孔径、圆、结构轮廓和按尺寸修改已有图元。
version: 1.0.0
---

# CAD Use

用户给出 DWG、DXF 或要求二维 CAD 制图时，优先使用 MyBuddy 的 CAD Use 工具。用附件路径或当前任务目录中的相对路径定位图纸。

- 新图用 `cad_create`。输出后缀决定 DWG 或 DXF。新图默认按毫米画。要在已有图纸上加图元，传入 `source` 并给副本一个新文件名。
- 改已有图元，先用 `cad_inspect` 获取图元的 `handle`、图层、原始尺寸和单位。只对已识别的图元使用 `cad_edit`，输出同格式副本。有多个匹配对象时，用图层、位置或尺寸进一步区分。
- `insunits: 4` 表示毫米，`insunits: 1` 表示英寸，`insunits: 0` 表示未指定。直径 20 mm 的圆在毫米图中使用 `radius: 10`。已有图纸单位按检查结果换算。
- 保存后对输出再调用 `cad_inspect`，核对尺寸、位置和相关图元，交付已登记的产物。如果用户需要预览或转换，用 `cad_export` 生成 PDF、SVG、PNG、DWG 或 DXF。向用户说明工具返回的图纸格式兼容提示。

读取和按图元标识修改的工作流参考 [CADCraft 的公开技能](https://github.com/hermes-pro/storytold-skills/blob/main/cadcraft/SKILL.md)。
