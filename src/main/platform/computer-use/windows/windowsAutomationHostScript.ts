/**
 * Persistent Windows automation host. Stdout is reserved for one NDJSON
 * response per request; diagnostics use stderr so protocol framing is stable.
 */
export const WINDOWS_AUTOMATION_HOST_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$null = Add-Type -AssemblyName UIAutomationClient
$null = Add-Type -AssemblyName UIAutomationTypes
$null = Add-Type -AssemblyName System.Windows.Forms
$null = Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MyBuddyWindowsAutomation {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint source, uint target, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  public static void EnablePerMonitorDpi() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }
  public static string Title(IntPtr hWnd) {
    int length = GetWindowTextLength(hWnd); if (length <= 0) return "";
    var text = new StringBuilder(length + 1); GetWindowText(hWnd, text, text.Capacity); return text.ToString();
  }
  public static string ClassName(IntPtr hWnd) {
    var text = new StringBuilder(512); GetClassName(hWnd, text, text.Capacity); return text.ToString();
  }
  public static uint ProcessId(IntPtr hWnd) { uint pid; GetWindowThreadProcessId(hWnd, out pid); return pid; }
  public static bool ForceForeground(IntPtr hWnd) {
    uint ignored;
    uint currentThread = GetCurrentThreadId();
    uint targetThread = GetWindowThreadProcessId(hWnd, out ignored);
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
    bool attachedForeground = false;
    bool attachedTarget = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      if (targetThread != 0 && targetThread != currentThread) attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      BringWindowToTop(hWnd);
      bool requested = SetForegroundWindow(hWnd);
      if (GetForegroundWindow() != hWnd) {
        // This explicit Computer Use action is allowed to switch windows, but
        // must not synthesize Alt and accidentally activate either app's menu.
        // The host still verifies the actual foreground HWND before success.
        try { SwitchToThisWindow(hWnd, false); } catch { }
        requested = SetForegroundWindow(hWnd) || requested;
      }
      if (GetForegroundWindow() == hWnd) {
        SetActiveWindow(hWnd);
        SetFocus(hWnd);
        return true;
      }
      return requested;
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
  public static IntPtr[] TopLevelWindows() {
    var result = new List<IntPtr>();
    EnumWindows((h, p) => { result.Add(h); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
  private static INPUT Mouse(uint flags, int x, int y, int data) {
    var input = new INPUT(); input.type = 0;
    input.U.mi.dx = x; input.U.mi.dy = y; input.U.mi.mouseData = unchecked((uint)data); input.U.mi.dwFlags = flags;
    return input;
  }
  private static INPUT AbsoluteMove(int x, int y) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = Math.Max(2, GetSystemMetrics(78)), height = Math.Max(2, GetSystemMetrics(79));
    int nx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
    int ny = (int)Math.Round((y - top) * 65535.0 / (height - 1));
    return Mouse(0x0001 | 0x8000 | 0x4000, nx, ny, 0);
  }
  private static void CompensatePartial(INPUT[] inputs, uint inserted) {
    var mouseReleases = new HashSet<uint>();
    var keyReleases = new Dictionary<string, INPUT>();
    int count = Math.Min(inputs.Length, (int)inserted);
    for (int index = 0; index < count; index++) {
      INPUT input = inputs[index];
      if (input.type == 0) {
        uint flags = input.U.mi.dwFlags;
        if ((flags & 0x0002) != 0) mouseReleases.Add(0x0004);
        if ((flags & 0x0004) != 0) mouseReleases.Remove(0x0004);
        if ((flags & 0x0008) != 0) mouseReleases.Add(0x0010);
        if ((flags & 0x0010) != 0) mouseReleases.Remove(0x0010);
        if ((flags & 0x0020) != 0) mouseReleases.Add(0x0040);
        if ((flags & 0x0040) != 0) mouseReleases.Remove(0x0040);
      } else if (input.type == 1) {
        uint flags = input.U.ki.dwFlags;
        string key = input.U.ki.wVk.ToString() + ":" + input.U.ki.wScan.ToString() + ":" + ((flags & 0x0004) != 0).ToString();
        if ((flags & 0x0002) != 0) keyReleases.Remove(key);
        else keyReleases[key] = input;
      }
    }
    var releases = new List<INPUT>();
    foreach (uint flags in mouseReleases) releases.Add(Mouse(flags, 0, 0, 0));
    foreach (var pair in keyReleases) {
      INPUT release = pair.Value; release.U.ki.dwFlags |= 0x0002; releases.Add(release);
    }
    if (releases.Count == 0) return;
    INPUT[] releaseArray = releases.ToArray();
    for (int attempt = 0; attempt < 2; attempt++) {
      if (SendInput((uint)releaseArray.Length, releaseArray, Marshal.SizeOf(typeof(INPUT))) == (uint)releaseArray.Length) break;
    }
  }
  private static bool SendBatch(IList<INPUT> inputs) {
    var array = new INPUT[inputs.Count]; inputs.CopyTo(array, 0);
    uint inserted = SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
    if (inserted == (uint)array.Length) return true;
    if (inserted > 0) CompensatePartial(array, inserted);
    return false;
  }
  public static bool SendMouseClickAt(int x, int y, uint down, uint up) {
    return SendBatch(new INPUT[] { AbsoluteMove(x, y), Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0) });
  }
  public static bool SendMouseClickCurrent(uint down, uint up) {
    return SendBatch(new INPUT[] { Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0) });
  }
  public static bool SendMouseClickAtCount(int x, int y, uint down, uint up, int count, int gapMs) {
    if (count < 1 || count > 3) return false;
    // Inject all clicks in one atomic batch so the system sees a double/triple
    // click (an interleaved absolute move can break double-click detection).
    var inputs = new List<INPUT>(); inputs.Add(AbsoluteMove(x, y));
    for (int click = 0; click < count; click++) {
      inputs.Add(Mouse(down, 0, 0, 0));
      inputs.Add(Mouse(up, 0, 0, 0));
    }
    return SendBatch(inputs);
  }
  public static bool SendMouseDownAt(int x, int y, uint down) {
    return SendBatch(new INPUT[] { AbsoluteMove(x, y), Mouse(down, 0, 0, 0) });
  }
  public static bool SendMouseUpAt(int x, int y, uint up) {
    return SendBatch(new INPUT[] { AbsoluteMove(x, y), Mouse(up, 0, 0, 0) });
  }
  public static bool SendMouseDragTimed(int x, int y, int x2, int y2, uint down, uint up, int steps, int durationMs) {
    if (steps < 1) steps = 1;
    if (steps > 60) steps = 60;
    int delay = durationMs > 0 ? Math.Max(0, durationMs / steps) : 0;
    if (!SendMouseDownAt(x, y, down)) return false;
    for (int step = 1; step <= steps; step++) {
      if (delay > 0) System.Threading.Thread.Sleep(delay);
      if (!SendBatch(new INPUT[] { AbsoluteMove(
        (int)Math.Round(x + (x2 - x) * (double)step / steps),
        (int)Math.Round(y + (y2 - y) * (double)step / steps)
      ) })) return false;
    }
    return SendBatch(new INPUT[] { Mouse(up, 0, 0, 0) });
  }
  public static bool SendScrollAtNotches(int x, int y, int notches, bool horizontal) {
    if (notches == 0) return false;
    int direction = notches > 0 ? 1 : -1;
    var inputs = new List<INPUT>(); inputs.Add(AbsoluteMove(x, y));
    uint flag = horizontal ? 0x1000u : 0x0800u;
    for (int index = 0; index < Math.Abs(notches); index++) inputs.Add(Mouse(flag, 0, 0, 120 * direction));
    return SendBatch(inputs);
  }
  public static bool SendKeyStates(byte[] downs, byte[] ups) {
    var inputs = new List<INPUT>();
    foreach (byte key in downs) { var input = new INPUT(); input.type = 1; input.U.ki.wVk = key; inputs.Add(input); }
    for (int index = ups.Length - 1; index >= 0; index--) { var input = new INPUT(); input.type = 1; input.U.ki.wVk = ups[index]; input.U.ki.dwFlags = 0x0002; inputs.Add(input); }
    return SendBatch(inputs);
  }
  public static bool PostMouseClick(IntPtr hwnd, int x, int y, int button, int count) {
    uint down = button == 2 ? 0x0204u : (button == 3 ? 0x0207u : 0x0201u);
    uint up = button == 2 ? 0x0205u : (button == 3 ? 0x0208u : 0x0202u);
    uint doubleClick = button == 1 ? 0x0203u : 0u;
    int wparam = button == 1 ? 1 : (button == 2 ? 2 : 16);
    IntPtr lparam = (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF));
    if (!PostMessage(hwnd, 0x0200u, IntPtr.Zero, lparam)) return false;
    for (int click = 0; click < count; click++) {
      if (!PostMessage(hwnd, down, (IntPtr)wparam, lparam)) return false;
      if (!PostMessage(hwnd, up, IntPtr.Zero, lparam)) return false;
      if (click == 0 && doubleClick != 0) {
        if (!PostMessage(hwnd, doubleClick, (IntPtr)wparam, lparam)) return false;
        if (!PostMessage(hwnd, up, IntPtr.Zero, lparam)) return false;
      }
    }
    return true;
  }
  public static bool SendMouseDrag(int x, int y, int x2, int y2, uint down, uint up) {
    var inputs = new List<INPUT>(); inputs.Add(AbsoluteMove(x, y)); inputs.Add(Mouse(down, 0, 0, 0));
    for (int step = 1; step <= 12; step++) {
      inputs.Add(AbsoluteMove(
        (int)Math.Round(x + (x2 - x) * step / 12.0),
        (int)Math.Round(y + (y2 - y) * step / 12.0)
      ));
    }
    inputs.Add(Mouse(up, 0, 0, 0));
    return SendBatch(inputs);
  }
  public static bool SendScrollAt(int x, int y, int deltaX, int deltaY) {
    var inputs = new List<INPUT>(); inputs.Add(AbsoluteMove(x, y));
    if (deltaY != 0) inputs.Add(Mouse(0x0800, 0, 0, deltaY));
    if (deltaX != 0) inputs.Add(Mouse(0x1000, 0, 0, deltaX));
    return SendBatch(inputs);
  }
  public static bool SendScrollCurrent(int deltaX, int deltaY) {
    var inputs = new List<INPUT>();
    if (deltaY != 0) inputs.Add(Mouse(0x0800, 0, 0, deltaY));
    if (deltaX != 0) inputs.Add(Mouse(0x1000, 0, 0, deltaX));
    return SendBatch(inputs);
  }
  public static bool SendKeyChord(byte[] keys) {
    var inputs = new List<INPUT>();
    foreach (byte key in keys) { var down = new INPUT(); down.type = 1; down.U.ki.wVk = key; inputs.Add(down); }
    for (int index = keys.Length - 1; index >= 0; index--) { var up = new INPUT(); up.type = 1; up.U.ki.wVk = keys[index]; up.U.ki.dwFlags = 0x0002; inputs.Add(up); }
    return SendBatch(inputs);
  }
  public static bool SendUnicode(string text) {
    foreach (char ch in text) {
      INPUT down = new INPUT(); down.type = 1; down.U.ki.wScan = ch; down.U.ki.dwFlags = 0x0004;
      INPUT up = down; up.U.ki.dwFlags = 0x0006;
      if (!SendBatch(new INPUT[] { down, up })) return false;
    }
    return true;
  }
}
'@

