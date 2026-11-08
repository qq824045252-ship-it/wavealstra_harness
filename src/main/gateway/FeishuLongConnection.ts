import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

export interface FeishuLongConnection {
  start(onEvent: (event: unknown) => Promise<void>): Promise<void>;
  close(): void;
  generation?(): unknown;
}
/** SDK owns framing and heartbeats. Bound reconnects to this connection lifecycle. */
export function createFeishuLongConnection(appId: string, appSecret: string,
  sdkFactory: (options: ConstructorParameters<typeof WSClient>[0]) => Pick<WSClient, "start" | "close"> = options => new WSClient(options),
): FeishuLongConnection {
  let closed = false;
  let epoch = {};
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let dispatcher: EventDispatcher | undefined;
  const retry = (): void => {
    if (closed || reconnect || !dispatcher) return;
    epoch = {};
    reconnect = setTimeout(() => {
      reconnect = undefined;
      if (closed || !dispatcher) return;
      client.close({ force: true });
      void client.start({ eventDispatcher: dispatcher }).catch(retry);
    }, 5_000);
  };
  const logger = {
    trace: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => { retry(); },
    debug: (...args: unknown[]) => {
      if (args.includes('client closed')) retry();
      // start() itself only schedules a connection. Wait for the actual socket open.
      if (args.includes('ws connect success') || args.includes('reconnect success')) {
        if (closed) { setTimeout(() => client.close({ force: true }), 0); return; }
        if (timeout) clearTimeout(timeout);
        if (reconnect) clearTimeout(reconnect); reconnect = undefined;
        resolveReady?.(); resolveReady = undefined;
      }
    },
  };
  const client = sdkFactory({ appId, appSecret, logger, loggerLevel: LoggerLevel.debug, autoReconnect: false });
  return {
    generation: () => epoch,
    async start(onEvent) {
      await new Promise<void>((resolve, reject) => {
        resolveReady = resolve; rejectReady = reject;
        timeout = setTimeout(() => { closed = true; if (reconnect) clearTimeout(reconnect); client.close({ force: true }); reject(new Error('飞书长连接建立超时')); }, 20_000);
        dispatcher = new EventDispatcher({}).register({
          'im.message.receive_v1': async event => { if (!closed) await onEvent(event); },
        });
        void client.start({ eventDispatcher: dispatcher }).catch(() => {
          if (timeout) clearTimeout(timeout);
          reject(new Error('飞书长连接启动失败'));
        });
      });
    },
    close() {
      closed = true; epoch = {};
      if (reconnect) clearTimeout(reconnect); reconnect = undefined;
      if (timeout) clearTimeout(timeout);
      rejectReady?.(new Error('飞书长连接已取消')); rejectReady = undefined;
      client.close({ force: true });
    },
  };
}
