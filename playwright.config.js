// Playwright 配置:桌面 + 手机两个 project,全程录像与截图,记录到 recordings/
// 本地 chromium 依赖库通过 LD_LIBRARY_PATH 注入(容器无 root,依赖解压于 .syslibs/)
const path = require("path");
const fs = require("fs");

const syslibs = path.join(__dirname, ".syslibs", "root");
if (fs.existsSync(syslibs)) {
  const dirs = [
    path.join(syslibs, "lib", "aarch64-linux-gnu"),
    path.join(syslibs, "usr", "lib", "aarch64-linux-gnu"),
  ].filter((d) => fs.existsSync(d));
  process.env.LD_LIBRARY_PATH = dirs.join(":") + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
}

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./recordings/.artifacts",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8734",
    video: { mode: "on", size: { width: 1280, height: 800 } },
    screenshot: "on",
    trace: "on",
    locale: "zh-CN",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 412, height: 800 } },
    },
  ],
  webServer: {
    command: "node scripts/serve.js 8734",
    url: "http://127.0.0.1:8734",
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
});
