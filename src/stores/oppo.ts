/**
 * OPPO 开放平台「API 传包能力」。
 * 官方文档：https://open.oppomobile.com/documentation/page/info?id=10998
 *
 * 只支持更新已有应用的版本。发布版本接口要求把应用资料整份带上，这里从现网资料原样回填。
 */
import { createHmac } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { OppoConfig } from "../config.ts";
import { UPLOAD_TIMEOUT_MS } from "../http.ts";
import type { HttpResponse } from "../http.ts";
import { StoreError } from "./types.ts";
import type { RemoteState, Store, StoreContext, SubmitResult } from "./types.ts";

const API = "https://oop-openapi-cn.heytapmobi.com";

/** online_type：1 审核通过后立即发布，2 定时发布 */
const ONLINE_TYPE_IMMEDIATE = "1";
/** cpu_code：非多包应用为 0 */
const CPU_CODE_SINGLE = 0;

/** task_state：1 待处理，2 处理成功，3 处理失败 */
const TASK_PENDING = "1";
const TASK_SUCCESS = "2";
const TASK_POLL_INTERVAL_MS = 5_000;
const TASK_POLL_MAX_ATTEMPTS = 60;

/** 发布版本接口对普通应用必传、可从现网资料回填的字段 */
const REQUIRED_PROFILE_FIELDS = [
    "app_name",
    "second_category_id",
    "third_category_id",
    "summary",
    "detail_desc",
    "privacy_source_url",
    "icon_url",
    "pic_url",
    "copyright_url",
    "business_username",
    "business_email",
    "business_mobile",
    "age_level",
    "adaptive_equipment",
];

/** 非必传、现网有值就原样带上的字段 */
const OPTIONAL_PROFILE_FIELDS = [
    "app_subname",
    "landscape_pic_url",
    "video_url",
    "electronic_cert_url",
    "icp_url",
    "special_url",
    "special_file_url",
    "adaptive_type",
];

/**
 * 签名：除 api_sign 外的全部参数按参数名 ASCII 升序，拼成 k1=v1&k2=v2，
 * 用 client_secret 做 HmacSHA256，输出小写十六进制。
 */
export function signParams(params: Record<string, string>, clientSecret: string): string {
    const text = Object.keys(params)
        .filter((key) => key !== "api_sign")
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
    return createHmac("sha256", clientSecret).update(text, "utf8").digest("hex");
}

function ensureOk(response: HttpResponse, action: string): any {
    const json = response.json;
    if (response.status !== 200 || !json || json.errno !== 0) {
        const detail = json?.data?.message ?? response.text.slice(0, 200) ?? `HTTP ${response.status}`;
        throw new StoreError(`OPPO ${action}失败：${detail}`, json?.errno ?? response.status);
    }
    return json.data ?? {};
}

export class OppoStore implements Store {
    readonly name = "oppo" as const;
    private readonly config: OppoConfig;
    private token?: string;
    /** check 时读到的现网资料，submit 时回填 */
    private profile?: Record<string, unknown>;

    constructor(config: OppoConfig) {
        this.config = config;
    }

    private async accessToken(ctx: StoreContext): Promise<string> {
        if (this.token) return this.token;
        const response = await ctx.http({
            url: `${API}/developer/v1/token`,
            query: { client_id: this.config.clientId, client_secret: this.config.clientSecret },
        });
        const token: unknown = ensureOk(response, "获取 token").access_token;
        if (typeof token !== "string" || !token) throw new StoreError("OPPO 获取 token 的返回里没有 access_token");
        this.token = token;
        return token;
    }

    /** 加上公共参数并签名 */
    private async signed(ctx: StoreContext, business: Record<string, string>): Promise<Record<string, string>> {
        const params: Record<string, string> = {
            ...business,
            access_token: await this.accessToken(ctx),
            timestamp: String(Math.floor(Date.now() / 1000)),
        };
        params.api_sign = signParams(params, this.config.clientSecret);
        return params;
    }

