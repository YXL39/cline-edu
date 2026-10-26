/**
 * HostBridge gRPC 服务器（Electron 主进程侧）。
 *
 * cline-core（standalone）在 `HOST_BRIDGE_ADDRESS`（默认 127.0.0.1:26041）上调用
 * `host.*` 服务与标准 `grpc.health.v1.Health`。本文件实现这些服务，把「宿主环境」
 * 能力（剪贴板、对话框、终端、工作区检索等）通过 context 回调暴露给 Electron。
 *
 * 消息编解码复用仓库中由 protoc-gen-ts_proto 生成的 ServiceDefinition：
 *   - 服务端 `addService` 使用其中的 requestDeserialize / responseSerialize
 *   - 客户端（ProtoBusBridge）使用其中的 requestSerialize / responseDeserialize
 */
import * as grpc from "@grpc/grpc-js"
import { HealthImplementation } from "grpc-health-check"
import { promises as fsp } from "fs"
import * as path from "path"
// 共享的 gRPC 生成模块位于仓库根 src/generated/grpc-js（desktop/tsconfig 的 rootDir 之外），
// 用 ES import 会触发 TS6059（文件不在 rootDir 下）。改用 require：
//  - esbuild（build.mjs）打包时仍会解析并内联该目录的 index.ts，运行行为不变；
//  - tsc 检查期不再把生成 .ts 拉进编译单元（其类型即 any，调用处均已 as any）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generated = require("../../src/generated/grpc-js")

/** host 能力回调 —— 由 Electron 主进程提供，保持本模块与 electron 解耦 */
export interface HostBridgeContext {
	hostName: string // 如 "ClineEdu Desktop"
	hostVersion: string // 宿主应用版本
	clineVersion: string // cline 核心构建版本
	studentDataDir?: string // 学生数据目录（作为默认工作区根）
	writeClipboard: (text: string) => void
	readClipboard: () => string
	openExternal: (url: string) => void
	/** shell.openPath；成功返回 true */
	openPath: (p: string) => Promise<boolean>
	/** 消息框；返回被选中的选项文本，未选返回 "" */
	showMessage: (payload: {
		type: number
		message: string
		detail?: string
		items?: string[]
		modal?: boolean
	}) => Promise<string>
	/** 输入框；取消返回 null */
	showInputBox: (payload: { title: string; prompt?: string; value?: string }) => Promise<string | null>
	/** 保存对话框；取消返回 undefined */
	showSaveDialog: (payload: { defaultPath?: string; filters?: Record<string, string[]> }) => Promise<string | undefined>
	/** 打开资源对话框；取消/未选返回空数组 */
	showOpenDialogue: (payload: { canSelectMany?: boolean; openLabel?: string }) => Promise<string[]>
	/** 转发给渲染层（diff 预览 / 打开文件 / 终端命令等无原生 UI 的能力） */
	forwardToRenderer: (channel: string, payload: unknown) => void
	log: (line: string) => void
	/** 收到 env.shutdown RPC 时调用（宿主应随后退出） */
	onShutdown: () => void
	/** 返回 webview 的 index.html（TestingService.getWebviewHtml 用） */
	getWebviewHtml?: () => string
}

interface DiffDoc {
	id: string
	path?: string
	content: string
}

/**
 * 创建 hostbridge gRPC 服务器。
 * 调用 `start(hostBridgeAddress)` 后，cline-core 的健康检查即可通过。
 */
export class HostBridgeServer {
	private server: grpc.Server | null = null
	private health: HealthImplementation | null = null
	private diffs = new Map<string, DiffDoc>()
	private diffSeq = 0
	private started = false

	constructor(private ctx: HostBridgeContext) {}

