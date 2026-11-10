# Existing fake-IP proxy compatibility: security and acceptance

Baseline: cd6f41e. This change does not edit network settings, disable SSRF, grant private-address exceptions, or restart a production app.

## Narrow supported configuration

An existing FlClash configuration at the current HOME's `.local/share/com.follow.clash/config.yaml` must already enable TUN and fake-IP DNS, use a supported 198.18/16 or /15 synthetic range, disable LAN access, have an unauthenticated loopback mixed port, and explicitly list `https://dns.alidns.com/dns-query`. No arbitrary resolver/proxy URL supplied by model or website is accepted. Other proxy clients/providers/configurations retain the prior rejection rather than receive an insecure fallback. This version supports HTTPS GET/HEAD only.

When local DNS returns only configured synthetic addresses, the host captures a pinned-route ticket. The extraction preflight carries that ticket into actual HTTP transport and all redirects: later local DNS answers cannot return this request to ordinary fetch.

The existing AliDNS service is queried over TLS through the existing proxy using fixed public bootstrap address 223.5.5.5, TLS server identity dns.alidns.com. Both A and AAAA responses are checked for question identity, status, truncation, CNAME loops/depth and public addresses. Mixed public/private answers fail. Every redirect re-resolves and checks its target. Public targets are CONNECTed by literal checked IP, never proxy-side hostname resolution; Host and TLS identity remain the original hostname. HTTPS downgrade, URL userinfo, local names, private/literal targets and non-read methods are rejected. Proxy/DNS/certificate failures do not fall back to direct or unchecked transport.

Strict public IPv4 and IPv6 sets exclude private, local, multicast, reserved, mapped, NAT64, 6to4 and Teredo ranges. The ordinary non-fake-DNS path is not claimed to be comprehensively DNS-rebinding-hardened by this change.

## Independent review

Independent reviewer found an initial preflight-to-transport DNS rebinding gap: fake-IP at extraction preflight could become public at a second lookup and fall back to ordinary fetch. Fixed with a retained Symbol route ticket. Reviewer rechecked the implementation and independently reran the regression: only the first local DNS call occurs and ordinary fetch is never called. No remaining release-blocking issue was identified.

Another real integration failure was found and fixed: fetch() forbids Host overrides, producing an HTTP 403 despite correct CONNECT and SNI. The final implementation uses undici.request, with original Host and fixed-IP dispatcher. HTTP response size is bounded and agents are released after completion/failure.

## Verified checks

- Typecheck: zero new errors.
- Architecture: 278/0; architecture graph 5/5.
- Public source policy: 22 cases / 15 source addresses; cross-origin credentials removed and private redirect never requested.
- Pinned proxy unit tests: IPv4/IPv6 public-only sets, existing config trust, DNS response identity, partial/mixed/private/CNAME responses, real loopback 407 response with literal bootstrap CONNECT, no fallback, invalid targets/methods produce no network request.
- fake→public→private DNS regression: verified route retained, local lookup count 1, ordinary fetch count 0.
- Live transport: local observer forwarded unchanged CONNECT tunnels to the existing proxy and recorded two `223.5.5.5:443` DNS tunnels plus the resolved public target tunnel. ClientHello contained dns.alidns.com and example.com SNI; actual webpage returned HTTP 200. The observer did not decrypt TLS or alter configuration.
- Live negative certificate: isolated self-signed wrong-host TLS endpoint was rejected before any HTTP request. This optional live check requires openssl; default portable unit tests do not.
- Actual HTML extractor, runtime-material evidence and team-watch evidence regression tests passed.
- Test classification audit passed. No full default suite or crash-injection suite was run.

## Product acceptance

The isolated real-model Electron test copies only the existing proxy's relevant configuration fields into temporary HOME; it does not change the real profile. The test must have two distinct completed native binding receipts with complete web-content, and both real results in the originating Bot conversation; model claims alone cannot pass it. It then pauses via natural language and exits normally.

A prior successful run observed complete raw HTML at 15:36 and 15:37 UTC, returned both results and paused. Final retained-ticket-source acceptance also passed: native fetch receipts at 15:40:08.642 and 15:41:06.464 UTC, bindings aa5417da and 6a0ba058, both complete web-content with identical hash 4e7eb7855bcd0ce15d812bd0d430a4e8304f8ac367312ac31a35aec7687cce83. Both results reached the original conversation; natural-language pause succeeded, final lifecycle paused, isolated Electron exited normally. Screenshot inspected. This proves repeated complete unchanged observation, not a live website change event.

Reproduce on the same supported environment:

```
BOT_WEB_EXPECT_SUCCESS=1 BOT_WEB_EXISTING_PROXY_CONFIG=/home/vivion/.local/share/com.follow.clash/config.yaml BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --web-watch
```

This is a few-minute public-page test, not proof of annual uptime, arbitrary X account access, login support, or arbitrary website change semantics. It does not create a user's real ongoing monitor.
