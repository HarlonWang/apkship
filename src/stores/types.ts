import type { ApkInfo } from "../apk.ts";
import type { Http } from "../http.ts";

export type StoreName = "huawei" | "xiaomi" | "oppo" | "vivo" | "honor";

/** 每次运行传给商店实现的上下文 */
export interface StoreContext {
    /** 应用包名（配置里的 package，已和 APK 核对一致） */
    packageName: string;
    /** 本商店对应的渠道包 */
    apkPath: string;
    apk: ApkInfo;
    /** 更新说明，submit 时必填 */
    notes?: string;
    http: Http;
    log: (message: string) => void;
    /** 等待，测试里可替换成立即返回 */
    sleep: (ms: number) => Promise<void>;
}

/** 商店上现有版本的信息，check 的结果 */
export interface RemoteState {
    /** 商店侧的应用标识（华为 appId、OPPO app_id），没有就不填 */
    appId?: string;
    appName?: string;
    /** 商店上最新版本的 versionCode（可能是在架版本，也可能是审核中的版本，取决于商店返回） */
    versionCode?: number;
    versionName?: string;
    /** 商店返回的状态描述，原样给人看 */
    status?: string;
}

export interface SubmitResult {
    /** 给人看的一句话结果 */
    message: string;
}

export interface Store {
    readonly name: StoreName;
    /** 只读：验证凭证、查应用、读线上版本。不写入任何内容 */
    check(ctx: StoreContext): Promise<RemoteState>;
    /** 上传渠道包并提交审核 */
    submit(ctx: StoreContext, remote: RemoteState): Promise<SubmitResult>;
}

/** 商店接口返回的业务错误，带上商店原始错误码，方便对照官方文档 */
export class StoreError extends Error {
    readonly code?: string | number;

    constructor(message: string, code?: string | number) {
        super(code === undefined ? message : `${message}（错误码 ${code}）`);
        this.name = "StoreError";
        this.code = code;
    }
}
