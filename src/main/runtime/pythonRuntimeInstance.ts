/**
 * 全局唯一的受管 Python 运行时实例。
 *
 * 必须是单例：环境准备的互斥是进程内 Map（见 PythonEnvironmentStore.preparing），
 * 而主进程已由 index.ts:309 的 requestSingleInstanceLock 保证单实例——
 * 两者合起来才构成「首次创建互斥」的完整保证。若 AgentService 与语音能力
 * 各持一个实例，同一规格可能被并发安装两次，互斥就形同虚设。
 */
import { PythonRuntimeService } from "./PythonRuntimeService";

let instance: PythonRuntimeService | null = null;

export function getPythonRuntimeService(): PythonRuntimeService {
  if (!instance) instance = new PythonRuntimeService();
  return instance;
}

/** 测试用：重置单例，避免用例之间串状态。 */
export function resetPythonRuntimeServiceForTest(): void {
  instance = null;
}