$null = Add-Type -TypeDefinition $source
[MyBuddyWindowsAutomation]::EnablePerMonitorDpi()

function New-ErrorResult([string]$code, [string]$message, $details = $null) {
  return @{ __error = @{ code = $code; message = $message; details = $details } }
}

function New-Rect($rect) {
  return [ordered]@{
    left = [int]$rect.Left; top = [int]$rect.Top; right = [int]$rect.Right; bottom = [int]$rect.Bottom
    width = [int]($rect.Right - $rect.Left); height = [int]($rect.Bottom - $rect.Top)
  }
}

function Get-WindowObject([IntPtr]$handle) {
  if (-not [MyBuddyWindowsAutomation]::IsWindow($handle)) { return $null }
  $windowRect = New-Object MyBuddyWindowsAutomation+RECT
  $clientRect = New-Object MyBuddyWindowsAutomation+RECT
  if (-not [MyBuddyWindowsAutomation]::GetWindowRect($handle, [ref]$windowRect)) { return $null }
  if (-not [MyBuddyWindowsAutomation]::GetClientRect($handle, [ref]$clientRect)) { return $null }
  $origin = New-Object MyBuddyWindowsAutomation+POINT
  $origin.X = 0; $origin.Y = 0
  if (-not [MyBuddyWindowsAutomation]::ClientToScreen($handle, [ref]$origin)) { return $null }
  $windowProcessId = [MyBuddyWindowsAutomation]::ProcessId($handle)
  $processName = $null
  try { $processName = [Diagnostics.Process]::GetProcessById([int]$windowProcessId).ProcessName } catch { }
  $dpi = 96
  try { $dpi = [int][MyBuddyWindowsAutomation]::GetDpiForWindow($handle); if ($dpi -le 0) { $dpi = 96 } } catch { $dpi = 96 }
  $monitor = [MyBuddyWindowsAutomation]::MonitorFromWindow($handle, 2)
  $monitorRect = $null
  if ($monitor -ne [IntPtr]::Zero) {
    $monitorInfo = New-Object MyBuddyWindowsAutomation+MONITORINFO
    $monitorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
    if ([MyBuddyWindowsAutomation]::GetMonitorInfo($monitor, [ref]$monitorInfo)) { $monitorRect = New-Rect $monitorInfo.rcMonitor }
  }
  return [ordered]@{
    handle = $handle.ToInt64().ToString()
    processId = [int]$windowProcessId
    processName = $processName
    title = [MyBuddyWindowsAutomation]::Title($handle)
    className = [MyBuddyWindowsAutomation]::ClassName($handle)
    visible = [MyBuddyWindowsAutomation]::IsWindowVisible($handle)
    minimized = [MyBuddyWindowsAutomation]::IsIconic($handle)
    foreground = ([MyBuddyWindowsAutomation]::GetForegroundWindow() -eq $handle)
    windowRect = New-Rect $windowRect
    clientRect = [ordered]@{ x = 0; y = 0; width = [int]($clientRect.Right - $clientRect.Left); height = [int]($clientRect.Bottom - $clientRect.Top) }
    clientOrigin = [ordered]@{ x = [int]$origin.X; y = [int]$origin.Y }
    dpi = $dpi
    scaleFactor = [Math]::Round($dpi / 96.0, 4)
    monitorHandle = if ($monitor -eq [IntPtr]::Zero) { $null } else { $monitor.ToInt64().ToString() }
    monitorRect = $monitorRect
  }
}

