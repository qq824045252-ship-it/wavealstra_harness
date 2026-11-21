import { verifyDeliveryContract, type DeliveryContract } from "./DeliveryContract";
import { fingerprint } from "./ImprovementDecisions";

/** Published bytes select a versioned, read-only host operation. */
export const deliveryTool = {
  id: "verify-markdown-delivery@1",
  input: ["workspace", "document", "headings", "attachments"],
  output: ["status", "missing", "evidence"],
  requires: ["read", "bound-workspace"],
  operations: ["read-stable-files", "match-markdown-headings", "check-attachments", "hash-file-contents"],
  writes: false,
};
export function executeDeliveryTool(tool:typeof deliveryTool, cwd:string, contract:DeliveryContract) {
  if(fingerprint(tool)!==fingerprint(deliveryTool)) throw new Error("无法执行该版本的交付检查工具");
  return verifyDeliveryContract(cwd,contract);
}
