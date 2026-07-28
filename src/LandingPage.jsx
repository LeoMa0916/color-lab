import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Database,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Menu,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  loginCloudAccount,
  registerCloudAccount,
  validatePassword,
  validateUsername,
} from "./cloudClient";
import "./landing.css";

const VIDEO_URL = "/media/color-lab-hero.mp4";

const NAV_ITEMS = [
  { label: "首页", action: "home" },
  { label: "能力", action: "capability" },
  { label: "隐私", action: "privacy" },
  { label: "联系方式", action: "contact" },
];

const PAGE_ORDER = NAV_ITEMS.map((item) => item.action);
const LEGAL_UPDATED_AT = "2026 年 7 月 28 日";

const PRIVACY_SECTIONS = [
  {
    title: "1. 适用范围与运营者",
    body: [
      "本政策适用于“调色室 Color Lab”网站及其参考图分析、仿色、预设导出、账户和云端同步功能。产品作者负责本产品中的个人信息处理，并通过本政策说明处理规则。",
      "如你不同意本政策，请不要注册、登录或启用云端保存；不登录时可否使用本地功能，以页面当时提供的能力为准。",
    ],
  },
  {
    title: "2. 我们处理的信息",
    body: [
      "账户信息：你设置的用户名，以及经过加盐和多轮派生后保存的密码摘要。服务器不保存可直接读取的明文密码。",
      "登录与安全信息：登录会话、是否选择“记住我”、会话到期时间、用于防止暴力尝试的网络地址摘要及必要安全记录。本机只保存不含登录令牌的会话提示；真实会话使用 HttpOnly Cookie。",
      "创作内容：你主动选择的参考照片、待调色照片、风格档案、导出设置和历史记录。浏览器内分析默认在本机完成；只有你明确使用云端上传或同步功能时，对应内容才会发送至云端。",
      "设备与运行信息：为诊断错误和保障兼容性，可能处理浏览器类型、系统类型、页面错误、接口状态和时间戳等必要技术信息。我们不以此建立广告画像。",
    ],
  },
  {
    title: "3. 使用目的与处理方式",
    body: [
      "上述信息仅用于创建和验证账户、跨设备恢复登录、保存你主动上传的内容、同步风格与历史、执行图片分析和导出、保障服务安全、定位故障及回复你的请求。",
      "我们不会出售个人信息，不把你的照片加入公共素材库，也不会将照片用于训练公开模型或广告定向，除非另行向你说明目的并取得必要授权。",
    ],
  },
  {
    title: "4. 本地处理、云端存储与跨境说明",
    body: [
      "图片解码、预览分析和大部分调色计算在你的浏览器内完成。模型文件可能按需下载并缓存在设备中。",
      "账户、会话、风格档案及你主动上传的文件由 Cloudflare 基础设施承载。实际存储或处理地点会随所使用的云服务配置而变化，可能位于中国大陆以外。启用云端功能前，请确认你有权上传相关图片，且能够接受相应的数据传输。",
      "我们会要求云服务提供方仅按提供基础设施、存储、安全和传输服务所需的范围处理数据。",
    ],
  },
  {
    title: "5. 保存期限",
    body: [
      "勾选“记住我”的登录会话最长保存 30 天；未勾选时通常在当前浏览器会话或 12 小时内失效。你可以随时退出登录使当前会话失效。",
      "云端照片、风格档案与历史记录保存至你主动删除、账户注销或服务停止所必需的合理期限。安全记录和服务日志按防护、审计与法律义务所需的最短期限保留。",
      "目前如需注销账户、批量导出或删除个人信息，请通过本政策末尾邮箱联系作者；完成身份核验后将在合理期限内处理。",
    ],
  },
  {
    title: "6. 共享、转让与公开披露",
    body: [
      "除提供云基础设施和安全服务所必需的服务商外，我们不会向第三方共享你的个人信息。发生合并、转让或运营主体变更时，将要求承接方继续受本政策约束，并按适用法律告知你。",
      "仅在取得你的单独同意，或为履行法定义务、响应有权机关依法提出的要求、保护用户或公众重大合法权益时，才可能进行必要披露。",
    ],
  },
  {
    title: "7. 你的权利",
    body: [
      "你可以访问、更正、复制或删除自己的云端内容，退出登录、停止上传，并通过邮箱请求查询、更正、删除个人信息、撤回同意或注销账户。",
      "撤回同意不影响撤回前基于同意进行的处理。删除浏览器 Cookie 或站点数据会使自动登录及本机保存的设置失效，但不会自动删除云端账户内容。",
    ],
  },
  {
    title: "8. 安全措施与风险",
    body: [
      "我们采用密码摘要、HttpOnly 会话 Cookie、同源校验、访问控制、速率限制及传输加密等措施降低风险。互联网和本地设备环境无法保证绝对安全，请妥善保管账户密码，不要上传无权处理或高度敏感的内容。",
      "若发生可能影响你权益的安全事件，我们会按适用法律采取补救措施，并通过站内提示、邮件或其他合理方式告知。",
    ],
  },
  {
    title: "9. 未成年人",
    body: [
      "本产品不专门面向未满 14 周岁的未成年人。未成年人应在监护人指导和同意下使用；如发现未经适当同意处理了未成年人信息，请联系我们删除。",
    ],
  },
  {
    title: "10. 更新与联系",
    body: [
      `本政策更新日期：${LEGAL_UPDATED_AT}。发生处理目的、信息种类或权利方式的重大变化时，我们会通过页面显著提示并在必要时重新取得同意。`,
      "隐私请求、账户注销、安全问题及投诉，请联系作者邮箱：mayiyao0916@gmail.com。为保护账户安全，我们可能要求提供必要的身份核验信息。",
    ],
  },
];

