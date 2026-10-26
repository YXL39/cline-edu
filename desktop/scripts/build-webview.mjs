/**
 * 构建 standalone webview（跨平台设置 PLATFORM=standalone，无需 cross-env）。
 * 产物：../webview-ui/build/index.html
 */
import { execSync } from "child_process"
import * as path from "path"
import { fileURLToPath } from "url"

const here = path.dirname(fileURLToPath(import.meta.url))
const webviewDir = path.join(here, "..", "..", "webview-ui")

console.log(`[desktop] 构建 standalone webview: ${webviewDir}`)
execSync("npm run build", {
	cwd: webviewDir,
	env: { ...process.env, PLATFORM: "standalone" },
	stdio: "inherit",
})
console.log("[desktop] standalone webview 构建完成 → webview-ui/build/index.html")
