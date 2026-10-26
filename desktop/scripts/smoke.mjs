/**
 * 冒烟测试：不启动 Electron，直接验证宿主侧全链路。
 *   1. 构建并启动 HostBridge gRPC 服务器（host.* + 健康检查）
 *   2. 以子进程启动 cline-core（standalone）
 *   3. 通过 ProtoBusBridge 模拟 webview 发送 cline.UiService.getWebviewHtml，
 *      断言收到成功响应。
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from "child_process"
import * as esbuild from "esbuild"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, "..")
const root = path.join(desktopDir, "..")

const HB_PORT = 28041
const PB_PORT = 28040
const HB_ADDR = `127.0.0.1:${HB_PORT}`
const PB_ADDR = `127.0.0.1:${PB_PORT}`

function log(msg) {
	console.log(`[smoke] ${msg}`)
}

function fail(reason, tail = []) {
	log(`FAIL: ${reason}`)
	if (tail.length) {
		log("---- cline-core last log lines ----")
		for (const l of tail.slice(-25)) console.log(`  ${l}`)
	}
	process.exit(1)
}

// 1) 构建 hostbridge / protobus-client（CJS，供 node 直接 require）
log("building hostbridge.ts / protobus-client.ts ...")
await esbuild.build({
	platform: "node",
	target: "node18",
	format: "cjs",
	bundle: true,
	sourcemap: false,
	logLevel: "silent",
	absWorkingDir: desktopDir,
	external: ["@grpc/grpc-js", "grpc-health-check", "@grpc/proto-loader"],
	entryPoints: [
		path.join(desktopDir, "src", "hostbridge.ts"),
		path.join(desktopDir, "src", "protobus-client.ts"),
	],
	outdir: path.join(desktopDir, "out-smoke"),
	outbase: path.join(desktopDir, "src"),
})
const { HostBridgeServer } = await import(pathToFileURL(path.join(desktopDir, "out-smoke", "hostbridge.js")).href)
const { ProtoBusBridge } = await import(pathToFileURL(path.join(desktopDir, "out-smoke", "protobus-client.js")).href)

// 2) 定位 cline-core
const coreDir = path.join(root, "dist-standalone")
const coreEntry = path.join(coreDir, "cline-core.js")
if (!fs.existsSync(coreEntry)) {
	fail(
		`cline-core runtime not found: ${coreEntry}. Run in repo root first:\n  node esbuild.mjs --standalone && node scripts/package-standalone.mjs -s`,
	)
}

// 临时数据目录
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-edu-smoke-"))
log(`temp data dir: ${dataDir}`)

// 3) 启动 hostbridge
const hb = new HostBridgeServer({
	hostName: "ClineEdu Smoke",
	hostVersion: "smoke",
	clineVersion: "smoke",
	studentDataDir: dataDir,
	writeClipboard: () => {},
	readClipboard: () => "",
	openExternal: () => {},
	openPath: async () => false,
	showMessage: async () => "",
	showInputBox: async () => null,
	showSaveDialog: async () => undefined,
	showOpenDialogue: async () => [],
	forwardToRenderer: () => {},
	log: (line) => console.log(`[hostbridge] ${line}`),
	onShutdown: () => {},
	getWebviewHtml: () => "<html><body>smoke</body></html>",
})
await hb.start(HB_ADDR)
log(`hostbridge ready: ${HB_ADDR}`)

// 4) 启动 cline-core
log(`spawning cline-core (CLINE_DIR=${dataDir}) ...`)
// 补齐 <INSTALL_DIR>/extension/package.json（与 ClineCoreService.ensureRuntimeFiles 相同逻辑）
const extPkg = path.join(coreDir, "extension", "package.json")
if (!fs.existsSync(extPkg)) {
	const rootPkg = path.join(coreDir, "..", "package.json")
	fs.mkdirSync(path.dirname(extPkg), { recursive: true })
	if (fs.existsSync(rootPkg)) fs.copyFileSync(rootPkg, extPkg)
}
const core = spawn(process.execPath, [coreEntry], {
	cwd: coreDir,
	env: {
		...process.env,
		CLINE_DIR: dataDir,
		PROTOBUS_ADDRESS: PB_ADDR,
		HOST_BRIDGE_ADDRESS: HB_ADDR,
		IS_DEV: "false",
		// vscode 占位包（与 ClineCoreService 注入保持一致）
		NODE_PATH: [path.join(desktopDir, "stubs", "node_modules"), process.env.NODE_PATH].filter(Boolean).join(
			path.delimiter,
		),
	},
	stdio: ["ignore", "pipe", "pipe"],
})
const coreLines = []
const onCoreData = (d) => {
	for (const line of d.toString().split(/\r?\n/).filter((l) => l.trim())) {
		coreLines.push(line)
		console.log(`[core] ${line}`)
	}
}
core.stdout.on("data", onCoreData)
core.stderr.on("data", (d) => onCoreData(`[stderr] ${d.toString()}`))

let exited = null
core.on("exit", (code) => {
	if (exited === null) exited = code
})

// 5) 等待 cline-core 就绪（日志出现 "All services started successfully"，或进程已退出）
const t0 = Date.now()
const ready = await new Promise((resolve) => {
	const timer = setInterval(async () => {
		if (exited !== null) {
			clearInterval(timer)
			resolve(false)
			return
		}
		const running = coreLines.some((l) => /All services started successfully/i.test(l))
		if (running || Date.now() - t0 > 90_000) {
			clearInterval(timer)
			resolve(running)
		}
	}, 1000)
})
if (!ready) fail("cline-core not ready within 90s (or exited)", coreLines)
log("cline-core ready")

// 6) 通过 ProtoBusBridge 发起真实 gRPC 调用（模拟 webview）
const responses = []
const bridge = new ProtoBusBridge(PB_ADDR, (payload) => {
	responses.push(payload)
	log(`response frame: ${JSON.stringify(payload).slice(0, 300)}`)
})

bridge.handleWebviewMessage(
	JSON.stringify({
		type: "grpc_request",
		grpc_request: {
			service: "cline.UiService",
			method: "getWebviewHtml",
			message: {},
			request_id: "smoke-1",
			is_streaming: false,
		},
	}),
)

const t1 = Date.now()
const deadline = 15_000
const ok = await new Promise((resolve) => {
	const timer = setInterval(() => {
		const r = responses.find((m) => m.grpc_response?.request_id === "smoke-1")
		if (r) {
			clearInterval(timer)
			resolve(!!r.grpc_response?.message && !r.grpc_response?.error)
		} else if (Date.now() - t1 > deadline) {
			clearInterval(timer)
			resolve(false)
		}
	}, 250)
})
if (!ok) fail("no successful getWebviewHtml response (ProtoBus bridge failed?)", coreLines)
log("PASS: ProtoBus bridge OK (webview request -> cline-core -> response)")

// 7) 清理
bridge.close()
core.kill("SIGTERM")
await new Promise((r) => setTimeout(r, 1500))
if (!core.killed) core.kill("SIGKILL")
hb.stop()
log("SMOKE TEST PASSED")
process.exit(0)
