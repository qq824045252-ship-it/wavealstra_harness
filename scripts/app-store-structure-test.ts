/**
 * The pre-refactor contract is frozen in app-store-contract.json. This gate
 * checks actual AST declarations/composition, not comments or copied snippets.
 * Behaviour and subscription lifetimes are covered by the store/runtime tests.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "@babel/parser";
import {
  APP_STORE_FACADE_PATH,
  APP_STORE_MODULE_ROOT,
  readAppStoreSources,
} from "./read-app-store-source";

interface Contract {
  actionAdditions: Record<string, string>;
  publicExports: Record<string, "type" | "value">;
  stateKeys: string[];
  optionalStateKeys: string[];
  actionKeys: string[];
  initializedKeys: string[];
}

interface SyntaxNode {
  type: string;
  [key: string]: unknown;
}
interface SourceModule {
  path: string;
  source: string;
  program: SyntaxNode;
}
interface Contribution {
  key: string;
  path: string;
  creator: string;
}

const contract: Contract = JSON.parse(
  readFileSync(join(process.cwd(), "scripts/app-store-contract.json"), "utf8"),
);
const modules = new Map<string, SourceModule>(
  readAppStoreSources().map(({ path, source }) => [
    path,
    {
      path,
      source,
      program: parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }).program as unknown as SyntaxNode,
    },
  ]),
);

const domains = [
  ["appUi", "AppUi"],
  ["tasks", "Tasks"],
  ["workspaces", "Workspaces"],
  ["projects", "Projects"],
  ["activeContext", "ActiveContext"],
  ["composer", "Composer"],
  ["artifacts", "Artifacts"],
  ["workbench", "Workbench"],
  ["terminal", "Terminal"],
  ["appConfig", "AppConfig"],
  ["capabilities", "Capabilities"],
] as const;
const appPath = (path: string): string => `${APP_STORE_MODULE_ROOT}/${path}`;

function node(value: unknown): SyntaxNode | undefined {
  return value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
    ? (value as SyntaxNode)
    : undefined;
}
function child(
  value: SyntaxNode | undefined,
  field: string,
): SyntaxNode | undefined {
  return node(value?.[field]);
}
function children(value: SyntaxNode | undefined, field: string): SyntaxNode[] {
  const items = value?.[field];
  return Array.isArray(items)
    ? items.map(node).filter((item): item is SyntaxNode => Boolean(item))
    : [];
}
function nameOf(value: unknown): string | undefined {
  const item = node(value);
  if (item?.type === "Identifier" && typeof item.name === "string")
    return item.name;
  if (item?.type === "StringLiteral" && typeof item.value === "string")
    return item.value;
  return undefined;
}
function unwrap(value: SyntaxNode | undefined): SyntaxNode | undefined {
  while (
    value &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(value.type)
  ) {
    value = child(value, "expression");
  }
  return value;
}
function walk(value: unknown, visit: (value: SyntaxNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const current = node(value);
  if (!current) return;
  visit(current);
  for (const [key, item] of Object.entries(current)) {
    if (
      !["loc", "leadingComments", "trailingComments", "innerComments"].includes(
        key,
      )
    )
      walk(item, visit);
  }
}
function sourceModule(path: string): SourceModule {
  const result = modules.get(path);
  assert.ok(result, `Missing app-store responsibility module: ${path}`);
  return result;
}
function assertSameMembers(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${label}: duplicate members`,
  );
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}
function declaration(statement: SyntaxNode): SyntaxNode | undefined {
  return statement.type === "ExportNamedDeclaration"
    ? child(statement, "declaration")
    : statement;
}
function findBinding(
  module: SourceModule,
  name: string,
): SyntaxNode | undefined {
  for (const statement of children(module.program, "body")) {
    const item = declaration(statement);
    if (!item) continue;
    if (item.type === "VariableDeclaration") {
      const binding = children(item, "declarations").find(
        (entry) => nameOf(entry.id) === name,
      );
      if (binding) return child(binding, "init");
    } else if (nameOf(item.id) === name) return item;
  }
  return undefined;
}
function propertyKey(property: SyntaxNode, label: string): string {
  assert.equal(
    Boolean(property.computed),
    false,
    `${label}: computed ownership keys are not reviewable`,
  );
  const key = nameOf(property.key);
  assert.ok(key, `${label}: expected a named property`);
  return key;
}
function interfaceMembers(module: SourceModule, name: string): SyntaxNode[] {
  const value = findBinding(module, name);
  assert.equal(
    value?.type,
    "TSInterfaceDeclaration",
    `${module.path} must declare ${name}`,
  );
  assert.equal(
    children(value, "extends").length,
    0,
    `${name}: declare ownership directly, without inherited fields`,
  );
  const members = children(child(value, "body"), "body");
  for (const member of members)
    assert.equal(
      member.type,
      "TSPropertySignature",
      `${name}: expected explicit state/action keys`,
    );
  return members;
}
function resolveModule(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(from), specifier))
    : specifier.startsWith("@/")
      ? `src/renderer/src/${specifier.slice(2)}`
      : undefined;
  if (!base) return undefined;
  return (
    [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}/index.ts`,
    ].find((path) => modules.has(path)) ?? base
  );
}
function findCallable(
  module: SourceModule,
  localName: string,
): { module: SourceModule; name: string; value: SyntaxNode } {
  const local = findBinding(module, localName);
  if (local) return { module, name: localName, value: local };
  for (const statement of children(module.program, "body")) {
    if (statement.type !== "ImportDeclaration") continue;
    const binding = children(statement, "specifiers").find(
      (entry) => nameOf(entry.local) === localName,
    );
    if (!binding) continue;
    const target = resolveModule(module.path, nameOf(statement.source) ?? "");
    assert.ok(
      target && modules.has(target),
      `${module.path}: ${localName} must resolve to an app-store module`,
    );
    const imported = nameOf(binding.imported);
    assert.ok(
      imported,
      `${module.path}: initializer imports must have explicit names`,
    );
    return findCallable(sourceModule(target), imported);
  }
  assert.fail(`${module.path}: cannot resolve initializer ${localName}`);
}
function returnedObject(value: SyntaxNode, label: string): SyntaxNode {
  assert.ok(
    [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(value.type),
    `${label}: expected a creator function`,
  );
  let result = unwrap(child(value, "body"));
  if (result?.type === "BlockStatement") {
    const returns = children(result, "body").filter(
      (item) => item.type === "ReturnStatement",
    );
    assert.equal(
      returns.length,
      1,
      `${label}: creator must return one explicit object`,
    );
    result = unwrap(child(returns[0], "argument"));
  }
  assert.equal(
    result?.type,
    "ObjectExpression",
    `${label}: creator must return an explicit object`,
  );
  return result!;
}
function contributions(
  module: SourceModule,
  object: SyntaxNode,
  creator: string,
  chain: string[] = [],
): Contribution[] {
  const result: Contribution[] = [];
  for (const property of children(object, "properties")) {
    if (property.type === "SpreadElement") {
      const call = unwrap(child(property, "argument"));
      assert.equal(
        call?.type,
        "CallExpression",
        `${module.path}/${creator}: spread an explicit creator call`,
      );
      const localName = nameOf(call!.callee);
      assert.ok(
        localName,
        `${module.path}/${creator}: creator calls must have named bindings`,
      );
      const target = findCallable(module, localName);
      const identity = `${target.module.path}#${target.name}`;
      assert.ok(
        !chain.includes(identity),
        `Recursive store composition: ${[...chain, identity].join(" -> ")}`,
      );
      result.push(
        ...contributions(
          target.module,
          returnedObject(target.value, identity),
          target.name,
          [...chain, identity],
        ),
      );
    } else {
      assert.ok(
        ["ObjectProperty", "ObjectMethod"].includes(property.type),
        `${module.path}/${creator}: unsupported initializer member`,
      );
      result.push({
        key: propertyKey(property, creator),
        path: module.path,
        creator,
      });
    }
  }
  return result;
}

// 1. The unchanged public facade is an explicit export contract, including types.
const facade = sourceModule(APP_STORE_FACADE_PATH);
const exports = new Map<string, "type" | "value">();
for (const statement of children(facade.program, "body")) {
  assert.notEqual(
    statement.type,
    "ExportAllDeclaration",
    "The facade must name its public exports, not leak an internal module with export *",
  );
  if (statement.type !== "ExportNamedDeclaration") continue;
  const value = child(statement, "declaration");
  const addExport = (
    name: string | undefined,
    kind: "type" | "value",
  ): void => {
    assert.ok(name, "Facade exports must be named");
    assert.ok(!exports.has(name), `Duplicate facade export: ${name}`);
    exports.set(name, kind);
  };
  if (value?.type === "VariableDeclaration") {
    for (const binding of children(value, "declarations"))
      addExport(nameOf(binding.id), "value");
  } else if (value)
    addExport(nameOf(value.id), value.type.startsWith("TS") ? "type" : "value");
  for (const specifier of children(statement, "specifiers")) {
    addExport(
      nameOf(specifier.exported),
      statement.exportKind === "type" || specifier.exportKind === "type"
        ? "type"
        : "value",
    );
  }
}
for (const [name, kind] of Object.entries(contract.publicExports))
  assert.equal(
    exports.get(name),
    kind,
    `Public ${kind} export must remain available: ${name}`,
  );
assertSameMembers(
  [...exports.keys()],
  Object.keys(contract.publicExports),
  "The public facade exposes the same named contract without leaking internal modules",
);
assert.ok(
  facade.source.split(/\r?\n/).length <= 200,
  "appStore.ts must remain a small public facade (at most 200 lines)",
);

// 2. Every existing field belongs to exactly one of the eleven state domains.
const stateOwnership: Contribution[] = [];
const optionalStateKeys: string[] = [];
for (const [file, domain] of domains) {
  const module = sourceModule(appPath(`slices/${file}.ts`));
  const members = interfaceMembers(module, `${domain}State`);
  const keys = members.map((member) => propertyKey(member, `${domain}State`));
  assertSameMembers(keys, [...new Set(keys)], `${domain}State declarations`);
  for (const member of members) {
    if (member.optional)
      optionalStateKeys.push(propertyKey(member, `${domain}State`));
    assert.notEqual(
      child(child(member, "typeAnnotation"), "typeAnnotation")?.type,
      "TSFunctionType",
      `${domain}State must own data; actions belong to AppActions`,
    );
  }
  const creator = `create${domain}State`;
  const binding = findBinding(module, creator);
  assert.ok(binding, `${module.path} must export ${creator}`);
  const initialized = contributions(
    module,
    returnedObject(binding, creator),
    creator,
  );
  assertSameMembers(
    initialized.map(({ key }) => key),
    keys,
    `${domain}State defaults preserve every declared field`,
  );
  stateOwnership.push(...initialized);
}
assertSameMembers(
  stateOwnership.map(({ key }) => key),
  contract.stateKeys,
  "Every legacy state field has exactly one domain owner",
);
assertSameMembers(
  optionalStateKeys,
  contract.optionalStateKeys,
  "Optional state fields preserve their type contract",
);

const actionMembers = interfaceMembers(
  sourceModule(appPath("actions.ts")),
  "AppActions",
);
assertSameMembers(
  actionMembers.map((member) => propertyKey(member, "AppActions")),
  [...contract.actionKeys, ...Object.keys(contract.actionAdditions)],
  "AppActions preserves every legacy action and declares only approved additions",
);
const appState = findBinding(sourceModule(appPath("types.ts")), "AppState");
assert.equal(
  appState?.type,
  "TSTypeAliasDeclaration",
  "AppState must be the intersection of domain states and actions",
);
const intersection = child(appState, "typeAnnotation");
assert.equal(
  intersection?.type,
  "TSIntersectionType",
  "AppState must compose state domains without duplicating their declarations",
);
assertSameMembers(
  children(intersection, "types").map((type) => {
    assert.equal(
      type.type,
      "TSTypeReference",
      "AppState members must reference named state/action interfaces",
    );
    const name = nameOf(type.typeName);
    assert.ok(name, "AppState members must have explicit names");
    return name;
  }),
  ["AppActions", ...domains.map(([, domain]) => `${domain}State`)],
  "AppState composes all eleven domains and AppActions exactly once",
);

// 3. Inspect the actual factory spread order so later spreads cannot hide keys.
const factory = sourceModule(appPath("createAppStore.ts"));
const compositions: SyntaxNode[] = [];
walk(factory.program, (value) => {
  if (value.type !== "ObjectExpression") return;
  if (
    children(value, "properties").some(
      (property) =>
        property.type === "SpreadElement" &&
        nameOf(child(child(property, "argument"), "callee")) ===
          "createAppUiState",
    )
  )
    compositions.push(value);
});
assert.equal(
  compositions.length,
  1,
  "createAppStore must have one explicit composition of its state/action creators",
);
const initialized = contributions(factory, compositions[0]!, "createAppStore");
const duplicateKeys = initialized.filter(
  (item, index) =>
    initialized.findIndex((other) => other.key === item.key) !== index,
);
assert.deepEqual(
  duplicateKeys,
  [],
  "No state/action creator may overwrite another creator's key",
);
assertSameMembers(
  initialized.map(({ key }) => key),
  [...contract.initializedKeys, ...Object.keys(contract.actionAdditions)],
  "The factory initializes every legacy key and approved action addition exactly once",
);

// 4. Lower modules receive context; only public hooks/compatibility adapters can
// import the singleton. Check re-exports, dynamic import, and require as well.
const singletonBoundaries = new Set([
  APP_STORE_FACADE_PATH,
  appPath("store.ts"),
  appPath("hooks.ts"),
  appPath("compat.ts"),
]);
for (const module of modules.values()) {
  walk(module.program, (value) => {
    let specifier: string | undefined;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(value.type)
    ) {
      specifier = nameOf(value.source);
    } else if (value.type === "CallExpression") {
      const callee = child(value, "callee");
      if (callee?.type === "Import" || nameOf(callee) === "require")
        specifier = nameOf(children(value, "arguments")[0]);
    }
    if (!specifier) return;
    if (
      value.type === "ImportDeclaration" &&
      /^zustand(?:\/vanilla)?$/.test(specifier)
    ) {
      const constructsStore = children(value, "specifiers").some(
        (binding) =>
          binding.type === "ImportDefaultSpecifier" ||
          ["create", "createStore"].includes(nameOf(binding.imported) ?? ""),
      );
      assert.ok(
        !constructsStore || module.path === appPath("createAppStore.ts"),
        `${module.path}: only createAppStore may construct a Zustand store`,
      );
    }
    const target = resolveModule(module.path, specifier);
    assert.ok(
      target !== appPath("createAppStore.ts") ||
        module.path === appPath("store.ts"),
      `${module.path}: only store.ts may import the factory to create the public singleton`,
    );
    assert.ok(
      singletonBoundaries.has(module.path) ||
        !target ||
        !singletonBoundaries.has(target),
      `${module.path} must receive AppContext, not import ${specifier}`,
    );
  });
}
const singleton = sourceModule(appPath("store.ts"));
let factoryCalls = 0;
walk(singleton.program, (value) => {
  if (
    value.type === "CallExpression" &&
    nameOf(value.callee) === "createAppStore"
  )
    factoryCalls += 1;
});
assert.equal(
  factoryCalls,
  1,
  "The public store boundary must construct exactly one app-store instance",
);

console.log(
  `app-store-structure: PASS (${exports.size} public exports, ${domains.length} domains, ${contract.stateKeys.length} state fields, ${actionMembers.length} actions; no overwritten keys or singleton back-imports)`,
);
