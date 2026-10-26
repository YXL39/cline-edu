import * as grpc from "@grpc/grpc-js"
// 共享的 gRPC 生成模块位于仓库根 src/generated/grpc-js（desktop/tsconfig 的 rootDir 之外），
// 用 ES import 会触发 TS6059。改用 require：esbuild（build.mjs）打包时仍会解析并内联 index.ts。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generated = require("../../src/generated/grpc-js")
import { PROTOBUS_REGISTRY } from "./generated/protobus-registry"

interface InFlightCall {
	cancel: () => void
}

/**
 * 把 webview 的 grpc_request(JSON) 转发到 cline-core 的 ProtoBus gRPC 服务端，
 * 再把响应以 grpc_response(JSON) 回传给 webview。
 *
 * 消息载荷在 webview 侧用 ts-proto 的 toJSON 编码、fromJSON 解码；
 * 这里用仓库生成的 ts-proto 消息类做同样的转换，gRPC 传输由 @grpc/grpc-js 完成。
 */
export class ProtoBusBridge {
	private serviceClients = new Map<string, any>()
	private inFlight = new Map<string, InFlightCall>()

	constructor(
		private address: string, // 如 127.0.0.1:26040
		private sendToWebview: (payload: Record<string, unknown>) => void,
	) {}

	/** 处理来自 webview 的 postMessage 文本（JSON 字符串） */
	handleWebviewMessage(raw: string): void {
		let msg: any
		try {
			msg = JSON.parse(raw)
		} catch {
			console.warn("[protobus] 无法解析 webview 消息:", raw.slice(0, 200))
			return
		}
		switch (msg?.type) {
			case "grpc_request": {
				const { service, method, message, request_id: rid, is_streaming: isStreaming } = msg.grpc_request ?? {}
				void this.route(service, method, message, rid, Boolean(isStreaming))
				break
			}
			case "grpc_request_cancel": {
				const rid = msg.grpc_request_cancel?.request_id
				if (rid) {
					const call = this.inFlight.get(rid)
					call?.cancel()
					this.inFlight.delete(rid)
					// 与 cline-core 宿主行为一致：回发取消确认帧（webview 会将其作为最终帧处理）
					this.sendToWebview({
						type: "grpc_response",
						grpc_response: { request_id: rid, message: { cancelled: true }, is_streaming: false },
					})
				}
				break
			}
			default:
				// 其余非 gRPC 消息（日志等）忽略
				if (msg?.type && msg.type !== "did-load") {
					console.debug("[protobus] 未处理的 webview 消息类型:", msg.type)
				}
		}
	}

	private async route(service: string, method: string, jsonMsg: unknown, rid: string, wantStreaming: boolean): Promise<void> {
		const svcDef = PROTOBUS_REGISTRY[service]
		if (!svcDef) {
			this.error(rid, `未知服务: ${service}`)
			return
		}
		const mDef = svcDef[method]
		if (!mDef) {
			this.error(rid, `未知方法: ${service}.${method}`)
			return
		}

		const cline = (generated as any).cline
		const ReqClass = resolveClass(cline, mDef.req)
		const RespClass = resolveClass(cline, mDef.resp)
		const serviceName = service.split(".")[1] // cline.UiService -> UiService
		const Ctor = cline[`${serviceName}Client`]
		if (!Ctor || !ReqClass || !RespClass) {
			this.error(rid, `缺少客户端或消息类: ${service}.${method} (Req=${mDef.req} Resp=${mDef.resp})`)
			return
		}

		// 通用客户端按 serviceName 缓存：每个服务一个实例（内部共享 channel 连接池）
		const client = this.serviceClients.get(service) ?? new Ctor(this.address, grpc.credentials.createInsecure())
		this.serviceClients.set(service, client)

		let request: unknown
		try {
			request = ReqClass.fromJSON(jsonMsg ?? {})
		} catch (err: any) {
			this.error(rid, `请求解码失败: ${err?.message}`)
			return
		}

		const streamable = wantStreaming || mDef.streaming
		if (streamable) {
			// 服务端流式
			const call = (client as any)[method](request, { "request-id": rid })
			const entry: InFlightCall = { cancel: () => (call as any).cancel?.() }
			this.inFlight.set(rid, entry)
			;(call as any).on("data", (chunk: unknown) => {
				this.send(rid, RespClass.toJSON(chunk), true)
			})
			;(call as any).on("end", () => {
				this.inFlight.delete(rid)
				this.complete(rid)
			})
			;(call as any).on("error", (err: Error) => {
				this.inFlight.delete(rid)
				this.error(rid, err?.message ?? String(err))
			})
			return
		}

		// 一元调用
		const meta = new grpc.Metadata()
		meta.set("request-id", rid)
		;(client as any)[method](request, meta, (err: grpc.ServiceError | null, resp: unknown) => {
			if (err) {
				this.error(rid, err.message || "unknown gRPC error")
				return
			}
			this.send(rid, RespClass.toJSON(resp), false)
		})
	}

	private send(rid: string, message: unknown, isStreaming: boolean): void {
		this.sendToWebview({
			type: "grpc_response",
			grpc_response: { request_id: rid, message, is_streaming: isStreaming },
		})
	}

	private complete(rid: string): void {
		this.sendToWebview({
			type: "grpc_response",
			grpc_response: { request_id: rid, is_streaming: false },
		})
	}

	private error(rid: string, message: string): void {
		this.sendToWebview({
			type: "grpc_response",
			grpc_response: { request_id: rid, error: message, is_streaming: false },
		})
	}

	close(): void {
		for (const c of this.serviceClients.values()) {
			try {
				c.close()
			} catch {
				/* ignore */
			}
		}
		this.serviceClients.clear()
		this.inFlight.clear()
	}
}

function resolveClass(ns: any, fqn: string): any {
	const [, name] = fqn.split(".")
	return ns?.[name]
}
