import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { groupProjectTodos } from "../src/renderer/src/lib/projectWorkspace";

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-todo-"));
const db = new AppDatabase(join(root, "app.db"));
const service = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));

const project = service.create({ name: "调研" });
const todo = service.createTodo({
  projectId: project.id,
  title: "写方案",
  status: "todo",
  assignee: "我",
  tags: ["调研"],
});
assert.equal(todo.title, "写方案");
assert.equal(todo.status, "todo");
assert.ok(todo.id.startsWith("ptodo_"));

const moved = service.updateTodo({ id: todo.id, status: "doing" });
assert.equal(moved.status, "doing");

const listed = service.listTodos(project.id);
assert.equal(listed.length, 1);
assert.equal(listed[0]?.status, "doing");

const grouped = groupProjectTodos(listed);
assert.equal(grouped.doing.length, 1);
assert.equal(grouped.todo.length, 0);

service.deleteTodo(todo.id);
assert.equal(service.listTodos(project.id).length, 0);

assert.throws(() => service.createTodo({ projectId: project.id, title: "  " }), /标题/);

db.close();
rmSync(root, { recursive: true, force: true });
console.log("project-todo-test: PASS");
