/**
 * 荣耀应用市场「API 传包服务」（Publish-API）。
 * 官方文档：https://developer.honor.com/cn/doc/guides/101359
 *
 * 只支持更新已有应用的版本。有版本在审核中或待发布时，荣耀不允许再次提交。
 */
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { hashFile } from "../apk.ts";
import type { HonorConfig } from "../config.ts";
import { UPLOAD_TIMEOUT_MS } from "../http.ts";
import type { HttpResponse } from "../http.ts";
import { StoreError } from "./types.ts";
import type { RemoteState, Store, StoreContext, SubmitResult } from "./types.ts";

const TOKEN_URL = "https://iam.developer.honor.com/auth/token";
const API = "https://appmarket-openapi-drcn.cloud.honor.com/openapi/v1/publish";

/** 文件类型表：100 为应用包 */
const FILE_TYPE_APK = 100;
/** releaseType：1 全网发布，2 指定时间发布，3 分阶段发布 */
const RELEASE_TYPE_FULL = 1;
/** setAll：0 只更新传入的语种，其他语种不动 */
const SET_ALL_ONLY_GIVEN = 0;

interface LanguageInfo {
    languageId: string;
    appName: string;
    intro: string;
    briefIntro?: string;
    newFeature?: string;
}

function ensureOk(response: HttpResponse, action: string): any {
    const json = response.json;
    if (response.status !== 200 || !json || json.code !== 0) {
        const detail = json?.msg ?? response.text.slice(0, 200) ?? `HTTP ${response.status}`;
        throw new StoreError(`荣耀${action}失败：${detail}`, json?.code ?? response.status);
    }
    return json.data;
}

export class HonorStore implements Store {
    readonly name = "honor" as const;
    private readonly config: HonorConfig;
    private authHeaders?: Record<string, string>;
    /** check 时读到的默认语种资料和上次提审信息，submit 时沿用 */
    private language?: LanguageInfo;
    private publishInfo?: Record<string, unknown>;

    constructor(config: HonorConfig) {
        this.config = config;
    }

    private async auth(ctx: StoreContext): Promise<Record<string, string>> {
        if (this.authHeaders) return this.authHeaders;
        const response = await ctx.http({
            method: "POST",
            url: TOKEN_URL,
            form: {
                grant_type: "client_credentials",
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
            },
        });
        const token: unknown = response.json?.access_token;
        if (response.status !== 200 || typeof token !== "string") {
            const detail = response.json?.error_description ?? response.json?.msg ?? response.text.slice(0, 200);
            throw new StoreError(`荣耀获取 token 失败：${detail}`, response.json?.code ?? response.status);
        }
        this.authHeaders = { Authorization: `Bearer ${token}` };
        return this.authHeaders;
    }

    private async resolveAppId(ctx: StoreContext): Promise<string> {
        if (this.config.appId) return this.config.appId;
        const data = ensureOk(
            await ctx.http({
                url: `${API}/get-app-id`,
                headers: await this.auth(ctx),
                query: { pkgName: ctx.packageName },
            }),
            "按包名查询应用",
        );
        const appId: unknown = (data ?? []).find((item: any) => item.packageName === ctx.packageName)?.appId;
        if (appId === undefined || appId === null) {
            throw new StoreError(`荣耀上没有找到包名为 ${ctx.packageName} 的应用，需要先在后台创建`);
        }
        return String(appId);
    }

    async check(ctx: StoreContext): Promise<RemoteState> {
        const appId = await this.resolveAppId(ctx);
        const detail =
            ensureOk(
                await ctx.http({
                    url: `${API}/get-app-detail`,
                    headers: await this.auth(ctx),
                    query: { appId },
                }),
                "查询应用详细信息",
            ) ?? {};

        const languages: LanguageInfo[] = detail.languageInfo ?? [];
        const defaultLanguage: unknown = detail.basicInfo?.defaultLanguage;
        this.language = languages.find((item) => item.languageId === defaultLanguage) ?? languages[0];
        this.publishInfo = detail.publishInfo ?? {};

        const versionCode = Number(detail.releaseInfo?.versionCode);
        return {
            appId,
            appName: this.language?.appName,
            versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
            versionName: detail.releaseInfo?.versionName || undefined,
        };
    }

    async submit(ctx: StoreContext, remote: RemoteState): Promise<SubmitResult> {
        const appId = remote.appId!;
        const headers = await this.auth(ctx);
        const fileName = basename(ctx.apkPath);
        if (!this.language) {
            throw new StoreError("荣耀上这个应用还没有多语言资料，需要先在后台填写应用名称和介绍");
        }

        ctx.log("获取上传地址");
        const pathsResponse = await ctx.http({
                method: "POST",
                url: `${API}/get-file-upload-url`,
                headers,
                query: { appId },
                json: [
                    {
                        fileName,
                        fileType: FILE_TYPE_APK,
                        fileSize: ctx.apk.size,
                        fileSha256: await hashFile(ctx.apkPath, "sha256"),
                    },
                ],
            });
        ensureOk(pathsResponse, "获取应用文件上传路径");
        // objectId 是 19 位整数，超出 JS 数字精度，JSON.parse 后会被改写，只能从原始响应文本里按字符串取
        const objectId = extractObjectId(pathsResponse.text);
        if (!objectId) {
            throw new StoreError("荣耀获取上传路径的返回里没有 objectId");
        }

        ctx.log(`上传 ${fileName}（${(ctx.apk.size / 1024 / 1024).toFixed(1)} MB）`);
        const form = new FormData();
        form.set("file", await openAsBlob(ctx.apkPath, { type: "application/vnd.android.package-archive" }), fileName);
        ensureOk(
            await ctx.http({
                method: "POST",
                url: `${API}/file-upload`,
                headers,
                query: { appId, objectId },
                multipart: form,
                timeoutMs: UPLOAD_TIMEOUT_MS,
            }),
            "上传应用文件",
        );

        ctx.log("写入更新说明");
        // 应用名称和介绍是必填项，沿用现有资料，只换新版本特性
        ensureOk(
            await ctx.http({
                method: "POST",
                url: `${API}/update-language-info`,
                headers,
                query: { appId },
                json: {
                    languageInfoList: [{ ...this.language, newFeature: ctx.notes }],
                    setAll: SET_ALL_ONLY_GIVEN,
                },
            }),
            "更新应用多语言信息",
        );

        ctx.log("绑定应用包");
        ensureOk(
            await ctx.http({
                method: "POST",
                url: `${API}/update-file-info`,
                query: { appId },
                // 同样为了保住 objectId 的精度，请求体手工拼，objectId 按数字原样写入
                headers: { ...headers, "Content-Type": "application/json" },
                body: new TextEncoder().encode(`{"bindingFileList":[{"objectId":${objectId}}]}`),
            }),
            "更新应用文件信息",
        );

        ctx.log("提交审核");
        // 审核用的测试账号和备注沿用上次提审时填的
        const previous = this.publishInfo ?? {};
        ensureOk(
            await ctx.http({
                method: "POST",
                url: `${API}/submit-audit`,
                headers,
                query: { appId },
                json: {
                    releaseType: RELEASE_TYPE_FULL,
                    testAccount: previous.testAccount ?? null,
                    testPassword: previous.testPassword ?? null,
                    testComment: previous.testComment ?? null,
                },
            }),
            "提交审核",
        );
        return { message: "已提交审核" };
    }
}

/** 从原始响应文本里取第一个 objectId，保留全部位数 */
export function extractObjectId(text: string): string | undefined {
    return /"objectId"\s*:\s*"?(\d+)"?/.exec(text)?.[1];
}
