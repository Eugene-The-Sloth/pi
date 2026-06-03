import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runMigrations } from "../src/migrations.ts";

describe("project .pi migration trust", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-migrations-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createLegacyProjectPi(): void {
		const projectPiDir = join(projectDir, ".pi");
		mkdirSync(join(projectPiDir, "commands"), { recursive: true });
		mkdirSync(join(projectPiDir, "hooks"), { recursive: true });
		mkdirSync(join(projectPiDir, "tools"), { recursive: true });
		writeFileSync(join(projectPiDir, "commands", "project.md"), "project prompt");
		writeFileSync(join(projectPiDir, "tools", "custom-tool"), "custom tool");
	}

	it("does not migrate or warn for project .pi paths when untrusted", () => {
		mkdirSync(join(agentDir, "commands"), { recursive: true });
		writeFileSync(join(agentDir, "commands", "global.md"), "global prompt");
		createLegacyProjectPi();

		const result = runMigrations(projectDir, { projectPiTrusted: false });

		expect(existsSync(join(agentDir, "prompts", "global.md"))).toBe(true);
		expect(existsSync(join(projectDir, ".pi", "commands", "project.md"))).toBe(true);
		expect(existsSync(join(projectDir, ".pi", "prompts"))).toBe(false);
		expect(result.deprecationWarnings.some((warning) => warning.includes("Project"))).toBe(false);
	});

	it("migrates and warns for project .pi migration paths when trusted", () => {
		createLegacyProjectPi();

		const result = runMigrations(projectDir, { projectPiTrusted: true });

		expect(existsSync(join(projectDir, ".pi", "commands"))).toBe(false);
		expect(existsSync(join(projectDir, ".pi", "prompts", "project.md"))).toBe(true);
		expect(result.deprecationWarnings).toContain(
			"Project hooks/ directory found. Hooks have been renamed to extensions.",
		);
		expect(result.deprecationWarnings).toContain(
			"Project tools/ directory contains custom tools. Custom tools have been merged into extensions.",
		);
	});
});
