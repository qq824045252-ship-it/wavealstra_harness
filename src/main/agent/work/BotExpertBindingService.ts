import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { TaskExpertBindingService } from "../../experts/TaskExpertBindingService";

/** Restore the frozen expert snapshot carried by a shared Work/Goal binding. */
export class BotExpertBindingService {
  constructor(private readonly tasks: TaskExpertBindingService) {}

  install(binding: WorkExecutionBindingDto): void {
    const snapshot = binding.expertSnapshot;
    if (snapshot.configuration) this.tasks.installFrozen(binding.taskId, snapshot.configuration, snapshot.skillPackages ?? []);
    else if (snapshot.expertId !== "expert-default-coordinator") throw new Error("执行缺少完整专家配置快照");
  }
}
