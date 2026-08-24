import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const npmCli = process.env.npm_execpath;
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("package.json is missing a valid version.");
}
const expectedVersion = packageJson.version;
let archive;
let temporary;

function parsePackOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("npm pack did not return valid JSON.");
  }
  const manifests = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && typeof parsed.filename === "string"
      ? [parsed]
      : typeof parsed === "object" && parsed !== null
        ? Object.values(parsed)
        : [];
  if (manifests.length !== 1) {
    throw new Error("npm pack returned an unexpected manifest.");
  }
  return manifests[0];
}

async function run(file, arguments_, options = {}) {
  const environment = { ...process.env, NO_COLOR: "1" };
  delete environment.npm_config_dry_run;
  delete environment.NPM_CONFIG_DRY_RUN;
  try {
    return await exec(file, arguments_, {
      cwd: options.cwd ?? root,
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${basename(file)} ${arguments_.join(" ")} failed.\n${detail}`);
  }
}

function runNpm(arguments_, options = {}) {
  if (npmCli !== undefined && npmCli.length > 0) {
    return run(node, [npmCli, ...arguments_], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, options);
}

try {
  const packed = await runNpm(["pack", "--json", "--ignore-scripts"]);
  const manifest = parsePackOutput(packed.stdout);
  if (typeof manifest.filename !== "string" || !Array.isArray(manifest.files)) {
    throw new Error("npm pack manifest is missing filename or files.");
  }
  archive = join(root, manifest.filename);
  const files = new Set(manifest.files.map((entry) => entry.path));
  const required = [
    "dist/cli.js",
    "dist/cli.d.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "package.json",
    "README.md",
    "LICENSE",
  ];
  for (const path of required) {
    if (!files.has(path)) throw new Error(`Packed package is missing ${path}.`);
  }
  for (const path of files) {
    if (path.startsWith("test/") || path.startsWith(".github/") || path.includes(".env")) {
      throw new Error(`Packed package contains a private/development file: ${path}.`);
    }
  }

  temporary = await mkdtemp(join(tmpdir(), "routelint-package-check-"));
  await writeFile(
    join(temporary, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: temporary,
  });
  const installedPackageJson = JSON.parse(
    await readFile(join(temporary, "node_modules", "routelint", "package.json"), "utf8"),
  );
  if (installedPackageJson.bin?.routelint !== "dist/cli.js") {
    throw new Error("Packed package is missing the routelint executable mapping.");
  }
  const cli = join(temporary, "node_modules", "routelint", "dist", "cli.js");
  const version = await runNpm(["exec", "--offline", "--", "routelint", "--version"], {
    cwd: temporary,
  });
  if (version.stdout.trim() !== expectedVersion) {
    throw new Error(
      `Installed CLI returned ${JSON.stringify(version.stdout.trim())}; expected ${expectedVersion}.`,
    );
  }
  const help = await run(node, [cli, "--help"], { cwd: temporary });
  for (const command of ["check", "next", "diff", "init"]) {
    if (!help.stdout.includes(command))
      throw new Error(`Installed CLI help is missing ${command}.`);
  }
  const configPath = join(temporary, "smoke.config.yml");
  await run(node, [cli, "init", configPath], { cwd: temporary });
  if (!(await readFile(configPath, "utf8")).includes("baseUrl:")) {
    throw new Error("Installed CLI did not create a usable config.");
  }
  const importCheck = await run(
    node,
    [
      "--input-type=module",
      "--eval",
      `import('routelint').then((m) => { if (m.VERSION !== ${JSON.stringify(expectedVersion)} || typeof m.runRouteLint !== 'function') process.exit(1) })`,
    ],
    { cwd: temporary },
  );
  if (importCheck.stderr.trim().length > 0) process.stderr.write(importCheck.stderr);
  process.stdout.write(`Package smoke check passed (${files.size} files).\n`);
} finally {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
  if (archive !== undefined) await rm(archive, { force: true });
}
