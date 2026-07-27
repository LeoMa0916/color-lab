---
name: "调色室 / Color Lab"
description: "以暗房液态镜片为意象的专业本地仿色工具"
colors:
  obsidian-background: "#06080a"
  studio-surface: "#121518"
  porcelain-text: "#f5f5f7"
  quiet-silver: "#9a9da3"
  optical-blue: "#3f74ff"
  focus-blue: "#79a2ff"
  signal-green: "#62dca1"
  glass-fill: "rgba(38, 42, 47, .58)"
  glass-edge: "rgba(255, 255, 255, .20)"
typography:
  display:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(3rem, 5.5vw, 5rem)"
    fontWeight: 500
    lineHeight: 1.02
    letterSpacing: "-0.05em"
  title:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "21px"
    fontWeight: 680
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Geist, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.35
rounded:
  control: "15px"
  panel: "20px"
  hero-panel: "32px"
  capsule: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.porcelain-text}"
    textColor: "{colors.obsidian-background}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.glass-fill}"
    textColor: "{colors.porcelain-text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  input:
    backgroundColor: "rgba(7, 11, 16, .58)"
    textColor: "{colors.porcelain-text}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "46px"
  glass-panel:
    backgroundColor: "{colors.glass-fill}"
    textColor: "{colors.porcelain-text}"
    rounded: "{rounded.hero-panel}"
    padding: "26px"
---

# Design System: 调色室 / Color Lab

## Overview

**Creative North Star: "暗房里的液态镜片"**

界面像一枚悬浮在暗房中的光学镜片：冷静、克制、透光，但不会牺牲专业工具所需的清晰度和密度。一级页面用影像、留白和一块高层级账户玻璃建立品牌气氛；工作台则把同一种材质压缩为更紧凑的控制表面。

液态玻璃是信息层级和交互状态，不是覆盖所有内容的装饰。玻璃表面必须同时具备可辨认的轮廓、高光边缘、局部饱和与柔和偏移阴影；照片、曲线和直方图始终比材质效果更重要。

**Key Characteristics:**

- 深色暗房底色与冷蓝光学强调色。
- 不对称高光、柔和折射和清晰边缘共同定义玻璃。
- 品牌首屏宽松，专业工作台紧凑。
- 动效用于解释进入、展开和处理中状态，并尊重减少动态效果设置。

## Colors

颜色以黑曜石暗底、瓷白文字和少量光学蓝为主，绿色只用于明确的完成或安全状态。

### Primary

- **光学蓝:** 用于主要调色操作、焦点和引擎身份；任何单屏都应控制其面积，让强调保持稀缺。
- **瓷白:** 用于高优先级文字和一级主按钮，形成类似发光陶瓷或高透玻璃的视觉锚点。

### Secondary

- **信号绿:** 仅用于成功、可用或安全状态，不承担装饰角色。

### Neutral

- **黑曜石背景:** 承载视频降级背景和编辑器画布。
- **暗房表面:** 用于不透明度较高的工具区底层。
- **静音银:** 用于次级说明、元数据和辅助状态。
- **玻璃填充与玻璃边缘:** 共同构成浮层、面板和导航材质。

**The Rare Blue Rule.** 光学蓝只标记当前主操作、活动状态或关键数据，不把整个界面染蓝。

## Typography

**Display Font:** Geist（系统无衬线回退）
**Body Font:** Geist（系统无衬线回退）

**Character:** 几何但不过度技术化，中文由系统字体自然补位；标题以紧凑字距形成影像品牌感，控件保持易读。

### Hierarchy

- **Display:** 中等字重、紧凑行高，仅用于一级页面的单一主标题。
- **Title:** 较高字重，用于品牌、面板标题和当前任务。
- **Body:** 常规字重和舒展行高，用于解释工作流与隐私边界。
- **Label:** 中等字重，用于字段、参数和状态；数据数字采用等宽数字特性。

**The One Hero Rule.** 每个视图只有一个展示级标题，工作台不复用首屏的夸张字号。

## Layout

