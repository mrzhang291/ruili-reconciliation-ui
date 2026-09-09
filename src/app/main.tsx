// 文件说明：React 应用入口，把 App 挂载到 index.html 的 root 节点。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../shared/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
