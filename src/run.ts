import { readApkInfo } from "./apk.ts";
import type { ApkInfo } from "./apk.ts";
import type { Config } from "./config.ts";
import { STORE_NAMES } from "./config.ts";
import type { Http } from "./http.ts";
import { HuaweiStore } from "./stores/huawei.ts";
import { OppoStore } from "./stores/oppo.ts";
import type { RemoteState, Store, StoreContext, StoreName } from "./stores/types.ts";
import { XiaomiStore } from "./stores/xiaomi.ts";

export type Mode = "check" | "submit";

export interface RunOptions {
    mode: Mode;
    config: Config;
    /** 更新说明，submit 时必填 */
    notes?: string;
    /** 只做本地校验，不发任何网络请求 */
    dryRun?: boolean;
    http: Http;
    log: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    /** 测试用：替换读 APK 和创建商店实例的方式 */
    readApk?: (path: string) => Promise<ApkInfo>;
    createStore?: (name: StoreName, config: Config) => Store;
}

export interface StoreReport {
    store: StoreName;
    ok: boolean;
    /** 已完成到哪一步 */
    stage: "local" | "check" | "submit";
    apk?: { path: string; versionName: string; versionCode: number };
    remote?: RemoteState;
    message: string;
}

export function createStore(name: StoreName, config: Config): Store {
    switch (name) {
        case "huawei":
            return new HuaweiStore(config.stores.huawei!);
        case "xiaomi":
            return new XiaomiStore(config.stores.xiaomi!);
        case "oppo":
            return new OppoStore(config.stores.oppo!);
    }
}

/** 各商店互相独立：一家失败不影响其他家，结果逐家汇报 */
export async function run(options: RunOptions): Promise<StoreReport[]> {
    const reports: StoreReport[] = [];
    for (const name of STORE_NAMES) {
        if (!options.config.stores[name]) continue;
        reports.push(await runStore(name, options));
    }
    return reports;
}

async function runStore(name: StoreName, options: RunOptions): Promise<StoreReport> {
    const { config, mode } = options;
    const apkPath = config.stores[name]!.apk;
    const log = (message: string) => options.log(`[${name}] ${message}`);
    const report: StoreReport = { store: name, ok: false, stage: "local", message: "" };

    try {
        const apk = await (options.readApk ?? readApkInfo)(apkPath);
        report.apk = { path: apkPath, versionName: apk.versionName, versionCode: apk.versionCode };
        if (apk.packageName !== config.package) {
            throw new Error(`渠道包的包名是 ${apk.packageName}，和配置的 ${config.package} 不一致`);
        }
        if (mode === "submit" && !options.notes?.trim()) {
            throw new Error("提审需要更新说明，请用 --notes 或 --notes-file 提供");
        }
        if (options.dryRun) {
            report.ok = true;
            report.message = "本地校验通过（--dry-run，未联网）";
            return report;
        }

        const store = (options.createStore ?? createStore)(name, config);
        const ctx: StoreContext = {
            packageName: config.package,
            apkPath,
            apk,
            notes: options.notes?.trim(),
            http: options.http,
            log,
            sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        };

        report.stage = "check";
        log("验证凭证并查询线上版本");
        const remote = await store.check(ctx);
        report.remote = remote;
        const newer = remote.versionCode === undefined || apk.versionCode > remote.versionCode;
        if (mode === "check") {
            report.ok = true;
            report.message = newer
                ? "凭证有效，可以提审"
                : `凭证有效，但渠道包的 versionCode ${apk.versionCode} 不大于商店上的 ${remote.versionCode}，提审会被拒`;
            return report;
        }
        if (!newer) {
            throw new Error(
                `渠道包的 versionCode ${apk.versionCode} 不大于商店上的 ${remote.versionCode}`,
            );
        }

        report.stage = "submit";
        const result = await store.submit(ctx, remote);
        report.ok = true;
        report.message = result.message;
    } catch (error) {
        report.message = error instanceof Error ? error.message : String(error);
    }
    return report;
}
