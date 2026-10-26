import { app } from "electron"
import fs from "fs"
import path from "path"

export interface AppSettings {
	studentDataDir: string
	protobusAddress: string
	hostBridgeAddress: string
}

const DEFAULTS: Omit<AppSettings, "studentDataDir"> = {
	protobusAddress: "127.0.0.1:26040",
	hostBridgeAddress: "127.0.0.1:26041",
}

export class Settings {
	private file = path.join(app.getPath("userData"), "settings.json")

	private data: AppSettings = {
		studentDataDir: "",
		...DEFAULTS,
	}

	load(): AppSettings {
		try {
			if (fs.existsSync(this.file)) {
				const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"))
				this.data = { ...this.data, ...parsed }
			}
		} catch (err) {
			console.error("[settings] failed to load:", err)
		}
		return this.data
	}

	save(patch: Partial<AppSettings>): AppSettings {
		this.data = { ...this.data, ...patch }
		fs.mkdirSync(path.dirname(this.file), { recursive: true })
		fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
		return this.data
	}

	get hasStudentDataDir(): boolean {
		return this.data.studentDataDir.length > 0
	}
}
