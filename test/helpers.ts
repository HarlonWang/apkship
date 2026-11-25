import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApkInfo } from "../src/apk.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/http.ts";
import type { StoreContext } from "../src/stores/types.ts";

export interface RecordedHttp {
    http: Http;
    requests: HttpRequest[];
}

/** 按请求 URL 里的关键字返回预设响应，并记录所有请求 */
export function mockHttp(routes: Array<[match: string, response: unknown | ((request: HttpRequest) => unknown)]>): RecordedHttp {
    const requests: HttpRequest[] = [];
    const http: Http = async (request) => {
        requests.push(request);
        const route = routes.find(([match]) => request.url.includes(match));
        if (!route) throw new Error(`测试里没有为这个请求准备响应：${request.url}`);
        const body = typeof route[1] === "function" ? route[1](request) : route[1];
        const response: HttpResponse = { status: 200, json: body, text: JSON.stringify(body ?? "") };
        return response;
    };
    return { http, requests };
}

export async function tempFile(name: string, content: string | Uint8Array): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "apkship-test-"));
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
}

export const APK: ApkInfo = {
    packageName: "com.example.app",
    versionCode: 200,
    versionName: "2.0.0",
    size: 11,
};

export function context(http: Http, apkPath: string, overrides: Partial<StoreContext> = {}): StoreContext {
    return {
        packageName: APK.packageName,
        apkPath,
        apk: APK,
        notes: "修复已知问题",
        http,
        log: () => {},
        sleep: async () => {},
        ...overrides,
    };
}
