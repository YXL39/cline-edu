import { execSync, spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"

export interface ClineCoreOptions {
	dataDir: string // 学生数据目录（.cline-chinese-edu 所在处）
	protobusAddress: string // 如 127.0.0.1:26040
	hostBridgeAddress: string // 如 127.0.0.1:26041
}

/**
 * 定位并托管 cline-core（standalone 版 Cline 核心服务，由 VSCode 扩展源码构建而来）。
 * 它需要 dist-standalone 目录（含 cline-core.js、extension/ 资源与 node_modules）。
 */
export function locateClineCoreDir(): string {
	const candidates = [
		path.join(__dirname, "..", "..", "dist-standalone"),
		path.join(__dirname, "..", "dist-standalone"),
		path.join(process.cwd(), "dist-standalone"),
	]
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "cline-core.js"))) {
			return dir
		}
	}
	throw new Error(
		"未找到 cline-core 运行时 (dist-standalone/cline-core.js)。请先在仓库根目录执行：\n" +
			"  node esbuild.mjs --standalone\n" +
			"  node scripts/package-standalone.mjs -s",
	)
}

/**
 * 补齐 cline-core（standalone）运行所需但构建产物中缺失的资源：
 * `initializeContext` 会读取 `<INSTALL_DIR>/extension/package.json`
 * （扩展清单，由 vscode-context 模拟 Extension 对象时使用）。
 * esbuild 构建只输出 cline-core.js + wasm，不会复制该文件，故在此兜底。
 */
export function ensureRuntimeFiles(coreDir: string): void {
	const extPkg = path.join(coreDir, "extension", "package.json")
	if (!fs.existsSync(extPkg)) {
		const rootPkg = path.join(coreDir, "..", "package.json")
		fs.mkdirSync(path.dirname(extPkg), { recursive: true })
		if (fs.existsSync(rootPkg)) {
			fs.copyFileSync(rootPkg, extPkg)
			console.log(`[cline-core] 已复制扩展清单 → ${extPkg}`)
		} else {
			throw new Error(`缺少扩展清单 ${rootPkg}，无法补齐 ${extPkg}`)
		}
	}
}

function findNodeExecutable(): string {
	// 使用系统 Node 运行 cline-core（better-sqlite3 等原生模块按 Node ABI 编译）
	const cmd = process.platform === "win32" ? "node.exe" : "node"
	try {
		const which = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`
		const out = execSync(which, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
		const first = out.split(/\r?\n/)[0]
		if (first && fs.existsSync(first)) {
			return first
		}
	} catch {
		/* fall through */
	}
	return cmd
}

export class ClineCoreService {
	private proc: ChildProcess | null = null
	private logLines: string[] = []

	onLog: ((line: string) => void) | null = null
	onExit: ((code: number | null) => void) | null = null

	start(opts: ClineCoreOptions): void {
		this.stop()
		const coreDir = locateClineCoreDir()
		ensureRuntimeFiles(coreDir)
		const entry = path.join(coreDir, "cline-core.js")
		const node = findNodeExecutable()

		const stubsDir = path.join(__dirname, "..", "stubs", "node_modules")
		const nodePath = [stubsDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter)

		const env = {
			...process.env,
			CLINE_DIR: opts.dataDir,
			PROTOBUS_ADDRESS: opts.protobusAddress,
			HOST_BRIDGE_ADDRESS: opts.hostBridgeAddress,
			INSTALL_DIR: coreDir,
			// 提供 "vscode" 占位包（standalone 构建将 vscode 标记为 external）
			NODE_PATH: nodePath,
		}

		console.log(`[cline-core] spawn: ${node} ${entry} (dataDir=${opts.dataDir})`)
		this.proc = spawn(node, [entry], {
			cwd: coreDir,
			env,
			// cline-core 自带日志到 stdout；保留管道便于排错
			stdio: ["ignore", "pipe", "pipe"],
		})

		const appendLine = (chunk: string) => {
			for (const line of chunk.split(/\r?\n/).filter((l) => l.trim().length > 0)) {
				this.logLines.push(line)
				if (this.logLines.length > 2000) {
					this.logLines.shift()
				}
				this.onLog?.(line)
			}
		}
		this.proc.stdout?.on("data", (d) => appendLine(d.toString()))
		this.proc.stderr?.on("data", (d) => appendLine(`[stderr] ${d.toString()}`))
		this.proc.on("exit", (code) => this.onExit?.(code))
	}

	restart(opts: ClineCoreOptions): void {
		this.start(opts)
	}

	stop(): void {
		if (this.proc) {
			const proc = this.proc
			this.proc = null
			try {
				proc.kill("SIGTERM")
			} catch {
				/* ignore */
			}
		}
	}

	getLogs(): string {
		return this.logLines.join("\n")
	}
}