function Get-TopWindows([bool]$visibleOnly = $true) {
  $items = [Collections.Generic.List[object]]::new()
  foreach ($handle in [MyBuddyWindowsAutomation]::TopLevelWindows()) {
    if ($visibleOnly -and -not [MyBuddyWindowsAutomation]::IsWindowVisible($handle)) { continue }
    $item = Get-WindowObject $handle
    if ($null -eq $item) { continue }
    if ([string]$item.title -like "__MYBUDDY_COMPUTER_USE_*") { continue }
    if (-not $visibleOnly -or -not [string]::IsNullOrWhiteSpace([string]$item.title)) { $items.Add($item) }
  }
  return @($items)
}

function Resolve-Target($target, [bool]$allowMissing = $false) {
  if ($null -eq $target) { return New-ErrorResult 'WINDOW_NOT_FOUND' 'Window target is required' }
  $handleText = [string]$target.windowHandle
  if (-not [string]::IsNullOrWhiteSpace($handleText)) {
    $number = 0L
    if (-not [Int64]::TryParse($handleText, [ref]$number)) { return New-ErrorResult 'WINDOW_NOT_FOUND' 'Invalid window handle' @{ handle = $handleText } }
    $handle = [IntPtr]::new($number)
    if (-not [MyBuddyWindowsAutomation]::IsWindow($handle)) {
      if ($allowMissing) { return $null }
      return New-ErrorResult 'WINDOW_NOT_FOUND' 'Window handle no longer exists' @{ handle = $handleText }
    }
    $item = Get-WindowObject $handle
    $expectedPid = if ($null -ne $target.expectedProcessId) { [int]$target.expectedProcessId } elseif ($null -ne $target.processId) { [int]$target.processId } else { 0 }
    if ($expectedPid -gt 0 -and $item.processId -ne $expectedPid) {
      return New-ErrorResult 'TARGET_CHANGED' 'Window handle belongs to a different process' @{ expectedProcessId = $expectedPid; actualProcessId = $item.processId; handle = $handleText }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$target.windowTitle) -and $item.title.IndexOf([string]$target.windowTitle, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return New-ErrorResult 'TARGET_CHANGED' 'Window handle does not match the requested title' @{ target = $target; window = $item }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$target.className) -and $item.className -cne [string]$target.className) {
      return New-ErrorResult 'TARGET_CHANGED' 'Window handle does not match the requested class' @{ target = $target; window = $item }
    }
    return $item
  }
  $matches = @(Get-TopWindows $true)
  if ($null -ne $target.processId) { $matches = @($matches | Where-Object { $_.processId -eq [int]$target.processId }) }
  if (-not [string]::IsNullOrWhiteSpace([string]$target.windowTitle)) {
    $needle = [string]$target.windowTitle
    $matches = @($matches | Where-Object { $_.title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$target.className)) {
    $className = [string]$target.className
    $matches = @($matches | Where-Object { $_.className -eq $className })
  }
  if ($matches.Count -eq 0) { if ($allowMissing) { return $null }; return New-ErrorResult 'WINDOW_NOT_FOUND' 'No window matched the target' $target }
  if ($matches.Count -gt 1) { return New-ErrorResult 'WINDOW_AMBIGUOUS' 'Multiple windows matched the target' @{ candidates = $matches } }
  return $matches[0]
}

