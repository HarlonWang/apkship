/**
 * vivo 开放平台「API 接口传包」（文件上传方式）。
 * 官方文档：https://dev.vivo.com.cn/documentCenter/doc/327
 *
 * 只支持更新已有应用的版本：先上传 APK 拿到流水号，再调应用更新接口提交。
 */
import { createHmac } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { hashFile } from "../apk.ts";
import type { VivoConfig } from "../config.ts";
import { UPLOAD_TIMEOUT_MS } from "../http.ts";
import type { HttpResponse } from "../http.ts";
import { StoreError } from "./types.ts";
import type { RemoteState, Store, StoreContext, SubmitResult } from "./types.ts";

const API = "https://developer-api.vivo.com.cn/router/rest";

/** onlineType：1 实时上架，2 定时上架 */
const ONLINE_TYPE_IMMEDIATE = "1";
/** compatibleDevice：1 手机，2 手机和平板，3 平板 */
const COMPATIBLE_DEVICE_PHONE = 1;

/** 审核状态（status） */
const AUDIT_STATUS: Record<number, string> = {
    1: "草稿",
    2: "待审核",
    3: "审核通过",
    4: "审核不通过",
    5: "撤销审核",
};
/** 上架状态（saleStatus） */
const SALE_STATUS: Record<number, string> = {
    0: "待上架",
    1: "已上架",
    2: "已下架",
};

/**
 * 签名：公共参数和业务参数（不含 sign 和文件）按参数名 ASCII 升序，拼成 k1=v1&k2=v2，
 * 用 access_secret 做 HmacSHA256，输出小写十六进制。
 */
export function signParams(params: Record<string, string>, accessSecret: string): string {
    const text = Object.keys(params)
        .filter((key) => key !== "sign")
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
    return createHmac("sha256", accessSecret).update(text, "utf8").digest("hex");
}

/** vivo 用 code 表示调用是否成功，用 subCode 表示业务是否成功，两者都为 0 才算成功 */
function ensureOk(response: HttpResponse, action: string): any {
    const json = response.json;
    if (response.status !== 200 || !json) {
        throw new StoreError(`vivo ${action}失败：${response.text.slice(0, 200)}`, response.status);
    }
    if (json.code !== 0) throw new StoreError(`vivo ${action}失败：${json.msg}`, json.code);
    if (json.subCode !== undefined && String(json.subCode) !== "0") {
        throw new StoreError(`vivo ${action}失败：${json.msg}`, json.subCode);
    }
    return json.data ?? {};
}

export class VivoStore implements Store {
    readonly name = "vivo" as const;
    private readonly config: VivoConfig;
    /** check 时读到的兼容设备，应用更新接口必传 */
    private compatibleDevice?: number;

    constructor(config: VivoConfig) {
        this.config = config;
    }

    /** 加上公共参数并签名 */
    private signed(method: string, business: Record<string, string>): Record<string, string> {
        const params: Record<string, string> = {
            ...business,
            method,
            access_key: this.config.accessKey,
            timestamp: String(Date.now()),
            format: "json",
            v: "1.0",
            sign_method: "hmac",
            target_app_key: "developer",
        };
        params.sign = signParams(params, this.config.accessSecret);
        return params;
    }

    async check(ctx: StoreContext): Promise<RemoteState> {
        const response = await ctx.http({
            method: "POST",
            url: API,
            form: this.signed("app.query.details", { packageName: ctx.packageName }),
        });
        const data = ensureOk(response, "查询应用详情");
        if (typeof data.compatibleDevice === "number") this.compatibleDevice = data.compatibleDevice;
        const versionCode = Number(data.versionCode);
        const status = [AUDIT_STATUS[data.status], SALE_STATUS[data.saleStatus]].filter(Boolean).join("，");
        return {
            appName: data.mainTitle,
            versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
            versionName: data.versionName,
            status: status || undefined,
        };
    }

    async submit(ctx: StoreContext): Promise<SubmitResult> {
        const fileMd5 = await hashFile(ctx.apkPath, "md5");

        ctx.log(`上传 ${basename(ctx.apkPath)}（${(ctx.apk.size / 1024 / 1024).toFixed(1)} MB）`);
        // 文件不参与签名，其余字段和签名一起放进表单
        const form = new FormData();
        const uploadParams = this.signed("app.upload.apk.app", { packageName: ctx.packageName, fileMd5 });
        for (const [key, value] of Object.entries(uploadParams)) form.set(key, value);
        form.set("file", await openAsBlob(ctx.apkPath), basename(ctx.apkPath));
        const uploaded = ensureOk(
            await ctx.http({ method: "POST", url: API, multipart: form, timeoutMs: UPLOAD_TIMEOUT_MS }),
            "上传 APK",
        );
        const serial: unknown = uploaded.serialnumber;
        if (typeof serial !== "string" || !serial) throw new StoreError("vivo 上传 APK 的返回里没有流水号");

        ctx.log("提交应用更新");
        ensureOk(
            await ctx.http({
                method: "POST",
                url: API,
                form: this.signed("app.sync.update.app", {
                    packageName: ctx.packageName,
                    versionCode: String(ctx.apk.versionCode),
                    apk: serial,
                    fileMd5,
                    onlineType: ONLINE_TYPE_IMMEDIATE,
                    updateDesc: ctx.notes ?? "",
                    compatibleDevice: String(this.compatibleDevice ?? COMPATIBLE_DEVICE_PHONE),
                }),
            }),
            "应用更新",
        );
        return { message: "已提交审核" };
    }
}