const TERMS_SECTIONS = [
  {
    title: "1. 协议接受",
    body: [
      `本用户协议更新于 ${LEGAL_UPDATED_AT}，适用于“调色室 Color Lab”网站。注册或登录前，你应完整阅读并主动勾选同意本协议与隐私政策。`,
      "如你代表他人、团队或机构使用，应确认已获得相应授权并有权接受本协议。",
    ],
  },
  {
    title: "2. 账户与登录",
    body: [
      "你应提供合法、可用的用户名并妥善保管密码，不得转让、出租账户或绕过访问控制。因你主动泄露凭据导致的风险由你承担；发现异常请及时退出并联系作者。",
      "“记住我”仅用于在同一站点和浏览器中延长登录状态。浏览器隐私设置、清理 Cookie、无痕模式、切换不同域名或安全策略可能使自动登录提前失效。",
    ],
  },
  {
    title: "3. 图片、风格与授权",
    body: [
      "你保留对上传图片和创作结果依法享有的权利，并保证对所上传内容具有处理、存储与导出的合法权限。不得上传违法内容、恶意文件或侵犯他人肖像权、隐私权、著作权及其他权益的内容。",
      "你授予本产品为提供分析、调色、存储、同步和导出功能所必需的有限处理权限；该权限不包含公开展示、出售或用于公开模型训练。",
    ],
  },
  {
    title: "4. 引擎结果与专业预设",
    body: [
      "参考驱动仿色属于计算近似，受原片曝光、场景光线、相机色彩、显示器和文件格式影响，不保证与任何相机厂商或商业软件的专有算法完全相同。",
      "XMP、CUBE 与 CLSTYLE 的承载能力不同：标准 CUBE 主要保存全局色彩映射，无法完整包含语义局部调整、纹理与随机颗粒；使用前应在目标软件中复核结果。",
    ],
  },
  {
    title: "5. 可接受使用",
    body: [
      "不得攻击、探测或干扰服务，不得批量注册、窃取他人内容、逆向绕过安全限制，或利用本产品制作、传播违法有害内容。合理的兼容性研究和对自己内容的导出不受影响。",
    ],
  },
  {
    title: "6. 服务变更与责任边界",
    body: [
      "产品仍在持续迭代，功能、文件兼容性和云端容量可能调整。我们会尽力维护可用性和数据安全，但不承诺服务永不中断；重要原片和预设应由你自行保留独立备份。",
      "在适用法律允许的范围内，对因设备、网络、第三方基础设施、错误操作或不兼容软件造成的间接损失不承担超出法定义务的责任；依法不得排除的责任不受本条限制。",
    ],
  },
  {
    title: "7. 终止、争议与联系",
    body: [
      "你可以停止使用并请求注销账户。严重违反本协议、危害服务或他人权益时，我们可采取限制功能、冻结会话或终止服务等必要措施，并按适用法律处理账户数据。",
      "本协议适用中华人民共和国可适用的法律。争议应优先友好协商；无法解决时，任何一方可依法向有管辖权的机构主张权利。联系邮箱：mayiyao0916@gmail.com。",
    ],
  },
];

