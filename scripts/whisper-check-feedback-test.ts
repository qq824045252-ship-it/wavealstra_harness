/**
 * 本机 Whisper「检查」反馈回归用例。
 *
 * 背景：设置 → 工具能力 → 语音与图像 →「语音转文字」选「本机 Whisper · NPU」后点「检查」，
 * provider.test() 只回一句泛化文本（root/环境/缺失项全丢），上层又把它丢弃，用户看不到任何信息。
 * 这里锁住 main 侧的契约：
 *   1) 资源缺失 → 可诊断的缺失信息（root / pythonSource / modelDir / 缺哪个文件）；
 *   2) 资源齐全 → 文本必须带 root / pythonSource / modelDir，并包含一次「无推理」依赖探测的结果；
 *   3) 依赖探测失败/进程异常 → 检查判为失败态（test() 抛出，由上层 catch 转 ok:false），消息带原因与路径；
 *   4) 默认探测实现自身失败（解释器不存在）也要返回可读 detail。
 *
 * 不跑模型推理、不需要音频样本、不依赖真实 python 环境（探测在可用路径用注入假实现）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { venvPythonRelativePath } from "../src/main/platform/runtime";
import {
  describeWhisperRuntime,
  probeWhisperDependencies,
  WHISPER_DEPENDENCY_MODULES,
  WHISPER_PROBE_TIMEOUT_MS,
} from "../src/main/voice/whisperAsr";
import {
  createLocalWhisperSpeechProvider,
  diagnoseLocalWhisper,
} from "../src/main/capabilities/LocalWhisperSpeechProvider";

const previousWhisperDir = process.env.MYBUDDY_WHISPER_DIR;
const root = await mkdtemp(join(tmpdir(), "mybuddy-whisper-check-test-"));
try {
  /* 1) 资源缺失：结构化报告与 test() 都必须说清缺什么、在哪。 */
  const missingRoot = join(root, "missing-whisper");
  process.env.MYBUDDY_WHISPER_DIR = missingRoot;
  const missingReport = describeWhisperRuntime();
  assert.equal(missingReport.available, false, "missing assets must not report available");
  assert.equal(missingReport.pythonSource, "none");
  assert.deepEqual(missingReport.missingAssets, ["transcribe_wav.py", "whisper-medium-int8"]);
  assert.equal(missingReport.root, missingRoot);
  assert.equal(missingReport.modelDir, join(missingRoot, "models", "whisper-medium-int8"));

  let probeCalls = 0;
  const missingProvider = createLocalWhisperSpeechProvider({
    probe: async () => {
      probeCalls += 1;
      return { ok: true, detail: "should never run" };
    },
  });
  await assert.rejects(
    () => missingProvider.test!(),
    (error: Error) => {
      assert.match(error.message, /本机 Whisper 不可用/);
      assert.match(error.message, /transcribe_wav\.py/);
      assert.match(error.message, /whisper-medium-int8/);
      assert.match(error.message, /root=/);
      assert.match(error.message, /pythonSource=none/);
      assert.match(error.message, /modelDir=/);
      return true;
    },
  );
  assert.equal(probeCalls, 0, "missing configuration must not spawn a dependency probe");

  /* 2) 资源齐全 + 注入探测：文本含 root / pythonSource / modelDir / Python 版本。 */
  const readyRoot = join(root, "ready-whisper");
  await mkdir(join(readyRoot, "models", "whisper-medium-int8"), { recursive: true });
  await writeFile(join(readyRoot, "transcribe_wav.py"), "# fixture: no inference in tests\n", "utf8");
  const venvPython = join(readyRoot, ".venv", venvPythonRelativePath());
  await mkdir(dirname(venvPython), { recursive: true });
  await writeFile(venvPython, "", "utf8");
  process.env.MYBUDDY_WHISPER_DIR = readyRoot;

  const readyReport = describeWhisperRuntime();
  assert.equal(readyReport.available, true, "fixture with model dir + .venv must be available");
  assert.equal(readyReport.missingAssets.length, 0);
  assert.ok(
    readyReport.pythonSource === "project-venv" || readyReport.pythonSource === "managed",
    `unexpected python source: ${readyReport.pythonSource}`,
  );

  const seen = { python: "", timeoutMs: 0 };
  const readyProvider = createLocalWhisperSpeechProvider({
    probe: async (python, options) => {
      seen.python = python;
      seen.timeoutMs = options.timeoutMs ?? 0;
      return {
        ok: true,
        pythonVersion: "3.12.13",
        missingModules: [],
        detail: `Python 3.12.13，${WHISPER_DEPENDENCY_MODULES.join(" / ")} 均可导入`,
      };
    },
  });
  const readyText = await readyProvider.test!();
  assert.equal(seen.python, readyReport.python, "probe must run against the resolved interpreter");
  assert.equal(seen.timeoutMs, WHISPER_PROBE_TIMEOUT_MS, "probe timeout must stay bounded");
  assert.match(readyText, /本机 Whisper 检查通过/);
  assert.ok(readyText.includes(`root=${readyRoot}`), readyText);
  assert.match(readyText, /pythonSource=(project-venv|managed)/);
  assert.ok(readyText.includes(`modelDir=${join(readyRoot, "models", "whisper-medium-int8")}`), readyText);
  assert.match(readyText, /Python 3\.12\.13/);
  assert.match(readyText, /未运行模型推理/, "check must state that no inference happened");

  /* 3a) 探测失败：检查进入失败态（test() 抛出，由上层 catch 转成 ok:false），消息保留诊断字段。 */
  const degraded = await diagnoseLocalWhisper({
    probe: async () => ({
      ok: false,
      pythonVersion: "3.12.13",
      missingModules: ["openvino_genai"],
      detail: "缺少 Python 模块：openvino_genai（Python 3.12.13）",
    }),
  });
  assert.equal(degraded.ok, false);
  assert.match(degraded.detail, /依赖探测未通过/);
  assert.match(degraded.detail, /openvino_genai/);
  assert.ok(degraded.detail.includes(`root=${readyRoot}`), degraded.detail);
  assert.match(degraded.detail, /modelDir=/);
  await assert.rejects(
    () => createLocalWhisperSpeechProvider({
      probe: async () => ({
        ok: false,
        missingModules: ["openvino_genai"],
        detail: "缺少 Python 模块：openvino_genai",
      }),
    }).test!(),
    (error: Error) => {
      assert.match(error.message, /依赖探测未通过/, "probe failure must fail the check");
      assert.match(error.message, /openvino_genai/, "probe failure must carry the reason");
      assert.ok(error.message.includes(`root=${readyRoot}`), error.message);
      assert.match(error.message, /modelDir=/);
      return true;
    },
  );

  /* 3b) 探测进程异常：同样进入失败态，消息带异常原因，不产生未捕获崩溃。 */
  await assert.rejects(
    () => createLocalWhisperSpeechProvider({
      probe: async () => {
        throw new Error("spawn ENOENT");
      },
    }).test!(),
    (error: Error) => {
      assert.match(error.message, /依赖探测进程异常：spawn ENOENT/, error.message);
      assert.ok(error.message.includes(`root=${readyRoot}`), error.message);
      return true;
    },
  );

  /* 4) 默认探测实现自身的失败路径：解释器不存在 → ok:false + 可读原因。 */
  const defaultProbeFailure = await probeWhisperDependencies(join(root, "no-such-python"), { timeoutMs: 5_000 });
  assert.equal(defaultProbeFailure.ok, false);
  assert.match(defaultProbeFailure.detail, /无法启动解释器|解释器探测失败/);

  console.log(
    "whisper check feedback: PASS (missing-asset diagnosis, root/pythonSource/modelDir detail, bounded no-inference probe, probe failure is a failure state, default probe failure path)",
  );
} finally {
  if (previousWhisperDir === undefined) delete process.env.MYBUDDY_WHISPER_DIR;
  else process.env.MYBUDDY_WHISPER_DIR = previousWhisperDir;
  await rm(root, { recursive: true, force: true });
}
