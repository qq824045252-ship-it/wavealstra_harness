/**
 * R3 Stage 2 — SemanticRuntime: lazy singleton ORT session + tokenizer
 * Lifecycle: app singleton per process, reused across queries and backfill.
 * Never falls back to hashEmbedding in production.
 */
import { existsSync, readFileSync } from "node:fs";
import { SemanticModelManager, SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "./SemanticModelManager";

type TokenizerCache = {
  vocabTokens: string[];
  tokenToId: Map<string, number>;
  scores: Map<string, number>;
  maxTokenLen: number;
};

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class SemanticUnavailableError extends Error {
  constructor(msg: string) { super(msg); this.name = "SemanticUnavailableError"; }
}

export class SemanticRuntime {
  private sess: any | null = null;
  private sessLoading: Promise<any | null> | null = null;
  private tokCache: TokenizerCache | null = null;
  private loadMs: number | null = null;

  constructor(private readonly manager: SemanticModelManager) {}

  get modelId() { return SEMANTIC_MODEL_ID; }
  get modelVersion() { return SEMANTIC_MODEL_VERSION; }
  get dimension() { return SEMANTIC_DIMENSION; }

  getLoadMs(): number | null { return this.loadMs; }

  isAvailable(): boolean {
    const st = this.manager.getStatus();
    return st.status === "ready";
  }

  /** Throw if not ready — caller maps to lexical-only vs explicit unavailable */
  ensureAvailableOrThrow(): void {
    const st = this.manager.getStatus();
    if (st.status !== "ready") throw new SemanticUnavailableError(`semantic model ${st.status}${st.error ? `: ${st.error}` : ""}`);
  }

  async ensureSession(): Promise<any> {
    this.ensureAvailableOrThrow();
    if (this.sess) return this.sess;
    if (this.sessLoading) return this.sessLoading;
    const modelPath = this.manager.getModelPath();
    if (!existsSync(modelPath)) throw new SemanticUnavailableError("model.onnx not found at " + modelPath);
    this.sessLoading = (async () => {
      try {
        const ort: any = await import("onnxruntime-node");
        const t0 = Date.now();
        const sess = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"], logSeverityLevel: 3 });
        this.loadMs = Date.now() - t0;
        this.sess = sess;
        return sess;
      } finally { this.sessLoading = null; }
    })();
    const s = await this.sessLoading;
    if (!s) throw new SemanticUnavailableError("failed to create ORT session");
    return s;
  }

  dispose(): void {
    try { this.sess?.release?.(); } catch { /* ignore */ }
    this.sess = null;
    this.sessLoading = null;
    this.tokCache = null;
  }

  async embed(text: string): Promise<Float32Array> {
    const sess = await this.ensureSession();
    const ids = this.tokenize(text);
    const maxLen = Math.min(ids.length, 512);
    const sliced = ids.slice(0, maxLen);
    const ort: any = await import("onnxruntime-node");
    const inputIds = new BigInt64Array(sliced.map((v) => BigInt(v)));
    const attn = new BigInt64Array(sliced.length).fill(1n);
    const feeds: Record<string, any> = {
      input_ids: new ort.Tensor("int64", inputIds, [1, sliced.length]),
      attention_mask: new ort.Tensor("int64", attn, [1, sliced.length]),
    };
    const out = await sess.run(feeds);
    const emb = (out.sentence_embedding ?? out["sentence_embedding"]) as any;
    if (!emb?.data) throw new Error("ORT output missing sentence_embedding");
    const raw = emb.data as Float32Array;
    const vec = new Float32Array(raw);
    let n = 0; for (let i = 0; i < vec.length; i++) n += vec[i]! * vec[i]!;
    n = Math.sqrt(n);
    if (n > 1e-9) for (let i = 0; i < vec.length; i++) vec[i]! /= n;
    if (vec.length !== SEMANTIC_DIMENSION) throw new Error(`dimension mismatch: ${vec.length} != ${SEMANTIC_DIMENSION}`);
    for (let i = 0; i < vec.length; i++) if (!Number.isFinite(vec[i]!)) throw new Error("embedding contains non-finite");
    return vec;
  }

  // ---- tokenizer (Unigram + Metaspace), must align with PoC ----
  private ensureTokenizer(): TokenizerCache | null {
    if (this.tokCache) return this.tokCache;
    const tokPath = this.manager.getTokenizerPath();
    if (!existsSync(tokPath)) return null;
    try {
      const j = JSON.parse(readFileSync(tokPath, "utf8"));
      const vocabArr: Array<[string, number]> = j.model?.vocab ?? [];
      const vocabTokens: string[] = [];
      const tokenToId = new Map<string, number>();
      const scores = new Map<string, number>();
      for (let i = 0; i < vocabArr.length; i++) {
        const [tok, sc] = vocabArr[i]!;
        vocabTokens[i] = tok;
        tokenToId.set(tok, i);
        scores.set(tok, sc);
      }
      for (const at of j.added_tokens ?? []) {
        if (!tokenToId.has(at.content)) {
          tokenToId.set(at.content, at.id);
          vocabTokens[at.id] = at.content;
          scores.set(at.content, 0);
        }
      }
      let maxLen = 0; for (const t of vocabTokens) if (t && t.length > maxLen) maxLen = t.length;
      this.tokCache = { vocabTokens, tokenToId, scores, maxTokenLen: Math.min(maxLen, 32) };
      return this.tokCache;
    } catch { return null; }
  }

  private tokenize(text: string): number[] {
    const cache = this.ensureTokenizer();
    if (!cache) {
      // Tokenizer missing is fatal in production — surface as unavailable, not hash fallback
      throw new SemanticUnavailableError("tokenizer.json not available");
    }
    const normalized = text.normalize("NFKC");
    const withPrefix = "▁" + normalized;
    const metaspace = withPrefix.replace(/ /g, "▁");
    const s = metaspace;
    const n = s.length;
    const dpScore = new Array(n + 1).fill(-Infinity) as number[];
    const dpPrev = new Array(n + 1).fill(-1) as number[];
    const dpTok = new Array(n + 1).fill("") as string[];
    dpScore[0] = 0;
    for (let i = 0; i < n; i++) {
      if (dpScore[i] === -Infinity) continue;
      for (let len = 1; len <= cache.maxTokenLen && i + len <= n; len++) {
        const piece = s.slice(i, i + len);
        const sc = cache.scores.get(piece);
        if (sc === undefined) continue;
        const ns = dpScore[i]! + sc;
        if (ns > dpScore[i + len]!) { dpScore[i + len] = ns; dpPrev[i + len] = i; dpTok[i + len] = piece; }
      }
      if (dpPrev[i + 1] === -1) {
        const unkScore = cache.scores.get("<unk>") ?? -10;
        const ns = dpScore[i]! + unkScore - 5;
        if (ns > dpScore[i + 1]!) { dpScore[i + 1] = ns; dpPrev[i + 1] = i; dpTok[i + 1] = "<unk>"; }
      }
    }
    if (dpScore[n] === -Infinity) return [0, 3, 2];
    const pieces: string[] = [];
    let cur = n;
    while (cur > 0) { const p = dpPrev[cur]!; if (p < 0) break; pieces.push(dpTok[cur]!); cur = p; }
    pieces.reverse();
    const ids: number[] = [0];
    for (const tok of pieces) ids.push(cache.tokenToId.get(tok) ?? 3);
    ids.push(2);
    return ids;
  }
}

// Global lazy singleton per process (keyed by modelsRoot for tests)
const singletons = new Map<string, SemanticRuntime>();
export function getSemanticRuntime(manager?: SemanticModelManager): SemanticRuntime {
  const m = manager ?? new SemanticModelManager();
  const key = m.getModelsRoot();
  let rt = singletons.get(key);
  if (!rt) { rt = new SemanticRuntime(m); singletons.set(key, rt); }
  return rt;
}
export function resetSemanticRuntimeForTest(modelsRoot?: string): void {
  if (modelsRoot) singletons.delete(modelsRoot);
  else singletons.clear();
}
