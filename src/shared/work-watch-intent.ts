import { z } from "zod";

export const workWatchIntentSchema = z.object({
  endsAt: z.number().int().nonnegative().max(8640000000000000).optional().describe("仅用户明确指定的持续追踪终止时刻，Unix毫秒。按用户时区换算为绝对时刻；到期停止新轮并结算在途，不代表目标成功。无限持续不填；举例365天不是指定期限；不能用任意语义停止条件推断日期。暂停和离线不会顺延"),
  notificationMode: z.enum(["every_check", "changes_only"]).optional().describe("用户要求仅变化时通知必须设changes_only；每轮汇报用every_check。旧任务未配置时保持每轮汇报"),
  notifyInitial: z.boolean().optional().describe("changes_only首轮是否通知；默认false只建立基线，用户要求首次也汇报才设true"),
  cronExpression: z.string().min(1).max(200).regex(/^\S+(?:\s+\S+){4}$/, "请使用五字段分钟级 Cron 时间表").optional().describe("五字段分钟级 Cron：* * * * * = 每分钟；*/5 * * * * = 每5分钟；0 * * * * = 每小时（不是每分钟）。按用户指定频率，不支持秒级轮询，不擅自提高检查频率"),
  timezone: z.string().min(1).max(100).optional().describe("IANA 时区，如 Asia/Shanghai；未指定时使用当前宿主时区"),
  nextWakeAt: z.number().int().nonnegative().optional().describe("一次性跟进或首次检查的 Unix 毫秒时间戳"),
  catchUpPolicy: z.enum(["latest", "each", "skip"]).optional().describe("离线后补最新一次、逐次补查或跳过；默认 latest"),
  scheduleBasis: z.enum(["user_specified", "recommended"]).optional().describe("区分用户指定时间与助理建议安排；创建watch必填。没有指定频率时可按任务建议合理低频，不冒充用户原话"),
  scheduleRationale: z.string().min(1).max(1000).optional().describe("建议安排的理由及可更改说明；scheduleBasis=recommended时必填"),
  stopConditionText: z.string().min(1).max(1000).optional().describe("保留用户给出的停止条件；检查后汇报是否满足，不自行宣称已完成"),
}).strict();