    async check(ctx: StoreContext): Promise<RemoteState> {
        const response = await ctx.http({
            url: `${API}/resource/v1/app/info`,
            query: await this.signed(ctx, { pkg_name: ctx.packageName }),
        });
        const data = ensureOk(response, "查询应用详情");
        this.profile = data;
        const versionCode = Number(data.version_code);
        return {
            appId: data.app_id,
            appName: data.app_name,
            versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
            versionName: data.version_name,
            status: data.audit_status_name,
        };
    }

    async submit(ctx: StoreContext): Promise<SubmitResult> {
        const profile = this.profile ?? {};
        const missing = REQUIRED_PROFILE_FIELDS.filter((key) => isEmpty(profile[key]));
        if (missing.length > 0) {
            throw new StoreError(
                `OPPO 现网资料里缺少发布版本必传的字段：${missing.join("、")}，请先在后台补全`,
            );
        }

        ctx.log("获取上传地址");
        const uploadConfig = ensureOk(
            await ctx.http({
                url: `${API}/resource/v1/upload/get-upload-url`,
                query: await this.signed(ctx, {}),
            }),
            "获取上传配置",
        );

        ctx.log(`上传 ${basename(ctx.apkPath)}（${(ctx.apk.size / 1024 / 1024).toFixed(1)} MB）`);
        const form = new FormData();
        form.set("type", "apk");
        form.set("sign", String(uploadConfig.sign));
        form.set("file", await openAsBlob(ctx.apkPath), basename(ctx.apkPath));
        const uploaded = ensureOk(
            await ctx.http({
                method: "POST",
                url: String(uploadConfig.upload_url),
                multipart: form,
                timeoutMs: UPLOAD_TIMEOUT_MS,
            }),
            "上传文件",
        );

        const business: Record<string, string> = {
            pkg_name: ctx.packageName,
            version_code: String(ctx.apk.versionCode),
            apk_url: JSON.stringify([{ url: uploaded.url, md5: uploaded.md5, cpu_code: CPU_CODE_SINGLE }]),
            update_desc: ctx.notes ?? "",
            online_type: ONLINE_TYPE_IMMEDIATE,
            // 测试附加说明必传，现网没有就传空字符串
            test_desc: isEmpty(profile.test_desc) ? "" : String(profile.test_desc),
        };
        for (const key of REQUIRED_PROFILE_FIELDS) business[key] = String(profile[key]);
        for (const key of OPTIONAL_PROFILE_FIELDS) {
            if (!isEmpty(profile[key])) business[key] = String(profile[key]);
        }

        ctx.log("提交发布版本");
        ensureOk(
            await ctx.http({
                method: "POST",
                url: `${API}/resource/v1/app/upd`,
                form: await this.signed(ctx, business),
            }),
            "发布版本",
        );

        // 发布版本是异步任务，轮询到有结果为止
        for (let attempt = 0; attempt < TASK_POLL_MAX_ATTEMPTS; attempt++) {
            await ctx.sleep(TASK_POLL_INTERVAL_MS);
            const task = ensureOk(
                await ctx.http({
                    method: "POST",
                    url: `${API}/resource/v1/app/task-state`,
                    form: await this.signed(ctx, {
                        pkg_name: ctx.packageName,
                        version_code: String(ctx.apk.versionCode),
                    }),
                }),
                "查询任务状态",
            );
            const state = String(task.task_state);
            if (state === TASK_SUCCESS) return { message: "已提交审核" };
            if (state !== TASK_PENDING) {
                throw new StoreError(`OPPO 发布版本任务失败：${task.err_msg || "未返回原因"}`);
            }
        }
        throw new StoreError("OPPO 发布版本任务一直在处理中，请稍后到后台确认结果");
    }
}

function isEmpty(value: unknown): boolean {
    return value === null || value === undefined || value === "";
}
