import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app, nativeImage } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsComputerUseBackend as ComputerAutomationService } from "../src/main/platform/computer-use/windows/WindowsComputerUseBackend";
import { WindowsAutomationHost } from "../src/main/platform/computer-use/windows/WindowsAutomationHost";
import { WindowsAutomationError, type ControlInfo, type WindowInfo } from "../src/main/platform/computer-use/protocol";

const profile = mkdtempSync(join(tmpdir(), "mybuddy-cu-native-"));
app.setPath("userData", profile); process.env.HOME = profile; process.env.USERPROFILE = profile;

const FORM_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$null=Add-Type -AssemblyName System.Windows.Forms
$null=Add-Type -AssemblyName System.Drawing
$null=Add-Type -AssemblyName PresentationFramework
$null=Add-Type -AssemblyName PresentationCore
$null=Add-Type -AssemblyName WindowsBase
$null=Add-Type -AssemblyName WindowsFormsIntegration
$null=Add-Type -Namespace MyBuddy -Name SmokeNative -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);'
$null=[MyBuddy.SmokeNative]::ShowWindow([MyBuddy.SmokeNative]::GetConsoleWindow(),0)
$null=[MyBuddy.SmokeNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
[Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object Windows.Forms.Form
$form.Text=$env:MYBUDDY_SMOKE_TITLE
$form.Name='MyBuddyComputerUseSmoke'
$form.StartPosition='Manual'
$form.Location=New-Object Drawing.Point(120,120)
$form.Size=New-Object Drawing.Size(420,240)
$form.TopMost=$false
$elementHost=New-Object Windows.Forms.Integration.ElementHost
$elementHost.Dock=[Windows.Forms.DockStyle]::Fill
$stack=New-Object Windows.Controls.StackPanel
$stack.Margin=New-Object Windows.Thickness(30)
$text=New-Object Windows.Controls.TextBox
$text.Name='SmokeTextBox'
$text.Height=28
$text.Margin=New-Object Windows.Thickness(0,0,0,16)
[Windows.Automation.AutomationProperties]::SetName($text,'Smoke TextBox')
[Windows.Automation.AutomationProperties]::SetAutomationId($text,'SmokeTextBox')
$button=New-Object Windows.Controls.Button
$button.Name='SmokeButton'
$button.Content='Smoke Button'
$button.Width=150
$button.Height=36
$button.HorizontalAlignment=[Windows.HorizontalAlignment]::Left
$button.Margin=New-Object Windows.Thickness(0,0,0,16)
[Windows.Automation.AutomationProperties]::SetName($button,'Smoke Button')
[Windows.Automation.AutomationProperties]::SetAutomationId($button,'SmokeButton')
$label=New-Object Windows.Controls.TextBlock
$label.Name='SmokeStatus'
$label.Text='idle'
[Windows.Automation.AutomationProperties]::SetName($label,'idle')
[Windows.Automation.AutomationProperties]::SetAutomationId($label,'SmokeStatus')
$button.Add_Click({$next=if($label.Text -eq 'clicked'){'idle'}else{'clicked'};$label.Text=$next;[Windows.Automation.AutomationProperties]::SetName($label,$next)})
$null=$stack.Children.Add($text)
$null=$stack.Children.Add($button)
$null=$stack.Children.Add($label)
$elementHost.Child=$stack
$form.Controls.Add($elementHost)
[Windows.Forms.Application]::Run($form)
`;

function launchSmoke(title: string): ChildProcessWithoutNullStreams {
  const encoded = Buffer.from(FORM_SCRIPT, "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-OutputFormat", "Text", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MYBUDDY_SMOKE_TITLE: title } },
  );
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { diagnostics += chunk; });
  child.once("exit", (code) => {
    const detail = diagnostics.replace(/^#< CLIXML\s*/i, "").trim();
    if (code !== 0 && detail) console.error(`[smoke-form] exit=${String(code)} ${detail}`);
  });
  return child;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WindowsAutomationError && error.code === code);
}

async function waitForCount(service: ComputerAutomationService, title: string, count: number): Promise<WindowInfo[]> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const listed = await service.execute({ action: "list_windows" });
    const matches = (listed.windows ?? []).filter((item) => item.title === title);
    if (matches.length === count) return matches;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${count} smoke windows`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} did not exit`);
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows smoke requires Windows");
  await app.whenReady();
  const title = `MyBuddy Computer Use Smoke ${process.pid}`;
  const host = new WindowsAutomationHost();
  const service = new ComputerAutomationService(host);
  const processes: ChildProcessWithoutNullStreams[] = [];
  try {
    processes.push(launchSmoke(title));
    await service.execute({ action: "wait_for_window", windowTitle: title, waitState: "visible", timeoutMs: 8_000 });

    const pids = new Set<number>();
    for (let i = 0; i < 20; i++) {
      await service.execute({ action: "list_windows" });
      assert.ok(host.pid);
      pids.add(host.pid!);
    }
    assert.equal(pids.size, 1, "20 readonly requests must reuse one host process");

    const inspected = await service.execute({ action: "inspect_window", windowTitle: title });
    const window = inspected.window!;
    assert.ok(window.windowRect.width > 0 && window.clientRect.width > 0);
    assert.ok(window.dpi >= 96 && window.scaleFactor >= 1);
    const focused = await service.execute({ action: "focus_window", windowHandle: window.handle, processId: window.processId });
    assert.equal((focused.window as WindowInfo).foreground, true);

    const controlsResult = await service.execute({ action: "inspect_controls", windowHandle: window.handle, maxDepth: 6, maxNodes: 100 });
    const controls = controlsResult.controls ?? [];
    if (!controls.some((control) => control.controlType === "Button")) console.log(`[smoke-controls] ${JSON.stringify(controlsResult)}`);
    assert.ok(controls.some((control) => control.controlType === "Button"));
    assert.ok(controls.some((control) => control.controlType === "Edit"));
    await expectCode(service.execute({
      action: "find_control",
      windowHandle: window.handle,
      controlName: "Smoke Button",
      controlType: "Button",
      exactName: true,
      maxDepth: 1,
      maxNodes: 100,
    }), "CONTROL_AMBIGUOUS");
    await expectCode(service.execute({
      action: "find_control",
      windowHandle: window.handle,
      controlName: "Smoke Button",
      controlType: "Button",
      exactName: true,
      maxDepth: 6,
      maxNodes: 5,
    }), "CONTROL_AMBIGUOUS");
    const button = (await service.execute({ action: "find_control", windowHandle: window.handle, controlName: "Smoke Button", controlType: "Button", exactName: true })).control!;
    const textbox = controls.find((control) => control.controlType === "Edit") as ControlInfo;
    assert.ok(button.runtimeId && textbox.runtimeId);

    await service.execute({ action: "set_control_value", windowHandle: window.handle, controlRuntimeId: textbox.runtimeId, text: "hello" });
    await service.execute({ action: "invoke_control", windowHandle: window.handle, controlRuntimeId: button.runtimeId });
    const afterInvoke = await service.execute({ action: "inspect_controls", windowHandle: window.handle, maxDepth: 6, maxNodes: 100 });
    assert.ok((afterInvoke.controls ?? []).some((control) => control.name === "clicked"), "semantic invoke must update label");
    await service.execute({ action: "invoke_control", windowHandle: window.handle, controlRuntimeId: button.runtimeId });
    const reset = await service.execute({ action: "inspect_controls", windowHandle: window.handle, maxDepth: 6, maxNodes: 100 });
    assert.ok((reset.controls ?? []).some((control) => control.name === "idle"), "second semantic invoke must reset click evidence");

    const screenshot = await service.execute({ action: "screenshot_window", windowHandle: window.handle, processId: window.processId, clientOnly: true });
    assert.ok((screenshot.screenshot?.byteLength ?? 0) > 100, "window screenshot must be a non-empty JPEG");
    assert.equal(screenshot.window?.handle, window.handle);
    const imageSize = nativeImage.createFromBuffer(Buffer.from(screenshot.screenshot!)).getSize();
    assert.equal(imageSize.width, Math.round(window.clientRect.width / window.scaleFactor), "screenshot pixels must equal client DIP width");
    assert.equal(imageSize.height, Math.round(window.clientRect.height / window.scaleFactor), "screenshot pixels must equal client DIP height");
    assert.equal((screenshot.capture as { coordinateSpace?: string }).coordinateSpace, "client-dip-aligned-pixels");
    assert.ok(button.clientBoundsDip, "UIA controls must expose client-DIP bounds that share click_client coordinates");
    const buttonCenter = {
      x: button.clientBoundsDip!.x + button.clientBoundsDip!.width / 2,
      y: button.clientBoundsDip!.y + button.clientBoundsDip!.height / 2,
    };
    assert.ok(button.screenBoundsPhysical, "raw UIA screen bounds remain available for diagnostics");
    assert.ok(buttonCenter.x >= 0 && buttonCenter.y >= 0, "button center must be inside the client coordinate space");
    await service.execute({
      action: "click_client",
      windowHandle: window.handle,
      processId: window.processId,
      observationId: screenshot.observationId,
      x: buttonCenter.x,
      y: buttonCenter.y,
    });
    const afterPhysicalClick = await service.execute({ action: "inspect_controls", windowHandle: window.handle, maxDepth: 6, maxNodes: 100 });
    assert.ok((afterPhysicalClick.controls ?? []).some((control) => control.name === "clicked"), "physical client click must hit the smoke button");

    const staleObservation = (await service.execute({ action: "inspect_window", windowHandle: window.handle })).observationId!;
    processes[0].kill();
    await service.execute({ action: "wait_for_window", windowHandle: window.handle, waitState: "closed", timeoutMs: 8_000 });
    processes.push(launchSmoke(title));
    const recreated = (await waitForCount(service, title, 1))[0];
    assert.notEqual(recreated.handle, window.handle, "recreated window must have a new HWND");
    await expectCode(service.execute({
      action: "click_client",
      windowHandle: recreated.handle,
      observationId: staleObservation,
      x: 10,
      y: 10,
    }), "STALE_OBSERVATION");

    processes.push(launchSmoke(title));
    await waitForCount(service, title, 2);
    await expectCode(service.execute({ action: "inspect_window", windowTitle: title }), "WINDOW_AMBIGUOUS");

    const cancelController = new AbortController();
    const cancelledHostPid = host.pid!;
    const cancelStartedAt = Date.now();
    const cancelledWait = service.execute(
      { action: "wait_for_window", windowTitle: "__MyBuddy cancel target__", waitState: "visible", timeoutMs: 30_000 },
      cancelController.signal,
    );
    setTimeout(() => cancelController.abort(), 100);
    await expectCode(cancelledWait, "REQUEST_CANCELLED");
    assert.ok(Date.now() - cancelStartedAt < 2_000, "cancelled wait must stop promptly rather than block the global Computer Use queue");
    await waitForProcessExit(cancelledHostPid);
    await service.execute({ action: "list_windows" });
    assert.ok(host.pid && host.pid !== cancelledHostPid, "next request must restart the host after cancellation");

    const originalHostPid = host.pid!;
    const pending = host.request("wait_for_window", { target: { windowTitle: "__MyBuddy never appears__" }, timeoutMs: 5_000 }, 7_000);
    setTimeout(() => host.simulateCrashForTest(), 100);
    await expectCode(pending, "HOST_UNAVAILABLE");
    await waitForProcessExit(originalHostPid);
    await service.execute({ action: "list_windows" });
    assert.ok(host.pid && host.pid !== originalHostPid, "next request must restart a crashed host");

    const restartedHostPid = host.pid!;
    await service.shutdown();
    assert.equal(host.running, false, "shutdown must not leave an orphan host");
    await waitForProcessExit(restartedHostPid);
    console.log("computer automation Windows smoke PASS (host reuse, UIA, DIP screenshot, physical click, stale target, cancellation, in-flight crash, restart)");
  } finally {
    for (const child of processes) if (child.exitCode == null && !child.killed) child.kill();
    await service.shutdown().catch(() => undefined);
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
