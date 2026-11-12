import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";

export interface SnapshotHashResult { valid: boolean; bytesRead: number; digest?: string }
export type SnapshotReadResult = (SnapshotHashResult & { status: "read" })
  | { status: "budget"; valid: false; bytesRead: 0; digest?: undefined };
export interface WindowsSnapshotRequest { path: string; size: number; identity: { dev: bigint; ino: bigint } }

// The process owns the native handle, not a pathname passed back to Node. Node's
// Windows fs flags cannot express FILE_FLAG_OPEN_REPARSE_POINT. Share-read only
// excludes concurrent writers/deletion; final canonical path + file identity are
// checked before and after bounded reads. The process timeout also bounds device
// or filesystem driver stalls without blocking the Electron main indefinitely.
const nativeReader = String.raw`
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace MyBuddy {
  public sealed class SnapshotResult { public string status="read"; public bool valid; public long bytesRead; public string digest; }
  public static class SnapshotReader {
    [StructLayout(LayoutKind.Sequential)] struct Info {
      public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
    static Info Inspect(SafeFileHandle handle) {
      Info value; if (!GetFileInformationByHandle(handle, out value)) throw new Win32Exception();
      if ((value.Attributes & (0x400u | 0x10u | 0x40u)) != 0 || GetFileType(handle) != 1) throw new IOException("Not a regular disk file");
      return value;
    }
    static bool Same(Info a, Info b) {
      return a.Attributes==b.Attributes && a.Volume==b.Volume && a.IndexHigh==b.IndexHigh && a.IndexLow==b.IndexLow
        && a.SizeHigh==b.SizeHigh && a.SizeLow==b.SizeLow && a.WriteHigh==b.WriteHigh && a.WriteLow==b.WriteLow
        && a.CreationHigh==b.CreationHigh && a.CreationLow==b.CreationLow;
    }
    static void CheckPath(string path) {
      string current = path;
      while (!String.IsNullOrEmpty(current)) {
        var attributes = File.GetAttributes(current);
        if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0) throw new IOException("Reparse path");
        current = Path.GetDirectoryName(current);
      }
    }
    static void CheckFinalPath(SafeFileHandle handle, string expected) {
      var path = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
      if (length==0 || length>=path.Capacity || !String.Equals(path.ToString(), @"\\?\"+expected, StringComparison.OrdinalIgnoreCase))
        throw new IOException("Redirected disk file");
    }
    public static SnapshotResult Hash(string path, long size, int chunkBytes, string expectedDevice, string expectedInode) {
      var result = new SnapshotResult();
      try {
        if(String.IsNullOrEmpty(path)) return result;
        path = Path.GetFullPath(path); CheckPath(path);
        using (var handle = CreateFileW(path, 0x80000000u, 1, IntPtr.Zero, 3, 0x00200000u | 0x08000000u, IntPtr.Zero)) {
          if (handle.IsInvalid) throw new Win32Exception();
          var before = Inspect(handle);
          if (before.Volume!=UInt64.Parse(expectedDevice) || (((ulong)before.IndexHigh<<32)|before.IndexLow)!=UInt64.Parse(expectedInode)) return result;
          if ((((long)before.SizeHigh << 32) | before.SizeLow) != size) return result;
          CheckFinalPath(handle,path); CheckPath(path);
          using (var stream = new FileStream(handle,FileAccess.Read,chunkBytes,false))
          using (var hash = SHA256.Create()) {
            var chunk = new byte[chunkBytes];
            while(result.bytesRead<size) {
              int count = stream.Read(chunk,0,(int)Math.Min(chunk.Length,size-result.bytesRead));
              if(count==0) return result;
              result.bytesRead+=count; hash.TransformBlock(chunk,0,count,chunk,0);
            }
            hash.TransformFinalBlock(new byte[0],0,0);
            var after = Inspect(handle); CheckFinalPath(handle,path); CheckPath(path);
            if(!Same(before,after)) return result;
            result.digest = BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();
            result.valid = true;
          }
        }
      } catch { result.valid=false; }
      return result;
    }
    public static SnapshotResult[] HashBatch(string[] paths, long[] sizes, string[] devices, string[] inodes, long budget, int chunkBytes) {
      var results=new SnapshotResult[paths.Length];
      for(int index=0;index<paths.Length;index++) {
        if(sizes[index]>budget) { results[index]=new SnapshotResult{status="budget"}; continue; }
        results[index]=Hash(paths[index],sizes[index],chunkBytes,devices[index],inodes[index]);
        budget-=results[index].bytesRead;
      }
      return results;
    }
  }
}`;

export function hashWindowsSnapshot(path: string, size: number, chunkBytes: number, identity: { dev: bigint; ino: bigint }): SnapshotHashResult {
  return hashWindowsSnapshots([{ path, size, identity }], size, chunkBytes)[0] ?? { valid: false, bytesRead: size };
}

/** One native process/compiler per bounded list, never one per file. */
export function hashWindowsSnapshots(requests: WindowsSnapshotRequest[], budget: number, chunkBytes: number): SnapshotReadResult[] {
  if (!requests.length) return [];
  const script = `$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n${nativeReader}\n'@;`
    + `$r=@([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MYBUDDY_SNAPSHOT_READS)) | ConvertFrom-Json);`
    + `$results=[MyBuddy.SnapshotReader]::HashBatch([string[]]@($r | ForEach-Object {$_.path}),[long[]]@($r | ForEach-Object {$_.size}),`
    + `[string[]]@($r | ForEach-Object {$_.device}),[string[]]@($r | ForEach-Object {$_.inode}),${budget},${chunkBytes});`
    + `ConvertTo-Json -InputObject @($results) -Compress`;
  const payload = requests.map(request => ({ path: request.path, size: request.size,
    device: request.identity.dev.toString(), inode: request.identity.ino.toString() }));
  try {
    const raw = execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MYBUDDY_SNAPSHOT_READS: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") } });
    const results = z.array(z.object({ status: z.enum(["read", "budget"]), valid: z.boolean(), bytesRead: z.number().int().nonnegative(),
      digest: z.string().regex(/^[a-f0-9]{64}$/).nullable() })).length(requests.length).parse(JSON.parse(raw));
    let remaining = budget;
    for (const [index, result] of results.entries()) {
      if (result.bytesRead > requests[index].size || result.bytesRead > remaining
        || result.status === "budget" && (result.valid || result.bytesRead !== 0 || requests[index].size <= remaining)
        || result.valid && (result.bytesRead !== requests[index].size || !result.digest)) throw new Error("Invalid native read accounting");
      remaining -= result.bytesRead;
    }
    return results.map(value => value.status === "budget" ? { status: "budget", valid: false, bytesRead: 0 }
      : { ...value, status: "read", digest: value.digest ?? undefined });
  } catch {
    // A killed/failed helper may already have consumed its entire allowed read.
    let remaining = budget;
    return requests.map(request => {
      if (request.size > remaining) return { status: "budget", valid: false, bytesRead: 0 };
      remaining -= request.size;
      return { status: "read", valid: false, bytesRead: request.size };
    });
  }
}
