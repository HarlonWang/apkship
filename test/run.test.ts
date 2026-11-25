import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { run } from "../src/run.ts";
import type { RunOptions } from "../src/run.ts";
import type { Store, StoreName } from "../src/stores/types.ts";
import { APK } from "./helpers.ts";

const CONFIG: Config = {
    package: "com.example.app",
    stores: {
        huawei: { apk: "/out/huawei.apk", clientId: "id", clientSecret: "secret" },
        oppo: { apk: "/out/oppo.apk", clientId: "id", clientSecret: "secret" },
    },
};

interface Calls {
    check: StoreName[];
    submit: StoreName[];
}

function options(overrides: Partial<RunOptions>, stores: Partial<Record<StoreName, Partial<Store>>> = {}) {
    const calls: Calls = { check: [], submit: [] };
    const base: RunOptions = {
        mode: "submit",
        config: CONFIG,
        notes: "修复已知问题",
        http: async () => {
            throw new Error("不应该联网");
        },
        log: () => {},
        readApk: async () => APK,
        createStore: (name) => ({
            name,
            check: async () => {
                calls.check.push(name);
                return { versionCode: 100, versionName: "1.0.0" };
            },
            submit: async () => {
                calls.submit.push(name);
                return { message: "已提交审核" };
            },
            ...stores[name],
        }),
    };
    return { calls, options: { ...base, ...overrides } };
}

test("submit：逐家校验后提审，报告里带渠道包和线上版本", async () => {
    const { calls, options: runOptions } = options({});
    const reports = await run(runOptions);
    assert.deepEqual(calls, { check: ["huawei", "oppo"], submit: ["huawei", "oppo"] });
    assert.deepEqual(reports[0], {
        store: "huawei",
        ok: true,
        stage: "submit",
        apk: { path: "/out/huawei.apk", versionName: "2.0.0", versionCode: 200 },
        remote: { versionCode: 100, versionName: "1.0.0" },
        message: "已提交审核",
    });
});

test("check：只验证不提审", async () => {
    const { calls, options: runOptions } = options({ mode: "check", notes: undefined });
    const reports = await run(runOptions);
    assert.deepEqual(calls.submit, []);
    assert.ok(reports.every((report) => report.ok && report.stage === "check"));
    assert.equal(reports[0]!.message, "凭证有效，可以提审");
});

test("--dry-run：只做本地校验，不创建商店实例也不联网", async () => {
    const { calls, options: runOptions } = options({ dryRun: true });
    const reports = await run(runOptions);
    assert.deepEqual(calls, { check: [], submit: [] });
    assert.ok(reports.every((report) => report.ok && report.stage === "local"));
});

test("渠道包包名和配置不一致时，不联网直接失败", async () => {
    const { calls, options: runOptions } = options({
        readApk: async () => ({ ...APK, packageName: "com.other.app" }),
    });
    const reports = await run(runOptions);
    assert.deepEqual(calls.check, []);
    assert.match(reports[0]!.message, /包名是 com\.other\.app，和配置的 com\.example\.app 不一致/);
    assert.equal(reports[0]!.ok, false);
});

test("submit 没给更新说明时直接失败", async () => {
    const { calls, options: runOptions } = options({ notes: "  " });
    const reports = await run(runOptions);
    assert.deepEqual(calls.check, []);
    assert.match(reports[0]!.message, /需要更新说明/);
});

test("versionCode 不大于商店上的版本：submit 拒绝上传，check 给出提醒", async () => {
    const stale = { huawei: { check: async () => ({ versionCode: 200 }) } };

    const submit = options({}, stale);
    const submitReports = await run(submit.options);
    assert.equal(submitReports[0]!.ok, false);
    assert.match(submitReports[0]!.message, /versionCode 200 不大于商店上的 200/);
    assert.deepEqual(submit.calls.submit, ["oppo"], "华为没有上传，OPPO 照常提审");

    const check = options({ mode: "check" }, stale);
    const checkReports = await run(check.options);
    assert.equal(checkReports[0]!.ok, true);
    assert.match(checkReports[0]!.message, /提审会被拒/);
});

test("一家商店失败不影响其他商店", async () => {
    const { options: runOptions } = options(
        {},
        {
            huawei: {
                check: async () => {
                    throw new Error("华为获取 token 失败：client secret 不对");
                },
            },
        },
    );
    const reports = await run(runOptions);
    assert.deepEqual(
        reports.map((report) => [report.store, report.ok, report.stage]),
        [
            ["huawei", false, "check"],
            ["oppo", true, "submit"],
        ],
    );
    assert.match(reports[0]!.message, /client secret 不对/);
});