function Field({
  autoComplete,
  autoFocus,
  error,
  icon: Icon,
  id,
  label,
  onChange,
  onToggleVisibility,
  placeholder,
  type = "text",
  value,
  visible,
}) {
  return (
    <label className="auth-field" htmlFor={id}>
      <span>{label}</span>
      <div className={error ? "auth-input-wrap has-error" : "auth-input-wrap"}>
        <Icon size={17} aria-hidden="true" />
        <input
          id={id}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          placeholder={placeholder}
          type={visible ? "text" : type}
          value={value}
          onChange={onChange}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {onToggleVisibility && (
          <button
            className="password-toggle"
            type="button"
            aria-label={visible ? "隐藏密码" : "显示密码"}
            onClick={onToggleVisibility}
          >
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        )}
      </div>
      {error && <small id={`${id}-error`}>{error}</small>}
    </label>
  );
}

function LegalDocumentDialog({ document, onClose, onSwitch }) {
  const isPrivacy = document === "privacy";
  const sections = isPrivacy ? PRIVACY_SECTIONS : TERMS_SECTIONS;
  const title = isPrivacy ? "隐私政策" : "用户协议";
  return (
    <div className="legal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="legal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span><FileText size={18} /></span>
            <div>
              <small>COLOR LAB LEGAL</small>
              <h2>{title}</h2>
            </div>
          </div>
          <button type="button" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button>
        </header>
        <nav aria-label="法律文件">
          <button
            type="button"
            className={!isPrivacy ? "active" : ""}
            onClick={() => onSwitch("terms")}
          >
            用户协议
          </button>
          <button
            type="button"
            className={isPrivacy ? "active" : ""}
            onClick={() => onSwitch("privacy")}
          >
            隐私政策
          </button>
          <small>更新于 {LEGAL_UPDATED_AT}</small>
        </nav>
        <article className="legal-document">
          <div className="legal-summary">
            <ShieldCheck size={18} />
            <p>
              {isPrivacy
                ? "照片默认在浏览器内分析；只有你主动启用云端功能时，所选内容才会上传。"
                : "请在注册或登录前完整阅读。勾选同意后，方可进入工作台。"}
            </p>
          </div>
          {sections.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              {section.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
        </article>
        <footer>
          <span>作者邮箱 mayiyao0916@gmail.com</span>
          <button type="button" onClick={onClose}>阅读完成</button>
        </footer>
      </section>
    </div>
  );
}

function AuthPanel({ mode, onAuthenticated, onModeChange, onOpenLegal }) {
  const usernameId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [remember, setRemember] = useState(true);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setErrors({});
    setMessage("");
    setPassword("");
    setConfirmation("");
  }, [mode]);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const nextErrors = {
      username: validateUsername(username),
      password: validatePassword(password),
      confirmation: mode === "register" && confirmation !== password
        ? "两次输入的密码不一致"
        : "",
      legal: acceptedTerms ? "" : "请先阅读并同意用户协议与隐私政策",
    };
    setErrors(nextErrors);
    setMessage("");
    if (Object.values(nextErrors).some(Boolean)) return;
    setSubmitting(true);
    try {
      const session = mode === "register"
        ? await registerCloudAccount({
          username,
          password,
          remember,
          acceptedTerms,
        })
        : await loginCloudAccount({
          username,
          password,
          remember,
          acceptedTerms,
        });
      onAuthenticated(session);
    } catch (error) {
      setMessage(error?.message || "暂时无法完成登录，请稍后重试");
      if (["wrong-password", "invalid-credentials"].includes(error?.code)) {
        setErrors({ password: error.message });
      }
      if (["account-not-found", "username-exists", "invalid-username"].includes(error?.code)) {
        setErrors({ username: error.message });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-panel" aria-label={mode === "login" ? "登录调色室" : "注册调色室账户"}>
      <div className="auth-panel-glow" aria-hidden="true" />
      <div className="auth-heading">
        <span className="auth-mark"><Sparkles size={18} /></span>
        <div>
          <p>COLOR LAB CLOUD</p>
          <h2>{mode === "login" ? "继续你的创作" : "创建云端账户"}</h2>
        </div>
      </div>

      <div className="auth-tabs" role="tablist" aria-label="账户方式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          className={mode === "login" ? "active" : ""}
          data-testid="auth-login-tab"
          onClick={() => onModeChange("login")}
        >
          登录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "register"}
          className={mode === "register" ? "active" : ""}
          data-testid="auth-register-tab"
          onClick={() => onModeChange("register")}
        >
          注册
        </button>
      </div>

      <form className="auth-form" onSubmit={submit} noValidate>
        <Field
          id={usernameId}
          label="用户名"
          icon={UserRound}
          value={username}
          error={errors.username}
          autoComplete="username"
          autoFocus
          placeholder="3–24 个字符"
          onChange={(event) => {
            setUsername(event.target.value);
            setErrors((value) => ({ ...value, username: "" }));
          }}
        />
        <Field
          id={passwordId}
          label="密码"
          icon={LockKeyhole}
          value={password}
          error={errors.password}
          type="password"
          visible={showPassword}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          placeholder="至少 8 位，包含文字和数字"
          onToggleVisibility={() => setShowPassword((value) => !value)}
          onChange={(event) => {
            setPassword(event.target.value);
            setErrors((value) => ({ ...value, password: "" }));
          }}
        />
        {mode === "register" && (
          <Field
            id={confirmId}
            label="确认密码"
            icon={CheckCircle2}
            value={confirmation}
            error={errors.confirmation}
            type="password"
            visible={showConfirmation}
            autoComplete="new-password"
            placeholder="再次输入密码"
            onToggleVisibility={() => setShowConfirmation((value) => !value)}
            onChange={(event) => {
              setConfirmation(event.target.value);
              setErrors((value) => ({ ...value, confirmation: "" }));
            }}
          />
        )}

        <label className="remember-row">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span className="remember-check"><CheckCircle2 size={13} /></span>
          <span>
            记住我
            <small>在这台设备保持 30 天登录状态</small>
          </span>
        </label>

        <div className={errors.legal ? "legal-consent-row has-error" : "legal-consent-row"}>
          <label>
            <input
              type="checkbox"
              checked={acceptedTerms}
              data-testid="legal-consent"
              onChange={(event) => {
                setAcceptedTerms(event.target.checked);
                setErrors((value) => ({ ...value, legal: "" }));
              }}
            />
            <span className="remember-check"><CheckCircle2 size={13} /></span>
            <span>我已阅读并同意</span>
          </label>
          <span>
            <button type="button" onClick={() => onOpenLegal("terms")}>《用户协议》</button>
            与
            <button type="button" onClick={() => onOpenLegal("privacy")}>《隐私政策》</button>
          </span>
          {errors.legal && <small role="alert">{errors.legal}</small>}
        </div>

        {message && <p className="auth-message" role="alert">{message}</p>}

        <button
          className="auth-submit"
          type="submit"
          disabled={submitting}
          data-testid="auth-submit"
        >
          {submitting
            ? <><LoaderCircle className="spin" size={18} />正在验证</>
            : mode === "login"
              ? <>登录并进入工作台<ArrowRight size={17} /></>
              : <><UserPlus size={17} />注册并进入工作台</>}
        </button>
      </form>

      <div className="local-security-note">
        <ShieldCheck size={15} />
        <span>账户、云端照片与历史记录仅对当前账号可见，可在不同设备同步。</span>
      </div>
    </section>
  );
}

