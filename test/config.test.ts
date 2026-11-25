import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, parseConfig } from "../src/config.ts";

const ENV = { OPPO_ID: "1234567890123456789", OPPO_SECRET: "s3cret" };

const OPPO_ONLY = `
package: com.example.app
stores:
    oppo:
        apk: out/oppo.apk
        clientId: \${OPPO_ID}
        clientSecret: \${OPPO_SECRET}
`;

test("展开环境变量，并把相对路径按配置文件目录解析", () => {
    const config = parseConfig(OPPO_ONLY, "/work/app", ENV);
    assert.equal(config.package, "com.example.app");
    assert.deepEqual(config.stores.oppo, {
        apk: "/work/app/out/oppo.apk",
        clientId: "1234567890123456789",
        clientSecret: "s3cret",
    });
});

test("密钥字段明文写在配置里会被拒绝", () => {
    const text = OPPO_ONLY.replace("${OPPO_SECRET}", "plain-secret");
    assert.throws(() => parseConfig(text, "/work", ENV), (error: Error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /stores\.oppo\.clientSecret 是密钥/);
        return true;
    });
});

test("引用的环境变量没设置时报出变量名", () => {
    assert.throws(() => parseConfig(OPPO_ONLY, "/work", { OPPO_ID: "1" }), /环境变量 OPPO_SECRET 没有设置/);
});

test("缺少必填字段时报出字段名", () => {
    const text = `
package: com.example.app
stores:
    xiaomi:
        apk: a.apk
        email: dev@example.com
        privateKey: \${XIAOMI_KEY}
`;
    assert.throws(() => parseConfig(text, "/work", { XIAOMI_KEY: "k" }), /stores\.xiaomi 缺少 certFile/);
});

test("华为要么给 API 客户端，要么给 Service Account", () => {
    const base = "package: com.example.app\nstores:\n    huawei:\n        apk: a.apk\n";
    assert.throws(() => parseConfig(base, "/work", {}), /clientId \+ clientSecret，或者 serviceAccountFile/);
    const config = parseConfig(`${base}        serviceAccountFile: keys/sa.json\n`, "/work", {});
    assert.equal(config.stores.huawei?.serviceAccountFile, "/work/keys/sa.json");
});

test("不认识的商店名直接报错", () => {
    const text = "package: com.example.app\nstores:\n    samsung:\n        apk: a.apk\n";
    assert.throws(() => parseConfig(text, "/work", {}), /不支持的商店：samsung/);
});

test("--only 只校验选中的商店，其他商店缺环境变量也不报错", () => {
    const text = `${OPPO_ONLY}    huawei:
        apk: out/huawei.apk
        clientId: abc
        clientSecret: \${HUAWEI_SECRET}
`;
    const config = parseConfig(text, "/work", ENV, ["oppo"]);
    assert.deepEqual(Object.keys(config.stores), ["oppo"]);
    assert.throws(() => parseConfig(text, "/work", ENV, ["xiaomi"]), /配置里没有商店 xiaomi/);
});