function Focus-Target($target) {
  $window = Resolve-Target $target
  if ($null -ne $window.__error) { return $window }
  if (-not $window.visible) { return New-ErrorResult 'WINDOW_NOT_VISIBLE' 'Target window is not visible' $window }
  $handle = [IntPtr]::new([Int64]::Parse($window.handle))
  $before = [MyBuddyWindowsAutomation]::GetForegroundWindow().ToInt64().ToString()
  if ($window.minimized) { $null = [MyBuddyWindowsAutomation]::ShowWindow($handle, 9) }
  $null = [MyBuddyWindowsAutomation]::ForceForeground($handle)
  $after = [MyBuddyWindowsAutomation]::GetForegroundWindow()
  for ($attempt = 0; $attempt -lt 20 -and $after -ne $handle; $attempt++) {
    Start-Sleep -Milliseconds 25
    $after = [MyBuddyWindowsAutomation]::GetForegroundWindow()
  }
  if ($after -ne $handle) {
    return New-ErrorResult 'FOCUS_FAILED' 'Target window did not become foreground' @{ expected = $window.handle; foregroundBefore = $before; foregroundAfter = $after.ToInt64().ToString() }
  }
  return [ordered]@{ focused = $true; foregroundBefore = $before; foregroundAfter = $after.ToInt64().ToString(); window = Get-WindowObject $handle }
}

function Get-PatternNames($element) {
  $patterns = [Collections.Generic.List[string]]::new()
  foreach ($entry in @(
    @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
    @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
    @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
    @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  )) {
    $instance = $null
    try { if ($element.TryGetCurrentPattern($entry[1], [ref]$instance)) { $patterns.Add([string]$entry[0]) } } catch { }
  }
  return @($patterns)
}

