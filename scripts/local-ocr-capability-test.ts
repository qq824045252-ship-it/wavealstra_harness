import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG, type BuiltinCapabilitiesConfigDto } from "../src/shared/builtin-capabilities";
import { LOCAL_OCR_CONNECTION_ID, LOCAL_WHISPER_CONNECTION_ID } from "../src/shared/media-capabilities";
import { BuiltinCapabilityRuntime, type ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { MediaCapabilityServices } from "../src/main/capabilities/MediaCapabilityServices";
import {
  createLocalOcrAdapter,
  defaultLocalOcrCli,
  isLocalOcrAvailable,
  localOcrSearchCandidates,
  localOcrUnavailableMessage,
  parseLocalOcrJson,
  probeLocalOcr,
  resolveLocalOcrCli,
  type LocalOcrRunOptions,
} from "../src/main/capabilities/LocalOcrProvider";
import type { VideoGenerationJob, VideoGenerationJobStore } from "../src/main/capabilities/VideoGenerationJobs";

const OCR_JSON = JSON.stringify({
  pages: [
    {
      texts: [
        { text: "第一行", score: 0.98, box: [[10, 20], [110, 20], [110, 50], [10, 50]] },
        { text: "第二行", score: 0.88, box: [[10, 60], [160, 60], [160, 90], [10, 90]] },
      ],
    },
  ],
});

function clone<T>(value: T): T { return structuredClone(value); }

class MemoryJobs implements VideoGenerationJobStore {
  private readonly values = new Map<string, VideoGenerationJob>();
  get(id: string): VideoGenerationJob | undefined { return clone(this.values.get(id)); }
  list(taskId?: string): VideoGenerationJob[] { return clone([...this.values.values()].filter(job => taskId === undefined || job.taskId === taskId)); }
  findByInvocation(taskId: string, toolCallId: string): VideoGenerationJob | undefined {
    return clone([...this.values.values()].find(job => job.taskId === taskId && job.toolCallId === toolCallId));
  }
  put(job: VideoGenerationJob): void { this.values.set(job.id, clone(job)); }
}

/** 真实 runtime + 内存存储；本机 OCR 的 CLI 解析与执行全部注入，不跑真 CLI。 */
class Fixture {
  configValue: BuiltinCapabilitiesConfigDto;
  cliPath: string | undefined;
  readonly runs: Array<{ cli: string; args: string[]; outputDir?: string }> = [];
  runImpl: (cli: string, args: string[], options: LocalOcrRunOptions) => Promise<{ stdout: string }>;
  readonly runtime: BuiltinCapabilityRuntime;
  readonly manager: MediaCapabilityServices;

  constructor(config: BuiltinCapabilitiesConfigDto, cliPath?: string) {
    this.configValue = clone(config);
    this.cliPath = cliPath;
    this.runImpl = async (_cli, args) => ({ stdout: args[0] === "--help" ? "usage: OCR_NPU_CLI" : OCR_JSON });
    this.runtime = new BuiltinCapabilityRuntime({
      store: {
        read: () => clone(this.configValue),
        write: next => { this.configValue = clone(next); return clone(next); },
      },
      credentials: { has: () => false, get: () => null, set: () => undefined, clear: () => undefined },
    });
    this.manager = new MediaCapabilityServices({
      runtime: this.runtime,
      videoJobs: new MemoryJobs(),
      getMagpieConfig: () => undefined,
      localOcr: {
        resolveCli: () => this.cliPath,
        run: (cli, args, options) => {
          const outputIndex = args.indexOf("--output_dir");
          this.runs.push({ cli, args: [...args], outputDir: outputIndex >= 0 ? args[outputIndex + 1] : undefined });
          return this.runImpl(cli, args, options);
        },
      },
    });
    this.runtime.attachMediaServices(this.manager);
  }

  bindLocalOcr(): void {
    this.configValue.ocr = { enabled: true };
    this.configValue.mediaBindings = {
      ...this.configValue.mediaBindings,
      ocr: { connectionId: LOCAL_OCR_CONNECTION_ID, selection: "manual" },
    };
  }
}

function ocrEnabledConfig(): BuiltinCapabilitiesConfigDto {
  const config = clone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.ocr = { enabled: true };
  return config;
}

/** 显式空环境，避免本机真实 PATH / 安装位置干扰解析结果。 */
function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { LOCALAPPDATA: undefined, ProgramFiles: undefined, PATH: "", ...extra };
}

