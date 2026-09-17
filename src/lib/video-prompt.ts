/**
 * Video script prompt builder for OpenMontage Remotion rendering.
 *
 * Instead of generating a text plan, this prompt asks OpenClaw to produce
 * a structured JSON object that matches the Remotion Explainer composition's
 * props schema. The JSON is then rendered to an actual MP4 video file.
 */

const CUT_TYPES = [
  { type: "hero_title",     desc: "标题页（text + subtitle）" },
  { type: "stat_card",      desc: "大数字统计（stat + subtitle + accentColor）" },
  { type: "bar_chart",      desc: "柱状图（title + chartData[{label,value}] + chartColors）" },
  { type: "pie_chart",      desc: "饼图（title + chartData + chartColors + donut + centerLabel + centerValue + showLegend）" },
  { type: "text_card",      desc: "文本卡片（text + subtitle + color）" },
  { type: "callout",         desc: "提示框（title + text + callout_type: tip/warning/info）" },
  { type: "comparison",     desc: "左右对比（title + leftLabel + leftValue + rightLabel + rightValue）" },
  { type: "progress_bar",   desc: "进度条（title + progress: 0~1 + progressLabel + progressColor）" },
  { type: "kpi_grid",       desc: "KPI网格（title + chartData[{label,value,change,suffix}] + columns）" }
];

const THEMES = [
  { id: "flat-motion-graphics", desc: "深色科技风（深蓝底 #0F172A + 紫色主色）" },
  { id: "clean-professional",   desc: "浅色专业风（白底 + 蓝色主色）" },
  { id: "minimalist-diagram",   desc: "极简图表风（浅灰底 + 红色点缀）" },
  { id: "anime-ghibli",          desc: "暖色动漫风（深色底 + 暖金色调）" }
];

