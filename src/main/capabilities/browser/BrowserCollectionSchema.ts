import { Type, type Static } from "typebox";

const selector = Type.String({ minLength: 1, maxLength: 1000 });
const target = Type.Object({ selector, scopeSelector: Type.Optional(selector) }, { additionalProperties: false });
const attribute = Type.Object({ selector, scopeSelector: Type.Optional(selector), attribute: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const browserCollectionSchema = Type.Object({
  scopeSelector: Type.Optional(selector), rowSelector: selector, cellSelector: selector,
  keyAttribute: Type.String({ minLength: 1, maxLength: 100 }),
  rowIndexAttribute: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  expectedRows: Type.Optional(attribute), queryIdentity: Type.Optional(attribute),
  terminal: Type.Union([
    Type.Object({ kind: Type.Literal("present"), target }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("disabled"), target }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("attribute"), target: attribute, value: Type.String({ maxLength: 1000 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("scroll-end"), target }, { additionalProperties: false }),
  ]),
  advance: Type.Union([
    Type.Object({ kind: Type.Literal("next"), target }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("scroll"), target }, { additionalProperties: false }),
  ]),
  horizontal: Type.Optional(Type.Object({ viewport: target, columnIndexAttribute: Type.String({ minLength: 1, maxLength: 100 }), expectedColumns: Type.Optional(attribute), maxSteps: Type.Integer({ minimum: 1, maximum: 50 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type BrowserCollectionOptions = Static<typeof browserCollectionSchema>;
