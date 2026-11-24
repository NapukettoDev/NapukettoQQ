---
"@napuketto/kernel": patch
"@napuketto/adapter": patch
---

fix: 图片发送写入真实尺寸与格式（手机端空白修复）

kernel 的 `prepareImageElement` 不再把 `picWidth` / `picHeight` 硬编码为 0、`picType`
硬编码为 1000：优先使用 canonical `size` / `mime`，缺失时由 `apis/image-meta.ts`
零依赖解析 PNG / GIF / BMP / WebP / JPEG 文件头补齐，并按 MIME/扩展名映射 NTQQ
picType（PNG 1001、WebP 1002、BMP 1005、GIF 2000、JPG 1000）。adapter 侧新增
`prepareImageElements`，在 OB11 / Milky / Satori 发送链路用 `@napuketto/media` 预填
`size` / `mime`，探测失败 warn 降级不阻断发送。