	async start(address: string): Promise<number> {
		const server = new grpc.Server()

		const g = generated as any
		server.addService(g.host.DiffServiceService, this.buildDiffHandlers())
		server.addService(g.host.EnvServiceService, this.buildEnvHandlers())
		server.addService(g.host.TestingServiceService, this.buildTestingHandlers())
		server.addService(g.host.WindowServiceService, this.buildWindowHandlers())
		server.addService(g.host.WorkspaceServiceService, this.buildWorkspaceHandlers())

		// 标准健康检查（cline-core 启动时轮询 check({service: ""})）
		const health = new HealthImplementation({ "": "SERVING" })
		health.addToServer(server)
		this.health = health

		const port = await new Promise<number>((resolve, reject) => {
			server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
				if (err) reject(err)
				else resolve(boundPort)
			})
		})
		this.server = server
		this.started = true
		this.ctx.log(`[hostbridge] 服务已启动: ${address}`)
		return port
	}

	stop(): void {
		try {
			this.server?.forceShutdown()
		} catch {
			/* ignore */
		}
		this.server = null
		this.health = null
		this.started = false
	}

	get isStarted(): boolean {
		return this.started
	}

	private buildDiffHandlers(): Record<string, any> {
		const ctx = this.ctx
		const log = (m: string) => ctx.log(`[hostbridge:diff] ${m}`)

		const guard = (diffId: string, requirePath = true): DiffDoc | null => {
			const doc = this.diffs.get(diffId)
			if (!doc) {
				log(`未知 diff_id: ${diffId}`)
				return null
			}
			if (requirePath && !doc.path) {
				log(`diff ${diffId} 无文件路径，无法落盘操作`)
				return null
			}
			return doc
		}

		return {
			openDiff: (call: any, cb: any) => {
				const req = call.request as any
				const existing = this.diffs.get(req.diff_id)
				const id = req.diff_id || req.path || `diff-${++this.diffSeq}`
				const doc: DiffDoc = {
					id,
					path: req.path || existing?.path,
					content: req.content ?? existing?.content ?? "",
				}
				this.diffs.set(id, doc)
				// 让渲染层有机会展示差异（当前仅转发，UI 可选实现）
				ctx.forwardToRenderer("host:openDiff", { diff_id: id, path: doc.path, content: doc.content })
				log(`openDiff ${id} (${doc.content.length} chars)`)
				cb(null, { diff_id: id })
			},
			getDocumentText: (call: any, cb: any) => {
				const { diff_id: diffId } = call.request as any
				const doc = guard(diffId, false)
				cb(null, { content: doc?.content ?? "" })
			},
			replaceText: (call: any, cb: any) => {
				const { diff_id: diffId, content, start_line: startLine, end_line: endLine } = call.request as any
				const doc = guard(diffId, false)
				if (!doc) {
					cb(null, {})
					return
				}
				const lines = doc.content.split("\n")
				if (startLine > 0 && endLine >= startLine) {
					lines.splice(startLine - 1, endLine - startLine + 1, ...String(content ?? "").split("\n"))
					doc.content = lines.join("\n")
				} else {
					doc.content = String(content ?? "")
				}
				cb(null, {})
			},
			scrollDiff: (_call: any, cb: any) => cb(null, {}),
			truncateDocument: (call: any, cb: any) => {
				const { diff_id: diffId, end_line: endLine } = call.request as any
				const doc = guard(diffId, false)
				if (doc && endLine >= 0) {
					const lines = doc.content.split("\n")
					doc.content = lines.slice(0, endLine).join("\n")
				}
				cb(null, {})
			},
			saveDocument: async (call: any, cb: any) => {
				const { diff_id: diffId } = call.request as any
				const doc = guard(diffId)
				if (!doc) {
					cb(null, {})
					return
				}
				try {
					await fsp.mkdir(path.dirname(doc.path!), { recursive: true })
					await fsp.writeFile(doc.path!, doc.content, "utf-8")
					log(`saveDocument ${diffId} -> ${doc.path}`)
				} catch (err: any) {
					log(`saveDocument 失败: ${err?.message}`)
					const e: grpc.ServerErrorResponse = {
					name: "serverError",
					code: grpc.status.INTERNAL,
					message: `saveDocument 失败: ${err?.message}`,
				}
					cb(e)
					return
				}
				cb(null, {})
			},
			closeAllDiffs: (_call: any, cb: any) => {
				this.diffs.clear()
				ctx.forwardToRenderer("host:closeAllDiffs", {})
				cb(null, {})
			},
			openMultiFileDiff: (call: any, cb: any) => {
				const req = call.request as any
				ctx.forwardToRenderer("host:openMultiDiff", req)
				cb(null, {})
			},
		}
	}

	// ── EnvService ─────────────────────────────────────────────────

	private buildEnvHandlers(): Record<string, any> {
		const ctx = this.ctx
		return {
			clipboardWriteText: (call: any, cb: any) => {
				const { value } = call.request as any
				try {
					ctx.writeClipboard(String(value ?? ""))
				} catch (err: any) {
					ctx.log(`[hostbridge:env] clipboardWriteText 失败: ${err?.message}`)
				}
				cb(null, {})
			},
			clipboardReadText: (_call: any, cb: any) => {
				let text = ""
				try {
					text = ctx.readClipboard()
				} catch {
					/* ignore */
				}
				cb(null, { value: text })
			},
			getHostVersion: (_call: any, cb: any) => {
				cb(null, {
					platform: ctx.hostName,
					version: ctx.hostVersion,
					cline_type: "ClineEdu Desktop",
					cline_version: ctx.clineVersion,
				})
			},
			getIdeRedirectUri: (_call: any, cb: any) => {
				// 桌面应用无 URI scheme，按协议约定返回空
				cb(null, { value: "" })
			},
			getTelemetrySettings: (_call: any, cb: any) => {
				// Setting: UNSUPPORTED=0, ENABLED=1, DISABLED=2 —— 桌面版默认禁用遥测
				cb(null, { is_enabled: 2 })
			},
			subscribeToTelemetrySettings: (call: any) => {
				call.write({ is_enabled: 2 })
				call.end()
			},
			shutdown: (_call: any, cb: any) => {
				cb(null, {})
				// 先回包再触发宿主退出，避免 cline-core 的 shutdown RPC 因连接断开而重试失败
				setTimeout(() => ctx.onShutdown(), 100)
			},
			debugLog: (call: any, cb: any) => {
				const { value } = call.request as any
				ctx.log(`[cline-core] ${String(value ?? "")}`)
				cb(null, {})
			},
			openExternal: (call: any, cb: any) => {
				const { value } = call.request as any
				try {
					ctx.openExternal(String(value ?? ""))
				} catch (err: any) {
					ctx.log(`[hostbridge:env] openExternal 失败: ${err?.message}`)
				}
				cb(null, {})
			},
		}
	}

	// ── TestingService ─────────────────────────────────────────────

	private buildTestingHandlers(): Record<string, any> {
		const ctx = this.ctx
		return {
			getWebviewHtml: (_call: any, cb: any) => {
				let html = ""
				try {
					html = ctx.getWebviewHtml?.() ?? ""
				} catch (err: any) {
					ctx.log(`[hostbridge:testing] getWebviewHtml 失败: ${err?.message}`)
				}
				cb(null, { html })
			},
		}
	}

	// ── WindowService ──────────────────────────────────────────────

	private buildWindowHandlers(): Record<string, any> {
		const ctx = this.ctx
		return {
			showTextDocument: (call: any, cb: any) => {
				const req = call.request as any
				ctx.forwardToRenderer("host:showTextDocument", req)
				cb(null, { document_path: req.path ?? "", is_active: true })
			},
			showOpenDialogue: async (call: any, cb: any) => {
				const req = call.request as any
				const paths = await ctx.showOpenDialogue({ canSelectMany: req.can_select_many, openLabel: req.open_label })
				cb(null, { paths })
			},
			showMessage: async (call: any, cb: any) => {
				const req = call.request as any
				const selected = await ctx.showMessage({
					type: req.type,
					message: req.message ?? "",
					detail: req.options?.detail,
					items: req.options?.items,
					modal: req.options?.modal,
				})
				cb(null, { selected_option: selected ?? "" })
			},
			showInputBox: async (call: any, cb: any) => {
				const req = call.request as any
				const response = await ctx.showInputBox({ title: req.title ?? "", prompt: req.prompt, value: req.value })
				cb(null, { response: response ?? undefined })
			},
			showSaveDialog: async (call: any, cb: any) => {
				const req = call.request as any
				const selectedPath = await ctx.showSaveDialog({
					defaultPath: req.options?.default_path,
					filters: req.options?.filters,
				})
				cb(null, { selected_path: selectedPath })
			},
			openFile: (call: any, cb: any) => {
				const req = call.request as any
				ctx.forwardToRenderer("host:openFile", req)
				cb(null, {})
			},
			openSettings: (call: any, cb: any) => {
				const req = call.request as any
				ctx.forwardToRenderer("host:openSettings", req)
				cb(null, {})
			},
			getOpenTabs: (_call: any, cb: any) => cb(null, { paths: [] }),
			getVisibleTabs: (_call: any, cb: any) => cb(null, { paths: [] }),
			getActiveEditor: (_call: any, cb: any) => cb(null, {}),
		}
	}

	// ── WorkspaceService ───────────────────────────────────────────

	private buildWorkspaceHandlers(): Record<string, any> {
		const ctx = this.ctx
		return {
			getWorkspacePaths: (_call: any, cb: any) => {
				cb(null, { paths: ctx.studentDataDir ? [ctx.studentDataDir] : [] })
			},
			saveOpenDocumentIfDirty: (_call: any, cb: any) => cb(null, { was_saved: false }),
			getDiagnostics: (_call: any, cb: any) => cb(null, {}),
			openProblemsPanel: (_call: any, cb: any) => cb(null, {}),
			openInFileExplorerPanel: (call: any, cb: any) => {
				const req = call.request as any
				void ctx.openPath(String(req.path ?? ""))
				cb(null, {})
			},
			openClineSidebarPanel: (_call: any, cb: any) => {
				ctx.forwardToRenderer("host:openClineSidebar", {})
				cb(null, {})
			},
			openTerminalPanel: (_call: any, cb: any) => cb(null, {}),
			executeCommandInTerminal: (call: any, cb: any) => {
				// 无原生终端：转发给渲染层；cline-core 会因 success=false 回退到自带终端管理器
				const req = call.request as any
				ctx.forwardToRenderer("host:terminalCommand", req)
				cb(null, { success: false })
			},
			openFolder: async (call: any, cb: any) => {
				const req = call.request as any
				let ok = false
				try {
					ok = await ctx.openPath(String(req.path ?? ""))
				} catch (err: any) {
					ctx.log(`[hostbridge:workspace] openFolder 失败: ${err?.message}`)
				}
				cb(null, { success: ok })
			},
			searchWorkspaceItems: async (call: any, cb: any) => {
				const req = call.request as any
				const root = req.workspace_path || ctx.studentDataDir
				const limit = req.limit > 0 ? Math.min(req.limit, 500) : 50
				const type = req.selected_type // undefined | 0(FILE) | 1(FOLDER)
				try {
					const items = await searchWorkspace(root, String(req.query ?? ""), limit, type)
					cb(null, { items })
				} catch (err: any) {
					ctx.log(`[hostbridge:workspace] searchWorkspaceItems 失败: ${err?.message}`)
					cb(null, { items: [] })
				}
			},
		}
	}
}

