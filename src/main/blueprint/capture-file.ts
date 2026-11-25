import { redactBlueprintSecrets } from "../../shared/blueprint-secret-policy";
import type { RuntimeCapturedFile } from "../platform/runtime-audit";
import type { GadgetSourceFile } from "../../shared/gadget-types";

export function decodeBlueprintFile(file: RuntimeCapturedFile): GadgetSourceFile & { encoding: "utf8" | "base64" } {
  return {
    path: file.path,
    content: file.text ? redactBlueprintSecrets(Buffer.from(file.content, "base64").toString("utf8")) : file.content,
    encoding: file.text ? "utf8" : "base64",
  };
}
