import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./i18n/config"
import "./main.css"
import "./index.css"
import App from "./App.tsx"

// VSCode provides `--vscode-*` theme CSS variables natively in its webviews;
// standalone hosts (Electron / JetBrains) do not, so all var(--vscode-*)
// mappings in theme.css would resolve to "invalid" and the UI loses styling.
// vite's `define` replaces __PLATFORM__ with a string literal, so in the
// vscode build this import is DCE'd (never bundled), and in the standalone
// build the Light+ fallback variables are applied.
declare const __PLATFORM__: string

if (__PLATFORM__ === "standalone") {
	import("./standalone-vscode-variables.css")
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
