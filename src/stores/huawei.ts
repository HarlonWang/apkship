/**
 * 华为 AppGallery Connect Publishing API。
 * 官方文档：https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-Guides/agcapi-getstarted-0000001111845114
 */
import { createPrivateKey, constants, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hashFile } from "../apk.ts";
import type { HuaweiConfig } from "../config.ts";
import { UPLOAD_TIMEOUT_MS } from "../http.ts";
import type { HttpResponse } from "../http.ts";
import { StoreError } from "./types.ts";
import type { RemoteState, Store, StoreContext, SubmitResult } from "./types.ts";

const API = "https://connect-api.cloud.huawei.com/api";
const JWT_AUDIENCE = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";

/** 官方文档：软件包异步解析，传包后等候 2 分钟再调用提交发布接口 */
const PARSE_WAIT_MS = 120_000;
const SUBMIT_RETRY_INTERVAL_MS = 30_000;
const SUBMIT_MAX_ATTEMPTS = 5;

/** app-info 返回的 releaseState 取值（releaseType 为 1 时） */
const RELEASE_STATES: Record<number, string> = {
    0: "已上架",
    1: "上架审核不通过",
    2: "已下架",
    3: "待上架",
    4: "审核中",
    5: "升级审核中",
    6: "申请下架",
    7: "草稿",
    8: "升级审核不通过",
    9: "下架审核不通过",
    10: "应用被开发者下架",
    11: "撤销上架",
    12: "预审中",
    13: "预审不通过",
};

interface ServiceAccount {
    key_id: string;
    private_key: string;
    sub_account: string;
}

function base64url(input: Buffer | string): string {
    return Buffer.from(input).toString("base64url");
}

