import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function Form() {
  const [value, setValue] = useState("");
  return <><label>受控字段<input id="react" value={value} onChange={event => setValue(event.target.value)} /></label><button id="react-save" onClick={() => { document.body.dataset.reactSubmitted = value; }}>保存受控字段</button><input aria-label="拒绝修改" id="reject" value="固定" onChange={() => {}} /></>;
}
const root = document.getElementById("react-root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Form />);
