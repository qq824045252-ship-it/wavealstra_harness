import assert from "node:assert/strict";
import { GATEWAY_SETUP_GUIDES, visibleGatewayFields } from "../src/renderer/src/components/settings/gatewaySetupGuides";
const feishu=["transport","appId","appSecret","verificationToken"].map(key=>({key}));
assert.deepEqual(visibleGatewayFields("feishu-default",{},feishu).map(x=>x.key),["transport","appId","appSecret"]);
assert.equal(visibleGatewayFields("feishu-default",{transport:"webhook"},feishu).length,4);
assert.equal(visibleGatewayFields("feishu-default",{verificationToken:"masked"},feishu).length,4);
const wecom=["mode","botId","corpId","agentId","secret","token","encodingAESKey"].map(key=>({key}));
assert.deepEqual(visibleGatewayFields("wecom-default",{mode:"smart"},wecom).map(x=>x.key),["mode","botId","secret"]);
assert.deepEqual(visibleGatewayFields("wecom-default",{botId:"id"},wecom).map(x=>x.key),["mode","botId","secret"]);
assert.equal(visibleGatewayFields("wecom-default",{mode:"callback"},wecom).length,6);
assert.equal(visibleGatewayFields("wecom-default",{},wecom).length,6);
assert.equal(Object.keys(GATEWAY_SETUP_GUIDES).length,7);
for(const guide of Object.values(GATEWAY_SETUP_GUIDES)){assert.equal(new URL(guide.url).protocol,"https:");assert.equal(guide.steps.length,3);}
console.log("Gateway setup guide PASS: mode-specific fields and seven official setup guides");
