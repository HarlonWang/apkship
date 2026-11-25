import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { StoreName } from "./stores/types.ts";

export interface HuaweiConfig {
    apk: string;
    /** API 客户端方式 */
    clientId?: string;
    clientSecret?: string;
    /** Service Account 方式：凭证 JSON 文件路径 */
    serviceAccountFile?: string;
    /** 不填则按包名查询 */
    appId?: string;
}

export interface XiaomiConfig {
    apk: string;
    /** 小米开发者站登录邮箱 */
    email: string;
    /** 自动发布接口的私钥 */
    privateKey: string;
    /** 从小米后台下载的公钥证书（.cer）路径 */
    certFile: string;
    /** 应用图标，小米推送接口必传 */
    icon: string;
    /** 隐私政策网址，小米推送接口必传 */
    privacyUrl: string;
    /** 不填则用小米上已有的应用名 */
    appName?: string;
}

export interface OppoConfig {
    apk: string;
    clientId: string;
    clientSecret: string;
}

export interface VivoConfig {
    apk: string;
    accessKey: string;
    accessSecret: string;
}

export interface Config {
    package: string;
    stores: {
        huawei?: HuaweiConfig;
        xiaomi?: XiaomiConfig;
        oppo?: OppoConfig;
        vivo?: VivoConfig;
    };
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/** 这些字段是密钥，只允许写成 ${环境变量}，不允许明文写进配置文件 */
const SECRET_FIELDS: Record<StoreName, string[]> = {
    huawei: ["clientSecret"],
    xiaomi: ["privateKey"],
    oppo: ["clientSecret"],
    vivo: ["accessSecret"],
};

const REQUIRED_FIELDS: Record<StoreName, string[]> = {
    huawei: ["apk"],
    xiaomi: ["apk", "email", "privateKey", "certFile", "icon", "privacyUrl"],
    oppo: ["apk", "clientId", "clientSecret"],
    vivo: ["apk", "accessKey", "accessSecret"],
};

/** 值是文件路径的字段，相对路径按配置文件所在目录解析 */
const PATH_FIELDS = ["apk", "serviceAccountFile", "certFile", "icon"];

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WHOLE_ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export const STORE_NAMES: StoreName[] = ["huawei", "xiaomi", "oppo", "vivo"];

function expandEnv(value: string, where: string, env: NodeJS.ProcessEnv): string {
    return value.replace(ENV_REF, (_, name: string) => {
        const resolved = env[name];
        if (resolved === undefined || resolved === "") {
            throw new ConfigError(`${where} 引用的环境变量 ${name} 没有设置`);
        }
        return resolved;
    });
}

/**
 * 解析配置文本。
 * @param baseDir 相对路径的基准目录（配置文件所在目录）
 * @param only 只处理这些商店；没列出的商店不校验、不展开环境变量
 */
export function parseConfig(
    text: string,
    baseDir: string,
    env: NodeJS.ProcessEnv = process.env,
    only?: StoreName[],
): Config {
    const raw = parse(text) as unknown;
    if (!raw || typeof raw !== "object") throw new ConfigError("配置文件内容为空或格式不对");
    const root = raw as Record<string, unknown>;

    if (typeof root.package !== "string" || !root.package) {
        throw new ConfigError("缺少 package（应用包名）");
    }
    if (!root.stores || typeof root.stores !== "object") {
        throw new ConfigError("缺少 stores（至少配置一个商店）");
    }
    const rawStores = root.stores as Record<string, unknown>;

    for (const name of Object.keys(rawStores)) {
        if (!STORE_NAMES.includes(name as StoreName)) {
            throw new ConfigError(`不支持的商店：${name}（支持 ${STORE_NAMES.join("、")}）`);
        }
    }
    for (const name of only ?? []) {
        if (!(name in rawStores)) throw new ConfigError(`配置里没有商店 ${name}`);
    }

    const stores: Record<string, Record<string, string>> = {};
    for (const name of STORE_NAMES) {
        if (!(name in rawStores)) continue;
        if (only && !only.includes(name)) continue;
        const rawStore = rawStores[name];
        if (!rawStore || typeof rawStore !== "object") {
            throw new ConfigError(`stores.${name} 应该是一组键值`);
        }

        const store: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawStore as Record<string, unknown>)) {
            const where = `stores.${name}.${key}`;
            if (value === null || value === undefined) continue;
            if (typeof value !== "string" && typeof value !== "number") {
                throw new ConfigError(`${where} 应该是字符串`);
            }
            const textValue = String(value);
            if (SECRET_FIELDS[name].includes(key) && !WHOLE_ENV_REF.test(textValue)) {
                throw new ConfigError(
                    `${where} 是密钥，不能明文写在配置文件里，请写成 \${环境变量名}`,
                );
            }
            const expanded = expandEnv(textValue, where, env);
            store[key] = PATH_FIELDS.includes(key) ? resolve(baseDir, expanded) : expanded;
        }

        for (const key of REQUIRED_FIELDS[name]) {
            if (!store[key]) throw new ConfigError(`stores.${name} 缺少 ${key}`);
        }
        if (name === "huawei") {
            const hasClient = Boolean(store.clientId && store.clientSecret);
            if (!hasClient && !store.serviceAccountFile) {
                throw new ConfigError(
                    "stores.huawei 需要 clientId + clientSecret，或者 serviceAccountFile",
                );
            }
        }
        stores[name] = store;
    }

    if (Object.keys(stores).length === 0) throw new ConfigError("stores 里没有可用的商店");
    return { package: root.package, stores: stores as Config["stores"] };
}

export async function loadConfig(path: string, only?: StoreName[]): Promise<Config> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch {
        throw new ConfigError(`读不到配置文件：${path}`);
    }
    return parseConfig(text, dirname(resolve(path)), process.env, only);
}
