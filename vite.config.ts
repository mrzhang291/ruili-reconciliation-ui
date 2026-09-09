// 文件说明：Vite 开发服务器和生产构建配置。
// 文件上传与 CherryStudio 调用已迁移到后端服务，前端不再需要本地上传插件和 API Key 注入。
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(() => {
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 3333,
      strictPort: true,
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
    },
  };
});
