import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { HttpRequest } from "../src/http.ts";
import { VivoStore, signParams } from "../src/stores/vivo.ts";
import { context, mockHttp, tempFile } from "./helpers.ts";

const CONFIG = { apk: "", accessKey: "ak", accessSecret: "secret123" };
const DETAILS = {
    code: 0,
    subCode: "0",
    msg: "成功",
    data: { mainTitle: "示例应用", versionCode: 100, versionName: "1.0.0", status: 3, saleStatus: 1, compatibleDevice: 2 },
};

test("签名：参数名升序拼接后做 HmacSHA256，结果和 openssl 算出的一致", () => {
    const sign = signParams(
        {
            v: "1.0",
            timestamp: "1587629951609",
            target_app_key: "developer",
            sign_method: "hmac",
            packageName: "com.test.test",
            method: "app.query.details",
            format: "json",
            access_key: "ak",
            sign: "忽略",
        },
        "secret123",
    );
    assert.equal(sign, "5b8a8897132643d7e65a4120976e0359c2a541d3e103bd983c3ea0f62ee7b805");
});

test("check：带公共参数和签名查询应用详情，读出版本和状态", async () => {
    const { http, requests } = mockHttp([["/router/rest", DETAILS]]);
    const remote = await new VivoStore(CONFIG).check(context(http, "unused.apk"));
    assert.deepEqual(remote, {
        appName: "示例应用",
        versionCode: 100,
        versionName: "1.0.0",
        status: "审核通过，已上架",
    });

    const form = requests[0]!.form!;
    assert.equal(requests[0]!.method, "POST");
    assert.equal(form.method, "app.query.details");
    assert.equal(form.packageName, "com.example.app");
    assert.equal(form.access_key, "ak");
    assert.equal(form.sign_method, "hmac");
    assert.equal(form.target_app_key, "developer");
    assert.match(form.timestamp!, /^\d{13}$/, "时间戳是毫秒");
    const { sign, ...rest } = form;
    assert.equal(sign, signParams(rest, "secret123"));
});

test("submit：上传 APK 拿流水号，再提交应用更新", async () => {
    const apkPath = await tempFile("vivo.apk", "apk-content");
    const md5 = createHash("md5").update("apk-content").digest("hex");
    const { http, requests } = mockHttp([
        [
            "/router/rest",
            (request: HttpRequest) => {
                const method = request.form?.method ?? request.multipart?.get("method");
                if (method === "app.query.details") return DETAILS;
                if (method === "app.upload.apk.app") return { code: 0, subCode: "0", data: { serialnumber: "serial-1" } };
                return { code: 0, subCode: "0", msg: "成功" };
            },
        ],
    ]);
    const store = new VivoStore(CONFIG);
    const ctx = context(http, apkPath);
    await store.check(ctx);
    const result = await store.submit(ctx);
    assert.equal(result.message, "已提交审核");

    const upload = requests[1]!.multipart!;
    assert.equal(upload.get("method"), "app.upload.apk.app");
    assert.equal(upload.get("fileMd5"), md5);
    assert.equal(await (upload.get("file") as File).text(), "apk-content");
    const signedFields: Record<string, string> = {};
    for (const [key, value] of upload.entries()) {
        if (key !== "file" && key !== "sign") signedFields[key] = value as string;
    }
    assert.equal(upload.get("sign"), signParams(signedFields, "secret123"), "文件不参与签名");

    const update = requests[2]!.form!;
    assert.equal(update.method, "app.sync.update.app");
    assert.equal(update.apk, "serial-1");
    assert.equal(update.fileMd5, md5);
    assert.equal(update.versionCode, "200");
    assert.equal(update.onlineType, "1");
    assert.equal(update.updateDesc, "修复已知问题");
    assert.equal(update.compatibleDevice, "2", "沿用线上的兼容设备");
});

test("调用成功但业务失败（subCode 非 0）时报错并带上业务码", async () => {
    const { http } = mockHttp([["/router/rest", { code: 0, subCode: "11001", msg: "包名不正确，未查询到应用" }]]);
    await assert.rejects(
        new VivoStore(CONFIG).check(context(http, "unused.apk")),
        /vivo 查询应用详情失败：包名不正确，未查询到应用（错误码 11001）/,
    );
});

test("签名校验失败等调用错误带上返回码", async () => {
    const { http } = mockHttp([["/router/rest", { code: 10001, msg: "签名校验失败" }]]);
    await assert.rejects(new VivoStore(CONFIG).check(context(http, "unused.apk")), /签名校验失败（错误码 10001）/);
});
