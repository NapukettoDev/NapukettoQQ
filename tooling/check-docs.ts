#!/usr/bin/env node
/**
 * 文档防腐检查：日期/阶段词、手工标题编号、死链、行数、行宽、JSON 样本体积。
 *
 * 运行：node tooling/check-docs.ts（或 pnpm check:docs）
 * 只扫描受治理的文档集（根 README / AGENTS / CONTRIBUTING / docs / 包内 docs），
 * 不扫描 CHANGELOG、私有子模块 native 与 node_modules。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LINE_LIMITS: Readonly<Record<string, number>> = {
    "README.md": 110,
    "AGENTS.md": 95,
    ".github/CONTRIBUTING.md": 30,
    "docs/README.md": 80,
    "docs/architecture/overview.md": 150,
    "docs/architecture/runtime.md": 180,
    "docs/architecture/decisions.md": 300,
    "docs/architecture/linux-native-host.md": 220,
    "docs/architecture/linux-native-host-evidence.md": 400,
    "docs/guides/configuration.md": 150,
    "docs/guides/docker.md": 140,
    "docs/guides/operations.md": 150,
    "docs/guides/development.md": 120,
    "docs/protocols/onebot11.md": 140,
    "docs/protocols/satori.md": 120,
    "docs/protocols/kurobot.md": 120,
    "docs/protocols/milky.md": 200,
    "packages/kernel/docs/design.md": 250,
    "packages/kernel/docs/evidence.md": 350,
    "packages/adapter/docs/design.md": 220,
    "packages/adapter/docs/evidence.md": 250,
    "packages/loader/docs/design.md": 200,
    "packages/loader/docs/evidence.md": 200,
    "packages/napuketto-create/docs/design.md": 140,
    "apps/napuketto-create/docs/design.md": 140,
    "apps/cli/docs/design.md": 120,
    "packages/cli/docs/design.md": 120,
    "packages/network/docs/design.md": 100,
    "packages/media/docs/design.md": 100,
};

const ROOT_DOCS = ["README.md", "AGENTS.md", ".github/CONTRIBUTING.md"] as const;
const PACKAGE_GROUPS = ["packages", "apps"] as const;

const DATE_PATTERN = /\b20\d\d-\d\d-\d\d\b|\b20\d\d年\d{1,2}月\b|\b\d{1,2}月\d{1,2}日\b/;
const STAGE_PATTERN = /\bStage\s*\d|第\s*[0-9一二三四五六七八九十]+\s*(?:批|轮)|批次/;
const HEADING_NUMBER_PATTERN = /^#{2,3}\s+(?:\d+(?:\.\d+)*\s*[.、]?\s+|Stage\b)/i;
const H4_PATTERN = /^#{4,}\s/;
const RVA_PATTERN = /0x[0-9A-Fa-f]{8,}|\b(?:RVA|Offset)\s*[:=]\s*[0-9A-Fa-fx]/;
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CRLF_PATTERN = /\r?\n/;
const H1_PATTERN = /^#\s+\S/;
const JSON_FENCE_PATTERN = /^```json\b/;
const URL_PATTERN = /https?:\/\//;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

interface Problem {
    file: string;
    line: number;
    message: string;
}

interface FenceState {
    inFence: boolean;
    jsonStart: number;
    jsonCount: number;
}

type PushProblem = (line: number, message: string) => void;

function toPosix(path: string): string {
    return path.split(sep).join("/");
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
            continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(abs));
            continue;
        }
        if (entry.name.endsWith(".md")) {
            out.push(abs);
        }
    }
    return out;
}

function walkIfExists(dir: string): string[] {
    return existsSync(dir) ? walk(dir) : [];
}

function rootDocPaths(): string[] {
    const paths: string[] = [];
    for (const file of ROOT_DOCS) {
        const abs = join(repoRoot, file);
        if (existsSync(abs)) {
            paths.push(abs);
        }
    }
    return paths;
}

function packageDocs(group: string): string[] {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) {
        return [];
    }
    const docs: string[] = [];
    for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) {
            continue;
        }
        const docsDir = join(groupDir, pkg.name, "docs");
        docs.push(...walkIfExists(docsDir));
    }
    return docs;
}

function collectDocs(): string[] {
    const docs = new Set<string>(rootDocPaths());
    for (const file of walkIfExists(join(repoRoot, "docs"))) {
        docs.add(file);
    }
    for (const group of PACKAGE_GROUPS) {
        for (const file of packageDocs(group)) {
            docs.add(file);
        }
    }
    return [...docs].sort();
}

function lineLimit(rel: string): number {
    const exact = LINE_LIMITS[rel];
    if (exact !== undefined) {
        return exact;
    }
    if (rel.endsWith("/evidence.md")) {
        return 400;
    }
    if (rel.endsWith("/design.md")) {
        return 260;
    }
    if (rel.startsWith("docs/protocols/")) {
        return 200;
    }
    if (rel.startsWith("docs/guides/")) {
        return 180;
    }
    return 300;
}

function readLines(abs: string): string[] {
    const lines = readFileSync(abs, "utf8").split(CRLF_PATTERN);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

function findFirstBody(lines: readonly string[]): number {
    for (let index = 1; index < lines.length; index += 1) {
        if ((lines[index] ?? "").trim() !== "") {
            return index;
        }
    }
    return -1;
}

function checkHeader(rel: string, lines: readonly string[], push: PushProblem): void {
    const limit = lineLimit(rel);
    if (lines.length > limit) {
        push(1, `行数 ${lines.length} 超过上限 ${limit}`);
    }

    const first = lines[0] ?? "";
    if (rel !== "README.md" && !H1_PATTERN.test(first)) {
        push(1, "首行必须是 H1 标题");
    }
    if (rel === "README.md") {
        return;
    }

    const firstBody = findFirstBody(lines);
    if (firstBody === -1) {
        return;
    }
    if (!(lines[firstBody] ?? "").trimStart().startsWith(">")) {
        push(firstBody + 1, "H1 下第一段必须是 > 引用块（本文解决什么/给谁/源码在哪）");
    }
}

function checkTemporal(rel: string, lines: readonly string[], push: PushProblem): void {
    if (rel === "docs/architecture/decisions.md" || rel === "docs/README.md") {
        return;
    }
    for (const [index, line] of lines.entries()) {
        if (DATE_PATTERN.test(line) || STAGE_PATTERN.test(line)) {
            push(index + 1, "禁止日期 / Stage / 批次等时点标记（ADR 除外）");
        }
    }
}

function checkHeadings(line: string, lineNo: number, push: PushProblem): void {
    if (H4_PATTERN.test(line)) {
        push(lineNo, "标题最多到 H3，禁止 H4");
    }
    if (HEADING_NUMBER_PATTERN.test(line)) {
        push(lineNo, "标题禁止手工编号（如 ## 1. / ### 9.12 / Stage 3b）");
    }
}

function checkWidth(line: string, trimmed: string, lineNo: number, push: PushProblem): void {
    if (Array.from(line).length <= 120) {
        return;
    }
    if (trimmed.startsWith("|") || trimmed.startsWith("<") || URL_PATTERN.test(line)) {
        return;
    }
    push(lineNo, `行宽 ${Array.from(line).length} 超过 120 字符`);
}

function checkRva(line: string, lineNo: number, push: PushProblem): void {
    if (RVA_PATTERN.test(line)) {
        push(lineNo, "禁止 RVA / Offset / 内存地址（逆向产物不进公共文档）");
    }
}

function isExternalTarget(target: string): boolean {
    return (
        target === "" ||
        target.startsWith("#") ||
        target.startsWith("<") ||
        SCHEME_PATTERN.test(target)
    );
}

function decodePath(target: string): string {
    try {
        return decodeURIComponent(target).split("#", 1)[0] ?? "";
    } catch {
        return target.split("#", 1)[0] ?? "";
    }
}

function resolveTarget(abs: string, pathPart: string): string {
    return pathPart.startsWith("/")
        ? join(repoRoot, pathPart.slice(1))
        : resolve(dirname(abs), pathPart);
}

function checkLinks(line: string, abs: string, lineNo: number, push: PushProblem): void {
    for (const match of line.matchAll(LINK_PATTERN)) {
        const target = match[1] ?? "";
        if (isExternalTarget(target)) {
            continue;
        }
        const pathPart = decodePath(target);
        if (pathPart === "") {
            continue;
        }
        if (!existsSync(resolveTarget(abs, pathPart))) {
            push(lineNo, `死链：${target}`);
        }
    }
}

function checkBodyLine(
    line: string,
    trimmed: string,
    lineNo: number,
    abs: string,
    push: PushProblem,
): void {
    checkHeadings(line, lineNo, push);
    checkWidth(line, trimmed, lineNo, push);
    checkRva(line, lineNo, push);
    checkLinks(line, abs, lineNo, push);
}

function checkFence(
    trimmed: string,
    rel: string,
    lineNo: number,
    state: FenceState,
    push: PushProblem,
): boolean {
    if (!trimmed.startsWith("```")) {
        return false;
    }
    if (state.inFence && state.jsonStart !== -1) {
        if (state.jsonCount > 15 && !rel.endsWith("/evidence.md")) {
            push(
                state.jsonStart,
                `JSON 代码块 ${state.jsonCount} 行，超过 15 行须迁入 evidence.md`,
            );
        }
        state.jsonStart = -1;
        state.jsonCount = 0;
    } else if (!state.inFence && JSON_FENCE_PATTERN.test(trimmed)) {
        state.jsonStart = lineNo + 1;
        state.jsonCount = 0;
    }
    state.inFence = !state.inFence;
    return true;
}

function checkBody(rel: string, abs: string, lines: readonly string[], push: PushProblem): void {
    const state: FenceState = { inFence: false, jsonStart: -1, jsonCount: 0 };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const trimmed = line.trim();
        if (checkFence(trimmed, rel, index, state, push)) {
            continue;
        }
        if (state.inFence) {
            if (state.jsonStart !== -1) {
                state.jsonCount += 1;
            }
            continue;
        }
        checkBodyLine(line, trimmed, index + 1, abs, push);
    }
    if (state.inFence && state.jsonStart !== -1) {
        push(state.jsonStart, "JSON 代码块未闭合");
    }
}

function checkFile(abs: string, problems: Problem[]): void {
    const rel = toPosix(relative(repoRoot, abs));
    const lines = readLines(abs);
    const push: PushProblem = (line, message) => {
        problems.push({ file: rel, line, message });
    };
    checkHeader(rel, lines, push);
    checkTemporal(rel, lines, push);
    checkBody(rel, abs, lines, push);
}

const docs = collectDocs();
const problems: Problem[] = [];
for (const abs of docs) {
    checkFile(abs, problems);
}
if (problems.length === 0) {
    console.log(`check-docs: ${docs.length} 篇文档通过`);
    process.exit(0);
}

for (const problem of problems) {
    process.stderr.write(`${problem.file}:${problem.line}: ${problem.message}\n`);
}
process.stderr.write(`\ncheck-docs: ${problems.length} 个问题（扫描 ${docs.length} 篇）\n`);
process.exit(1);
