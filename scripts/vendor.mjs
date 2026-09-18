/**
 * Refreshes vendor/fast-jev-compaction from upstream, pinned to a commit.
 *
 * The upstream README says `npm install fast-jev-compaction`, but that package is
 * not published (404 on the registry), so the library is vendored: cloned, built
 * with its own toolchain, then reduced to the files the extension imports.
 *
 * Usage: npm run vendor
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://github.com/tamaratran/fast-jev-compaction";
const COMMIT = "e3f262a7f4d42bd8dd32ced30d26176f7cb545b0";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(root, "vendor");
const target = join(vendorRoot, "fast-jev-compaction");

const run = (command, args, cwd) => {
	execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
};

console.log(`vendoring ${UPSTREAM} @ ${COMMIT}`);
mkdirSync(vendorRoot, { recursive: true });
rmSync(target, { recursive: true, force: true });

run("git", ["clone", "--filter=blob:none", "--no-checkout", UPSTREAM, target], root);
run("git", ["checkout", COMMIT], target);
rmSync(join(target, ".git"), { recursive: true, force: true });

run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], target);
run("npm", ["run", "build"], target);

// Keep only what the extension needs, so no toolchain is committed.
for (const folder of ["src", "tests", "hooks", "demo", "examples", "types", ".claude-plugin", ".codex-plugin"]) {
	rmSync(join(target, folder), { recursive: true, force: true });
}
for (const file of ["tsconfig.json", "tsconfig.hooks.json", "package-lock.json", ".gitignore"]) {
	rmSync(join(target, file), { force: true });
}
rmSync(join(target, "node_modules"), { recursive: true, force: true });

writeFileSync(
	join(target, "PROVENANCE.md"),
	[
		"# Provenance",
		"",
		"This folder is the build output of an unmodified upstream checkout, not hand-written code.",
		"",
		`- Source: ${UPSTREAM}`,
		`- Commit: ${COMMIT}`,
		`- Version: see package.json (upstream)`,
		"- Rebuild: `npm run vendor`",
		"",
		"Only `dist/` (compiled JavaScript, type declarations, source maps), `package.json`,",
		"`README.md` and `LICENSE` are kept; the upstream toolchain, sources and editor/agent",
		"plugin manifests are not committed.",
		"Upstream is MIT licensed; its LICENSE file is kept next to this file.",
		"",
	].join("\n"),
);

console.log(`done: ${target}`);
