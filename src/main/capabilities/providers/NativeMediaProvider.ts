import type { MediaCapabilityProvider } from "../BuiltinCapabilityRuntime";
import type { VideoGenerationJobStore } from "../VideoGenerationJobs";
import type { ApiConnectionResolver } from "./ApiServiceConnection";

/**
 * Options shared by the native (non OpenAI-shaped) media adapters.
 *
 * Native providers such as Black Forest Labs and DashScope expose their own
 * asynchronous task API: submit a task, poll it, then download the artifact.
 * They reuse the same credential, connection resolution and durable video-job
 * ledger as the OpenAI-shaped adapter, but never the generic `/images` or
 * `/videos` routes.
 */
export interface NativeMediaProviderOptions {
  /** Stable connection id; also the provider id reported in results. */
  id: string;
  label: string;
  /** Resolve the saved connection (base URL, timeout and auth headers) for a capability. */
  getConnection: ApiConnectionResolver;
  /** Durable ledger for resumable video tasks. Without it the adapter exposes image generation only. */
  jobStore?: VideoGenerationJobStore;
  fetch?: typeof fetch;
  polling?: { intervalMs?: number; maxWaitMs?: number; maxAttempts?: number };
}

export type NativeMediaProviderFactory = (options: NativeMediaProviderOptions) => MediaCapabilityProvider;
