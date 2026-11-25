import assert from "node:assert/strict";
import { test } from "node:test";
import { OppoStore, signParams } from "../src/stores/oppo.ts";
import { context, mockHttp, tempFile } from "./helpers.ts";

const CONFIG = { apk: "", clientId: "1234567890123456789", clientSecret: "secret123" };

const PROFILE = {
    app_id: "111",
    app_name: "示例应用",
    version_code: "100",
    version_name: "1.0.0",
    audit_status_name: "上线",
    second_category_id: "74",
    third_category_id: "6685",
    summary: "一句话简介",
    detail_desc: "这是一段不少于二十个字的软件介绍文字内容",
    privacy_source_url: "https://example.com/privacy",
    icon_url: "http://img/icon.png",
    pic_url: "http://img/1.jpg,http://img/2.jpg",
    copyright_url: "http://img/copyright.jpg",
    business_username: "张三",
    business_email: "biz@example.com",
    business_mobile: "13800000000",
    age_level: "3",
    adaptive_equipment: "4",
    test_desc: null,
    icp_url: "",
    landscape_pic_url: "http://img/l1.jpg",
};

test("签名：参数名升序拼接后做 HmacSHA256，结果和 openssl 算出的一致", () => {
    const sign = signParams(
        { timestamp: "1609401600", pkg_name: "com.foo.bar", access_token: "tok", api_sign: "忽略" },
        "secret123",
    );
    assert.equal(sign, "5a274652d28b4433edb7efea40c1f0e3f3c31568bc0136bbcf889bc9fd8bbd4b");
});

test("check：读出线上版本和审核状态", async () => {
    const { http, requests } = mockHttp([
        ["/developer/v1/token", { errno: 0, data: { access_token: "tok" } }],
        ["/resource/v1/app/info", { errno: 0, data: PROFILE }],
    ]);
    const remote = await new OppoStore(CONFIG).check(context(http, "unused.apk"));
    assert.deepEqual(remote, {
        appId: "111",
        appName: "示例应用",
        versionCode: 100,
        versionName: "1.0.0",
        status: "上线",
    });
    const query = requests[1]!.query as Record<string, string>;
    assert.equal(query.pkg_name, "com.example.app");
    assert.equal(query.access_token, "tok");
    const { api_sign, ...rest } = query;
    assert.equal(api_sign, signParams(rest, "secret123"));
});

test("submit：上传渠道包后，用现网资料回填发布版本的必传字段", async () => {
    const apkPath = await tempFile("oppo.apk", "apk-content");
    const { http, requests } = mockHttp([
        ["/developer/v1/token", { errno: 0, data: { access_token: "tok" } }],
        ["/resource/v1/app/info", { errno: 0, data: PROFILE }],
        ["/upload/get-upload-url", { errno: 0, data: { upload_url: "https://upload.example/put", sign: "once" } }],
        ["https://upload.example/put", { errno: 0, data: { url: "https://cdn/x.apk", md5: "abc" } }],
        ["/resource/v1/app/upd", { errno: 0, data: { success: true } }],
        ["/resource/v1/app/task-state", { errno: 0, data: { task_state: "2" } }],
    ]);
    const store = new OppoStore(CONFIG);
    const ctx = context(http, apkPath);
    await store.check(ctx);
    const result = await store.submit(ctx);
    assert.equal(result.message, "已提交审核");

    const upload = requests.find((request) => request.url === "https://upload.example/put")!;
    assert.equal(upload.multipart!.get("type"), "apk");
    assert.equal(upload.multipart!.get("sign"), "once");

    const form = requests.find((request) => request.url.endsWith("/app/upd"))!.form!;
    assert.equal(form.version_code, "200");
    assert.equal(form.update_desc, "修复已知问题");
    assert.equal(form.online_type, "1");
    assert.equal(form.apk_url, JSON.stringify([{ url: "https://cdn/x.apk", md5: "abc", cpu_code: 0 }]));
    assert.equal(form.app_name, "示例应用");
    assert.equal(form.summary, "一句话简介");
    assert.equal(form.test_desc, "", "测试附加说明必传，现网为空时传空字符串");
    assert.equal(form.landscape_pic_url, "http://img/l1.jpg", "现网有值的可选字段原样带上");
    assert.ok(!("icp_url" in form), "现网为空的可选字段不带");
    const { api_sign, ...rest } = form;
    assert.equal(api_sign, signParams(rest, "secret123"));
});

test("submit：现网资料缺必传字段时，在上传前就报错", async () => {
    const { http, requests } = mockHttp([
        ["/developer/v1/token", { errno: 0, data: { access_token: "tok" } }],
        ["/resource/v1/app/info", { errno: 0, data: { ...PROFILE, copyright_url: "" } }],
    ]);
    const store = new OppoStore(CONFIG);
    const ctx = context(http, "unused.apk");
    await store.check(ctx);
    await assert.rejects(store.submit(ctx), /缺少发布版本必传的字段：copyright_url/);
    assert.equal(requests.length, 2, "没有发起上传");
});

test("submit：异步任务失败时带出 OPPO 返回的原因", async () => {
    const apkPath = await tempFile("oppo.apk", "apk-content");
    const { http } = mockHttp([
        ["/developer/v1/token", { errno: 0, data: { access_token: "tok" } }],
        ["/resource/v1/app/info", { errno: 0, data: PROFILE }],
        ["/upload/get-upload-url", { errno: 0, data: { upload_url: "https://upload.example/put", sign: "once" } }],
        ["https://upload.example/put", { errno: 0, data: { url: "https://cdn/x.apk", md5: "abc" } }],
        ["/resource/v1/app/upd", { errno: 0, data: { success: true } }],
        ["/resource/v1/app/task-state", { errno: 0, data: { task_state: "3", err_msg: "包名不一致" } }],
    ]);
    const store = new OppoStore(CONFIG);
    const ctx = context(http, apkPath);
    await store.check(ctx);
    await assert.rejects(store.submit(ctx), /任务失败：包名不一致/);
});

test("接口返回业务错误时带上错误码", async () => {
    const { http } = mockHttp([
        ["/developer/v1/token", { errno: 800002, data: { message: "Client Secret长度不正确" } }],
    ]);
    await assert.rejects(
        new OppoStore(CONFIG).check(context(http, "unused.apk")),
        /获取 token失败：Client Secret长度不正确（错误码 800002）/,
    );
});
