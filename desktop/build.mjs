/**
 * ClineEdu 桌面版构建脚本（esbuild）。
 * 产物：out/main.js + out/preload.js（CJS，gRPC 依赖保持 external）。
 * 用法：node build.mjs
 */
import * as path from "path"
import { fileURLToPath } from "url"
import * as esbuild from "esbuild"

const here = path.dirname(fileURLToPath(import.meta.url))

// 仓库根（生成代码所在位置）
const root = path.join(here, "..")

const common = {
	bundle: true,
	platform: "node",
	target: "node18",
	format: "cjs",
	sourcemap: true,
	logLevel: "info",
	absWorkingDir: here,
	external: ["electron", "@grpc/grpc-js", "grpc-health-check", "@grpc/proto-loader"],
	define: { "process.env.NODE_ENV": '"production"' },
	// 仓库生成代码中若残留别名导入（一般不会），按根 tsconfig 映射
	tsconfig: path.join(root, "tsconfig.json"),
}

await esbuild.build({
	...common,
	entryPoints: [path.join(here, "src", "main.ts")],
	outdir: path.join(here, "out"),
	outbase: path.join(here, "src"),
})

await esbuild.build({
	...common,
	entryPoints: [path.join(here, "src", "preload.ts")],
	outdir: path.join(here, "out"),
	outbase: path.join(here, "src"),
})

console.log("[desktop] 构建完成: out/main.js, out/preload.js")