一级页面在桌面端采用左侧品牌叙事、右侧固定账户玻璃舱的非对称构图，并保持在单个动态视口内。宽度低于 900px 时，账户表单改为可关闭的底部玻璃面板；导航折叠为全屏菜单。工作台在宽屏维持参考区、画布区、检查器三区结构，在平板隐藏非关键列，在手机按操作顺序纵向排列。

间距遵循 4px/8px 节奏。触控目标至少 44px，固定层避开手机安全区域，任何断点不得产生页面级横向滚动。

## Elevation & Depth

深度由混合策略建立：半透明填充负责区分层级，`backdrop-filter` 负责光学融合，顶部内高光描述材质厚度，向下偏移的扩散阴影说明悬浮距离。模态账户面板使用更高饱和与更强轮廓，编辑器常驻面板则更克制。

### Shadow Vocabulary

- **光学边缘:** 一像素内高光，应用于玻璃面板与主按钮。
- **环境悬浮:** 低透明度的大半径黑色阴影，应用于一级账户面板。
- **工具分层:** 小半径偏移阴影，应用于工作台导航和控件组。

**The Optical Evidence Rule.** 玻璃必须同时具备边缘、透射和阴影证据；只有模糊或只有透明度都不算完成的玻璃。

## Shapes

主控件使用 15px 圆角，工作台面板使用约 20px 圆角，一级账户玻璃舱使用 32px 圆角。胶囊只用于状态、标签和分段控制。品牌镜片标记允许轻微不规则轮廓，其余组件保持稳定几何形状。

## Components

### Buttons

- **Shape:** 触感清晰的柔和矩形，主按钮高度 48px，其他触控按钮不小于 44px。
- **Primary:** 瓷白表面、暗色文字、细高光边缘；用于每个界面的唯一主行动。
- **Hover / Focus:** 悬停仅有轻微位移或高光变化；键盘焦点使用可见的光学蓝双像素轮廓。
- **Secondary / Ghost:** 使用低透明玻璃或完全透明文字按钮，层级不得与主按钮竞争。

### Chips

- **Style:** 小字号、胶囊形、玻璃底或蓝色低透明底，用于引擎版本、模式和状态。
- **State:** 选中状态同时改变填充与文字对比，不能只依赖颜色差异。

### Cards / Containers

- **Corner Style:** 工作台 20px，一级账户舱 32px。
- **Background:** 暗色半透明玻璃，必要时叠加方向性渐变。
- **Shadow Strategy:** 遵循光学边缘与环境悬浮词汇。
- **Border:** 始终保留可见但克制的白色半透明轮廓。
- **Internal Padding:** 紧凑工作台 12–16px，一级账户舱 24–26px。

### Inputs / Fields

- **Style:** 46px 高、显式标签、暗色半透明底、15px 圆角和左侧 Lucide 图标。
- **Focus:** 光学蓝边缘与外轮廓，不改变布局尺寸。
- **Error / Disabled:** 错误在字段下就近出现并提供恢复方向；提交中禁用按钮并显示旋转进度。

### Navigation

桌面导航与视频融为一层，不额外铺设厚重背景；移动端使用可关闭的全屏深色玻璃菜单。工作台顶栏是紧凑悬浮玻璃条，账户退出与导出保持空间分离。

### Account Glass Chamber

一级账户舱是系统的签名组件：不对称内部光、32px 圆角、增强饱和模糊、顶部高光和独立滚动共同确保视频复杂时表单仍清晰。

## Do's and Don'ts

### Do:

- **Do** 用真实内容、视频和照片为玻璃提供折射背景。
- **Do** 保持表单显式标签、可见焦点、就近错误和提交状态。
- **Do** 在视频或网络资源不可用时保留完整的静态暗房背景。
- **Do** 在工作台优先保证直方图、曲线、图片与参数的可读性。

### Don't:

- **Don't** 把每一段文字都放进独立玻璃卡片。
- **Don't** 使用无边界的低透明表面，让文字与背景互相干扰。
- **Don't** 用装饰动画掩盖分析、导出或登录的真实进度。
- **Don't** 使用 Emoji 充当结构图标，或混用不同描边语言。
