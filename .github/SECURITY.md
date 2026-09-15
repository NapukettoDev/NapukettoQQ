# 安全政策

> [跳转到英文版（English Version）](#english-version)

## 支持的版本

NapukettoQQ 处于 0.x 早期阶段（npm 作用域 `@napuketto/*`），API 未冻结。安全更新仅针对当前发布线提供，并以补丁版本的形式通过正式发布链（changesets → `pnpm release`）发布。

| 版本线 | 支持情况 |
| ------ | -------- |
| 0.x（当前发布线，`@napuketto/kernel`、`@napuketto/loader`、`@napuketto/adapter`、`@napuketto/network`、`@napuketto/media`、`@napuketto/cli` 等） | 支持 |
| 已被取代或停止维护的旧版本线 | 不支持 |

## 报告漏洞

请通过以下方式报告漏洞：

* **首选**：使用 GitHub 的私有漏洞报告功能——进入本仓库 **Security** 标签页 → **Report a vulnerability**，填写漏洞详情。该渠道对维护者与报告者均可见，漏洞细节不会公开暴露。
* **备选**：发送邮件至 `oppenheymu@gmail.com`（与行为准则中一致的联系邮箱），请在主题中注明「Security」。

报告后的流程与预期：

* 我们通常会在 **48 小时内**确认收到报告，并给出初步评估。
* 确认有效的漏洞将以补丁版本修复，并记录于受影响包的 CHANGELOG；在修复落地前，我们不会公开漏洞细节，以免影响未升级的用户。
* **请不要**在公开渠道（Issues、讨论区、社交媒体等）披露尚未修复的漏洞细节。

### 范围说明

* `packages/loader/native/`（闭源 Native Bypass 载具，仅以编译后二进制分发）同样在报告范围内，请走上述渠道。
* 腾讯 QQ 客户端本体（`wrapper.node` 等）自身的问题不属本项目范围，请向腾讯报告；但若本项目的引导 / 载具方式放大了其风险，欢迎报告。
* 本项目承诺零磁盘篡改（不修改 QQ 安装目录任何文件），漏洞相关行为均为运行期内存操作；若发现违背该承诺的途径，请作为高危报告。

---

<a id="english-version"></a>

# Security Policy

## Supported Versions

NapukettoQQ is in its early 0.x stage (npm scope `@napuketto/*`); the API is not frozen yet. Security updates are provided for the current release line only, shipped as patch releases through the formal release chain (changesets → `pnpm release`).

| Version | Supported |
| ------- | --------- |
| 0.x (current release line: `@napuketto/kernel`, `@napuketto/loader`, `@napuketto/adapter`, `@napuketto/network`, `@napuketto/media`, `@napuketto/cli`, ...) | Yes |
| Superseded or unmaintained release lines | No |

## Reporting a Vulnerability

Please report vulnerabilities through the following channels:

* **Preferred**: use GitHub's private vulnerability reporting — go to the **Security** tab of this repository → **Report a vulnerability** and fill in the details. The channel is visible to maintainers and reporters only, and vulnerability details are not exposed publicly.
* **Alternative**: send an email to `oppenheymu@gmail.com` (same contact as in the Code of Conduct), with "Security" noted in the subject line.

What to expect after reporting:

* We typically **acknowledge receipt within 48 hours** and provide an initial assessment.
* Confirmed vulnerabilities are fixed in a patch release and recorded in the affected package's CHANGELOG; until the fix lands, we will not disclose details publicly, so that users who have not yet upgraded are not exposed.
* **Please do not** disclose details of unfixed vulnerabilities in public channels (Issues, discussions, social media, etc.).

### Scope notes

* `packages/loader/native/` (the closed-source Native Bypass vehicle, distributed as compiled binaries only) is also in scope; please use the channels above.
* Issues in the Tencent QQ client itself (`wrapper.node`, etc.) are out of scope for this project — report them to Tencent. However, if the way this project boots or its vehicle amplifies such a risk, reports are welcome.
* This project never modifies any file under the on-disk QQ installation directory; vulnerability-relevant behavior is runtime in-memory only. If you find a path that violates this invariant, please report it as high severity.
