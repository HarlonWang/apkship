import assert from "node:assert/strict";
import { X509Certificate, constants, createHash, createPrivateKey, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { XiaomiStore, encryptSig } from "../src/stores/xiaomi.ts";
import { context, mockHttp, tempFile } from "./helpers.ts";

// 仅供测试的自签名证书和私钥（1024 位，和小米官方示例的密钥长度一致）
const CERT_FILE = new URL("./fixtures/xiaomi-test-cert.cer", import.meta.url).pathname;
const PRIVATE_KEY = createPrivateKey(
    readFileSync(new URL("./fixtures/xiaomi-test-key.pem", import.meta.url)),
);
const PUBLIC_KEY = new X509Certificate(readFileSync(CERT_FILE)).publicKey;

const KEY_BYTES = 128;
const SEGMENT_BYTES = 117;

/** 把 SIG 解回明文：逐段做 RSA 原始解密，再手工去掉 PKCS#1 v1.5 填充（00 02 随机非零字节 00 明文） */
function decryptSig(hex: string): string {
    const encrypted = Buffer.from(hex, "hex");
    const plain: Buffer[] = [];
    for (let offset = 0; offset < encrypted.length; offset += KEY_BYTES) {
        const block = privateDecrypt(
            { key: PRIVATE_KEY, padding: constants.RSA_NO_PADDING },
            encrypted.subarray(offset, offset + KEY_BYTES),
        );
        assert.equal(block[0], 0);
        assert.equal(block[1], 2);
        plain.push(block.subarray(block.indexOf(0, 2) + 1));
    }
    return Buffer.concat(plain).toString("utf8");
}

function md5(content: string): string {
    return createHash("md5").update(content).digest("hex");
}

test("SIG：按 117 字节分段加密，输出小写十六进制，解密后是约定的 JSON", () => {
    const items = [
        { name: "RequestData", hash: "0".repeat(32) },
        { name: "apk", hash: "a".repeat(32) },
        { name: "icon", hash: "b".repeat(32) },
    ];
    const sig = encryptSig(items, "私钥-private", PUBLIC_KEY);
    assert.match(sig, /^[0-9a-f]+$/);

    const plain = JSON.stringify({ sig: items, password: "私钥-private" });
    const segments = Math.ceil(Buffer.byteLength(plain) / SEGMENT_BYTES);
    assert.ok(segments > 1, "明文要长到需要分段");
    assert.equal(sig.length, segments * KEY_BYTES * 2);
    assert.equal(decryptSig(sig), plain);
});

function store(overrides: Record<string, string> = {}) {
    return new XiaomiStore({
        apk: "",
        email: "dev@example.com",
        privateKey: "pk",
        certFile: CERT_FILE,
        icon: "",
        privacyUrl: "https://example.com/privacy",
        ...overrides,
    });
}

test("check：查询请求带签名，读出线上版本", async () => {
    const { http, requests } = mockHttp([
        [
            "/dev/query",
            {
                result: 0,
                updateVersion: true,
                packageInfo: { appName: "示例应用", versionName: "1.0.0", versionCode: 100, packageName: "com.example.app" },
            },
        ],
    ]);
    const remote = await store().check(context(http, "unused.apk"));
    assert.deepEqual(remote, { appName: "示例应用", versionCode: 100, versionName: "1.0.0" });

    const form = requests[0]!.form!;
    assert.deepEqual(JSON.parse(form.RequestData!), { packageName: "com.example.app", userName: "dev@example.com" });
    assert.deepEqual(JSON.parse(decryptSig(form.SIG!)), {
        sig: [{ name: "RequestData", hash: md5(form.RequestData!) }],
        password: "pk",
    });
});

test("check：应用不存在或不允许更新时报错", async () => {
    const missing = mockHttp([["/dev/query", { result: 0 }]]);
    await assert.rejects(store().check(context(missing.http, "unused.apk")), /没有找到包名为 com\.example\.app 的应用/);

    const locked = mockHttp([["/dev/query", { result: 0, updateVersion: false, packageInfo: { versionCode: 100 } }]]);
    await assert.rejects(store().check(context(locked.http, "unused.apk")), /不允许版本更新/);
});

test("submit：以更新包方式推送，签名覆盖 RequestData、apk、icon", async () => {
    const apkPath = await tempFile("xiaomi.apk", "apk-content");
    const iconPath = await tempFile("icon.png", "icon-content");
    const { http, requests } = mockHttp([["/dev/push", { result: 0, message: "" }]]);

    const result = await store({ icon: iconPath }).submit(context(http, apkPath), { appName: "示例应用" });
    assert.equal(result.message, "已推送，进入审核");

    const form = requests[0]!.multipart!;
    const requestData = form.get("RequestData") as string;
    const parsed = JSON.parse(requestData);
    assert.equal(parsed.userName, "dev@example.com");
    assert.equal(parsed.synchroType, 1);
    assert.equal(typeof parsed.appInfo, "string", "appInfo 是 JSON 字符串，不是嵌套对象");
    assert.deepEqual(JSON.parse(parsed.appInfo), {
        appName: "示例应用",
        packageName: "com.example.app",
        updateDesc: "修复已知问题",
        privacyUrl: "https://example.com/privacy",
    });
    assert.equal(await (form.get("apk") as File).text(), "apk-content");
    assert.equal((form.get("apk") as File).name, "xiaomi.apk");
    assert.deepEqual(JSON.parse(decryptSig(form.get("SIG") as string)), {
        sig: [
            { name: "RequestData", hash: md5(requestData) },
            { name: "apk", hash: md5("apk-content") },
            { name: "icon", hash: md5("icon-content") },
        ],
        password: "pk",
    });
});

test("submit：小米返回失败时带出原因和错误码", async () => {
    const apkPath = await tempFile("xiaomi.apk", "apk-content");
    const { http } = mockHttp([["/dev/push", { result: -92, message: "APK 不满足要求" }]]);
    await assert.rejects(
        store({ icon: apkPath }).submit(context(http, apkPath), { appName: "示例应用" }),
        /小米推送失败：APK 不满足要求（错误码 -92）/,
    );
});
