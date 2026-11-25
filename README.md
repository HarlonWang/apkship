# apkship

把 APK 提交到国内应用商店的命令行工具。目前支持华为、小米、OPPO、vivo、荣耀。

- 每个商店对应自己的渠道包，一条命令逐家上传并提交审核。
- 密钥只从环境变量读，配置文件可以放心入库。
- 按各商店官方文档实现，不带遥测，不检查更新。

> 当前是 0.1.0：签名算法和请求流程有单测覆盖，但**还没有用真实账号跑通过提审**。第一次使用建议先跑 `apkship check`，再拿一个本来就要提审的版本试。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install -g apkship
apkship --help
```

不想全局安装时可以用 `npx apkship <命令>`。

## 用法

```bash
# 只读：验证凭证有效、能查到应用、读出线上版本
apkship check

# 上传渠道包并提交审核
apkship submit --notes "修复已知问题"
apkship submit --notes-file release-notes.txt --only huawei,oppo

# 只做本地校验（包名、配置、环境变量），不发任何网络请求
apkship submit --notes "修复已知问题" --dry-run
```

| 选项 | 说明 |
|---|---|
| `-c, --config <文件>` | 配置文件，默认 `apkship.yaml` |
| `--only <商店>` | 只处理指定商店，多个用逗号分隔 |
| `-n, --notes <文字>` | 更新说明，`submit` 必填 |
| `--notes-file <文件>` | 从文件读更新说明 |
| `--dry-run` | 只做本地校验，不联网 |
| `--json` | 结果以 JSON 输出到标准输出，过程日志在标准错误 |

退出码：`0` 全部成功，`1` 有商店失败，`2` 用法或配置错误。各商店互相独立，一家失败不影响其他家。

## 配置

完整示例见 [apkship.example.yaml](apkship.example.yaml)。

```yaml
package: com.example.app
stores:
    huawei:
        apk: out/huawei.apk
        clientId: ${HUAWEI_CLIENT_ID}
        clientSecret: ${HUAWEI_CLIENT_SECRET}
    oppo:
        apk: out/oppo.apk
        clientId: ${OPPO_CLIENT_ID}
        clientSecret: ${OPPO_CLIENT_SECRET}
```

`clientSecret`、`privateKey` 这类密钥字段必须写成 `${环境变量名}`，写明文会直接报错。

## 提审前会做的校验

1. 渠道包的包名和配置的 `package` 一致。
2. 凭证有效，应用在商店上已经存在。
3. 渠道包的 versionCode 大于商店上的版本。

任何一条不满足，这家商店不会上传。

## 各商店说明

### 华为

- 凭证：AppGallery Connect 的 API 客户端（`clientId` + `clientSecret`），或 Service Account 凭证文件。
- 流程：取上传地址 → 上传 → 绑定软件包 → 写更新说明 → 等 2 分钟（官方要求，软件包异步解析）→ 提交审核。
- 更新说明写到应用的默认语言下。

### 小米

- 凭证：开发者站登录邮箱、自动发布接口的私钥、后台下载的公钥证书。
- 推送接口要求每次都带应用图标和隐私政策网址。
- **没有测试环境，推送成功就进入审核**；需要撤回只能到后台操作。
- 小米没有开放审核状态查询接口。

### OPPO

- 凭证：管理中心 → 我的 API → 服务端应用的 `client_id` 和 `client_secret`。
- 发布版本接口要求带上整份应用资料，apkship 从现网资料原样回填，只替换安装包、版本号和更新说明。现网资料缺必传项时会在上传前报错。
- 一句话简介限 13 个字。老应用现网简介可能超长，用 `summary` 配一句短的，否则会在上传前报错。
- 详情接口返回的图标和截图是 CDN 转出的 webp，发布接口只收 png/jpg。现网是 webp 时要用 `icon`（512×512 png）和 `screenshots`（1080×1920，逗号分隔）配上本地文件，apkship 会先上传再替换，否则会在上传前报错。
- 权限使用说明等合规材料不在接口范围内，仍需在后台填写。

### vivo

- 凭证：管理中心 → 账号管理 → API 管理开通后分配的 `access_key` 和 `access_secret`，账号下所有应用通用。
- 流程：上传 APK 拿到流水号 → 调应用更新接口提交，审核通过后实时上架。
- 正式环境每个传包接口限 50 次/天。

### 荣耀

- 凭证：管理中心 → 开放能力 → 凭证里申请的 API 密钥（`client_id` 和密钥）。
- 流程：取上传地址 → 上传 → 写新版本特性 → 绑定应用包 → 提交审核（全网发布）。
- 应用名称、介绍和审核用的测试账号沿用现有资料。
- 有版本在审核中或待发布时，荣耀不允许再次提交。
- 接口查不到正在审核的版本，check 只显示已上架版本，审核状态请到后台看。

## 目前不做的

- 新应用首次上架（各家都要求先在后台创建应用）
- 审核状态轮询和通知
- 商店资料同步（截图、简介）
- 应用宝等其他商店

## 开发

```bash
npm install
npm test          # 单测，HTTP 全部打桩
npm run typecheck
npm run build
```

## 许可

[Apache-2.0](LICENSE)

## 发版

改 `package.json` 的 `version`，提交后打同名 tag（不带 `v`）并推送，例如：

```sh
git tag 0.2.0 && git push origin 0.2.0
```

`Publish Release` workflow 会校验 tag 和 version 一致，跑类型检查、单测、构建后用 npm Trusted Publishing 发布，再建 GitHub Release。
