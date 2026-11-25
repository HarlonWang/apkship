/**
 * 小米应用商店「应用自动发布接口」。
 * 官方文档：https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1134
 *
 * 注意：小米没有测试环境，推送成功后直接进入审核；也没有开放审核状态查询接口。
 */
import { X509Certificate, constants, createHash, publicEncrypt } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hashFile } from "../apk.ts";
import type { XiaomiConfig } from "../config.ts";
import { UPLOAD_TIMEOUT_MS } from "../http.ts";
import type { HttpResponse } from "../http.ts";
import { StoreError } from "./types.ts";
import type { RemoteState, Store, StoreContext, SubmitResult } from "./types.ts";

const API = "https://api.developer.xiaomi.com/devupload";

/** synchroType：0 新增，1 更新包，2 内容更新 */
const SYNCHRO_TYPE_UPDATE = 1;

/** PKCS#1 v1.5 加密的填充至少占 11 字节 */
const PKCS1_PADDING_SIZE = 11;

export interface SigItem {
    name: string;
    /** 32 位小写 MD5 */
    hash: string;
}

/**
 * 生成 SIG：把各参数的 MD5 和私钥拼成 JSON，用小米的公钥证书做 RSA 分段加密，输出小写十六进制。
 * 分段大小 = 密钥字节数 - 11（官方示例里 1024 位密钥对应 117 字节）。
 */
export function encryptSig(items: SigItem[], privateKey: string, publicKey: KeyObject): string {
    const plain = Buffer.from(JSON.stringify({ sig: items, password: privateKey }), "utf8");
    const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength;
    if (!modulusLength) throw new StoreError("小米公钥证书不是 RSA 证书");
    const segmentSize = modulusLength / 8 - PKCS1_PADDING_SIZE;

    const encrypted: Buffer[] = [];
    for (let offset = 0; offset < plain.length; offset += segmentSize) {
        encrypted.push(
            publicEncrypt(
                { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
                plain.subarray(offset, offset + segmentSize),
            ),
        );
    }
    return Buffer.concat(encrypted).toString("hex");
}

function md5(text: string): string {
    return createHash("md5").update(text, "utf8").digest("hex");
}

function ensureOk(response: HttpResponse, action: string): any {
    const json = response.json;
    if (response.status !== 200 || !json || json.result !== 0) {
        const detail = json?.message ?? response.text.slice(0, 200) ?? `HTTP ${response.status}`;
        throw new StoreError(`小米${action}失败：${detail}`, json?.result ?? response.status);
    }
    return json;
}

export class XiaomiStore implements Store {
    readonly name = "xiaomi" as const;
    private readonly config: XiaomiConfig;
    private publicKey?: KeyObject;

    constructor(config: XiaomiConfig) {
        this.config = config;
    }

    private async loadPublicKey(): Promise<KeyObject> {
        if (!this.publicKey) {
            const cert = new X509Certificate(await readFile(this.config.certFile));
            this.publicKey = cert.publicKey;
        }
        return this.publicKey;
    }

    async check(ctx: StoreContext): Promise<RemoteState> {
        const requestData = JSON.stringify({
            packageName: ctx.packageName,
            userName: this.config.email,
        });
        const sig = encryptSig(
            [{ name: "RequestData", hash: md5(requestData) }],
            this.config.privateKey,
            await this.loadPublicKey(),
        );
        const response = await ctx.http({
            method: "POST",
            url: `${API}/dev/query`,
            form: { RequestData: requestData, SIG: sig },
        });
        const json = ensureOk(response, "查询应用");
        const info = json.packageInfo;
        if (!info) {
            throw new StoreError(`小米上没有找到包名为 ${ctx.packageName} 的应用，需要先在后台创建`);
        }
        if (json.updateVersion === false) {
            throw new StoreError("小米返回当前不允许版本更新（updateVersion=false），可能有版本正在审核");
        }
        const versionCode = Number(info.versionCode);
        return {
            appName: info.appName,
            versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
            versionName: info.versionName,
        };
    }

    async submit(ctx: StoreContext, remote: RemoteState): Promise<SubmitResult> {
        const appName = this.config.appName ?? remote.appName;
        if (!appName) throw new StoreError("小米推送需要应用名，请在配置里填 stores.xiaomi.appName");

        const appInfo = {
            appName,
            packageName: ctx.packageName,
            updateDesc: ctx.notes,
            privacyUrl: this.config.privacyUrl,
        };
        // appInfo 在 RequestData 里是 JSON 字符串；签名用的字符串必须和发送的完全一致
        const requestData = JSON.stringify({
            userName: this.config.email,
            appInfo: JSON.stringify(appInfo),
            synchroType: SYNCHRO_TYPE_UPDATE,
        });

        ctx.log("计算签名");
        const sig = encryptSig(
            [
                { name: "RequestData", hash: md5(requestData) },
                { name: "apk", hash: await hashFile(ctx.apkPath, "md5") },
                { name: "icon", hash: await hashFile(this.config.icon, "md5") },
            ],
            this.config.privateKey,
            await this.loadPublicKey(),
        );

        const form = new FormData();
        form.set("RequestData", requestData);
        form.set("SIG", sig);
        form.set("apk", await openAsBlob(ctx.apkPath), basename(ctx.apkPath));
        form.set("icon", await openAsBlob(this.config.icon), basename(this.config.icon));

        ctx.log(`推送 ${basename(ctx.apkPath)}（${(ctx.apk.size / 1024 / 1024).toFixed(1)} MB）`);
        const response = await ctx.http({
            method: "POST",
            url: `${API}/dev/push`,
            multipart: form,
            timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        const json = ensureOk(response, "推送");
        return { message: json.message || "已推送，进入审核" };
    }
}
