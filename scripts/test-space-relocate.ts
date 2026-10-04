/**
 * 空间文件夹挪位后回收匹配（不碰真实数据）
 * 运行：pnpm run test:space-relocate
 */
import assert from "node:assert/strict";
import {
  findSpaceToRemount,
  spaceFolderBasename,
  spacePathKey,
} from "../src/shared/space-relocate";

type Space = { id: string; name: string; path?: string };

const spaces: Space[] = [
  { id: "aoda", name: "北京奥达数据", path: "C:\\Users\\servi\\Desktop\\北京奥达数据" },
  { id: "free", name: "free_project", path: "D:\\work\\free_project" },
  { id: "legacy", name: "周报系统" },
];

function existsFrom(live: Set<string>): (p: string) => boolean {
  return (p) => live.has(spacePathKey(p));
}

function check(label: string, fn: () => void): void {
  fn();
  console.log(`✔ ${label}`);
}

check("路径比较忽略尾斜杠与大小写", () => {
  assert.equal(spacePathKey("C:\\Foo\\Bar\\"), spacePathKey("c:/foo/bar"));
  assert.equal(spaceFolderBasename("C:\\Users\\servi\\Desktop\\北京奥达数据\\"), "北京奥达数据");
});

check("旧路径仍在 → 不回收（视为第二个目录）", () => {
  const live = new Set([spacePathKey("C:\\Users\\servi\\Desktop\\北京奥达数据"), spacePathKey("D:\\work\\free_project")]);
  const hit = findSpaceToRemount(
    spaces,
    "E:\\archive\\北京奥达数据",
    "北京奥达数据",
    existsFrom(live),
  );
  assert.equal(hit, undefined);
});

check("旧路径已不存在 + 同名 → 回收原空间", () => {
  const live = new Set([spacePathKey("D:\\work\\free_project")]);
  const hit = findSpaceToRemount(
    spaces,
    "E:\\archive\\北京奥达数据",
    "北京奥达数据",
    existsFrom(live),
  );
  assert.equal(hit?.id, "aoda");
});

check("空间已改名但旧文件夹名一致 + 旧路径消失 → 仍回收", () => {
  const renamed: Space[] = [{ id: "aoda", name: "奥达", path: "C:\\old\\北京奥达数据" }];
  const hit = findSpaceToRemount(renamed, "D:\\new\\北京奥达数据", "北京奥达数据", () => false);
  assert.equal(hit?.id, "aoda");
});

check("无路径的同名遗留空间 → 回收并回填", () => {
  const hit = findSpaceToRemount(spaces, "C:\\Users\\servi\\Desktop\\周报系统", "周报系统", () => false);
  assert.equal(hit?.id, "legacy");
});

check("目标路径已被占用 → 不回收", () => {
  const extra: Space[] = [
    ...spaces,
    { id: "newer", name: "北京奥达数据 2", path: "E:\\archive\\北京奥达数据" },
  ];
  const hit = findSpaceToRemount(
    extra,
    "E:\\archive\\北京奥达数据",
    "北京奥达数据",
    (p) => spacePathKey(p) === spacePathKey("E:\\archive\\北京奥达数据"),
  );
  assert.equal(hit, undefined);
});

check("同名优先于仅名字碰巧相同的无路径空间：basename 优先", () => {
  const mixed: Space[] = [
    { id: "name-only", name: "北京奥达数据" },
    { id: "moved", name: "奥达备份", path: "C:\\old\\北京奥达数据" },
  ];
  const hit = findSpaceToRemount(mixed, "D:\\new\\北京奥达数据", "北京奥达数据", () => false);
  assert.equal(hit?.id, "moved");
});

console.log("\n全部测试通过 ✅");