/**
 * 轻量工作区文件检索（供 @mentions 自动补全）。
 * 跳过隐藏目录与常见无关目录；按 query 子串（大小写不敏感）匹配，路径相对 root。
 */
async function searchWorkspace(root: string, query: string, limit: number, selectedType?: number | null): Promise<any[]> {
	const items: any[] = []
	if (!root) return items
	const q = query.toLowerCase()
	const typeFilter = (name: string, isDir: boolean): boolean => {
		if (selectedType === undefined || selectedType === null) return true
		return selectedType === 1 ? isDir : !isDir && name.length > 0
	}
	const SKIP_DIRS = new Set(["node_modules", ".git", ".cline", ".vscode", "dist", "dist-standalone", ".idea"])
	let scanned = 0

	await (async function walk(dir: string, depth: number): Promise<void> {
		if (items.length >= limit || depth > 6 || scanned > 5000) return
		let entries: import("fs").Dirent[]
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			if (items.length >= limit) return
			scanned++
			if (e.name.startsWith(".")) continue
			const full = path.join(dir, e.name)
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name) && typeFilter(e.name, true) && (q === "" || full.toLowerCase().includes(q))) {
					items.push({ path: path.relative(root, full), type: 1, label: e.name })
				}
				await walk(full, depth + 1)
			} else if (e.isFile() && typeFilter(e.name, false) && (q === "" || full.toLowerCase().includes(q))) {
				items.push({ path: path.relative(root, full), type: 0, label: e.name })
			}
		}
	})(root, 0)

	return items.slice(0, limit)
}