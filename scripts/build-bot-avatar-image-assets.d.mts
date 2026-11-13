export declare const AVATAR_WASM_FILE: string;
export declare function avatarPhotonBuildOptions(root: string): import('esbuild').BuildOptions;
export declare function buildBotAvatarImageAssets(root: string): Promise<Array<{type:"asset";fileName:string;source:string|Uint8Array}>>;
