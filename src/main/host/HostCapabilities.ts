/**
 * Explicit capability manifest declared by a Pi Node Host execution worker (`P0-02`).
 * Rust Core filters `core_execution_runs.kind` dispatch against these capabilities
 * so capability-restricted or partial hosts never drain incompatible executions.
 */

export type PiExecutionKind =
  | "pi_turn"
  | "pi_compact"
  | "pi_control"
  | "bot_turn"
  | "work_turn"
  | "work"
  | "turn"
  | "cron"
  | "cron_turn"
  | "dots_control"
  | "gateway_control"
  | "maintenance_control"
  | (string & {});

export interface HostCapabilityFlags {
  /** Core Pi conversation & subagent turns (`pi_turn`, `pi_compact`, `pi_control`, `bot_turn`, `work_turn`, `work`, `turn`). Defaults to true. */
  piCore?: boolean;
  /** Cron scheduled prompt execution (`cron`, `cron_turn`). Defaults to true when workflow CronService is wired. */
  cron?: boolean;
  /** Dots periodic control cycles (`dots_control`). Defaults to true when DotsActions/monitors are wired. */
  dotsControl?: boolean;
  /** Gateway channel control cycles (`gateway_control`). Defaults to false unless Gateway control runner is wired. */
  gatewayControl?: boolean;
  /** Background maintenance cycles (`maintenance_control`). Defaults to true when piCore is enabled. */
  maintenanceControl?: boolean;
  /** Additional execution kinds explicitly supported by this host. */
  extraKinds?: readonly string[];
}

export function buildHostCapabilities(flags: HostCapabilityFlags = {}): string[] {
  const kinds = new Set<string>();
  if (flags.piCore !== false) {
    for (const kind of ["pi_turn", "pi_compact", "pi_control", "bot_turn", "work_turn", "work", "turn"]) {
      kinds.add(kind);
    }
  }
  if (flags.cron) {
    kinds.add("cron");
    kinds.add("cron_turn");
  }
  if (flags.dotsControl) {
    kinds.add("dots_control");
  }
  if (flags.gatewayControl) {
    kinds.add("gateway_control");
  }
  if (flags.maintenanceControl ?? flags.piCore !== false) {
    kinds.add("maintenance_control");
  }
  if (flags.extraKinds) {
    for (const kind of flags.extraKinds) {
      const trimmed = kind.trim();
      if (trimmed) kinds.add(trimmed);
    }
  }
  return Array.from(kinds).sort();
}

export function supportsExecutionKind(
  capabilities: ReadonlySet<string> | readonly string[],
  kind: string,
): boolean {
  if (Array.isArray(capabilities)) return capabilities.includes(kind);
  return (capabilities as ReadonlySet<string>).has(kind);
}
