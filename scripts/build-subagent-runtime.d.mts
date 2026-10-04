export interface SubagentRuntimeAsset { type: 'asset'; fileName: string; source: string | Uint8Array; }
export declare function buildSubagentRuntime(root: string): Promise<SubagentRuntimeAsset[]>;
