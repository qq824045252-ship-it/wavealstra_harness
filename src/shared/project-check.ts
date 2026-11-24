export const STANDALONE_PROJECT_TESTS = {
  pytest: "pytest",
  "python-pytest": "python -m pytest",
  "go-test": "go test ./...",
  "cargo-test": "cargo test",
} as const;

export function standaloneProjectTest(name: string): string | undefined {
  return Object.hasOwn(STANDALONE_PROJECT_TESTS, name)
    ? STANDALONE_PROJECT_TESTS[name as keyof typeof STANDALONE_PROJECT_TESTS] : undefined;
}

export const PROJECT_CHECK_NAME_PATTERN = "^(?:typecheck|test(?::[a-zA-Z0-9][a-zA-Z0-9:_-]*)?|" +
  Object.keys(STANDALONE_PROJECT_TESTS).join("|") + ")$";

export function isProjectTest(name: string): boolean {
  return /^test(?::[a-zA-Z0-9][a-zA-Z0-9:_-]*)?$/u.test(name) || Boolean(standaloneProjectTest(name));
}
