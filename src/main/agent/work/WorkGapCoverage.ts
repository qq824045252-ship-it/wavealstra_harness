import type Database from "better-sqlite3";
import type { WorkActor, WorkControlResult } from "../../../shared/bot-work";
import type { WorkSubitemDto } from "../../../shared/bot-work-phase3";
import type { CoverNotStartedParams } from "../../../shared/bot-work-review";
import type { WorkService } from "./WorkService";

/**
 * 历史审批缺口的“替代证据覆盖”入口已随 Work 动作审批退役。
 * 保留表与调用面，历史缺口如实显示为缺口，不伪造完成、也不重跑旧动作。
 */
export class WorkGapCoverage {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_gap_coverages (
      fact_id TEXT NOT NULL REFERENCES work_subitem_results(fact_id),
      work_id TEXT NOT NULL REFERENCES works(work_id), operation_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at INTEGER NOT NULL,
      PRIMARY KEY(fact_id,operation_id)
    );`);
  }

  project(item: WorkSubitemDto): WorkSubitemDto { return item; }

  resolve(actor: WorkActor, params: CoverNotStartedParams): WorkControlResult {
    void actor; void params;
    return { ok: false, code: "unmet_acceptance_criteria",
      message: "Work 动作审批已退役，历史审批缺口不再提供替代证据覆盖；请在执行记录中核对实际结果" };
  }
}
