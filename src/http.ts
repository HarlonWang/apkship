/**
 * 对 fetch 的一层薄封装：统一超时、统一把响应解析成 JSON，测试时可整体替换。
 */
export interface HttpRequest {
    method?: "GET" | "POST" | "PUT";
    url: string;
    headers?: Record<string, string>;
    /** 查询参数，值为 undefined 的不带 */
    query?: Record<string, string | number | undefined>;
    /** JSON 请求体 */
    json?: unknown;
    /** application/x-www-form-urlencoded 请求体 */
    form?: Record<string, string>;
    /** multipart/form-data 请求体 */
    multipart?: FormData;
    /** 原始请求体（上传文件用） */
    body?: Uint8Array;
    /** 超时毫秒数，默认 60 秒；上传文件要调大 */
    timeoutMs?: number;
}

export interface HttpResponse {
    status: number;
    /** 响应体解析成的 JSON；不是 JSON 时为 undefined */
    json: any;
    text: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export function buildUrl(url: string, query?: HttpRequest["query"]): string {
    if (!query) return url;
    const target = new URL(url);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) target.searchParams.set(key, String(value));
    }
    return target.toString();
}

export function createHttp(fetchImpl: typeof fetch = fetch): Http {
    return async (request) => {
        const headers: Record<string, string> = { ...request.headers };
        let body: BodyInit | undefined;
        if (request.json !== undefined) {
            headers["Content-Type"] ??= "application/json";
            body = JSON.stringify(request.json);
        } else if (request.form) {
            headers["Content-Type"] ??= "application/x-www-form-urlencoded";
            body = new URLSearchParams(request.form).toString();
        } else if (request.multipart) {
            // Content-Type 连同 boundary 由 fetch 自己生成
            body = request.multipart;
        } else if (request.body) {
            body = request.body as unknown as BodyInit;
        }

        const response = await fetchImpl(buildUrl(request.url, request.query), {
            method: request.method ?? "GET",
            headers,
            body,
            signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        const text = await response.text();
        let json: unknown;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        return { status: response.status, json, text };
    };
}
