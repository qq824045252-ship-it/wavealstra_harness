"""Start the registered Windows Dots host soak on an unseen, disposable Win32 desktop."""
import argparse
import ctypes as ct
from ctypes import wintypes as w
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

root = Path(__file__).resolve().parents[1]
u = ct.WinDLL("user32", use_last_error=True)
k = ct.WinDLL("kernel32", use_last_error=True)

class Startup(ct.Structure):
    _fields_ = [("cb",w.DWORD),("reserved",w.LPWSTR),("desktop",w.LPWSTR),("title",w.LPWSTR),
                *[(key,w.DWORD) for key in ("x","y","cx","cy","charsX","charsY","fill","flags")],
                ("show",w.WORD),("reserved2size",w.WORD),("reserved2",ct.c_void_p),
                ("stdin",w.HANDLE),("stdout",w.HANDLE),("stderr",w.HANDLE)]

class Process(ct.Structure):
    _fields_ = [("process",w.HANDLE),("thread",w.HANDLE),("pid",w.DWORD),("tid",w.DWORD)]

def bind(dll, name, result, *args):
    f = getattr(dll, name)
    f.restype, f.argtypes = result, args
    return f

desktop = bind(u,"CreateDesktopW",w.HANDLE,w.LPCWSTR,w.LPCWSTR,ct.c_void_p,w.DWORD,w.DWORD,ct.c_void_p)
close_desk = bind(u,"CloseDesktop",w.BOOL,w.HANDLE)
thread_desk = bind(u,"GetThreadDesktop",w.HANDLE,w.DWORD)
thread_id = bind(k,"GetCurrentThreadId",w.DWORD)
user_info = bind(u,"GetUserObjectInformationW",w.BOOL,w.HANDLE,ct.c_int,ct.c_void_p,w.DWORD,ct.POINTER(w.DWORD))
create = bind(k,"CreateProcessW",w.BOOL,w.LPCWSTR,w.LPWSTR,ct.c_void_p,ct.c_void_p,w.BOOL,w.DWORD,
              ct.c_void_p,w.LPCWSTR,ct.POINTER(Startup),ct.POINTER(Process))
close = bind(k,"CloseHandle",w.BOOL,w.HANDLE)
def name(tid):
    buf, length = ct.create_unicode_buffer(512), w.DWORD()
    hd = thread_desk(tid)
    if not hd:
        raise ValueError("thread has no accessible desktop handle")
    if not user_info(hd,2,buf,ct.sizeof(buf),ct.byref(length)):
        raise ct.WinError(ct.get_last_error())
    return buf.value

def inspect_threads(args):
    # Query from a peer on the same desktop; cross-desktop thread handles can deny access.
    original = name(thread_id())
    results = {}
    for tid in args.inspect:
        try: results[str(tid)] = name(tid)
        except (OSError, ValueError) as e: results[str(tid)] = str(e)
    args.output.write_text(json.dumps({"observer":original,"threads":results},indent=2))

def inspect_peer(args):
    si, pi = Startup(), Process()
    si.cb, si.desktop = ct.sizeof(si), "winsta0\\" + args.desktop
    command = [sys.executable,__file__,"--inspect",*map(str,args.inspect),"--output",str(args.output)]
    if not create(sys.executable,ct.create_unicode_buffer(subprocess.list2cmdline(command)),None,None,False,
                  0x08000000,None,str(root),ct.byref(si),ct.byref(pi)):
        raise ct.WinError(ct.get_last_error())
    try:
        k.WaitForSingleObject.argtypes = [w.HANDLE,w.DWORD]
        if k.WaitForSingleObject(pi.process,20000) != 0: raise TimeoutError("desktop observer")
    finally:
        close(pi.process)
        close(pi.thread)
    print(args.output.read_text())

def start(args):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = root / "out/diagnostics/dots-isolated-desktop" / (stamp + "-" + uuid.uuid4().hex[:8])
    out.mkdir(parents=True)
    label = "MyBuddyDots-" + out.name
    hd = desktop(label,None,None,0,0x10000000,None)
    if not hd: raise ct.WinError(ct.get_last_error())
    try:
        si, pi = Startup(), Process()
        si.cb, si.desktop = ct.sizeof(si), "winsta0\\" + label
        command = [sys.executable, __file__, "--worker", str(out), "--desktop", label, "--pnpm", str(args.pnpm)]
        if args.desktop_notifications: command.append("--desktop-notifications")
        if not create(sys.executable,ct.create_unicode_buffer(subprocess.list2cmdline(command)),None,None,False,
                      0x08000000,None,str(root),ct.byref(si),ct.byref(pi)):
            raise ct.WinError(ct.get_last_error())
        close(pi.thread)
        close(pi.process)
        # Keep creator's desktop handle until the worker is attached and has checked child inheritance.
        for _ in range(180):
            if (out / "launch.json").exists():
                print((out / "launch.json").read_text()); return
            if (out / "failed.txt").exists(): raise RuntimeError((out/"failed.txt").read_text())
            time.sleep(0.5)
        raise TimeoutError(str(out))
    finally: close_desk(hd)

def worker(args):
    try:
        first = name(thread_id())
        child = subprocess.check_output([sys.executable,__file__,"--probe"],text=True).strip()
        if first != args.desktop or child != first: raise RuntimeError(f"Desktop inheritance failed: {first}, {child}")
        cmd = [str(args.pnpm), "run", "test:dots-host", "--soak-hours=168"]
        if args.desktop_notifications: cmd.append("--desktop-notifications")
        with (args.worker/"runner.log").open("wb") as log:
            process = subprocess.Popen(cmd, cwd=root, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            record = {"desktop":first,"childDesktop":child,"runnerPid":process.pid,"command":cmd,"diagnostics":str(args.worker)}
            (args.worker/"launch.json").write_text(json.dumps(record,indent=2))
            code = process.wait()
            (args.worker/"exit.json").write_text(json.dumps({"exitCode":code}))
    except Exception as e:
        (args.worker/"failed.txt").write_text(str(e))
        raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    version = json.loads((root/"package.json").read_text(encoding="utf-8-sig"))["packageManager"].split("@")[1].split("+")[0]
    parser.add_argument("--pnpm",type=Path,default=Path(os.environ["LOCALAPPDATA"])/"node/corepack/v1/pnpm"/version/"pnpm-native.exe")
    parser.add_argument("--worker",type=Path)
    parser.add_argument("--desktop")
    parser.add_argument("--desktop-notifications",action="store_true")
    parser.add_argument("--probe",action="store_true")
    parser.add_argument("--thread",type=int)
    parser.add_argument("--inspect",type=int,nargs="+")
    parser.add_argument("--output",type=Path)
    args = parser.parse_args()
    if args.probe or args.thread: print(name(args.thread or thread_id()))
    elif args.inspect and args.desktop: inspect_peer(args)
    elif args.inspect: inspect_threads(args)
    elif args.worker: worker(args)
    else: start(args)
