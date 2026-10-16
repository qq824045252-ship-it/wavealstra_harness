export declare const IMAGE_RESIZE_WORKER_FILE: 'image-resize-worker.js';
export declare const PHOTON_WASM_FILE: 'photon_rs_bg.wasm';
export declare const SUBAGENT_RUNTIME_WASM_FILE: 'capabilities/subagent/runtime/chunks/photon_rs_bg.wasm';
export declare function buildPiImageResizeAssets(root: string): Promise<Array<{
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}>>;
