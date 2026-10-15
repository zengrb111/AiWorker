/**
 * 字体栈 —— **只使用免费可商用字体**。
 *
 * ## 授权依据
 *
 * | 字体 | 授权 | 说明 |
 * | --- | --- | --- |
 * | Noto Sans SC（思源黑体） | **SIL OFL 1.1** | Google 出品，可自由商用、修改、再分发，唯一限制是不可单独售卖字体文件本身 |
 * | JetBrains Mono | **SIL OFL 1.1** | JetBrains 出品 |
 * | Cascadia Mono | **SIL OFL 1.1** | 微软出品，开源 |
 *
 * ## 为什么不能用系统常见中文字体
 *
 * 这些在 Windows/macOS 上默认存在的字体**都不是免费可商用**：
 * - `Microsoft YaHei`（微软雅黑）—— 方正授权，商用需单独付费，是最常踩的坑
 * - `SimHei`（黑体）/ `SimSun`（宋体）—— 中易授权
 * - `PingFang SC`（苹方）/ `Hiragino Sans GB` —— 苹果、字猎工房专有
 *
 * 视频成片属于商业制品，烧录/嵌入这些字体会构成侵权。因此这里**不把它们放进字体栈**，
 * 即使系统装了也不用 —— 避免有人误加回来。
 *
 * ## 关于不加载字体文件
 *
 * 渲染在本机 Windows 的无头 Chromium 中进行，系统字体可被直接解析，
 * 因此无需把字体文件塞进 Remotion 的 public 目录（那样每次渲染都要 bundle 一次）。
 * 仓库里那份 `assets/fonts/NotoSansSC-VF.ttf`（约 17MB）供 ffmpeg 侧
 * （字幕烧录、片头标题）与封面生成使用，那两处必须用文件路径，无法走字体栈。
 *
 * 前提：**渲染机需安装 Noto Sans SC**。Windows 10/11 简体中文版默认自带
 * （`C:\Windows\Fonts\NotoSansSC-VF.ttf`）；Linux 服务器需自行安装
 * `fonts-noto-cjk`。没装时 Chromium 会 fallback 到默认 sans-serif，
 * 观感会变但不会侵权（fallback 到的仍是系统字体，风险由系统字体本身决定）。
 */

/**
 * 正文 / 字幕。
 *
 * 刻意**不把任何非免费可商用字体放进兜底链**（微软雅黑、苹方等一律不收）。
 * 宁可 fallback 到 generic `sans-serif`，也不要让「合规」在兜底路径上失守 ——
 * 那种失守最隐蔽，因为正常路径上看起来完全正常。
 */
export const FONT_SANS =
  '"Noto Sans SC", "Source Han Sans SC", "Noto Sans CJK SC", "WenQuanYi Zen Hei", sans-serif';

/**
 * 标题 / 片尾落版。
 *
 * 刻意与正文同一套字体：中文场景下另配一套标题字体（如衬线）容易与正文割裂，
 * 且免费可商用的中文衬线选择有限。差异靠字号/字重/颜色表达。
 */
export const FONT_DISPLAY = FONT_SANS;

/** 等宽（调试信息、序号、代码片段）。三个都是 SIL OFL 1.1。 */
export const FONT_MONO =
  '"JetBrains Mono", "Cascadia Mono", "Courier New", Consolas, monospace';
