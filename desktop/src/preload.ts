/**
 * Electron preload（渲染层宿主 API）。
 * 通过 contextBridge 暴露 `window.electron.host`，由注入的引导脚本把
 * `window.standalonePostMessage` 指向它，从而接入 webview 的 standalone 消息通道。
 */
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("electron", {
	host: {
		/** webview → 主进程：standalone gRPC 请求的 JSON 字符串 */
		postMessage: (json: string) => {
			ipcRenderer.send("webview:message", json)
		},
		/** 主进程 → webview：gRPC 响应帧（{type:"grpc_response", grpc_response}） */
		onGrpcResponse: (cb: (payload: unknown) => void) => {
			const listener = (_e: unknown, payload: unknown) => cb(payload)
			ipcRenderer.on("host:grpc-response", listener)
			return () => ipcRenderer.removeListener("host:grpc-response", listener)
		},
		/** 主进程 → 渲染层：hostbridge 转发的宿主事件（diff / 终端命令等） */
		onHostEvent: (cb: (payload: { channel: string; data: unknown } | undefined) => void) => {
			const listener = (_e: unknown, payload: { channel: string; data: unknown }) => cb(payload)
			ipcRenderer.on("host:event", listener)
			return () => ipcRenderer.removeListener("host:event", listener)
		},
		/** 学生数据目录选择；返回新目录（取消时 undefined） */
		selectDirectory: (): Promise<string | undefined> => ipcRenderer.invoke("app:selectDirectory"),
		/** 版本 / 构建信息（宿主 + cline-core） */
		versions: (): Promise<Record<string, string>> => ipcRenderer.invoke("app:versions"),
		/** 重启 cline-core 核心服务 */
		restartCore: (): Promise<boolean> => ipcRenderer.invoke("core:restart"),
		/** cline-core 日志行（排错用） */
		onCoreLog: (cb: (line: string) => void) => {
			const listener = (_e: unknown, line: string) => cb(line)
			ipcRenderer.on("core:log", listener)
			return () => ipcRenderer.removeListener("core:log", listener)
		},
	},
})