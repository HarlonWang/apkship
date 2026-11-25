import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";

export interface ApkInfo {
    packageName: string;
    versionCode: number;
    versionName: string;
    /** 文件大小，字节 */
    size: number;
}

/** 从 APK 的 AndroidManifest.xml 里读包名和版本 */
export async function readApkInfo(path: string): Promise<ApkInfo> {
    const { size } = await stat(path);
    // adbkit-apkreader 是 CommonJS 包，且没有类型声明
    const require = createRequire(import.meta.url);
    const ApkReader = require("adbkit-apkreader");
    const reader = await ApkReader.open(path);
    const manifest = await reader.readManifest();
    const packageName: unknown = manifest.package;
    const versionCode: unknown = manifest.versionCode;
    if (typeof packageName !== "string" || typeof versionCode !== "number") {
        throw new Error(`读不出包名或 versionCode：${path}`);
    }
    return {
        packageName,
        versionCode,
        versionName: String(manifest.versionName ?? ""),
        size,
    };
}

/** 流式计算文件摘要，返回小写十六进制 */
export function hashFile(path: string, algorithm: "md5" | "sha256"): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash(algorithm);
        createReadStream(path)
            .on("data", (chunk) => hash.update(chunk))
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}
