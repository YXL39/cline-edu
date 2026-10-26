/**
 * ClineEdu 桌面版 —— Electron 主进程。
 *
 * 启动序列：
 *   1. 启动 HostBridge gRPC 服务器（host.* 服务 + 标准健康检查），
 *      使 cline-core 的启动前置检查通过；
 *   2. 以子进程方式托管 cline-core（standalone）；
 *   3. 创建 BrowserWindow，加载 standalone webview（build 产物），
 *      用 ProtoBusBridge 把 webview 的 gRPC JSON 消息转发到 cline-core。
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import * as fs from "fs"
import * as net from "net"
import * as path from "path"
import { ClineCoreService } from "./cline-core"
import { HostBridgeServer, type HostBridgeContext } from "./hostbridge"
import { ProtoBusBridge } from "./protobus-client"
import { Settings } from "./settings"

const HOST_NAME = "ClineEdu Desktop"
const settings = new Settings()
const core = new ClineCoreService()
let win: BrowserWindow | null = null
let hostbridge: HostBridgeServer | null = null
let bridge: ProtoBusBridge | null = null
let quitting = false

// ── 资源定位 ─────────────────────────────────────────────────────

function repoRootCandidates(): string[] {
	// 注意：不能用 process.cwd()——它可能指向用户主目录等无关位置，
	// 那里的 build/index.html（如 Cline 上游 VSCode 版 webview）会被误加载导致白屏。
	return [
		// 开发构建：repo/desktop/out -> repo
		path.join(__dirname, "..", ".."),
		// 桌面目录旁放了 repo 副本的情况
		path.join(__dirname, ".."),
	]
}

function findWebviewPage(): string | null {
	for (const root of repoRootCandidates()) {
		// 必须同时是「ClineEdu 仓库根」（含 webview-ui 工程）且已构建 standalone 产物
		const marker = path.join(root, "webview-ui", "package.json")
		const p = path.join(root, "webview-ui", "build", "index.html")
		if (fs.existsSync(marker) && fs.existsSync(p)) return p
	}
	return null
}

function findClineVersion(): string {
	for (const root of repoRootCandidates()) {
		const p = path.join(root, "package.json")
		if (fs.existsSync(p)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(p, "utf-8"))
				if (typeof pkg.version === "string") return pkg.version
			} catch {
				/* ignore */
			}
		}
	}
	return "unknown"
}

/**
 * 向 standalone webview 的 index.html 注入宿主引导脚本（幂等）。
 * 引导脚本把 `window.standalonePostMessage`（webview 的出站通道）接到
 * preload 暴露的 `window.electron.host`，并把主进程的响应帧 post 回 window。
 */
