# 任务 12 媒体预算验证

以 `origin/main` 的 `e774e37` 为基线。复用 [#160 的进程和输出隔离](https://github.com/NapukettoDev/NapukettoQQ/pull/160)
（`37087d5`）、[#178 的媒体出站策略](https://github.com/NapukettoDev/NapukettoQQ/pull/178)
（`5966a5e`）与 [#179 的动作缓存所有权](https://github.com/NapukettoDev/NapukettoQQ/pull/179)
（`f572475`）。任务 12 的提交可独立应用，06／07 无额外在途依赖。

| 审计编号 | 改动 | 验证 |
| --- | --- | --- |
| H-11 上游 | [音频](../src/audio.ts)、[图片](../src/image.ts)、[SILK Worker](../src/silk-worker.mts)、[kernel 摘要](../../kernel/src/apis/msg.ts) | 大文件头部探测、跨多个读块的 MD5、正常 SILK/WAV、600,000 ms 元数据通过，额外一帧及不完整包拒绝；32 MiB 输入、真实归一化 PCM 精确到 28,800,000 字节及越界清理；Worker 取消后退出 |
| M-09 上游 | [Milky URI](../../adapter/src/milky/helper/message/media-uri.ts) | 标准及 URL-safe Base64、30 MiB 精确边界、超出 40 Mi 编码字符拒绝、尾块无效、取消、消费完成和原生调用模拟失败后的条目清理 |
| L-03 FFmpeg | [进程与写入](../src/process.ts)、[视频](../src/video.ts) | 参数测试核对协议／demuxer 白名单、线程、像素、帧和期限；测试覆盖超大输入、输出跨过 128 MiB、空输出、伪造产物元数据、取消及保留旧缩略图 |

## 测试命令

```sh
pnpm --filter @napuketto/media build
pnpm --filter @napuketto/kernel build
pnpm --filter @napuketto/adapter build
pnpm test:quiet packages/media packages/adapter/src/milky/helper/message/__tests__/media-uri.test.ts packages/kernel/src/apis/__tests__/msg-api-more.test.ts
pnpm check && pnpm test:quiet
pnpm exec fallow audit --base origin/main
```

三个单包构建、Fallow 增量门禁均通过。定向测试 361 项通过。完整门禁 240 个测试文件通过，
3,685 项通过、14 项跳过。

Windows Node 24.16.0、pnpm 12.4.1 与 FFmpeg/FFprobe 9.0。锁定 `silk-wasm@3.7.1`、
`image-size@2.1.0`、`file-type@22.3.0` 和 `execa@10.2.1`。

真实进程验收使用临时目录和合成输入，下列命令可生成样本。

```sh
ffmpeg -hide_banner -v error -f lavfi -i "testsrc2=s=320x240:r=30:d=2" -f lavfi -i "sine=d=2" -c:v libx264 -c:a aac input.mp4
ffmpeg -hide_banner -v error -f lavfi -i "sine=d=1" input.mp3
ffmpeg -hide_banner -v error -f lavfi -i "sine=sample_rate=24000:d=600" limit.flac
ffmpeg -hide_banner -v error -f lavfi -i "sine=sample_rate=24000:d=600.05" above.flac
ffmpeg -hide_banner -v error -f lavfi -i "testsrc2=s=640x360:r=30:d=12" -c:v libx264 -preset ultrafast cancel.mp4
```

- 从 `dist/index.mjs` 调用 `transcodeVideo`，把 320×240 画面缩放至 160×120，
  在 1、23.976、24、60 fps 下输出均为 2,023 ms。0.2s 输入在 1 fps 下有一帧且可探测。
  `ffmpeg -xerror -i <输出> -f null -` 解码验证分片 MP4、首帧 PNG 和解码 WAV。
- `encodePcmToSilk` 接受 600s FLAC。600.05s 在 28,800,000 字节的输出边界拒绝，
  临时 PCM 文件被删除。1s MP3 生成 1,000 ms SILK，解码 WAV 含 40 ms 编解码器填充。
- 真实 FFmpeg 开始写出后取消，调用返回拒绝且临时目录清空。SILK 解码取消后没有部分文件。
  PATH 缺失 FFmpeg 和无法解析的 MOV 都保留原目标并清理独占临时目录。

FFmpeg 的文件大小参数允许超出设置值，因此运行时通过管道在每次实际写入前检查预算。
分片 MP4 允许在管道上保持完整封装。[FFmpeg 文件大小选项](https://ffmpeg.org/ffmpeg.html#Main-options) ·
[FFmpeg MP4 分片文档](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation)

## 迁移与任务 13

任务 13 依赖本 PR 所发布的 `@napuketto/media`，changeset 计划从 0.3.0 升至 0.4.0。
从公共入口导入 `decodeSilkToWav`、`DecodeSilkToWavOptions`、`MAX_AUDIO_INPUT_BYTES`
和 `MAX_AUDIO_SECONDS`。给每次解码传独占 `outDir` 与可选 `signal`。按 32 MiB 输入、
600s 实际 PCM、单声道 16-bit 计算预算。成功返回路径的所有者在最后一次消费后回收；
取消或失败时该次解码负责删除部分文件，调用方负责清理自己创建的目录。
下游接入以发布版本为依赖，保持原有媒体文件的所有者不变。

视频转码输出为分片 H.264/AAC MP4。调用方需传偶数宽高和范围内的有限帧率，超预算输入可先缩放或缩短。
本地真机验证覆盖 FFmpeg 播放解码。QQ 原生/Satori 端到端发送、Linux 真实 FFmpeg、
旧 FFmpeg 版本兼容下限、峰值 RSS／并发吞吐和 128 MiB 实际视频转码容量还需测量。
视频 128 MiB 守卫已有合成管道测试，数值上限与真实转码容量分别验证。
