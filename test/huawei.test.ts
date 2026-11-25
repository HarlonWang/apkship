import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { HuaweiStore, signServiceAccountJwt } from "../src/stores/huawei.ts";
import { context, mockHttp, tempFile } from "./helpers.ts";

const OK = { ret: { code: 0, msg: "success" } };
const CLIENT = { apk: "", clientId: "cid", clientSecret: "csecret" };

const TOKEN_ROUTE: [string, unknown] = ["/oauth2/v1/token", { access_token: "tok", expires_in: 172800 }];
const APPID_ROUTE: [string, unknown] = ["/appid-list", { ...OK, appids: [{ key: "示例应用", value: "10086" }] }];
const INFO_ROUTE: [string, unknown] = [
    "/app-info",
    { ...OK, appInfo: { releaseState: 0, onShelfVersionCode: 100, onShelfVersionNumber: "1.0.0", defaultLang: "zh-CN" } },
];

test("Service Account：JWT 用 PS256 签名，头和载荷符合华为约定", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = signServiceAccountJwt(
        {
            key_id: "kid-1",
            sub_account: "sub-1",
            private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        },
        1_700_000_000,
    );
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { kid: "kid-1", typ: "JWT", alg: "PS256" });
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
        aud: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
        iss: "sub-1",
        iat: 1_700_000_000,
        exp: 1_700_003_600,
    });
    const valid = verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
        Buffer.from(signature, "base64url"),
    );
    assert.ok(valid);
});

test("check：换 token、按包名查 appId、读在架版本", async () => {
    const { http, requests } = mockHttp([TOKEN_ROUTE, APPID_ROUTE, INFO_ROUTE]);
    const remote = await new HuaweiStore(CLIENT).check(context(http, "unused.apk"));
    assert.deepEqual(remote, { appId: "10086", versionCode: 100, versionName: "1.0.0", status: "已上架" });

    assert.deepEqual(requests[0]!.json, { grant_type: "client_credentials", client_id: "cid", client_secret: "csecret" });
    assert.deepEqual(requests[1]!.headers, { client_id: "cid", Authorization: "Bearer tok" });
    assert.deepEqual(requests[1]!.query, { packageName: "com.example.app" });
    assert.equal(requests.filter((request) => request.url.includes("/oauth2/")).length, 1, "token 只取一次");
});

test("check：配置了 appId 就不再按包名查", async () => {
    const { http, requests } = mockHttp([TOKEN_ROUTE, INFO_ROUTE]);
    const remote = await new HuaweiStore({ ...CLIENT, appId: "42" }).check(context(http, "unused.apk"));
    assert.equal(remote.appId, "42");
    assert.ok(!requests.some((request) => request.url.includes("/appid-list")));
});

test("check：包名在华为上查不到应用时提示先创建", async () => {
    const { http } = mockHttp([TOKEN_ROUTE, ["/appid-list", { ...OK, appids: [] }]]);
    await assert.rejects(new HuaweiStore(CLIENT).check(context(http, "unused.apk")), /需要先在后台创建/);
});

test("submit：取上传地址、PUT 文件、绑定软件包、写更新说明、等待后提审", async () => {
    const apkPath = await tempFile("huawei.apk", "apk-content");
    const waits: number[] = [];
    const { http, requests } = mockHttp([
        TOKEN_ROUTE,
        APPID_ROUTE,
        INFO_ROUTE,
        [
            "/upload-url/for-obs",
            {
                ...OK,
                urlInfo: {
                    url: "https://obs.example/obj-1",
                    objectId: "obj-1",
                    method: "PUT",
                    headers: { Authorization: "AWS4 sig", Host: "obs.example", "Content-Type": "application/octet-stream" },
                },
            },
        ],
        ["https://obs.example/obj-1", undefined],
        ["/app-file-info", OK],
        ["/app-language-info", OK],
        ["/app-submit", OK],
    ]);
    const store = new HuaweiStore(CLIENT);
    const ctx = context(http, apkPath, { sleep: async (ms) => void waits.push(ms) });
    const remote = await store.check(ctx);
    const result = await store.submit(ctx, remote);
    assert.equal(result.message, "已提交审核");

    const byUrl = (part: string) => requests.find((request) => request.url.includes(part))!;
    assert.deepEqual(byUrl("/upload-url/for-obs").query, {
        appId: "10086",
        fileName: "huawei.apk",
        contentLength: 11,
        sha256: createHash("sha256").update("apk-content").digest("hex"),
    });
    const upload = byUrl("https://obs.example/obj-1");
    assert.equal(upload.method, "PUT");
    assert.deepEqual(upload.headers, { Authorization: "AWS4 sig", "Content-Type": "application/octet-stream" });
    assert.equal(Buffer.from(upload.body!).toString(), "apk-content");
    assert.deepEqual(byUrl("/app-file-info").json, {
        fileType: 5,
        files: [{ fileName: "huawei.apk", fileDestUrl: "obj-1" }],
    });
    assert.deepEqual(byUrl("/app-language-info").json, { lang: "zh-CN", newFeatures: "修复已知问题" });
    assert.equal(byUrl("/app-submit").method, "POST");
    assert.deepEqual(waits, [120_000], "提审前按官方要求等 2 分钟");
});

test("submit：软件包还没解析完导致提审失败时会重试", async () => {
    const apkPath = await tempFile("huawei.apk", "apk-content");
    let submitCalls = 0;
    const { http } = mockHttp([
        TOKEN_ROUTE,
        APPID_ROUTE,
        INFO_ROUTE,
        ["/upload-url/for-obs", { ...OK, urlInfo: { url: "https://obs.example/obj-1", objectId: "obj-1", headers: {} } }],
        ["https://obs.example/obj-1", undefined],
        ["/app-file-info", OK],
        ["/app-language-info", OK],
        ["/app-submit", () => (++submitCalls < 3 ? { ret: { code: 204144660, msg: "package is being parsed" } } : OK)],
    ]);
    const store = new HuaweiStore(CLIENT);
    const ctx = context(http, apkPath);
    const result = await store.submit(ctx, await store.check(ctx));
    assert.equal(result.message, "已提交审核");
    assert.equal(submitCalls, 3);
});

test("接口返回业务错误时带上华为的错误码", async () => {
    const { http } = mockHttp([TOKEN_ROUTE, ["/appid-list", { ret: { code: 204144641, msg: "invalid package" } }]]);
    await assert.rejects(
        new HuaweiStore(CLIENT).check(context(http, "unused.apk")),
        /华为按包名查询应用失败：invalid package（错误码 204144641）/,
    );
});