function ensureHostBootstrap(htmlFile: string): void {
	try {
		const html = fs.readFileSync(htmlFile, "utf-8")
		const MARKER = "ClineEdu host bootstrap"
		if (html.includes(MARKER)) return
		const script = `<script>
/* ${MARKER} */
;(function () {
	var host = window.electron && window.electron.host
	if (!host) return
	window.standalonePostMessage = function (json) { host.postMessage(json) }
	host.onGrpcResponse(function (payload) { window.postMessage(payload, "*") })
	host.onHostEvent(function (payload) {
		if (payload && window.addEventListener) window.postMessage({ type: "host-event", channel: payload.channel, data: payload.data }, "*")
	})
})()
</script>`
		const out = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${script}`)
		if (out === html) {
			console.warn("[main] 未找到 <head>，无法注入引导脚本:", htmlFile)
			return
		}
		fs.writeFileSync(htmlFile, out, "utf-8")
	} catch (err) {
		console.warn("[main] 注入宿主引导脚本失败:", err)
	}
}

/**
 * 校验 webview 产物是否为 standalone 平台构建。
 * vite define 会把 `__PLATFORM__` 内联成字符串字面量，bundle 中会出现
 * `Build platform:"vscode"` 或 `Build platform:"standalone"`。
 * 加载到 vscode 版产物会导致 Electron 内 `acquireVsCodeApi` 缺失、
 * 所有 postMessage 静默丢弃 → 白屏。
 */
function webviewIsStandalone(): boolean {
	try {
		const root = findRepoRoot()
		if (!root) return false
		const p = path.join(root, "webview-ui", "build", "assets", "index.js")
		if (!fs.existsSync(p)) return false
		const text = fs.readFileSync(p, "utf-8")
		// 实际形态（minify 后）：`Build platform:","standalone")` 或 `Build platform:","vscode")`
		const m = /Build platform:\s*"?,?\s*"([a-z]+)/.exec(text)
		return m?.[1] === "standalone"
	} catch {
		return false
	}
}

function findRepoRoot(): string | null {
	for (const root of repoRootCandidates()) {
		if (fs.existsSync(path.join(root, "package.json"))) return root
	}
	return null
}

function buildHostContext(): HostBridgeContext {
	const s = settings.load()
	return {
		hostName: HOST_NAME,
		hostVersion: app.getVersion(),
		clineVersion: findClineVersion(),
		studentDataDir: s.studentDataDir || undefined,
		writeClipboard: (text) => clipboard.writeText(text),
		readClipboard: () => clipboard.readText(),
		openExternal: (url) => {
			if (/^https?:\/\//i.test(url)) {
				void shell.openExternal(url)
			} else {
				console.warn(`[hostbridge] 拒绝打开非 http(s) 链接: ${url}`)
			}
		},
		openPath: async (p) => {
			if (!p) return false
			const err = await shell.openPath(p)
			return !err
		},
		showMessage: async (payload) => {
			if (!win || win.isDestroyed()) return ""
			const icon = (["error", "info", "warning"] as const)[payload.type] ?? "info"
			const items = payload.items && payload.items.length > 0 ? payload.items : ["OK"]
			const res = await dialog.showMessageBox(win, {
				type: icon,
				message: payload.message,
				detail: payload.detail,
				buttons: items,
				// 注：Electron MessageBoxOptions 无 modal/noButton 字段；
				// 传窗口参数的对话框本身就是窗口模态。
			})
			return items[res.response] ?? ""
		},
		showInputBox: async (payload) => {
			if (!win || win.isDestroyed()) return null
			// Electron 原生对话框不支持文本输入（inputBox/responseText 非 Electron 字段，会被忽略）。
			// 当前以 question 消息框近似；如需真正的输入框，可另做小模态 BrowserWindow 实现。
			const res = await dialog.showMessageBox(win, {
				type: "question",
				title: payload.title || "输入",
				message: payload.prompt ?? payload.title ?? "",
				buttons: ["确定", "取消"],
			})
			if (res.response === 1) return null
			return ""
		},
		showSaveDialog: async (payload) => {
			if (!win || win.isDestroyed()) return undefined
			const filters: { name: string; extensions: string[] }[] = Object.entries(payload.filters ?? {}).map(
				([name, exts]) => ({ name, extensions: exts.map((e) => e.replace(/^\./, "")) }),
			)
			const res = await dialog.showSaveDialog(win, { defaultPath: payload.defaultPath, filters })
			return res.canceled ? undefined : res.filePath
		},
		showOpenDialogue: async (payload) => {
			if (!win || win.isDestroyed()) return []
			const res = await dialog.showOpenDialog(win, {
				// Electron 用 properties 控制多选（canMultiSelect 非 Electron 字段，之前实际不生效）
				properties: payload.canSelectMany ? ["openFile", "multiSelections"] : ["openFile"],
				title: payload.openLabel,
			})
			return res.canceled ? [] : res.filePaths
		},
		forwardToRenderer: (channel, data) => {
			if (win && !win.isDestroyed()) {
				win.webContents.send("host:event", { channel, data })
			}
		},
		log: (line) => console.log(line),
		onShutdown: () => {
			if (!quitting) app.quit()
		},
		getWebviewHtml: () => {
			const page = findWebviewPage()
			return page ? fs.readFileSync(page, "utf-8") : ""
		},
	}
}

function startCore(): void {
	const s = settings.load()
	console.log(`[main] 启动 cline-core: dataDir=${s.studentDataDir} protobus=${s.protobusAddress} hostbridge=${s.hostBridgeAddress}`)
	bridge?.close()
	bridge = null
	core.start({
		dataDir: s.studentDataDir,
		protobusAddress: s.protobusAddress,
		hostBridgeAddress: s.hostBridgeAddress,
	})
	bridge = new ProtoBusBridge(s.protobusAddress, (payload) => {
		if (win && !win.isDestroyed()) win.webContents.send("host:grpc-response", payload)
	})
	core.onLog = (line) => {
		console.log(`[core] ${line}`)
		if (win && !win.isDestroyed()) win.webContents.send("core:log", line)
	}
	core.onExit = (code) => {
		if (quitting) return
		console.error(`[main] cline-core 意外退出 (code=${code})，最后日志：`)
		for (const line of core.getLogs().split("\n").slice(-30)) console.error(`  ${line}`)
		if (win && !win.isDestroyed()) {
			void dialog
				.showMessageBox(win, {
					type: "error",
					title: "ClineEdu",
					message: "核心服务（cline-core）意外退出。",
					detail: core.getLogs().split("\n").slice(-15).join("\n"),
					buttons: ["退出", "重启核心"],
				})
				.then(({ response }) => {
					if (response === 1) restartCore()
					else app.quit()
				})
		} else {
			app.quit()
		}
	}
}

function restartCore(): void {
	bridge?.close()
	bridge = null
	core.stop()
	startCore()
}

/**
 * 轮询等待 cline-core 的 ProtoBus gRPC 端口可连接。
 * webview 的 standalone gRPC 栈在加载时会立即发起订阅；若 cline-core
 * 尚未在 protobusAddress 上 listening，会得到 ECONNREFUSED 且不再自恢复，
 * 导致白屏。故加载 webview 前必须等该端口就绪。
 */
function waitForProtoBus(address: string, timeoutMs = 25000): Promise<boolean> {
	const sep = address.lastIndexOf(":")
	const host = sep > 0 ? address.slice(0, sep) : "127.0.0.1"
	const port = sep > 0 ? Number(address.slice(sep + 1)) : 26040
	const start = Date.now()
	const probe = (): Promise<boolean> =>
		new Promise((resolve) => {
			const sock = net.connect({ host, port })
			const finish = (ok: boolean) => {
				sock.destroy()
				resolve(ok)
			}
			sock.once("connect", () => finish(true))
			sock.once("error", () => finish(false))
			setTimeout(() => finish(false), 800)
		})
	return (async () => {
		while (Date.now() - start < timeoutMs) {
			if (await probe()) return true
			await new Promise((r) => setTimeout(r, 300))
		}
		return false
	})()
}

async function createWindow(): Promise<void> {
	win = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: HOST_NAME,
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			backgroundThrottling: false,
			devTools: true,
		},
	})

	// 排错：把渲染层 console / 加载错误转发到主进程日志
	win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
		const tag = level >= 3 ? "ERR" : level === 1 ? "WARN" : "log"
		console.log(`[webview-console:${tag}] ${message} (line ${line} of ${sourceId})`)
	})
	win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
		console.error(`[webview-load-fail] code=${code} ${desc} url=${url} main=${isMainFrame}`)
	})

	const page = findWebviewPage()
	if (page) {
		ensureHostBootstrap(page)
		// 等 cline-core 的 ProtoBus 就绪再加载 webview，避免 gRPC 初始化 ECONNREFUSED 竞态
		const protobus = settings.load().protobusAddress
		const ready = await waitForProtoBus(protobus, 25000)
		console.log(
			ready
				? `[main] ProtoBus 就绪 (${protobus})，加载 webview`
				: `[main] 等待 ProtoBus (${protobus}) 超时，仍加载 webview（gRPC 可能暂不可用）`,
		)
		void win.loadFile(page)
	} else {
		const msg = `尚未构建 standalone webview。

请在仓库目录执行：
  cd webview-ui
  cross-env PLATFORM=standalone npm run build

完成后重启本应用。`
		void win.loadURL(
			"data:text/html;charset=utf-8," +
				encodeURIComponent(`<pre style="font-family:monospace;white-space:pre-wrap;padding:32px;color:#333">${msg}</pre>`),
		)
	}

	win.on("closed", () => {
		win = null
	})
}

// ── 应用生命周期 ─────────────────────────────────────────────────

app.whenReady().then(async () => {
	// 默认学生数据目录
	const s = settings.load()
	if (!s.studentDataDir) {
		const def = path.join(app.getPath("documents"), "ClineEdu")
		fs.mkdirSync(def, { recursive: true })
		settings.save({ studentDataDir: def })
	}

	// 1) HostBridge gRPC 服务（cline-core 启动前必须就绪）
	try {
		hostbridge = new HostBridgeServer(buildHostContext())
		const port = await hostbridge.start(settings.load().hostBridgeAddress)
		console.log(`[main] hostbridge 就绪: ${port}`)
	} catch (err) {
		console.error("[main] hostbridge 启动失败:", err)
		void dialog.showErrorBox("ClineEdu", `hostbridge 启动失败：${String(err)}`)
		app.quit()
		return
	}

	// 2) 核心服务 + 窗口
	startCore()
	void createWindow()

	// 3) IPC
	ipcMain.on("webview:message", (_e, json: unknown) => {
		bridge?.handleWebviewMessage(String(json))
	})
	ipcMain.handle("app:selectDirectory", async () => {
		if (!win || win.isDestroyed()) return undefined
		const res = await dialog.showOpenDialog(win, {
			title: "选择学生数据目录",
			properties: ["openDirectory", "createDirectory"],
			defaultPath: settings.load().studentDataDir,
		})
		if (res.canceled || res.filePaths.length === 0) return undefined
		const dir = res.filePaths[0]
		settings.save({ studentDataDir: dir })
		restartCore() // CLINE_DIR 变更需要重启核心
		return dir
	})
	ipcMain.handle("app:versions", async () => ({
		host: HOST_NAME,
		hostVersion: app.getVersion(),
		cline: findClineVersion(),
		dataDir: settings.load().studentDataDir,
		protobusAddress: settings.load().protobusAddress,
		hostBridgeAddress: settings.load().hostBridgeAddress,
	}))
	ipcMain.handle("core:restart", async () => {
		restartCore()
		return true
	})
})

app.on("before-quit", () => {
	quitting = true
	core.stop()
	bridge?.close()
	bridge = null
	hostbridge?.stop()
})

app.on("window-all-closed", () => {
	app.quit()
})