/**
 * 字体栈。
 *
 * 为什么不加载字体文件：
 * 渲染在本机 Windows 的无头 Chromium 中进行，系统字体可直接被 Chromium 解析，
 * 因此无需把字体文件塞进仓库，也规避了两个真实风险——
 * 1) `@remotion/google-fonts` 在渲染期去 Google Fonts 拉字体，国内必然慢或直接失败；
 * 2) 中文字体常用的 `.ttc`（TrueType Collection，msyh.ttc）在浏览器 Web Font 机制下
 *    并不保证可解析，转成 woff2 又会体积巨大。
 *
 * 字幕的字体由 ffmpeg 侧 `burnSubtitles` 用 `C:/Windows/Fonts/msyh.ttc` 烧录，
 * 与此处互不影响，两条链路字体口径保持一致（微软雅黑优先）。
 */

/** 正文 / 字幕：优先微软雅黑，兼容 macOS 与 Linux 兜底。 */
export const FONT_SANS =
  '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

/** 标题 / 片尾落版：同一套中文字体栈，避免中西文割裂。 */
export const FONT_DISPLAY = FONT_SANS;

/** 等宽（调试信息、序号等）。 */
export const FONT_MONO =
  '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace';
