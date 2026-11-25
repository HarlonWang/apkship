import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createHttp } from "../src/http.ts";

interface Seen {
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body: string;
}

let seen: Seen;
let baseUrl: string;
const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
        seen = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
        };
        if (request.url?.startsWith("/text")) {
            response.writeHead(500).end("不是 JSON");
        } else {
            response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
        }
    });
});

before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const http = createHttp();

test("GET：查询参数做 URL 编码，undefined 的不带", async () => {
    const response = await http({ url: `${baseUrl}/q`, query: { name: "a b&c", count: 3, skip: undefined } });
    assert.equal(seen.method, "GET");
    assert.equal(seen.url, "/q?name=a+b%26c&count=3");
    assert.deepEqual(response.json, { ok: true });
});

test("JSON 请求体", async () => {
    await http({ method: "PUT", url: `${baseUrl}/j`, headers: { client_id: "cid" }, json: { a: "中文" } });
    assert.equal(seen.method, "PUT");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.equal(seen.headers.client_id, "cid");
    assert.equal(seen.body, '{"a":"中文"}');
});

test("表单请求体", async () => {
    await http({ method: "POST", url: `${baseUrl}/f`, form: { a: "1", b: "x y" } });
    assert.equal(seen.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(seen.body, "a=1&b=x+y");
});

test("multipart 请求体带文件", async () => {
    const form = new FormData();
    form.set("type", "apk");
    form.set("file", new Blob(["apk-content"]), "app.apk");
    await http({ method: "POST", url: `${baseUrl}/m`, multipart: form });
    assert.match(seen.headers["content-type"]!, /^multipart\/form-data; boundary=/);
    assert.match(seen.body, /name="type"\r\n\r\napk/);
    assert.match(seen.body, /name="file"; filename="app\.apk"[\s\S]*apk-content/);
});

test("原始二进制请求体，按给定的请求头发送", async () => {
    await http({
        method: "PUT",
        url: `${baseUrl}/b`,
        headers: { "Content-Type": "application/octet-stream", "x-amz-date": "20260101T000000Z" },
        body: Buffer.from("apk-content"),
    });
    assert.equal(seen.headers["content-type"], "application/octet-stream");
    assert.equal(seen.headers["x-amz-date"], "20260101T000000Z");
    assert.equal(seen.headers["content-length"], "11");
    assert.equal(seen.body, "apk-content");
});

test("响应不是 JSON 时保留状态码和原文", async () => {
    const response = await http({ url: `${baseUrl}/text` });
    assert.equal(response.status, 500);
    assert.equal(response.json, undefined);
    assert.equal(response.text, "不是 JSON");
});
