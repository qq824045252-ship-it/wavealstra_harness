/**
 * freecad-scripts — FreeCADCmd 受管脚本（2026-08 随 CAD 主链切换独立化）。
 *
 * 来源：仓库历史 runner 内嵌脚本（TECHVIEW_FREECAD_SCRIPT /
 * FCSTD_READBACK_FREECAD_SCRIPT），2026-08 提取为仓库资产。
 * 契约：脚本经 FreeCadInterop.runScript 执行（fc_args() 读参；超时/整树杀由 TS 侧保证）。
 * - techdraw：真实 TechDraw DrawPage + 三视图 + 尺寸 → SVG（console 合成）+ FCStd；
 * - fcstd_readback：FCStd → 结构化摘要（对象/类型/参数/形状/父链/约束状态）+ STEP 导出。
 * 不依赖外部 OCP 内核，仅 FreeCAD 自带 Python + Part/TechDraw/Import 模块。
 */
export const TECHVIEW_FREECAD_SCRIPT = `import json
import os
import sys
import traceback


def _run():
    args = fc_args()
    input_path = args[0]
    out_dir = args[1]
    page_w = float(args[2])
    page_h = float(args[3])
    include_dims = args[4] == "1"

    def emit(step, **kw):
        kw["step"] = step
        print(json.dumps(kw, ensure_ascii=False), flush=True)

    template_svg = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\\n'
        '<svg id="td-template" xmlns="http://www.w3.org/2000/svg" width="%(w)gmm" height="%(h)gmm" viewBox="0 0 %(w)g %(h)g">\\n'
        '<rect x="2" y="2" width="%(w)g-4" height="%(h)g-4" style="fill:none;stroke:#000000;stroke-width:0.5"/>\\n'
        '</svg>\\n'
    ) % {"w": page_w, "h": page_h}

    import FreeCAD as App
    import Part
    import TechDraw

    if input_path.lower().endswith(".fcstd"):
        doc = App.openDocument(input_path)
        obj = None
        for o in doc.Objects:
            if hasattr(o, "Shape") and o.Shape is not None and not o.Shape.isNull():
                obj = o
                break
        if obj is None:
            raise RuntimeError("FCStd 中未找到可投影的实体")
        shape = obj.Shape
    else:
        shape = Part.read(input_path)
        doc = App.newDocument("td")
        obj = doc.addObject("Part::Feature", "Part__Feature")
        obj.Shape = shape
        doc.recompute()

    page = doc.addObject("TechDraw::DrawPage", "Page")
    template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    tmpl_path = os.path.join(out_dir, "techdraw_template.svg")
    with open(tmpl_path, "w", encoding="utf-8") as fh:
        fh.write(template_svg)
    template.Template = tmpl_path
    page.Template = template

    # 三视图（第三角投影方向）+ 布局
    views = []
    for name, direction, x, y in (
        ("Front", (0, -1, 0), page_w * 0.30, page_h * 0.55),
        ("Top", (0, 0, -1), page_w * 0.62, page_h * 0.55),
        ("Right", (-1, 0, 0), page_w * 0.30, page_h * 0.18),
    ):
        v = doc.addObject("TechDraw::DrawViewPart", name)
        v.Source = [obj]
        v.Direction = direction
        v.X = x
        v.Y = y
        v.Scale = 1.0
        page.addView(v)
        views.append(v)

    if include_dims:
        try:
            front = views[0]
            dv = doc.addObject("TechDraw::DrawViewDimension", "DimW")
            dv.Type = "DistanceX"
            dv.References2D = [front.getEdgeByIndex(1), front.getEdgeByIndex(3)]
            page.addView(dv)
        except Exception:
            pass

    doc.recompute()
    emit("views_created", count=len(page.Views))

    fragments = {}
    for v in views:
        try:
            frag = TechDraw.viewPartAsSvg(v) or ""
            fragments[v.Name] = frag
        except Exception as exc:
            fragments[v.Name] = ""
            emit("view_fragment_failed", view=v.Name, error=repr(exc)[:200])
    emit("fragments", views={k: len(v) for k, v in fragments.items()})

    # 合成完整 SVG 图纸（页面模板 + 各视图）
    parts = []
    for v in views:
        frag = fragments.get(v.Name, "")
        if not frag:
            continue
        parts.append('<g transform="translate(%.3f %.3f)">%s</g>' % (v.X, v.Y, frag))
    svg = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="%gmm" height="%gmm" viewBox="0 0 %g %g">'
        '<rect x="2" y="2" width="%g" height="%g" fill="none" stroke="#000" stroke-width="0.6"/>'
        '<text x="6" y="%g" font-size="6" fill="#000">MyBuddy TechDraw · %s</text>'
        '<text x="6" y="%g" font-size="6" fill="#000">三视图: Front / Top / Right · 单位 mm · 比例 1:1</text>'
        '%s</svg>'
    ) % (
        page_w, page_h, page_w, page_h, page_w - 4, page_h - 4,
        page_h - 6, os.path.basename(input_path),
        page_h - 12,
        "".join(parts),
    )
    out_svg = os.path.join(out_dir, "techdraw.svg")
    with open(out_svg, "w", encoding="utf-8") as fh:
        fh.write(svg)
    emit("svg_written", path=out_svg, bytes=os.path.getsize(out_svg))

    out_fcstd = os.path.join(out_dir, "techdraw.fcstd")
    doc.saveAs(out_fcstd)
    emit("fcstd_written", path=out_fcstd, bytes=os.path.getsize(out_fcstd))
    App.closeDocument(doc.Name)
    emit("done", ok=True)


try:
    _run()

except Exception:
    print(json.dumps({"step": "error", "error": traceback.format_exc()[-3000:]}), flush=True)
    sys.exit(1)`;
