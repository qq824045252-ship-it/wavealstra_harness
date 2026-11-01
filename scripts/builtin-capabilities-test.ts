import { checkHttpRecognition } from "./recognition-http-check";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BUILTIN_CAPABILITIES_CONFIG,
  type BuiltinCapabilitiesConfigDto,
} from "../src/shared/builtin-capabilities";
import { isSideEffectTool } from "../src/shared/pi-event-mapper";
import { resolveSessionToolSelection } from "../src/main/agent/PromptAssembly";
import {
  BuiltinCapabilityRuntime,
  type MediaCapabilityProvider,
  type SpeechCapabilityProvider,
  type VisionCapabilityProvider,
} from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { createVisionModelCapabilityProvider } from "../src/main/capabilities/VisionModelCapabilityProvider";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";

interface Tool {
  name: string;
  execute: (
    id: string,
    params: never,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ isError?: boolean; details?: unknown; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
}

function fakeApi(): { api: ExtensionAPI; tools: Tool[] } {
  const tools: Tool[] = [];
  return {
    tools,
    api: {
      registerTool: (tool: never) => tools.push(tool as unknown as Tool),
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      on: () => undefined,
      appendEntry: () => undefined,
      sendMessage: () => undefined,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as unknown as ExtensionAPI,
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-capabilities-"));
  try {
    const config: BuiltinCapabilitiesConfigDto = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    config.vision.model = "fake/vision-model";
    config.imageGeneration.provider = "fake";
    config.videoGeneration.provider = "fake";
    config.speechToText.provider = "fake";
    config.textToSpeech.provider = "fake";
    const runtime = new BuiltinCapabilityRuntime({
      store: { read: () => structuredClone(config), write: (next) => structuredClone(next) },
      credentials: { has: () => true, get: () => "secret", set: () => undefined, clear: () => undefined },
    });
    let visionCalls = 0;
    const vision: VisionCapabilityProvider = {
      id: "default", label: "Fake Vision",
      describe: async (input) => {
        visionCalls++;
        return { provider: "fake", descriptions: input.imagePaths.map((imagePath) => ({ imagePath, text: "delegated image" })) };
      },
    };
    const media: MediaCapabilityProvider = {
      id: "fake", label: "Fake Media",
      generateImage: async () => ({ provider: "fake", items: [{ bytes: Buffer.from("png"), mimeType: "image/png", fileName: "result.png" }] }),
      generateVideo: async () => ({ provider: "fake", items: [{ bytes: Buffer.from("mp4"), mimeType: "video/mp4", fileName: "result.exe" }] }),
    };
    const speech: SpeechCapabilityProvider = {
      id: "fake", label: "Fake Speech",
      speechToText: async () => ({ provider: "fake", text: "hello" }),
      textToSpeech: async () => ({ provider: "fake", items: [{ bytes: Buffer.from("mp3"), mimeType: "audio/mpeg", fileName: "speech.mp3" }] }),
    };
    runtime.registerProvider("vision", vision);
    runtime.registerProvider("media", media);
    runtime.registerProvider("speech", speech);
    runtime.setBrowserAvailable(true);

    let visionTestRequest: unknown;
    const runtimeVisionProvider = createVisionModelCapabilityProvider({
      getRuntime: () => ({
        getAvailable: async () => [{ id: "vision-model", name: "Vision Model", input: ["text", "image"] }],
        completeSimple: async (_model: unknown, request: unknown) => {
          visionTestRequest = request;
          return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
        },
      } as never),
      getSelectedModel: () => "fake/vision-model",
    });
    const visionTestDetail = await runtimeVisionProvider.test?.();
    assert.match(visionTestDetail ?? "", /图像理解模型实测可用/);
    const visionTestContent = (((visionTestRequest as { messages?: Array<{ content?: Array<{ type?: string; mimeType?: string }> }> })?.messages?.[0]?.content) ?? []);
    assert(visionTestContent.some((part) => part.type === "image" && part.mimeType === "image/png"), "Vision capability check must perform a real PNG image request");

    const degradedConfig = structuredClone(config);
    degradedConfig.vision.model = undefined;
    const degradedRuntime = new BuiltinCapabilityRuntime({
      store: { read: () => structuredClone(degradedConfig), write: (next) => structuredClone(next) },
      credentials: { has: () => true, get: () => "secret", set: () => undefined, clear: () => undefined },
    });
    degradedRuntime.registerProvider("vision", vision);
    const degradedStatus = degradedRuntime.snapshot().capabilities.find((item) => item.id === "vision");
    assert.equal(degradedStatus?.state, "degraded", "missing delegated model must be degraded rather than falsely ready");
    const degradedCheck = await degradedRuntime.test("vision");
    assert.equal(degradedCheck.ok, true);
    assert.equal(degradedCheck.state, "degraded");

    const unavailableRuntime = new BuiltinCapabilityRuntime({
      store: { read: () => structuredClone(config), write: (next) => structuredClone(next) },
      credentials: { has: () => true, get: () => "secret", set: () => undefined, clear: () => undefined },
    });
    unavailableRuntime.registerProvider("media", {
      ...media,
      isAvailable: () => false,
      availabilityDetail: () => "OAuth required",
    });
    const unavailableImageStatus = unavailableRuntime.snapshot().capabilities.find((item) => item.id === "image-generation");
    assert.equal(unavailableImageStatus?.state, "needs-configuration");
    assert.equal(unavailableImageStatus?.detail, "OAuth required");
    const unavailableApi = fakeApi();
    createBuiltinCapabilityExtension({
      taskId: "task-unavailable-image",
      taskRoot: root,
      runtime: unavailableRuntime,
      browser: { available: false } as never,
      artifactService: () => null,
      getProducerMessageId: () => undefined,
      getIsolationLevel: () => "guarded",
    })(unavailableApi.api);
    assert(!unavailableApi.tools.some((tool) => tool.name === "image_generate"), "unavailable image provider must not register image_generate");

    const descriptors: ArtifactDescriptor[] = [];
    const emittedPaths: string[] = [];
    const artifactService = {
      register: async (input: { taskId: string; kind: ArtifactDescriptor["kind"]; title?: string; mimeType?: string; workspaceFile: { entryFile: string; rootDir: string } }) => {
        const descriptor: ArtifactDescriptor = {
          id: `art-${descriptors.length + 1}`,
          taskId: input.taskId,
          kind: input.kind,
          source: { type: "workspace-file", entryFile: input.workspaceFile.entryFile, rootDir: input.workspaceFile.rootDir },
          version: 1,
          capabilities: {},
          title: input.title,
          mimeType: input.mimeType,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        descriptors.push(descriptor);
        return descriptor;
      },
    };
    const browser = {
      available: true,
      execute: async (input: { action: string }) => input.action === "screenshot"
        ? { action: "screenshot", screenshot: Buffer.from("png") }
        : { action: input.action, detail: "ok" },
    };
    let skillAssessCalls = 0;
    let skillCreateCalls = 0;
    const { api, tools } = fakeApi();
    createBuiltinCapabilityExtension({
      taskId: "task-native",
      taskRoot: root,
      runtime,
      browser: browser as never,
      artifactService: () => artifactService as never,
      markArtifactEmitted: (filePath) => emittedPaths.push(filePath),
      getProducerMessageId: () => "message-1",
      getIsolationLevel: () => "guarded",
      skillAuthoring: {
        assess: async (intent) => { skillAssessCalls += 1; return { decision: "no-skill", reason: intent }; },
        create: async (intent, forceCreate) => { skillCreateCalls += 1; return { created: Boolean(forceCreate), intent }; },
      },
    })(api);

    const names = tools.map((tool) => tool.name);
    for (const name of [
      "web_search", "fetch_content", "source_check", "get_search_content", "describe_image", "image_generate", "video_generate",
      "speech_to_text", "text_to_speech", "browser_exec", "runtime_probe", "execute_code",
      "skill_authoring_assess", "skill_authoring_create",
    ]) assert(names.includes(name), `missing native tool ${name}`);

    const skillAssess = tools.find((tool) => tool.name === "skill_authoring_assess")!;
    const skillCreate = tools.find((tool) => tool.name === "skill_authoring_create")!;
    assert.equal((await skillAssess.execute("tc-skill-assess", { intent: "一次性解释" } as never)).isError, undefined);
    assert.equal((await skillCreate.execute("tc-skill-create", { intent: "重复能力", force_create: true } as never)).isError, undefined);
    assert.equal(skillAssessCalls, 1);
    assert.equal(skillCreateCalls, 1);

    assert(!names.includes("terminal"), "the duplicate terminal alias must not be exposed to new sessions");

    const executeCodeTool = tools.find((tool) => tool.name === "execute_code")!;
    const shellCodeResult = await executeCodeTool.execute(
      "tc-execute-shell",
      {
        language: "shell",
        code: "printf 'EXEC_SHELL_OK\\n'\npython - <<'PY'\nprint('EXEC_UNICODE_OK_中文')\nPY",
        timeout: 15,
      } as never,
    );
    const shellCodeText = shellCodeResult.content?.map((part) => part.text ?? "").join("\n") ?? "";
    assert.match(shellCodeText, /EXEC_SHELL_OK/);
    assert.match(shellCodeText, /EXEC_UNICODE_OK_中文/);

    if (process.platform === "win32") {
      const powerShellCodeResult = await executeCodeTool.execute(
        "tc-execute-powershell",
        { language: "powershell", code: "Write-Output 'EXEC_POWERSHELL_OK'", timeout: 15 } as never,
      );
      assert.match(
        powerShellCodeResult.content?.map((part) => part.text ?? "").join("\n") ?? "",
        /EXEC_POWERSHELL_OK/,
      );
    }

    const sampleImage = join(root, "sample.png");
    writeFileSync(sampleImage, Buffer.from("fake-image"));
    const multimodalCtx = { model: { provider: "fake", id: "multimodal", input: ["text", "image"] } };
    const textOnlyCtx = { model: { provider: "fake", id: "text-only", input: ["text"] } };
    const describe = tools.find((tool) => tool.name === "describe_image")!;
    const nativeDescribe = await describe.execute(
      "tc-describe-native",
      { image_path: sampleImage } as never,
      undefined,
      undefined,
      multimodalCtx,
    );
    assert.equal(nativeDescribe.isError, undefined);
    assert(nativeDescribe.content?.some((part) => part.type === "image"), "multimodal main model must receive image content directly");
    assert.equal(visionCalls, 0, "native multimodal route must not call delegated Vision");
    assert.equal((nativeDescribe.details as { vision?: { route?: string } })?.vision?.route, "native-multimodal");

    const delegatedDescribe = await describe.execute(
      "tc-describe-delegated",
      { image_path: sampleImage } as never,
      undefined,
      undefined,
      textOnlyCtx,
    );
    assert.equal(delegatedDescribe.isError, undefined);
    assert.equal(visionCalls, 1, "text-only main model must call delegated Vision");
    assert.equal((delegatedDescribe.details as { vision?: { route?: string } })?.vision?.route, "delegated-vision");
    assert(!delegatedDescribe.content?.some((part) => part.type === "image"), "text-only main model must not receive raw image content");

    const image = tools.find((tool) => tool.name === "image_generate")!;
    const video = tools.find((tool) => tool.name === "video_generate")!;
    const tts = tools.find((tool) => tool.name === "text_to_speech")!;
    const screenshot = tools.find((tool) => tool.name === "browser_exec")!;
    assert.equal((await image.execute("tc-image", { prompt: "image" } as never)).isError, undefined);
    assert.equal((await video.execute("tc-video", { prompt: "video" } as never)).isError, undefined);
    assert.equal((await tts.execute("tc-tts", { text: "hello" } as never)).isError, undefined);
    const nativeScreenshot = await screenshot.execute(
      "tc-shot-native",
      { action: "screenshot" } as never,
      undefined,
      undefined,
      multimodalCtx,
    );
    assert.equal(nativeScreenshot.isError, undefined);
    assert(nativeScreenshot.content?.some((part) => part.type === "image"), "multimodal screenshot must be returned as image content");
    assert.equal((nativeScreenshot.details as { vision?: { route?: string } })?.vision?.route, "native-multimodal");
    assert.equal(visionCalls, 1, "native screenshot must not invoke delegated Vision");

    const delegatedScreenshot = await screenshot.execute(
      "tc-shot-delegated",
      { action: "screenshot" } as never,
      undefined,
      undefined,
      textOnlyCtx,
    );
    assert.equal(delegatedScreenshot.isError, undefined);
    assert.equal((delegatedScreenshot.details as { vision?: { route?: string } })?.vision?.route, "delegated-vision");
    assert.equal(visionCalls, 2, "text-only screenshot must invoke delegated Vision exactly once");
    assert(!delegatedScreenshot.content?.some((part) => part.type === "image"), "delegated screenshot must return text instead of raw image to text-only model");
    assert.deepEqual(descriptors.map((item) => item.kind), ["image", "video", "audio", "image", "image"]);
    assert.equal(emittedPaths.length, descriptors.length, "registered native media paths must be marked emitted for same-turn snapshot dedupe");
    assert.deepEqual(emittedPaths, descriptors.map((item) => item.source.type === "workspace-file" ? item.source.entryFile : ""));
    for (const item of descriptors) {
      assert.equal(item.source.type, "workspace-file");
      if (item.source.type === "workspace-file") assert(existsSync(item.source.entryFile));
    }
    const videoArtifact = descriptors.find((item) => item.kind === "video");
    assert(videoArtifact?.source.type === "workspace-file" && videoArtifact.source.entryFile.endsWith(".mp4"));

    const disabledConfig = structuredClone(config);
    disabledConfig.web.enabled = false;
    disabledConfig.vision.enabled = false;
    disabledConfig.imageGeneration.enabled = false;
    disabledConfig.videoGeneration.enabled = false;
    disabledConfig.speechToText.enabled = false;
    disabledConfig.textToSpeech.enabled = false;
    disabledConfig.browser.enabled = false;
    disabledConfig.diagnostics = { enabled: false };
    disabledConfig.execution.terminalEnabled = false;
    disabledConfig.execution.codeExecutionEnabled = false;
    const disabledRuntime = new BuiltinCapabilityRuntime({
      store: { read: () => structuredClone(disabledConfig), write: (next) => structuredClone(next) },
      credentials: { has: () => true, get: () => "secret", set: () => undefined, clear: () => undefined },
    });
    disabledRuntime.registerProvider("vision", vision);
    disabledRuntime.registerProvider("media", media);
    disabledRuntime.registerProvider("speech", speech);
    const disabledApi = fakeApi();
    createBuiltinCapabilityExtension({
      taskId: "task-disabled",
      taskRoot: root,
      runtime: disabledRuntime,
      browser: { available: false } as never,
      artifactService: () => null,
      getProducerMessageId: () => undefined,
      getIsolationLevel: () => "guarded",
    })(disabledApi.api);
    assert.deepEqual(disabledApi.tools.map((tool) => tool.name), []);

    const configPath = join(root, "fresh", "capabilities.json");
    const store = new BuiltinCapabilityStore(configPath);
    const stored = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    stored.web.enabled = false;
    store.write(stored);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).web.enabled, false);
    assert.equal(existsSync(`${configPath}.tmp`), false);
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      web: { enabled: true },
      vision: { enabled: true },
      imageGeneration: { enabled: true },
      videoGeneration: { enabled: true },
      speechToText: { enabled: true },
      textToSpeech: { enabled: true },
      browser: { enabled: true },
      execution: { terminalEnabled: true, codeExecutionEnabled: true },
      subagent: { enabled: true },
    }), "utf8");
    assert.equal(store.read().imageGeneration.provider, DEFAULT_BUILTIN_CAPABILITIES_CONFIG.imageGeneration.provider, "schema v1 config without image adapter must inherit product Codex adapter");
    assert.equal(store.read().imageGeneration.model, DEFAULT_BUILTIN_CAPABILITIES_CONFIG.imageGeneration.model);
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 99, web: { enabled: false } }), "utf8");
    assert.equal(store.read().web.enabled, true, "unknown schema must reset to current defaults");

    const mainSource = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
    const preloadSource = readFileSync(join(process.cwd(), "src/preload/index.ts"), "utf8");
    const preloadTypes = readFileSync(join(process.cwd(), "src/preload/index.d.ts"), "utf8");
    for (const channel of [
      "getBuiltinCapabilities", "saveBuiltinCapabilities", "saveBuiltinCredential", "testBuiltinCapability",
    ]) {
      assert(mainSource.includes(`ipcMain.handle(AgentIpc.${channel}`), `missing Main IPC handler ${channel}`);
      assert(preloadSource.includes(`AgentIpc.${channel}`), `missing preload bridge ${channel}`);
      assert(preloadTypes.includes(`${channel}:`), `missing preload type ${channel}`);
    }
    const settingsSource = readFileSync(join(process.cwd(), "src/renderer/src/components/settings/SettingsModal.tsx"), "utf8");
    assert(settingsSource.includes('tab === "extensions" && <CapabilitiesTab />'));
    const agentSource = readFileSync(join(process.cwd(), "src/main/agent/AgentService.ts"), "utf8");
    assert(!agentSource.includes("loadUserExtensionFactories("), "product session must not load arbitrary disk extensions");
    assert(agentSource.includes("modelSupportsImageInput(entry.session.model)"), "attachment image routing must inspect the actual session model");
    assert(agentSource.includes("routeVisionForPaths({"), "text-only attachment routing must use delegated Vision fallback");
    const extensionAssemblerSource = readFileSync(join(process.cwd(), "src/main/agent/SessionExtensionAssembler.ts"), "utf8");
    assert(!extensionAssemblerSource.includes("loadLegacyCapabilityFactories("), "session assembler must not load legacy disk capabilities");
    assert(!extensionAssemblerSource.includes("user-extension-loader"), "session assembler must not reference disk extension loader");
    const builtinCapabilitySource = readFileSync(join(process.cwd(), "src/main/capabilities/builtin-capability-extension.ts"), "utf8");
    assert(builtinCapabilitySource.includes("createWebAccessCapabilityExtension(pi)"), "WebAccess must be compiled into product capability registration");
    assert(!existsSync(join(process.cwd(), "src/main/agent/user-extension-loader.ts")), "legacy user extension loader must be deleted");
    const pathsSource = readFileSync(join(process.cwd(), "src/main/paths.ts"), "utf8");
    assert(!pathsSource.includes("getExtensionsDir"), "runtime must not expose ~/.mybuddy/extensions as executable surface");

    assert.equal(isSideEffectTool("browser_exec", { action: "read" }), false);
    assert.equal(isSideEffectTool("browser_exec", { action: "click" }), true);
    assert.equal(isSideEffectTool("runtime_probe", { action: "read" }), false);
    assert.equal(isSideEffectTool("runtime_probe", { action: "mark" }), false);
    assert.equal(isSideEffectTool("video_generate", {}), true);
    const readonly = resolveSessionToolSelection("readonly", { mode: "inherit" });
    assert(readonly.excludeTools?.includes("video_generate"));
    assert(readonly.excludeTools?.includes("execute_code"));

    await checkHttpRecognition(root);
    console.log("builtin capabilities: ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