export function buildVideoScriptPrompt(userContent: string, conversationContext: string): string {
  const cutTypeList = CUT_TYPES.map((c) => `  - ${c.type}：${c.desc}`).join("\n");
  const themeList = THEMES.map((t) => `  - ${t.id}：${t.desc}`).join("\n");

  return [
    "你是一个视频脚本设计师。你的任务是根据用户的需求，生成一个可以直接渲染为 MP4 视频的 JSON 脚本。",
    "这个 JSON 脚本将被 Remotion 渲染引擎读取并渲染为真实的视频文件。",
    "",
    "## 视频技术规格",
    "- 分辨率：1920x1080",
    "- 帧率：30fps",
    "- 编码：H.264 / MP4",
    "- 时长：15~30 秒（5~8 个场景）",
    "",
    "## 可用场景类型（cut.type）",
    "",
    cutTypeList,
    "",
    "## 可用主题（theme）",
    "",
    themeList,
    "",
    "## 旁白文本（narration）",
    "",
    "你必须生成一段旁白文本，用于 AI 配音。要求：",
    "1. narration 是一段纯文本，不要包含场景编号或标记",
    "2. 旁白内容是对视频画面的解说，不是场景文字的重复",
    "3. 旁白时长应与视频总时长接近（每秒约 4 个字）",
    "4. 语气自然、口语化，适合朗读",
    "5. 中文旁白",
    "",
    "## 场景画面描述（visual_prompt + search_keywords）",
    "",
    "每个场景必须包含以下两个字段：",
    "",
    "### visual_prompt（AI 生成画面描述）",
    "1. 用英文描述画面内容（AI 图片生成对英文效果更好）",
    "2. 描述要具体、有画面感，例如：'a golden retriever running on a sunny beach with waves crashing'",
    "3. 包含风格关键词：cinematic, high quality, professional photography",
    "4. 不要描述文字或图表，只描述视觉画面",
    "",
    "### search_keywords（免费素材搜索关键词）",
    "1. 用简短英文关键词描述场景画面，用于在 Wikimedia Commons / NASA / Archive.org 等免费素材库搜索真实素材",
    "2. 关键词要具体、可搜索，例如：'golden retriever beach'、'city skyline sunset'、'space galaxy'",
    "3. 用空格分隔的关键词短语，不要用句子",
    "4. 优先用名词+场景的组合，如 'mountain peak snow'、'ocean waves aerial'",
    "5. 如果场景是抽象概念（如数据图表），用相关实体关键词，如 'circuit board closeup'、'abstract data visualization'",
    "6. 系统会优先用 search_keywords 搜索免费真实素材，找不到再用 visual_prompt 生成 AI 图片",
    "",
    "## JSON 输出格式",
    "",
    "你必须输出一个合法的 JSON 对象，格式如下：",
    "",
    "```json",
    "{",
    '  "theme": "flat-motion-graphics",',
    '  "narration": "这是一段旁白文本，用于AI配音。它应该自然流畅，适合朗读，内容是对视频画面的解说...",',
    '  "cuts": [',
    "    {",
    '      "id": "scene-1",',
    '      "source": "",',
    '      "search_keywords": "futuristic city skyline sunset",',
    '      "visual_prompt": "a futuristic city skyline at sunset with golden light, cinematic, high quality, professional photography",',
    '      "type": "hero_title",',
    '      "in_seconds": 0,',
    '      "out_seconds": 4,',
    '      "text": "大标题文字",',
    '      "subtitle": "副标题文字",',
    '      "backgroundColor": "#0F172A"',
    "    },",
    "    {",
    '      "id": "scene-2",',
    '      "source": "",',
    '      "search_keywords": "digital brain circuit",',
    '      "visual_prompt": "a close-up of a glowing digital brain made of circuit patterns, cinematic, high quality",',
    '      "type": "stat_card",',
    '      "in_seconds": 4,',
    '      "out_seconds": 8,',
    '      "stat": "8.1B",',
    '      "subtitle": "描述文字",',
    '      "accentColor": "#22D3EE",',
    '      "backgroundColor": "#0F172A"',
    "    },",
    "    {",
    '      "id": "scene-3",',
    '      "source": "",',
    '      "search_keywords": "bar chart data visualization",',
    '      "visual_prompt": "abstract 3D bar chart floating in dark space with glowing neon data points, cinematic",',
    '      "type": "bar_chart",',
    '      "in_seconds": 8,',
    '      "out_seconds": 14,',
    '      "title": "柱状图标题",',
    '      "chartData": [',
    '        { "label": "A", "value": 42 },',
    '        { "label": "B", "value": 18 }',
    "      ],",
    '      "chartColors": ["#22D3EE", "#A78BFA"],',
    '      "showGrid": true,',
    '      "showValues": true,',
    '      "backgroundColor": "#0F172A"',
    "    },",
    "    {",
    '      "id": "scene-4",',
    '      "source": "",',
    '      "search_keywords": "mountain peak hiker summit",',
    '      "visual_prompt": "a person standing on a mountain peak looking at a vast horizon, inspiring, cinematic",',
    '      "type": "text_card",',
    '      "in_seconds": 14,',
    '      "out_seconds": 18,',
    '      "text": "结尾文案",',
    '      "subtitle": "副文案",',
    '      "color": "#F8FAFC",',
    '      "backgroundColor": "#0F172A"',
    "    }",
    "  ],",
    '  "overlays": [',
    "    {",
    '      "type": "section_title",',
    '      "in_seconds": 4.2,',
    '      "out_seconds": 7.0,',
    '      "text": "小节标题",',
    '      "subtitle": "小节副标题",',
    '      "accentColor": "#22D3EE"',
    "    }",
    "  ],",
    '  "captions": [],',
    '  "audio": {}',
    "}",
    "```",
    "",
    "## 设计规则",
    "",
    "1. 每个场景的 out_seconds = 下一个场景的 in_seconds（时间线连续）",
    "2. 第一个场景的 in_seconds 必须为 0",
    "3. 最后一个场景之后留 1 秒余量用于淡出",
    "4. 每个场景时长 3~5 秒",
    "5. 场景类型不要连续重复超过 2 次",
    "6. 颜色要协调：背景色统一，accentColor 用主题中的 chartColors",
    "7. 所有文字使用中文",
    "8. 数据要合理、有说服力",
    "9. overlays 的 in/out 时间要落在对应 cut 的时间范围内",
    "10. narration 旁白文本的长度（字符数）应约为视频总秒数 × 4",
    "",
    "## 重要：只输出 JSON",
    "",
    "不要输出任何解释性文字、Markdown 标题或说明。",
    "只输出一个合法的 JSON 对象，以 ```json 开头，以 ``` 结尾。",
    "JSON 必须可以被 JSON.parse 直接解析。",
    "",
    "## 历史会话上下文",
    "",
    conversationContext || "暂无历史会话。",
    "",
    "## 用户需求",
    "",
    userContent,
    ""
  ].join("\n");
}

/**
 * Extract the JSON object from OpenClaw's response.
 * The model is instructed to wrap it in ```json ... ```,
 * but we also handle raw JSON as a fallback.
 */
export function extractRemotionProps(rawContent: string): Record<string, unknown> | null {
  // Try to find a ```json ... ``` block
  const jsonBlockMatch = rawContent.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try to find any ``` ... ``` block
  const genericBlockMatch = rawContent.match(/```\s*\n([\s\S]*?)\n```/);
  if (genericBlockMatch) {
    try {
      return JSON.parse(genericBlockMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try parsing the entire content as JSON
  try {
    const parsed = JSON.parse(rawContent.trim());
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.cuts)) {
      return parsed;
    }
  } catch {
    // fall through
  }

  // Try to find the first { ... } that looks like a Remotion props object
  const objectMatch = rawContent.match(/\{[\s\S]*"cuts"[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // fall through
    }
  }

  return null;
}
