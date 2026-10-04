export const MemoryGatewayIpc = {
  status: "memory-gateway:status",
  configure: "memory-gateway:configure",
  listGrants: "memory-gateway:listGrants",
  createGrant: "memory-gateway:createGrant",
  updateGrant: "memory-gateway:updateGrant",
  rotateGrant: "memory-gateway:rotateGrant",
  deleteGrant: "memory-gateway:deleteGrant",
} as const;

export type MemoryGatewayAccessMode = "read" | "read-write";
export type MemoryGatewayGrantScopeType = "all" | "global" | "project" | "workspace" | "task";

export interface MemoryGatewayAccessGrantDto {
  id: string;
  name: string;
  enabled: boolean;
  mode: MemoryGatewayAccessMode;
  scopeType: MemoryGatewayGrantScopeType;
  scopeId?: string;
  /** Earliest revision timestamp visible through this delegated grant. */
  accessSince: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryGatewayCreateGrantRequest {
  name: string;
  mode: MemoryGatewayAccessMode;
  scopeType: MemoryGatewayGrantScopeType;
  scopeId?: string;
}

export interface MemoryGatewayUpdateGrantRequest {
  id: string;
  name?: string;
  enabled?: boolean;
  mode?: MemoryGatewayAccessMode;
  scopeType?: MemoryGatewayGrantScopeType;
  scopeId?: string | null;
}

export interface MemoryGatewayIssuedGrantDto {
  grant: MemoryGatewayAccessGrantDto;
  /** Secret is returned exactly once on create/rotate and is never persisted in plaintext. */
  token: string;
}

export interface MemoryGatewayConfigureRequest {
  enabled?: boolean;
  writeEnabled?: boolean;
  port?: number;
}

export interface MemoryGatewayStatusDto {
  configuredEnabled: boolean;
  running: boolean;
  memoryEnabled: boolean;
  host: "127.0.0.1";
  port: number;
  writeEnabled: boolean;
  mcpUrl: string;
  httpBaseUrl: string;
  grantCount: number;
  grantStoreError?: string;
  environmentOverrides: {
    enabled: boolean;
    writeEnabled: boolean;
    port: boolean;
  };
}