function Convert-Control($element, [int]$depth, $window = $null) {
  try {
    $current = $element.Current
    $typeName = [string]$current.ControlType.ProgrammaticName
    if ($typeName.StartsWith('ControlType.')) { $typeName = $typeName.Substring(12) }
    $bounds = $current.BoundingRectangle
    $screenBounds = if ($bounds.IsEmpty) { $null } else { [ordered]@{ left = [double]$bounds.Left; top = [double]$bounds.Top; width = [double]$bounds.Width; height = [double]$bounds.Height } }
    $clientBounds = $null
    if ($null -ne $screenBounds -and $null -ne $window -and [double]$window.scaleFactor -gt 0) {
      $clientBounds = [ordered]@{
        x = [Math]::Round(($screenBounds.left - [double]$window.clientOrigin.x) / [double]$window.scaleFactor, 3)
        y = [Math]::Round(($screenBounds.top - [double]$window.clientOrigin.y) / [double]$window.scaleFactor, 3)
        width = [Math]::Round($screenBounds.width / [double]$window.scaleFactor, 3)
        height = [Math]::Round($screenBounds.height / [double]$window.scaleFactor, 3)
      }
    }
    return [ordered]@{
      runtimeId = (($element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.')
      automationId = [string]$current.AutomationId
      name = [string]$current.Name
      controlType = $typeName
      className = [string]$current.ClassName
      frameworkId = [string]$current.FrameworkId
      enabled = [bool]$current.IsEnabled
      offscreen = [bool]$current.IsOffscreen
      keyboardFocusable = [bool]$current.IsKeyboardFocusable
      hasKeyboardFocus = [bool]$current.HasKeyboardFocus
      screenBoundsPhysical = $screenBounds
      clientBoundsDip = $clientBounds
      bounds = if ($null -eq $clientBounds) { $null } else { [ordered]@{ left = $clientBounds.x; top = $clientBounds.y; width = $clientBounds.width; height = $clientBounds.height } }
      patterns = @(Get-PatternNames $element)
      depth = $depth
    }
  } catch { [Console]::Error.WriteLine('[UIA Convert-Control] ' + $_.Exception.Message); return $null }
}

function Get-Controls($window, [int]$maxDepth = 10, [int]$maxNodes = 300) {
  $handle = [IntPtr]::new([Int64]::Parse($window.handle))
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { return [ordered]@{ controls = @(); uiaAvailable = $false; truncated = $false; detail = 'UI Automation root is unavailable' } }
  if ($null -eq $root) { return [ordered]@{ controls = @(); uiaAvailable = $false; truncated = $false; detail = 'UI Automation root is unavailable' } }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue([pscustomobject]@{ Element = $root; Depth = 0 })
  $controls = [Collections.Generic.List[object]]::new()
  $visited = 0
  $truncated = $false
  while ($queue.Count -gt 0) {
    $pair = $queue.Dequeue(); $element = $pair.Element; $depth = [int]$pair.Depth
    $visited++
    if ($visited -gt $maxNodes) { $truncated = $true; break }
    if ($depth -gt 0) {
      $control = Convert-Control $element $depth $window
      if ($null -ne $control) {
        $hasName = -not [string]::IsNullOrWhiteSpace([string]$control['name'])
        $hasAutomationId = -not [string]::IsNullOrWhiteSpace([string]$control['automationId'])
        $meaningfulType = [string]$control['controlType'] -notin @('Pane','Custom','Window')
        if ($hasName -or $hasAutomationId -or $meaningfulType) { $controls.Add($control) }
      }
    }
    if ($depth -ge $maxDepth) {
      try { if ($null -ne $walker.GetFirstChild($element)) { $truncated = $true } } catch { $truncated = $true }
      continue
    }
    try {
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child) {
        if (($visited + $queue.Count) -ge $maxNodes) { $truncated = $true; break }
        $queue.Enqueue([pscustomobject]@{ Element = $child; Depth = ($depth + 1) })
        $child = $walker.GetNextSibling($child)
      }
    } catch { }
  }
  return [ordered]@{ controls = @($controls); uiaAvailable = $true; truncated = $truncated; detail = if ($controls.Count -eq 0) { 'No meaningful controls exposed' } else { $null } }
}

function Select-Control($window, $selector, [int]$maxDepth = 10, [int]$maxNodes = 1000) {
  $tree = Get-Controls $window $maxDepth $maxNodes
  if ($null -ne $tree.__error) { return $tree }
  $matches = @($tree.controls)
  if (-not [string]::IsNullOrWhiteSpace([string]$selector.controlRuntimeId)) { $matches = @($matches | Where-Object { $_.runtimeId -eq [string]$selector.controlRuntimeId }) }
  if (-not [string]::IsNullOrWhiteSpace([string]$selector.automationId)) { $matches = @($matches | Where-Object { $_.automationId -eq [string]$selector.automationId }) }
  if (-not [string]::IsNullOrWhiteSpace([string]$selector.controlType)) { $matches = @($matches | Where-Object { $_.controlType -eq [string]$selector.controlType }) }
  if (-not [string]::IsNullOrWhiteSpace([string]$selector.controlClassName)) { $matches = @($matches | Where-Object { $_.className -eq [string]$selector.controlClassName }) }
  if (-not [string]::IsNullOrWhiteSpace([string]$selector.controlName)) {
    $name = [string]$selector.controlName
    if ([bool]$selector.exactName) { $matches = @($matches | Where-Object { $_.name.Equals($name, [StringComparison]::OrdinalIgnoreCase) }) }
    else { $matches = @($matches | Where-Object { $_.name.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
  }
  if ($tree.truncated) { return New-ErrorResult 'CONTROL_AMBIGUOUS' 'UI Automation search was truncated; uniqueness cannot be established' @{ candidates = $matches; truncated = $true; maxDepth = $maxDepth; maxNodes = $maxNodes } }
  if ($matches.Count -eq 0) { return New-ErrorResult 'CONTROL_NOT_FOUND' 'No UI Automation control matched' $selector }
  if ($matches.Count -gt 1) { return New-ErrorResult 'CONTROL_AMBIGUOUS' 'Multiple UI Automation controls matched' @{ candidates = $matches } }
  return $matches[0]
}

function Find-ControlElement($window, [string]$runtimeId) {
  $handle = [IntPtr]::new([Int64]::Parse($window.handle))
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue($root)
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt 2000) {
    $element = $queue.Dequeue(); $visited++
    try { if ((($element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') -eq $runtimeId) { return $element } } catch { }
    try {
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child) {
        if (($visited + $queue.Count) -ge 2000) { break }
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch { }
  }
  return $null
}

function Get-ClientPoint($target, [double]$x, [double]$y) {
  $focused = Focus-Target $target
  if ($null -ne $focused.__error) { return $focused }
  $window = $focused.window
  $physicalX = [Math]::Round($x * $window.scaleFactor)
  $physicalY = [Math]::Round($y * $window.scaleFactor)
  if ($physicalX -lt 0 -or $physicalY -lt 0 -or $physicalX -ge $window.clientRect.width -or $physicalY -ge $window.clientRect.height) {
    return New-ErrorResult 'POINT_OUTSIDE_CLIENT' 'Client point is outside the target window' @{ x = $x; y = $y; physicalX = $physicalX; physicalY = $physicalY; clientRect = $window.clientRect; scaleFactor = $window.scaleFactor }
  }
  $point = New-Object MyBuddyWindowsAutomation+POINT; $point.X = $physicalX; $point.Y = $physicalY
  $handle = [IntPtr]::new([Int64]::Parse($window.handle))
  if (-not [MyBuddyWindowsAutomation]::ClientToScreen($handle, [ref]$point)) { return New-ErrorResult 'TARGET_CHANGED' 'ClientToScreen failed for target' $window }
  return [ordered]@{ window = $window; x = [int]$point.X; y = [int]$point.Y; foregroundBefore = $focused.foregroundBefore; foregroundAfter = $focused.foregroundAfter }
}

function Confirm-InputTarget($window) {
  $handle = [IntPtr]::new([Int64]::Parse([string]$window.handle))
  if (-not [MyBuddyWindowsAutomation]::IsWindow($handle)) { return New-ErrorResult 'TARGET_CHANGED' 'Target closed before input injection' $window }
  $actualProcessId = [int][MyBuddyWindowsAutomation]::ProcessId($handle)
  if ($actualProcessId -ne [int]$window.processId) { return New-ErrorResult 'TARGET_CHANGED' 'Target handle changed process before input injection' @{ expected = $window.processId; actual = $actualProcessId } }
  if ([MyBuddyWindowsAutomation]::GetForegroundWindow() -ne $handle) { return New-ErrorResult 'FOCUS_FAILED' 'Target lost foreground before input injection' $window }
  return $null
}

function Get-MouseFlags([string]$button, [bool]$down) {
  if ($button -eq 'right') { return $(if ($down) { 0x0008 } else { 0x0010 }) }
  if ($button -eq 'middle') { return $(if ($down) { 0x0020 } else { 0x0040 }) }
  return $(if ($down) { 0x0002 } else { 0x0004 })
}

function Invoke-Dispatch([string]$action, $params) {
  switch ($action) {
    'active_window' { $handle = [MyBuddyWindowsAutomation]::GetForegroundWindow(); return Get-WindowObject $handle }
    'list_windows' { return @(Get-TopWindows $true) }
    'inspect_window' { return Resolve-Target $params.target }
    'focus_window' { return Focus-Target $params.target }
    'wait_for_window' {
      $timeout = if ($null -ne $params.timeoutMs) { [Math]::Min(30000, [Math]::Max(100, [int]$params.timeoutMs)) } else { 5000 }
      $state = if ([string]::IsNullOrWhiteSpace([string]$params.state)) { 'visible' } else { [string]$params.state }
      $deadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
      do {
        $window = Resolve-Target $params.target $true
        if ($null -ne $window -and $null -ne $window.__error) { return $window }
        if ($state -eq 'closed' -and $null -eq $window) { return [ordered]@{ matched = $true; state = $state; window = $null } }
        if ($null -ne $window -and (($state -eq 'visible' -and $window.visible) -or ($state -eq 'foreground' -and $window.foreground))) { return [ordered]@{ matched = $true; state = $state; window = $window } }
        Start-Sleep -Milliseconds 100
      } while ([DateTime]::UtcNow -lt $deadline)
      return New-ErrorResult 'WAIT_TIMEOUT' 'Timed out waiting for window state' @{ state = $state; timeoutMs = $timeout; target = $params.target }
    }
    'inspect_controls' {
      $window = Resolve-Target $params.target; if ($null -ne $window.__error) { return $window }
      $depth = if ($null -ne $params.maxDepth) { [Math]::Min(32, [Math]::Max(1, [int]$params.maxDepth)) } else { 10 }
      $nodes = if ($null -ne $params.maxNodes) { [Math]::Min(1000, [Math]::Max(1, [int]$params.maxNodes)) } else { 300 }
      $result = Get-Controls $window $depth $nodes; $result.window = $window; return $result
    }
    'find_control' {
      $window = Resolve-Target $params.target; if ($null -ne $window.__error) { return $window }
      $depth = if ($null -ne $params.maxDepth) { [Math]::Min(32, [Math]::Max(1, [int]$params.maxDepth)) } else { 10 }
      $nodes = if ($null -ne $params.maxNodes) { [Math]::Min(1000, [Math]::Max(1, [int]$params.maxNodes)) } else { 1000 }
      $control = Select-Control $window $params.selector $depth $nodes; if ($null -ne $control.__error) { return $control }
      return [ordered]@{ window = $window; control = $control }
    }
    'invoke_control' {
      $focused = Focus-Target $params.target; if ($null -ne $focused.__error) { return $focused }; $window = $focused.window
      $depth = if ($null -ne $params.maxDepth) { [Math]::Min(32, [Math]::Max(1, [int]$params.maxDepth)) } else { 10 }
      $nodes = if ($null -ne $params.maxNodes) { [Math]::Min(1000, [Math]::Max(1, [int]$params.maxNodes)) } else { 1000 }
      $control = Select-Control $window $params.selector $depth $nodes; if ($null -ne $control.__error) { return $control }
      $element = Find-ControlElement $window $control.runtimeId; if ($null -eq $element) { return New-ErrorResult 'CONTROL_NOT_FOUND' 'Control disappeared before invocation' $control }
      try {
        if (-not [bool]$element.Current.IsEnabled) { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control is disabled' $control }
        if ([bool]$element.Current.IsOffscreen) { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control is offscreen' $control }
      } catch { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control state is unavailable before invocation' $control }
      $pattern = $null; $kind = $null
      try {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); $kind = 'Invoke' }
        elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); $kind = 'SelectionItem' }
        elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); $kind = 'Toggle' }
        elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); $kind = 'ExpandCollapse' }
        else { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control exposes no supported semantic action' $control }
      } catch { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' $_.Exception.Message $control }
      return [ordered]@{ window = Get-WindowObject ([IntPtr]::new([Int64]::Parse($window.handle))); control = $control; invokedPattern = $kind }
    }
    'set_control_value' {
      $focused = Focus-Target $params.target; if ($null -ne $focused.__error) { return $focused }; $window = $focused.window
      $depth = if ($null -ne $params.maxDepth) { [Math]::Min(32, [Math]::Max(1, [int]$params.maxDepth)) } else { 10 }
      $nodes = if ($null -ne $params.maxNodes) { [Math]::Min(1000, [Math]::Max(1, [int]$params.maxNodes)) } else { 1000 }
      $control = Select-Control $window $params.selector $depth $nodes; if ($null -ne $control.__error) { return $control }
      $element = Find-ControlElement $window $control.runtimeId; if ($null -eq $element) { return New-ErrorResult 'CONTROL_NOT_FOUND' 'Control disappeared before value update' $control }
      try {
        if (-not [bool]$element.Current.IsEnabled) { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control is disabled' $control }
        if ([bool]$element.Current.IsOffscreen) { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control is offscreen' $control }
      } catch { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control state is unavailable before value update' $control }
      $pattern = $null
      try {
        if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -or $pattern.Current.IsReadOnly) { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' 'Control does not expose a writable ValuePattern' $control }
        $pattern.SetValue([string]$params.value)
      } catch { return New-ErrorResult 'CONTROL_NOT_ACTIONABLE' $_.Exception.Message $control }
      return [ordered]@{ window = Get-WindowObject ([IntPtr]::new([Int64]::Parse($window.handle))); control = $control; valueSet = $true }
    }
    'move_client' {
      $point = Get-ClientPoint $params.target $params.x $params.y; if ($null -ne $point.__error) { return $point }
      if (-not [MyBuddyWindowsAutomation]::SetCursorPos($point.x, $point.y)) { return New-ErrorResult 'TARGET_CHANGED' 'SetCursorPos failed' $point }
      return $point
    }
    'click_client' {
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      $buttonNumber = if ($button -eq 'right') { 2 } elseif ($button -eq 'middle') { 3 } else { 1 }
      $count = if ($null -ne $params.clickCount) { [Math]::Min(3, [Math]::Max(1, [int]$params.clickCount)) } else { 1 }
      if ([bool]$params.background) {
        $window = Resolve-Target $params.target; if ($null -ne $window.__error) { return $window }
        $physicalX = [Math]::Round([double]$params.x * [double]$window.scaleFactor)
        $physicalY = [Math]::Round([double]$params.y * [double]$window.scaleFactor)
        if ($physicalX -lt 0 -or $physicalY -lt 0 -or $physicalX -ge $window.clientRect.width -or $physicalY -ge $window.clientRect.height) {
          return New-ErrorResult 'POINT_OUTSIDE_CLIENT' 'Client point is outside the target window' @{ x = $params.x; y = $params.y; physicalX = $physicalX; physicalY = $physicalY; clientRect = $window.clientRect; scaleFactor = $window.scaleFactor }
        }
        $handle = [IntPtr]::new([Int64]::Parse($window.handle))
        if (-not [MyBuddyWindowsAutomation]::PostMouseClick($handle, $physicalX, $physicalY, $buttonNumber, $count)) {
          return New-ErrorResult 'TARGET_CHANGED' 'Background click message post failed' $window
        }
        return [ordered]@{ background = $true; posted = $true; window = $window; x = $physicalX; y = $physicalY; button = $button; clickCount = $count }
      }
      $point = Get-ClientPoint $params.target $params.x $params.y; if ($null -ne $point.__error) { return $point }
      $guard = Confirm-InputTarget $point.window; if ($null -ne $guard) { return $guard }
      $downs = @(); if ($null -ne $params.modifiers) { $downs = @($params.modifiers | ForEach-Object { [byte][int]$_ }) }
      $ok = $true
      if ($downs.Count -gt 0) { $ok = [MyBuddyWindowsAutomation]::SendKeyStates([byte[]]$downs, [byte[]]@()) }
      if ($ok) {
        $hold = if ($null -ne $params.holdMs) { [Math]::Min(5000, [Math]::Max(0, [int]$params.holdMs)) } else { 0 }
        if ($hold -gt 0) {
          $ok = [MyBuddyWindowsAutomation]::SendMouseDownAt($point.x, $point.y, (Get-MouseFlags $button $true))
          if ($ok) { Start-Sleep -Milliseconds $hold; $ok = [MyBuddyWindowsAutomation]::SendMouseUpAt($point.x, $point.y, (Get-MouseFlags $button $false)) }
        } else {
          $ok = [MyBuddyWindowsAutomation]::SendMouseClickAtCount($point.x, $point.y, (Get-MouseFlags $button $true), (Get-MouseFlags $button $false), $count, 60)
        }
      }
      if ($downs.Count -gt 0) { $null = [MyBuddyWindowsAutomation]::SendKeyStates([byte[]]@(), [byte[]]$downs) }
      if (-not $ok) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic click injection failed' $point }
      return $point
    }
    'mouse_down_client' {
      $point = Get-ClientPoint $params.target $params.x $params.y; if ($null -ne $point.__error) { return $point }
      $guard = Confirm-InputTarget $point.window; if ($null -ne $guard) { return $guard }
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      if (-not [MyBuddyWindowsAutomation]::SendMouseDownAt($point.x, $point.y, (Get-MouseFlags $button $true))) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic mouse down failed' $point }
      return $point
    }
    'mouse_up_client' {
      $point = Get-ClientPoint $params.target $params.x $params.y; if ($null -ne $point.__error) { return $point }
      $guard = Confirm-InputTarget $point.window; if ($null -ne $guard) { return $guard }
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      if (-not [MyBuddyWindowsAutomation]::SendMouseUpAt($point.x, $point.y, (Get-MouseFlags $button $false))) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic mouse up failed' $point }
      return $point
    }
    'drag_client' {
      $start = Get-ClientPoint $params.target $params.x $params.y; if ($null -ne $start.__error) { return $start }
      $finish = Get-ClientPoint $params.target $params.x2 $params.y2; if ($null -ne $finish.__error) { return $finish }
      if ($start.window.handle -ne $finish.window.handle -or $start.window.processId -ne $finish.window.processId) { return New-ErrorResult 'TARGET_CHANGED' 'Target changed while preparing drag' }
      $guard = Confirm-InputTarget $finish.window; if ($null -ne $guard) { return $guard }
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      $steps = if ($null -ne $params.steps) { [Math]::Min(60, [Math]::Max(1, [int]$params.steps)) } else { 12 }
      $duration = if ($null -ne $params.durationMs) { [Math]::Min(10000, [Math]::Max(0, [int]$params.durationMs)) } else { 0 }
      if (-not [MyBuddyWindowsAutomation]::SendMouseDragTimed($start.x, $start.y, $finish.x, $finish.y, (Get-MouseFlags $button $true), (Get-MouseFlags $button $false), $steps, $duration)) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic drag injection failed' $finish }; return $finish
    }
    'drag_screen' {
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      $steps = if ($null -ne $params.steps) { [Math]::Min(60, [Math]::Max(1, [int]$params.steps)) } else { 12 }
      $duration = if ($null -ne $params.durationMs) { [Math]::Min(10000, [Math]::Max(0, [int]$params.durationMs)) } else { 0 }
      if (-not [MyBuddyWindowsAutomation]::SendMouseDragTimed([int]$params.x, [int]$params.y, [int]$params.x2, [int]$params.y2, (Get-MouseFlags $button $true), (Get-MouseFlags $button $false), $steps, $duration)) { return New-ErrorResult 'TARGET_CHANGED' 'Cross-window drag injection failed' }; return @{ legacy = $true; crossWindow = $true }
    }
    'scroll_client' {
      $window = Resolve-Target $params.target; if ($null -ne $window.__error) { return $window }
      $x = if ($null -ne $params.x) { [double]$params.x } else { ($window.clientRect.width / $window.scaleFactor) / 2 }
      $y = if ($null -ne $params.y) { [double]$params.y } else { ($window.clientRect.height / $window.scaleFactor) / 2 }
      $point = Get-ClientPoint $params.target $x $y; if ($null -ne $point.__error) { return $point }
      $guard = Confirm-InputTarget $point.window; if ($null -ne $guard) { return $guard }
      $notches = if ($null -ne $params.notches) { [int]$params.notches } else { 0 }
      if ($notches -ne 0) {
        $notches = [Math]::Min(50, [Math]::Max(-50, $notches))
        if (-not [MyBuddyWindowsAutomation]::SendScrollAtNotches($point.x, $point.y, $notches, $false)) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic scroll injection failed' $point }
        return [ordered]@{ window = $point.window; x = $point.x; y = $point.y; notches = $notches; foregroundBefore = $point.foregroundBefore; foregroundAfter = $point.foregroundAfter }
      }
      $dx = if ($null -ne $params.deltaX) { [int]$params.deltaX } else { 0 }; $dy = if ($null -ne $params.deltaY) { [int]$params.deltaY } else { 0 }
      if ($dx -eq 0 -and $dy -eq 0) { return New-ErrorResult 'POINT_OUTSIDE_CLIENT' 'Scroll delta must be non-zero' }
      if (-not [MyBuddyWindowsAutomation]::SendScrollAt($point.x,$point.y,$dx,$dy)) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic scroll injection failed' $point }; return $point
    }
    'mouse_move' { if (-not [MyBuddyWindowsAutomation]::SetCursorPos([int]$params.x,[int]$params.y)) { return New-ErrorResult 'TARGET_CHANGED' 'Legacy cursor positioning failed' }; return @{ legacy = $true } }
    'mouse_click' {
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      $ok = if ($null -ne $params.x -and $null -ne $params.y) { [MyBuddyWindowsAutomation]::SendMouseClickAt([int]$params.x,[int]$params.y,(Get-MouseFlags $button $true),(Get-MouseFlags $button $false)) } else { [MyBuddyWindowsAutomation]::SendMouseClickCurrent((Get-MouseFlags $button $true),(Get-MouseFlags $button $false)) }
      if (-not $ok) { return New-ErrorResult 'TARGET_CHANGED' 'Legacy atomic click injection failed' }; return @{ legacy = $true }
    }
    'mouse_drag' {
      $button = if ([string]::IsNullOrWhiteSpace([string]$params.button)) { 'left' } else { [string]$params.button }
      if (-not [MyBuddyWindowsAutomation]::SendMouseDrag([int]$params.x,[int]$params.y,[int]$params.x2,[int]$params.y2,(Get-MouseFlags $button $true),(Get-MouseFlags $button $false))) { return New-ErrorResult 'TARGET_CHANGED' 'Legacy atomic drag injection failed' }; return @{ legacy = $true }
    }
    'scroll' { if (-not [MyBuddyWindowsAutomation]::SendScrollCurrent([int]$params.deltaX,[int]$params.deltaY)) { return New-ErrorResult 'TARGET_CHANGED' 'Legacy atomic scroll injection failed' }; return @{ legacy = $true } }
    'key_press' {
      if ($null -ne $params.target) {
        $focused = Focus-Target $params.target; if ($null -ne $focused.__error) { return $focused }
        $guard = Confirm-InputTarget $focused.window; if ($null -ne $guard) { return $guard }
      }
      $keys = @([string]$params.key -split '\+' | ForEach-Object { [byte][int][Enum]::Parse([Windows.Forms.Keys], $_, $true) })
      if (-not [MyBuddyWindowsAutomation]::SendKeyChord([byte[]]$keys)) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic key chord injection failed' }; return @{ targeted = ($null -ne $params.target) }
    }
    'type_text' {
      $value = [string]$params.text
      if ($null -eq $params.target) {
        if (-not [MyBuddyWindowsAutomation]::SendUnicode($value)) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic Unicode input injection failed' }
        return @{ targeted = $false; length = $value.Length }
      }
      $focused = Focus-Target $params.target
      if ($null -ne $focused.__error) { return $focused }
      $typedLength = 0
      foreach ($character in $value.ToCharArray()) {
        $changed = Confirm-InputTarget $focused.window
        if ($null -ne $changed) {
          if ($typedLength -eq 0) { return $changed }
          return @{ targeted = $true; completed = $false; typedLength = $typedLength; requestedLength = $value.Length; stopReason = $changed.__error }
        }
        if (-not [MyBuddyWindowsAutomation]::SendUnicode([string]$character)) {
          if ($typedLength -eq 0) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic Unicode input injection failed' }
          return @{ targeted = $true; completed = $false; typedLength = $typedLength; requestedLength = $value.Length; stopReason = @{ code = 'TARGET_CHANGED'; message = 'Atomic Unicode input injection failed' } }
        }
        $typedLength++
        $changed = Confirm-InputTarget $focused.window
        if ($null -ne $changed) { return @{ targeted = $true; completed = $false; typedLength = $typedLength; requestedLength = $value.Length; stopReason = $changed.__error } }
      }
      return @{ targeted = $true; completed = $true; typedLength = $typedLength; requestedLength = $value.Length; length = $value.Length }
    }
    'key_down' {
      if ($null -ne $params.target) {
        $focused = Focus-Target $params.target; if ($null -ne $focused.__error) { return $focused }
        $guard = Confirm-InputTarget $focused.window; if ($null -ne $guard) { return $guard }
      }
      $keys = @([string]$params.key -split '\+' | ForEach-Object { [byte][int][Enum]::Parse([Windows.Forms.Keys], $_, $true) })
      if (-not [MyBuddyWindowsAutomation]::SendKeyStates([byte[]]$keys, [byte[]]@())) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic key down injection failed' }
      return @{ targeted = ($null -ne $params.target); down = $true }
    }
    'key_up' {
      if ($null -ne $params.target) {
        $focused = Focus-Target $params.target; if ($null -ne $focused.__error) { return $focused }
        $guard = Confirm-InputTarget $focused.window; if ($null -ne $guard) { return $guard }
      }
      $keys = @([string]$params.key -split '\+' | ForEach-Object { [byte][int][Enum]::Parse([Windows.Forms.Keys], $_, $true) })
      if (-not [MyBuddyWindowsAutomation]::SendKeyStates([byte[]]@(), [byte[]]$keys)) { return New-ErrorResult 'TARGET_CHANGED' 'Atomic key up injection failed' }
      return @{ targeted = ($null -ne $params.target); up = $true }
    }
    'capture_window_background' {
      $window = Resolve-Target $params.target; if ($null -ne $window.__error) { return $window }
      if ($window.minimized) { return New-ErrorResult 'WINDOW_NOT_VISIBLE' 'Target window is minimized; background capture needs a visible window' $window }
      $handle = [IntPtr]::new([Int64]::Parse($window.handle))
      $width = [int]$window.windowRect.width; $height = [int]$window.windowRect.height
      if ($width -le 0 -or $height -le 0) { return New-ErrorResult 'CAPTURE_FAILED' 'Target window has no drawable size' $window }
      $bitmap = New-Object System.Drawing.Bitmap $width, $height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $hdc = $graphics.GetHdc()
      try { $printed = [MyBuddyWindowsAutomation]::PrintWindow($handle, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
      if (-not $printed) { $bitmap.Dispose(); return New-ErrorResult 'CAPTURE_FAILED' 'PrintWindow failed for the target window' $window }
      $bitmap.Save([string]$params.path, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Dispose()
      return [ordered]@{ window = $window; path = [string]$params.path; width = $width; height = $height }
    }
    'shutdown' { return @{ shutdown = $true } }
    default { return New-ErrorResult 'HOST_PROTOCOL_ERROR' ('Unsupported action: ' + $action) }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $result = Invoke-Dispatch ([string]$request.action) $request.params
    if ($null -ne $result.__error) { $response = @{ id = [string]$request.id; ok = $false; error = $result.__error } }
    else { $response = @{ id = [string]$request.id; ok = $true; result = $result } }
  } catch {
    $response = @{ id = if ($null -ne $request) { [string]$request.id } else { '' }; ok = $false; error = @{ code = 'HOST_PROTOCOL_ERROR'; message = $_.Exception.Message } }
    [Console]::Error.WriteLine('[WindowsAutomationHost] ' + $_.Exception.ToString())
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 16 -Compress))
  [Console]::Out.Flush()
  if ($null -ne $request -and [string]$request.action -eq 'shutdown') { break }
}
`;
