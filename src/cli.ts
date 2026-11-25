#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ConfigError, STORE_NAMES, loadConfig } from "./config.ts";
import { createHttp } from "./http.ts";
import { run } from "./run.ts";
import type { Mode, StoreReport } from "./run.ts";
import type { StoreName } from "./stores/types.ts";

const USAGE = `apkship：把 APK 提交到国内应用商店（华为、小米、OPPO）

用法：
  apkship check  [选项]    只读：验证凭证、查应用、读线上版本
  apkship submit [选项]    校验后上传渠道包并提交审核

选项：
  -c, --config <文件>      配置文件，默认 apkship.yaml
      --only <商店>        只处理指定商店，多个用逗号分隔（huawei,xiaomi,oppo）
  -n, --notes <文字>       更新说明（submit 必填，和 --notes-file 二选一）
      --notes-file <文件>  从文件读更新说明
      --dry-run            只做本地校验，不发任何网络请求
      --json               结果以 JSON 输出到标准输出
  -h, --help               显示帮助
  -v, --version            显示版本

退出码：0 全部成功；1 有商店失败；2 用法或配置错误`;

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

async function main(argv: string[]): Promise<number> {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                config: { type: "string", short: "c", default: "apkship.yaml" },
                only: { type: "string" },
                notes: { type: "string", short: "n" },
                "notes-file": { type: "string" },
                "dry-run": { type: "boolean", default: false },
                json: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
                version: { type: "boolean", short: "v", default: false },
            },
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error("\n" + USAGE);
        return EXIT_USAGE;
    }
    const { values, positionals } = parsed;

    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    if (values.version) {
        const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        console.log(pkg.version);
        return 0;
    }

    const command = positionals[0];
    if (positionals.length !== 1 || (command !== "check" && command !== "submit")) {
        console.error(USAGE);
        return EXIT_USAGE;
    }
    const mode: Mode = command;

    try {
        let only: StoreName[] | undefined;
        if (values.only) {
            only = values.only.split(",").map((name) => name.trim()) as StoreName[];
            const unknown = only.filter((name) => !STORE_NAMES.includes(name));
            if (unknown.length > 0) {
                throw new ConfigError(`--only 里有不支持的商店：${unknown.join("、")}`);
            }
        }

        if (values.notes && values["notes-file"]) {
            throw new ConfigError("--notes 和 --notes-file 只能给一个");
        }
        let notes = values.notes;
        if (values["notes-file"]) {
            try {
                notes = await readFile(values["notes-file"], "utf8");
            } catch {
                throw new ConfigError(`读不到更新说明文件：${values["notes-file"]}`);
            }
        }

        const config = await loadConfig(values.config, only);
        const reports = await run({
            mode,
            config,
            notes,
            dryRun: values["dry-run"],
            http: createHttp(),
            // 过程日志走标准错误，标准输出只留结果，方便 --json 时被脚本解析
            log: (message) => console.error(message),
        });

        if (values.json) {
            console.log(JSON.stringify(reports, null, 4));
        } else {
            for (const report of reports) console.log(formatReport(report));
        }
        return reports.every((report) => report.ok) ? 0 : EXIT_FAILED;
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`配置错误：${error.message}`);
            return EXIT_USAGE;
        }
        throw error;
    }
}

function formatReport(report: StoreReport): string {
    const lines = [`${report.ok ? "✓" : "✗"} ${report.store}：${report.message}`];
    if (report.apk) {
        lines.push(`    渠道包：${report.apk.versionName}（${report.apk.versionCode}）${report.apk.path}`);
    }
    if (report.remote) {
        const { versionName, versionCode, status } = report.remote;
        const version = versionCode === undefined ? "未知" : `${versionName ?? ""}（${versionCode}）`;
        lines.push(`    商店上：${version}${status ? `，${status}` : ""}`);
    }
    return lines.join("\n");
}

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error) => {
        console.error(error);
        process.exitCode = EXIT_FAILED;
    },
);
