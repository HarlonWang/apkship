import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { HonorStore } from "../src/stores/honor.ts";
import { context, mockHttp, tempFile } from "./helpers.ts";

const CONFIG = { apk: "", clientId: "cid", clientSecret: "csecret" };
const OK = { code: 0, msg: "success" };

const TOKEN: [string, unknown] = ["/auth/token", { access_token: "tok", expires_in: 3600, token_type: "Bearer" }];
const APP_ID: [string, unknown] = [
    "/get-app-id",
    { ...OK, data: [{ appId: 111, packageName: "com.other.app" }, { appId: 10086, packageName: "com.example.app" }] },
];
const DETAIL: [string, unknown] = [
    "/get-app-detail",
    {
        ...OK,
        data: {
            basicInfo: { defaultLanguage: "zh-CN" },
            languageInfo: [
                { languageId: "en-US", appName: "Example", intro: "English intro" },
                { languageId: "zh-CN", appName: "示例应用", intro: "应用介绍", briefIntro: "一句话", newFeature: "旧说明" },
            ],
            publishInfo: { forceUpdate: 0, testAccount: "tester", testPassword: "pw", testComment: null, releaseType: 1 },
            releaseInfo: { versionName: "1.0.0", versionCode: 100 },
        },
    },
];

test("check：换 token、按包名取 appId、读已上架版本", async () => {
    const { http, requests } = mockHttp([TOKEN, APP_ID, DETAIL]);
    const remote = await new HonorStore(CONFIG).check(context(http, "unused.apk"));
    assert.deepEqual(remote, { appId: "10086", appName: "示例应用", versionCode: 100, versionName: "1.0.0" });

    assert.deepEqual(requests[0]!.form, { grant_type: "client_credentials", client_id: "cid", client_secret: "csecret" });
    assert.deepEqual(requests[1]!.headers, { Authorization: "Bearer tok" });
    assert.deepEqual(requests[1]!.query, { pkgName: "com.example.app" });
    assert.deepEqual(requests[2]!.query, { appId: "10086" });
});

test("check：应用没上架过时版本为空，不报错", async () => {
    const { http } = mockHttp([
        TOKEN,
        ["/get-app-detail", { ...OK, data: { basicInfo: {}, languageInfo: [], publishInfo: {}, releaseInfo: {} } }],
    ]);
    const remote = await new HonorStore({ ...CONFIG, appId: "42" }).check(context(http, "unused.apk"));
    assert.deepEqual(remote, { appId: "42", appName: undefined, versionCode: undefined, versionName: undefined });
});

test("check：包名在荣耀上查不到应用时提示先创建", async () => {
    const { http } = mockHttp([TOKEN, ["/get-app-id", { ...OK, data: [] }]]);
    await assert.rejects(new HonorStore(CONFIG).check(context(http, "unused.apk")), /需要先在后台创建/);
});

test("submit：取上传地址、上传、写新版本特性、绑定应用包、提交审核", async () => {
    const apkPath = await tempFile("honor.apk", "apk-content");
    const { http, requests } = mockHttp([
        TOKEN,
        APP_ID,
        DETAIL,
        ["/get-file-upload-url", { ...OK, data: [{ fileName: "honor.apk", uploadUrl: "https://x", objectId: 9001 }] }],
        ["/file-upload", OK],
        ["/update-language-info", OK],
        ["/update-file-info", OK],
        ["/submit-audit", { ...OK, data: "release-1" }],
    ]);
    const store = new HonorStore(CONFIG);
    const ctx = context(http, apkPath);
    const result = await store.submit(ctx, await store.check(ctx));
    assert.equal(result.message, "已提交审核");

    const byUrl = (part: string) => requests.find((request) => request.url.includes(part))!;
    assert.deepEqual(byUrl("/get-file-upload-url").json, [
        {
            fileName: "honor.apk",
            fileType: 100,
            fileSize: 11,
            fileSha256: createHash("sha256").update("apk-content").digest("hex"),
        },
    ]);
    const upload = byUrl("/file-upload");
    assert.deepEqual(upload.query, { appId: "10086", objectId: "9001" });
    assert.equal(await (upload.multipart!.get("file") as File).text(), "apk-content");
    assert.deepEqual(byUrl("/update-language-info").json, {
        languageInfoList: [
            { languageId: "zh-CN", appName: "示例应用", intro: "应用介绍", briefIntro: "一句话", newFeature: "修复已知问题" },
        ],
        setAll: 0,
    });
    assert.deepEqual(byUrl("/update-file-info").json, { bindingFileList: [{ objectId: 9001 }] });
    assert.deepEqual(byUrl("/submit-audit").json, {
        releaseType: 1,
        testAccount: "tester",
        testPassword: "pw",
        testComment: null,
    });
    const order = requests.map((request) => request.url.split("/").pop());
    assert.ok(order.indexOf("file-upload") < order.indexOf("update-file-info"));
    assert.ok(order.indexOf("update-file-info") < order.indexOf("submit-audit"));
});

test("接口返回业务错误时带上荣耀的错误码", async () => {
    const { http } = mockHttp([TOKEN, ["/get-app-id", { code: 40001, msg: "no permission" }]]);
    await assert.rejects(
        new HonorStore(CONFIG).check(context(http, "unused.apk")),
        /荣耀按包名查询应用失败：no permission（错误码 40001）/,
    );
});