function HomeView({ onNavigate }) {
  return (
    <div className="page-layout home-view">
      <section className="page-lead">
        <p className="hero-badge">Reference-driven color intelligence</p>
        <h1 className="hero-title">
          让影像的光<br />
          照进你的照片。
        </h1>
      </section>
      <section className="landing-bottom">
        <p className="hero-description">
          从样片读取影调、色彩、光线与质感，让 Color Engine 4 建立属于你的可编辑风格。
        </p>
        <button className="hero-explore" type="button" onClick={() => onNavigate("capability")}>
          探索色彩引擎 <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}

function CapabilityView({ onNavigate }) {
  const features = [
    { icon: Aperture, label: "语义仿色", body: "区分肤色、天空、植物与中性色，避免全局匹配造成串色。" },
    { icon: Palette, label: "七色色彩", body: "独立分析红、橙、黄、绿、青、蓝、紫的色相、明度与纯度。" },
    { icon: SlidersHorizontal, label: "实时控制", body: "基本参数、RGB 曲线、颗粒与质感在画面上即时反馈。" },
    { icon: Layers3, label: "RAW 与批量", body: "支持主流 RAW、多个目标照片以及原尺寸导出。" },
    { icon: FileText, label: "专业预设导出", body: "直接导出 Lightroom / Camera Raw XMP、33³ CUBE LUT 与完整 CLSTYLE 风格档案。" },
  ];
  return (
    <div className="page-layout detail-view">
      <section className="detail-copy">
        <p className="page-kicker">COLOR ENGINE 4</p>
        <h1>读取的不只是颜色，<br />还有照片的光。</h1>
        <p>风格被拆成影调、光源、语义区域、三维色彩关系与多尺度质感，再以可编辑参数重新组合。</p>
        <button className="page-inline-action" type="button" onClick={() => onNavigate("privacy")}>
          了解数据边界 <ArrowRight size={16} />
        </button>
      </section>
      <div className="capability-list" aria-label="色彩引擎能力">
        {features.map(({ icon: Icon, label, body }, index) => (
          <article key={label}>
            <span><Icon size={18} /></span>
            <small>0{index + 1}</small>
            <h2>{label}</h2>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function PrivacyView({ onNavigate, onOpenLegal }) {
  const protections = [
    { icon: LockKeyhole, title: "私有访问", body: "云端对象不提供公开地址，读取、下载与删除均校验当前账号。" },
    { icon: Database, title: "跨设备同步", body: "账户、照片索引、历史记录与风格档案跟随同一账号。" },
    { icon: ImageIcon, title: "原图控制", body: "本地分析仍在浏览器完成；只有用户选择上传的照片进入云端。" },
  ];
  return (
    <div className="page-layout detail-view privacy-view">
      <section className="detail-copy">
        <p className="page-kicker">PRIVATE BY ACCOUNT</p>
        <h1>可以同步，<br />不等于公开。</h1>
        <p>登录后可把照片和创作历史保存到云端。每个文件都归属账号，不进入公共图库，也不会被其他用户检索。</p>
        <div className="privacy-actions">
          <button className="page-inline-action" type="button" onClick={() => onOpenLegal("privacy")}>
            阅读完整隐私政策 <FileText size={16} />
          </button>
          <button className="page-text-action" type="button" onClick={() => onNavigate("contact")}>
            联系与反馈 <ArrowRight size={16} />
          </button>
        </div>
      </section>
      <div className="privacy-stack">
        <div className="privacy-orbit" aria-hidden="true">
          <span><Cloud size={28} /></span>
          <i />
          <b />
        </div>
        {protections.map(({ icon: Icon, title, body }) => (
          <article key={title}>
            <Icon size={18} />
            <div>
              <h2>{title}</h2>
              <p>{body}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ContactView({ onNavigate }) {
  return (
    <div className="page-layout contact-view">
      <section className="contact-copy">
        <p className="page-kicker">REACH COLOR LAB</p>
        <h1>让下一次更新，<br />回应真实的创作。</h1>
        <p>功能建议、错误样片、相机色彩反馈与隐私请求，可以直接发送至作者邮箱。发送原始照片前，请先确认其中不含无关人员的敏感信息。</p>
      </section>
      <section className="contact-actions" aria-label="联系方式">
        <a href="mailto:mayiyao0916@gmail.com">
          <span><Mail size={21} /></span>
          <div>
            <small>AUTHOR EMAIL</small>
            <strong>mayiyao0916@gmail.com</strong>
          </div>
          <ArrowRight size={17} />
        </a>
        <a href="mailto:mayiyao0916@gmail.com?subject=Color%20Lab%20功能建议">
          <span><Sparkles size={21} /></span>
          <div>
            <small>FEEDBACK</small>
            <strong>发送功能建议或样片反馈</strong>
          </div>
          <ArrowRight size={17} />
        </a>
        <button type="button" onClick={() => onNavigate("home")}>
          <ArrowLeft size={16} /> 返回首页
        </button>
      </section>
    </div>
  );
}

function PageContent({ page, onNavigate, onOpenLegal }) {
  if (page === "capability") return <CapabilityView onNavigate={onNavigate} />;
  if (page === "privacy") {
    return <PrivacyView onNavigate={onNavigate} onOpenLegal={onOpenLegal} />;
  }
  if (page === "contact") return <ContactView onNavigate={onNavigate} />;
  return <HomeView onNavigate={onNavigate} />;
}

export function LandingPage({ onAuthenticated }) {
  const transitionTimer = useRef(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [legalDocument, setLegalDocument] = useState(null);
  const [activePage, setActivePage] = useState("home");
  const [transition, setTransition] = useState(null);

  useEffect(() => () => clearTimeout(transitionTimer.current), []);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        if (legalDocument) setLegalDocument(null);
        else setAuthOpen(false);
        setMobileMenuOpen(false);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [legalDocument]);

  function openAuth(mode = "login") {
    setAuthMode(mode);
    setAuthOpen(true);
    setMobileMenuOpen(false);
  }

  function navigate(nextPage) {
    if (nextPage === activePage) {
      setMobileMenuOpen(false);
      return;
    }
    const fromIndex = PAGE_ORDER.indexOf(activePage);
    const toIndex = PAGE_ORDER.indexOf(nextPage);
    const direction = toIndex > fromIndex ? "forward" : "backward";
    clearTimeout(transitionTimer.current);
    setTransition({
      from: activePage,
      to: nextPage,
      direction,
      id: `${activePage}-${nextPage}-${Date.now()}`,
    });
    setActivePage(nextPage);
    setMobileMenuOpen(false);
    transitionTimer.current = setTimeout(() => setTransition(null), 620);
  }

  return (
    <main id="home" className={`landing-root page-${activePage} relative h-screen w-full overflow-hidden bg-black font-geist`}>
      <video
        className="landing-video absolute h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
      >
        <source src={VIDEO_URL} type="video/mp4" />
      </video>
      <div className="landing-scrim absolute inset-0" aria-hidden="true" />
      <div className="landing-orb landing-orb-one" aria-hidden="true" />
      <div className="landing-orb landing-orb-two" aria-hidden="true" />

      <nav className="landing-nav relative z-30 flex items-center justify-between px-6 py-5 md:px-12 lg:px-16" aria-label="主导航">
        <div className="flex items-center gap-10">
          <button className="landing-brand text-lg font-semibold tracking-tight text-white sm:text-xl" type="button" onClick={() => navigate("home")}>
            <span className="brand-lens" aria-hidden="true" />
            <span>调色室</span>
            <small>Color Lab</small>
          </button>
          <div className="landing-desktop-nav hidden items-center gap-7 md:flex">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.action}
                type="button"
                aria-current={activePage === item.action ? "page" : undefined}
                className="text-sm text-white/80 transition-colors hover:text-white"
                onClick={() => navigate(item.action)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <button
          className="landing-login-button hidden rounded-lg bg-white px-5 py-2 text-sm font-medium text-black transition-transform hover:scale-105 md:inline-flex"
          type="button"
          onClick={() => openAuth("login")}
        >
          登录工作台 <ArrowRight size={15} />
        </button>

        <button
          className="mobile-menu-toggle relative z-50 grid h-10 w-10 place-items-center md:hidden"
          type="button"
          aria-label={mobileMenuOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen((value) => !value)}
        >
          <Menu className={mobileMenuOpen ? "menu-icon out" : "menu-icon"} size={21} />
          <X className={mobileMenuOpen ? "close-icon in" : "close-icon"} size={21} />
        </button>
      </nav>

      <div className={mobileMenuOpen ? "mobile-menu open" : "mobile-menu"} aria-hidden={!mobileMenuOpen}>
        <div className="mobile-menu-inner">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.action}
              type="button"
              aria-current={activePage === item.action ? "page" : undefined}
              onClick={() => navigate(item.action)}
            >
              {item.label}
            </button>
          ))}
          <button className="mobile-menu-cta" type="button" onClick={() => openAuth("login")}>
            登录工作台
          </button>
        </div>
      </div>

      <div className="landing-scenes">
        {transition ? (
          <div className={`scene-transition ${transition.direction}`} key={transition.id}>
            <div className="landing-scene scene-from" aria-hidden="true">
              <PageContent page={transition.from} onNavigate={navigate} onOpenLegal={setLegalDocument} />
            </div>
            <div className="landing-scene scene-to">
              <PageContent page={transition.to} onNavigate={navigate} onOpenLegal={setLegalDocument} />
            </div>
          </div>
        ) : (
          <div className="landing-scene scene-current">
            <PageContent page={activePage} onNavigate={navigate} onOpenLegal={setLegalDocument} />
          </div>
        )}
      </div>

      {authOpen && (
        <div className="auth-modal-layer">
          <button
            className="auth-modal-backdrop"
            aria-label="关闭账户窗口"
            type="button"
            onClick={() => setAuthOpen(false)}
          />
          <aside className="auth-shell open" role="dialog" aria-modal="true" aria-label="Color Lab 账户">
            <button className="auth-modal-close" type="button" aria-label="关闭账户窗口" onClick={() => setAuthOpen(false)}>
              <X size={18} />
            </button>
            <AuthPanel
              mode={authMode}
              onModeChange={setAuthMode}
              onAuthenticated={onAuthenticated}
              onOpenLegal={setLegalDocument}
            />
          </aside>
        </div>
      )}
      {legalDocument && (
        <LegalDocumentDialog
          document={legalDocument}
          onClose={() => setLegalDocument(null)}
          onSwitch={setLegalDocument}
        />
      )}
    </main>
  );
}
