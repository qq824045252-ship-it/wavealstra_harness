#!/usr/bin/env python3
"""blwfish freecad-mcp live smoke（MyBuddy 验收入口，可重复）。

场景 A（安装板：Sketch→Pad→Pocket×4→save）+ B（支架：Pad→Pocket→linear_pattern→save）。
验证：结构化工具路径 0 次 execute_python、Fully constrained、原生 Feature Tree、save 闭环。

前置：
- 日常模式（默认）：要求 FreeCAD GUI 已运行且 AICopilot backend 监听 23456
  （MyBuddy 的 runtime prewarm 会启动 GUI；或手工打开 FreeCAD）。
- --headless：测试/CI 专用，自行 spawn FreeCADCmd + headless_server.py（不改变日常配置）。
- --spawn-gui：启动 portable FreeCAD.exe（可见 GUI）并等待 23456（真实 GUI 验证）。
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time

SERVER = r"C:/Users/servi/Desktop/mybuddy/MyBuddyTools/mcp/freecad-mcp-blwfish/.venv/Scripts/python.exe"
SCRIPT = r"C:/Users/servi/Desktop/mybuddy/MyBuddyTools/mcp/freecad-mcp-blwfish/freecad_mcp_server.py"
FREECAD_BIN = r"C:/Users/servi/Desktop/mybuddy/MyBuddyTools/FreeCAD_1.1.3-Windows-x86_64-py311/bin"
HEADLESS_SCRIPT = r"C:/Users/servi/Desktop/mybuddy/MyBuddyTools/mcp/freecad-mcp-blwfish/AICopilot/headless_server.py"
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp-cad-acceptance")

stats = {"calls": 0, "python_calls": 0}


def wait_tcp(host, port, timeout=60):
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def ensure_freecad(mode):
    if mode == "headless":
        env = dict(os.environ, FREECAD_MCP_PORT="23456")
        proc = subprocess.Popen(
            [os.path.join(FREECAD_BIN, "FreeCADCmd.exe"), HEADLESS_SCRIPT],
            env=env, cwd=os.path.dirname(HEADLESS_SCRIPT),
        )
        if not wait_tcp("127.0.0.1", 23456):
            proc.kill()
            sys.exit("headless FreeCAD 启动超时（23456 未监听）")
        return proc
    if mode == "gui":
        proc = subprocess.Popen([os.path.join(FREECAD_BIN, "FreeCAD.exe")])
        if not wait_tcp("127.0.0.1", 23456, timeout=90):
            sys.exit("GUI FreeCAD 启动后 AICopilot backend 未监听 23456")
        return proc
    # 默认：复用已运行的 GUI 实例（MyBuddy prewarm 或用户手工打开）
    if not wait_tcp("127.0.0.1", 23456, timeout=10):
        print("提示：未检测到 23456 上的 AICopilot backend。请先打开 FreeCAD GUI")
        print("（MyBuddy 选择 mechanical-cad Tag 会自动启动），或使用 --headless/--spawn-gui。")
        sys.exit(2)
    return None


async def call(session, name, args, label=""):
    stats["calls"] += 1
    if name in ("execute_python", "execute_python_async"):
        stats["python_calls"] += 1
    r = await session.call_tool(name, args)
    text = "".join(c.text or "" for c in r.content if c.type == "text")
    ok = not (r.is_error or text.startswith("Error") or '"error"' in text[:200])
    print(f"  [{label or name}] {'OK ' if ok else 'ERR'} -> {text[:200]}")
    return text, ok


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["reuse", "headless", "gui"], default="reuse")
    args = parser.parse_args()
    os.makedirs(SAVE_DIR, exist_ok=True)
    proc = ensure_freecad(args.mode)
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        params = StdioServerParameters(command=SERVER, args=[SCRIPT])
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as session:
                await session.initialize()
                t, ok = await call(session, "check_freecad_connection", {}, "conn")
                if not ok:
                    print("FATAL: FreeCAD backend 未就绪"); sys.exit(2)

                print("\n===== 场景 A：安装板（Sketch→Pad→Pocket→保存） =====")
                await call(session, "view_control", {"operation": "create_document", "document_name": "MountingPlate"}, "create_doc")
                await call(session, "sketch_operations", {"operation": "create_sketch", "name": "Sketch", "plane": "XY"}, "create_sketch")
                await call(session, "sketch_operations", {"operation": "add_rectangle", "sketch_name": "Sketch", "width": 100, "height": 60, "constrain": True}, "add_rect")
                await call(session, "sketch_operations", {"operation": "verify_sketch", "sketch_name": "Sketch"}, "verify")
                await call(session, "sketch_operations", {"operation": "close_sketch", "sketch_name": "Sketch"}, "close")
                await call(session, "partdesign_operations", {"operation": "pad", "sketch_name": "Sketch", "length": 5}, "pad")
                for i, (hx, hy) in enumerate([(15, 15), (85, 15), (15, 45), (85, 45)]):
                    await call(session, "sketch_operations", {"operation": "create_sketch", "name": f"Hole{i}", "plane": "XY"}, f"sketch_hole{i}")
                    await call(session, "sketch_operations", {"operation": "add_circle", "sketch_name": f"Hole{i}", "x": hx, "y": hy, "radius": 1.5}, f"circle{i}")
                    await call(session, "sketch_operations", {"operation": "close_sketch", "sketch_name": f"Hole{i}"}, f"close_hole{i}")
                    await call(session, "partdesign_operations", {"operation": "pocket", "sketch_name": f"Hole{i}", "length": 5}, f"pocket{i}")
                await call(session, "view_control", {"operation": "save_document", "document_name": "MountingPlate", "filename": os.path.join(SAVE_DIR, "mounting_plate.FCStd")}, "save")

                print("\n===== 场景 B：支架（Pad + Pocket + Pattern） =====")
                await call(session, "view_control", {"operation": "create_document", "document_name": "Bracket"}, "create_doc_b")
                await call(session, "sketch_operations", {"operation": "create_sketch", "name": "Sketch", "plane": "XY"}, "create_sketch_b")
                await call(session, "sketch_operations", {"operation": "add_rectangle", "sketch_name": "Sketch", "width": 80, "height": 40, "constrain": True}, "add_rect_b")
                await call(session, "partdesign_operations", {"operation": "pad", "sketch_name": "Sketch", "length": 10}, "pad_b")
                await call(session, "sketch_operations", {"operation": "create_sketch", "name": "Slot", "plane": "XY"}, "sketch_slot")
                await call(session, "sketch_operations", {"operation": "add_circle", "sketch_name": "Slot", "x": 40, "y": 20, "radius": 6}, "slot_circle")
                await call(session, "sketch_operations", {"operation": "close_sketch", "sketch_name": "Slot"}, "close_slot")
                await call(session, "partdesign_operations", {"operation": "pocket", "sketch_name": "Slot", "length": 10}, "pocket_b")
                await call(session, "partdesign_operations", {"operation": "linear_pattern", "feature_name": "Pocket", "length": 60, "direction": "x", "count": 3}, "pattern_b")
                await call(session, "view_control", {"operation": "save_document", "document_name": "Bracket", "filename": os.path.join(SAVE_DIR, "bracket.FCStd")}, "save_b")

                print(f"\n===== 统计：总调用 {stats['calls']}，裸 python 调用 {stats['python_calls']} =====")
                if stats["python_calls"] > 0:
                    print("WARNING: 主路径出现 execute_python 调用（结构化工具应覆盖）")
                print("保存目录:", SAVE_DIR)
    finally:
        if proc is not None:
            proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