function fakeCli(directory: string, name = "OCR_NPU_CLI.cmd"): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "fixture", "utf8");
  return path;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-local-ocr-"));
  const originalFetch = globalThis.fetch;
  let unexpectedNetwork = 0;
  globalThis.fetch = (async () => { unexpectedNetwork++; throw new Error("real network disabled in local OCR test"); }) as typeof fetch;
  const failures: string[] = [];
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try { await run(); console.log(`PASS ${name}`); passed++; }
    catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
  };
  const context = (call: string, signal?: AbortSignal): ToolExecutionContext => ({ taskId: "fixture-task", taskRoot: root, toolCallId: call, ...(signal ? { signal } : {}) });
  try {
    await test("parseLocalOcrJson reads text and pixel boxes out of noisy stdout", () => {
      const result = parseLocalOcrJson(`loading model...\n${OCR_JSON}\ndone`);
      assert.equal(result.text, "第一行\n第二行");
      assert.deepEqual(result.boxes, [
        { text: "第一行", x: 10, y: 20, width: 100, height: 30, confidence: 0.98 },
        { text: "第二行", x: 10, y: 60, width: 150, height: 30, confidence: 0.88 },
      ]);
    });

    await test("parseLocalOcrJson never invents boxes and accepts an empty page", () => {
      const withoutBox = parseLocalOcrJson(JSON.stringify({ pages: [{ texts: [{ text: "无框" }] }] }));
      assert.equal(withoutBox.text, "无框");
      assert.equal(Object.hasOwn(withoutBox, "boxes"), false, "missing pixel boxes must stay absent");
      const empty = parseLocalOcrJson(JSON.stringify({ pages: [{ texts: [] }] }));
      assert.equal(empty.text, "");
      assert.equal(Object.hasOwn(empty, "boxes"), false);
      assert.throws(() => parseLocalOcrJson("not json"), /无法解析/);
    });

    await test("parseLocalOcrJson falls back to <image>_ocr.json in the output directory", () => {
      const outputDir = join(root, "ocr-out");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "shot_ocr.json"), OCR_JSON, "utf8");
      const result = parseLocalOcrJson("", outputDir, join(root, "shot.png"));
      assert.equal(result.text, "第一行\n第二行");
      assert.equal(result.boxes?.length, 2);
      assert.throws(() => parseLocalOcrJson("", join(root, "missing-out"), join(root, "shot.png")), /无法解析/);
    });

    await test("resolver honours MYBUDDY_OCR_CLI and MYBUDDY_OCR_DIR before anything else", () => {
      const directory = join(root, "cli-dir");
      const cli = fakeCli(directory);
      assert.equal(resolveLocalOcrCli({ env: cleanEnv({ MYBUDDY_OCR_CLI: cli }) }), cli);
      assert.equal(resolveLocalOcrCli({ env: cleanEnv({ MYBUDDY_OCR_DIR: directory }) }), cli);
      assert.equal(isLocalOcrAvailable({ env: cleanEnv({ MYBUDDY_OCR_DIR: directory }) }), true);
      const empty = join(root, "empty-dir");
      mkdirSync(empty, { recursive: true });
      assert.equal(isLocalOcrAvailable({ env: cleanEnv({ MYBUDDY_OCR_DIR: empty }), homeDir: empty }), false);
    });

    await test("resolver finds the capability-project default location and lists it when absent", () => {
      const home = join(root, "fake-home");
      const expected = defaultLocalOcrCli(home);
      mkdirSync(join(expected, ".."), { recursive: true });
      writeFileSync(expected, "fixture", "utf8");
      const candidates = localOcrSearchCandidates({ env: cleanEnv(), homeDir: home });
      assert.deepEqual(candidates, [join(process.cwd(), "tools", "OCR_NPU", "OCR_NPU_CLI.exe"), expected],
        "the capability-project location is derived from home, not a hardcoded personal path");
      assert.equal(resolveLocalOcrCli({ env: cleanEnv(), homeDir: home }), expected);
      const emptyHome = join(root, "empty-home");
      mkdirSync(emptyHome, { recursive: true });
      assert.equal(resolveLocalOcrCli({ env: cleanEnv(), homeDir: emptyHome }), undefined);
      assert.match(localOcrUnavailableMessage(), /MYBUDDY_OCR_CLI/);
    });

    await test("resolver falls back to PATH", () => {
      const directory = join(root, "path-dir");
      const cli = fakeCli(directory, "OCR_NPU_CLI.exe");
      const home = join(root, "path-home");
      mkdirSync(home, { recursive: true });
      assert.equal(resolveLocalOcrCli({ env: cleanEnv({ PATH: `${directory}${delimiter}/usr/bin` }), homeDir: home }), cli);
    });

    await test("services exposes the built-in local OCR connection next to local Whisper", () => {
      const cli = fakeCli(join(root, "services-cli"));
      const fixture = new Fixture(ocrEnabledConfig(), cli);
      const option = fixture.manager.services().find((entry) => entry.id === LOCAL_OCR_CONNECTION_ID);
      assert.ok(option, "local OCR must appear in the service list the settings dropdown renders");
      assert.equal(option.label, "本机 OCR · NPU");
      assert.equal(option.source, "local");
      assert.deepEqual(option.capabilities, ["ocr"]);
      assert.deepEqual(option.models, {});
      assert.equal(option.allowCustomModel, false);
      assert.equal(option.configured, true);
      assert.equal(option.authState, "none");
      assert.equal(option.location, "loopback");
      assert.match(option.detail ?? "", /本机 NPU 识别/);
      assert.match(option.detail ?? "", /识别正文会进入当前对话/);
      assert.match(option.detail ?? "", new RegExp(cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(fixture.manager.services().some((entry) => entry.id === LOCAL_WHISPER_CONNECTION_ID), "local Whisper stays listed");
      assert.ok(fixture.runtime.snapshot().mediaServices?.some((entry) => entry.id === LOCAL_OCR_CONNECTION_ID), "snapshot.mediaServices is the renderer contract");
    });

    await test("configured follows CLI availability and a local binding never requires a model", () => {
      const cli = fakeCli(join(root, "status-cli"));
      const fixture = new Fixture(ocrEnabledConfig(), cli);
      fixture.bindLocalOcr();
      assert.equal(fixture.manager.status("ocr").state, "unchecked", "no model is required for the local connection");
      assert.equal(fixture.manager.status("ocr").provider, "本机 OCR · NPU");
      assert.equal(fixture.runtime.snapshot().capabilities.find((item) => item.id === "ocr")?.state, "unchecked",
        "snapshot.capabilities (renderer status) reflects the local binding");

      fixture.cliPath = undefined;
      const missing = fixture.manager.services().find((entry) => entry.id === LOCAL_OCR_CONNECTION_ID);
      assert.equal(missing?.configured, false);
      assert.match(missing?.detail ?? "", /MYBUDDY_OCR_CLI/);
      const status = fixture.manager.status("ocr");
      assert.equal(status.state, "needs-configuration");
      assert.match(status.detail ?? "", /MYBUDDY_OCR_CLI/);
      assert.deepEqual(fixture.manager.binding("ocr"), { connectionId: LOCAL_OCR_CONNECTION_ID, selection: "manual" }, "saved binding is preserved");
    });

    await test("check probes the CLI without inference and reports diagnostics", async () => {
      const cli = fakeCli(join(root, "check-cli"));
      const fixture = new Fixture(ocrEnabledConfig(), cli);
      fixture.bindLocalOcr();
      const checked = await fixture.manager.test("ocr");
      assert.equal(checked.ok, true);
      assert.match(checked.detail, /未发送样本/);
      assert.match(checked.detail, /--help 探测通过/);
      assert.match(checked.detail, new RegExp(cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(fixture.runs.length, 1, "only the --help probe runs");
      assert.deepEqual(fixture.runs[0].args, ["--help"]);

      fixture.cliPath = undefined;
      const failed = await fixture.manager.test("ocr");
      assert.equal(failed.ok, false);
      assert.equal(failed.state, "needs-configuration");
      assert.match(failed.detail, /MYBUDDY_OCR_CLI/);
    });

    await test("ocrAdapter runs the CLI once and returns parsed text with pixel boxes", async () => {
      const cli = fakeCli(join(root, "adapter-cli"));
      const fixture = new Fixture(ocrEnabledConfig(), cli);
      fixture.bindLocalOcr();
      const outputDirs: string[] = [];
      fixture.runImpl = async (_cli, args) => {
        const outputDir = args[args.indexOf("--output_dir") + 1];
        outputDirs.push(outputDir);
        assert.equal(existsSync(outputDir), true, "adapter creates the CLI output directory before running it");
        return { stdout: OCR_JSON };
      };
      const imagePath = join(root, "sample.png");
      writeFileSync(imagePath, Buffer.from("fixture-image"));
      const adapter = fixture.runtime.ocrAdapter();
      assert.ok(adapter);
      const result = await adapter.recognize(imagePath, context("ocr-run"));
      assert.equal(result.text, "第一行\n第二行");
      assert.equal(result.boxes?.length, 2);
      assert.deepEqual(fixture.runs[0].args.slice(0, 4), ["--input_path", imagePath, "--json", "--output_dir"]);
      assert.equal(outputDirs.length, 1);
      assert.equal(existsSync(outputDirs[0]), false, "temporary output directory is removed afterwards");
      assert.equal(fixture.manager.status("ocr").state, "ready", "a successful run marks the binding as ready");
      assert.equal(unexpectedNetwork, 0, "local OCR performs no network request");
    });

    await test("ocrAdapter reports a missing CLI and supports cancellation", async () => {
      const fixture = new Fixture(ocrEnabledConfig());
      fixture.bindLocalOcr();
      assert.throws(() => fixture.runtime.ocrAdapter(), /未找到本机 OCR_NPU_CLI/);

      const cli = fakeCli(join(root, "abort-cli"));
      const aborted = new Fixture(ocrEnabledConfig(), cli);
      aborted.bindLocalOcr();
      aborted.runImpl = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
      const imagePath = join(root, "abort.png");
      writeFileSync(imagePath, Buffer.from("fixture-image"));
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(aborted.runtime.ocrAdapter()!.recognize(imagePath, context("ocr-abort", controller.signal)), /已取消/);
    });

    await test("createLocalOcrAdapter and probeLocalOcr share the injected resolver", async () => {
      const imagePath = join(root, "direct.png");
      writeFileSync(imagePath, Buffer.from("fixture-image"));
      const adapter = createLocalOcrAdapter({ resolveCli: () => "fake-ocr-cli", run: async (_cli, args) => ({ stdout: args[0] === "--help" ? "usage" : OCR_JSON }) });
      const result = await adapter.recognize(imagePath, context("direct-run"));
      assert.equal(result.text, "第一行\n第二行");
      assert.match(await probeLocalOcr({ resolveCli: () => "fake-ocr-cli", run: async () => ({ stdout: "usage" }) }), /fake-ocr-cli/);
      await assert.rejects(probeLocalOcr({ resolveCli: () => undefined }), /MYBUDDY_OCR_CLI/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(`FAILED: ${failures.join(" | ")}`);
    process.exitCode = 1;
  }
}

await main();