/** Service Account 方式：用私钥签一个 PS256 的 JWT，直接放进 Authorization */
export function signServiceAccountJwt(account: ServiceAccount, nowSeconds: number): string {
    const header = { kid: account.key_id, typ: "JWT", alg: "PS256" };
    const payload = {
        aud: JWT_AUDIENCE,
        iss: account.sub_account,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
        key: createPrivateKey(account.private_key),
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return `${signingInput}.${base64url(signature)}`;
}

/** 华为接口统一用 ret.code 表示业务结果，0 为成功 */
function ensureOk(response: HttpResponse, action: string): any {
    const ret = response.json?.ret;
    if (response.status !== 200 || !ret || ret.code !== 0) {
        const detail = ret?.msg ?? response.text.slice(0, 200) ?? `HTTP ${response.status}`;
        throw new StoreError(`华为${action}失败：${detail}`, ret?.code ?? response.status);
    }
    return response.json;
}

export class HuaweiStore implements Store {
    readonly name = "huawei" as const;
    private readonly config: HuaweiConfig;
    private authHeaders?: Record<string, string>;
    /** 应用在华为后台的默认语言，更新说明要写到这个语言下 */
    private defaultLang?: string;

    constructor(config: HuaweiConfig) {
        this.config = config;
    }

    private async auth(ctx: StoreContext): Promise<Record<string, string>> {
        if (this.authHeaders) return this.authHeaders;

        if (this.config.serviceAccountFile) {
            const account = JSON.parse(
                await readFile(this.config.serviceAccountFile, "utf8"),
            ) as ServiceAccount;
            if (!account.key_id || !account.private_key || !account.sub_account) {
                throw new StoreError("华为 Service Account 凭证文件缺少 key_id / private_key / sub_account");
            }
            const jwt = signServiceAccountJwt(account, Math.floor(Date.now() / 1000));
            this.authHeaders = { Authorization: `Bearer ${jwt}` };
            return this.authHeaders;
        }

        const response = await ctx.http({
            method: "POST",
            url: `${API}/oauth2/v1/token`,
            json: {
                grant_type: "client_credentials",
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
            },
        });
        const token: unknown = response.json?.access_token;
        if (response.status !== 200 || typeof token !== "string") {
            const detail = response.json?.ret?.msg ?? response.text.slice(0, 200);
            throw new StoreError(`华为获取 token 失败：${detail}`, response.json?.ret?.code);
        }
        this.authHeaders = {
            client_id: this.config.clientId!,
            Authorization: `Bearer ${token}`,
        };
        return this.authHeaders;
    }

    private async resolveAppId(ctx: StoreContext): Promise<string> {
        if (this.config.appId) return this.config.appId;
        const response = await ctx.http({
            url: `${API}/publish/v2/appid-list`,
            headers: await this.auth(ctx),
            query: { packageName: ctx.packageName },
        });
        const json = ensureOk(response, "按包名查询应用");
        const appId: unknown = json.appids?.[0]?.value;
        if (typeof appId !== "string" || !appId) {
            throw new StoreError(`华为上没有找到包名为 ${ctx.packageName} 的应用，需要先在后台创建`);
        }
        return appId;
    }

    async check(ctx: StoreContext): Promise<RemoteState> {
        const appId = await this.resolveAppId(ctx);
        const response = await ctx.http({
            url: `${API}/publish/v2/app-info`,
            headers: await this.auth(ctx),
            query: { appId },
        });
        const info = ensureOk(response, "查询应用信息").appInfo ?? {};
        const versionCode = Number(info.onShelfVersionCode ?? info.versionCode);
        const releaseState: unknown = info.releaseState;
        if (typeof info.defaultLang === "string") this.defaultLang = info.defaultLang;
        return {
            appId,
            versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
            versionName: info.onShelfVersionNumber ?? info.versionNumber,
            status:
                typeof releaseState === "number"
                    ? (RELEASE_STATES[releaseState] ?? `releaseState=${releaseState}`)
                    : undefined,
        };
    }

    async submit(ctx: StoreContext, remote: RemoteState): Promise<SubmitResult> {
        const appId = remote.appId!;
        const headers = await this.auth(ctx);
        const fileName = basename(ctx.apkPath);

        ctx.log("获取上传地址");
        const sha256 = await hashFile(ctx.apkPath, "sha256");
        const urlResponse = await ctx.http({
            url: `${API}/publish/v2/upload-url/for-obs`,
            headers,
            query: { appId, fileName, contentLength: ctx.apk.size, sha256 },
        });
        const urlJson = ensureOk(urlResponse, "获取上传地址");
        const urlInfo = urlJson.urlInfo ?? {};
        const uploadHeaders: Record<string, string> = { ...(urlInfo.headers ?? urlJson.headers) };
        if (typeof urlInfo.url !== "string" || typeof urlInfo.objectId !== "string") {
            throw new StoreError("华为获取上传地址的返回里没有 url / objectId");
        }
        // Host 和 Content-Length 由 HTTP 客户端按 URL 和请求体自动生成，值与返回的一致
        for (const key of Object.keys(uploadHeaders)) {
            if (["host", "content-length"].includes(key.toLowerCase())) delete uploadHeaders[key];
        }

        ctx.log(`上传 ${fileName}（${(ctx.apk.size / 1024 / 1024).toFixed(1)} MB）`);
        const upload = await ctx.http({
            method: "PUT",
            url: urlInfo.url,
            headers: uploadHeaders,
            body: await readFile(ctx.apkPath),
            timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        if (upload.status !== 200) {
            throw new StoreError(`华为上传文件失败：${upload.text.slice(0, 200)}`, upload.status);
        }

        ctx.log("绑定软件包");
        ensureOk(
            await ctx.http({
                method: "PUT",
                url: `${API}/publish/v2/app-file-info`,
                headers,
                query: { appId },
                json: { fileType: 5, files: [{ fileName, fileDestUrl: urlInfo.objectId }] },
            }),
            "更新应用文件信息",
        );

        ctx.log("写入更新说明");
        ensureOk(
            await ctx.http({
                method: "PUT",
                url: `${API}/publish/v2/app-language-info`,
                headers,
                query: { appId },
                json: { lang: this.defaultLang ?? "zh-CN", newFeatures: ctx.notes },
            }),
            "更新语言描述信息",
        );

        ctx.log("等待华为解析软件包（约 2 分钟）");
        await ctx.sleep(PARSE_WAIT_MS);

        let lastError: unknown;
        for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
            try {
                ensureOk(
                    await ctx.http({
                        method: "POST",
                        url: `${API}/publish/v2/app-submit`,
                        headers,
                        query: { appId },
                    }),
                    "提交审核",
                );
                return { message: "已提交审核" };
            } catch (error) {
                // 软件包可能还没解析完，隔一会儿再试
                lastError = error;
                if (attempt < SUBMIT_MAX_ATTEMPTS) {
                    ctx.log(`提交审核未成功，${SUBMIT_RETRY_INTERVAL_MS / 1000} 秒后重试（第 ${attempt} 次）`);
                    await ctx.sleep(SUBMIT_RETRY_INTERVAL_MS);
                }
            }
        }
        throw lastError;
    }
}
