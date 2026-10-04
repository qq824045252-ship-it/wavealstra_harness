const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");

const file = path.join(__dirname, "..", "src", "renderer", "src", "components", "chat", "DetailCard.tsx");
const src = fs.readFileSync(file, "utf8");

try {
  babel.transformSync(src, {
    filename: file,
    presets: [],
    plugins: [],
    parserOpts: {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    },
  });
  console.log("PARSE OK");
} catch (e) {
  console.error("PARSE FAIL:", e.message);
  if (e.loc) console.error("at line", e.loc.line, "col", e.loc.column);
}
