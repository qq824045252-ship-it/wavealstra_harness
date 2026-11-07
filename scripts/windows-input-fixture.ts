import { WindowsComputerUseBackend } from "../src/main/platform/computer-use/windows/WindowsComputerUseBackend";
import { WindowsAutomationError } from "../src/main/platform/computer-use/protocol";

/** Native-host simulator for existing UI policy tests; negative receipt tests use the real class directly. */
export class WindowsComputerUseFixture extends WindowsComputerUseBackend {
  constructor(host: ConstructorParameters<typeof WindowsComputerUseBackend>[0], capture?: ConstructorParameters<typeof WindowsComputerUseBackend>[1]) {
    if (!host) throw new Error("Windows fixture requires an explicit fake native host");
    const held = new Map<string, Set<string>>();
    const fixture = {
      ...host,
      waitForQuiescence: host.waitForQuiescence?.bind(host) ?? (async () => {}),
      request: async (action: string, params: Record<string, unknown>, timeout?: number, signal?: AbortSignal) => {
        const owner = String(params.inputOwner ?? "__direct__");
        const controls = held.get(owner) ?? new Set<string>(); held.set(owner, controls);
        const receipt = () => ({ owner, hostInstance: "fixture-native-host", controls: [...controls] });
        let result: unknown;
        try { result = await host.request(action as never, params as never, timeout, signal); }
        catch (error) {
          // Only the fixture's explicit native pre-input failure supplies proof;
          // transport/cancellation failures retain their unknown delivery state.
          if (error instanceof WindowsAutomationError && error.code === "FOCUS_FAILED"
            && error.details && typeof error.details === "object" && "focusAttempt" in error.details) {
            throw new WindowsAutomationError(error.code, error.message, { ...error.details, ownedInputState: receipt() });
          }
          throw error;
        }
        const key = String(params.key ?? "");
        const vk = ({ ShiftKey: 16, ControlKey: 17, Menu: 18, LWin: 91 } as Record<string, number>)[key] ?? key.charCodeAt(0);
        if (action === "key_down") controls.add(`key:${vk}:0:0`);
        if (action === "key_up") controls.delete(`key:${vk}:0:0`);
        if (action === "mouse_down_client") controls.add(`mouse:${params.button ?? "left"}`);
        if (action === "mouse_up_client") controls.delete(`mouse:${params.button ?? "left"}`);
        return result && typeof result === "object" && !Array.isArray(result)
          ? { ...result, ownedInputState: receipt() } : result;
      },
    };
    super(fixture as never, capture);
  }
}
