export interface ManagedResourceAction {
  kind: "desktop" | "browser";
  taskId?: string;
  action: string;
  readonly: boolean;
  inputKey?: string;
}
export interface ManagedResourceBoundary {
  <T>(input: ManagedResourceAction, run: () => Promise<T>): Promise<T>;
}
let boundary: ManagedResourceBoundary | undefined;

/** Host composition installs one boundary; backend implementations keep their native validation. */
export function setManagedResourceBoundary(next: ManagedResourceBoundary | undefined): void { boundary = next; }
export function withManagedResource<T>(input: ManagedResourceAction, run: () => Promise<T>): Promise<T> {
  return boundary ? boundary(input, run) : run();
}
