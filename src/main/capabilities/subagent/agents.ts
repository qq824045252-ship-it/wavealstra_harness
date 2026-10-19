/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseFrontmatterCompat } from "./compat.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** 用户显式覆盖目录：<agentDir>/agents（PI_CODING_AGENT_DIR 指向 ~/.mybuddy） */
	userAgentsDir?: string;
	/** MyBuddy 产品自带的角色目录：<agentDir>/plugins/agents（= paths.getAgentsDir()） */
	productAgentsDir?: string;
}

/**
 * MyBuddy 产品目录下的角色定义：`<agentDir>/plugins/agents/*.md`。
 *
 * 由于 `PI_CODING_AGENT_DIR` 被 MyBuddy 重定向到 `~/.mybuddy`，pi 原生的
 * user scope 读的是 `~/.mybuddy/agents`；而产品里安装/内置的角色（planner /
 * reviewer / scout / worker 等）实际落在 `~/.mybuddy/plugins/agents`
 * （见 src/main/paths.ts getAgentsDir）。只读前者会让 `subagent` 报
 * 「Unknown agent: worker」——所以 user/both scope 必须同时扫描产品目录。
 */
function getProductAgentsDir(): string {
	const override = process.env.MYBUDDY_AGENTS_DIR?.trim();
	if (override) return override;
	return path.join(getAgentDir(), "plugins", "agents");
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatterCompat<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const productDir = getProductAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// user scope = 用户显式目录 + 产品自带目录（两者都算「本机用户级」，不随仓库变化）
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const productAgents = scope === "project" ? [] : loadAgentsFromDir(productDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// 优先级（后者覆盖前者）：产品自带 < 用户显式覆盖 < 项目本地
	if (scope !== "project") {
		for (const agent of productAgents) agentMap.set(agent.name, agent);
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope === "project" || scope === "both") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
		userAgentsDir: userDir,
		productAgentsDir: productDir,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