export const FCSTD_READBACK_FREECAD_SCRIPT = `import json
import os
import sys
import traceback


def _run():
    args = fc_args()
    fcstd_path = args[0]
    out_dir = args[1]

    def emit(step, **kw):
        kw["step"] = step
        print(json.dumps(kw, ensure_ascii=False), flush=True)

    import FreeCAD as App
    import Import  # noqa: F401

    doc = App.openDocument(fcstd_path)
    # 重算并捕获失败态（RecomputesFailed 不可得时 null=unknown，绝不伪造）
    recompute_errors = None
    try:
        doc.recompute()
        recompute_errors = bool(getattr(doc, "RecomputesFailed", False))
    except Exception:
        recompute_errors = None
    emit("opened", name=doc.Name, objects=len(doc.Objects), recomputeErrors=recompute_errors)

    # 结构化摘要：每个对象 name/label/type + State + 标量参数 +（草图）约束/求解状态
    type_counts: dict[str, int] = {}
    objects = []
    for o in doc.Objects:
        type_counts[o.TypeId] = type_counts.get(o.TypeId, 0) + 1
        params: dict = {}
        for prop in o.PropertiesList[:60]:
            try:
                v = o.getPropertyByName(prop)
            except Exception:
                continue
            if isinstance(v, (int, float, str, bool)) or v is None:
                params[prop] = v
            elif hasattr(v, "Value"):
                try:
                    params[prop] = float(v.Value)
                except Exception:
                    pass
        entry: dict = {
            "name": o.Name,
            "label": getattr(o, "Label", ""),
            "type": o.TypeId,
            "state": list(getattr(o, "State", []) or []),
            "params": params,
        }
        # Sketcher::SketchObject：几何/约束计数 + 求解状态（API 不可得 → null/空串，绝不伪造）
        if "Sketcher::" in o.TypeId or hasattr(o, "Constraints"):
            try:
                gc = len(o.Geometry)
                cc = len(o.Constraints)
                conflicts = None
                redundancies = None
                solve_status = ""
                fully = None
                dof = None
                # FreeCAD 1.1+：结构化求解属性（确定性；1.0/0.21 无这些属性 → 回退旧 API）
                if hasattr(o, "FullyConstrained"):
                    fully = bool(o.FullyConstrained)
                if hasattr(o, "ConflictingConstraints"):
                    conflicts = bool(o.ConflictingConstraints)
                elif hasattr(o, "hasConflicts"):
                    conflicts = bool(o.hasConflicts())
                if hasattr(o, "RedundantConstraints"):
                    redundancies = bool(o.RedundantConstraints)
                elif hasattr(o, "hasRedundancies"):
                    redundancies = bool(o.hasRedundancies())
                # DoF 仅在 solve 后更新（FCStd 重新打开时初值 0）→ 先 solve 再读
                try:
                    o.solve()
                except Exception:
                    pass
                if hasattr(o, "DoF"):
                    dof = int(o.DoF)
                if hasattr(o, "getStatusString"):
                    # 1.1+：确定性状态文本（"Valid" / "Sketch with conflicting constraints..."）
                    solve_status = str(o.getStatusString())
                else:
                    try:
                        res = o.solve()
                        if isinstance(res, tuple):
                            msg = str(res[1]) if len(res) > 1 else str(res[0])
                            solve_status = msg
                            low = msg.lower()
                            if "fully constrained" in low:
                                fully = True
                            elif "under-constrained" in low:
                                fully = False
                        else:
                            solve_status = str(res)
                    except Exception:
                        pass
                entry["sketch"] = {
                    "geometryCount": gc,
                    "constraintCount": cc,
                    "conflicts": conflicts,
                    "redundancies": redundancies,
                    "solveStatus": solve_status,
                    "fullyConstrained": fully,
                    "DoF": dof,
                }
            except Exception:
                pass
        if hasattr(o, "Shape") and getattr(o, "Shape", None) is not None:
            try:
                s = o.Shape
                entry["shape"] = {
                    "valid": s.isValid(),
                    "solids": len(s.Solids),
                    "faces": len(s.Faces),
                    "edges": len(s.Edges),
                    "volume": s.Volume if hasattr(s, "Volume") else None,
                }
            except Exception:
                pass
        objects.append(entry)

    # 导出 STEP（读回 → 受管 import 的关键桥）
    step_out = os.path.join(out_dir, "readback.step")
    shape_objs = [o for o in doc.Objects if hasattr(o, "Shape") and getattr(o, "Shape", None) is not None and not o.Shape.isNull()]
    Import.export(shape_objs, step_out)

    summary = {
        "fcstd": fcstd_path,
        "valid": True,
        "document": doc.Name,
        "recomputeErrors": recompute_errors,
        "objectCount": len(objects),
        "shapeObjectCount": len(shape_objs),
        "typeCounts": type_counts,
        "objects": objects,
        "stepFile": step_out,
        "stepBytes": os.path.getsize(step_out),
    }
    out_json = os.path.join(out_dir, "readback.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    emit("readback_written", path=out_json, objects=len(objects), stepBytes=os.path.getsize(step_out))
    App.closeDocument(doc.Name)
    emit("done", ok=True)


try:
    _run()
except Exception:
    print(json.dumps({"step": "error", "error": traceback.format_exc()[-3000:]}), flush=True)
    sys.exit(1)`;
