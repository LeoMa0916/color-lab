import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Database,
  Eye,
  EyeOff,
  Github,
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

function AuthPanel({ mode, onAuthenticated, onModeChange }) {
  const usernameId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [remember, setRemember] = useState(true);
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
    };
    setErrors(nextErrors);
    setMessage("");
    if (Object.values(nextErrors).some(Boolean)) return;
    setSubmitting(true);
    try {
      const session = mode === "register"
        ? await registerCloudAccount({ username, password, remember })
        : await loginCloudAccount({ username, password, remember });
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

function PrivacyView({ onNavigate }) {
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
        <button className="page-inline-action" type="button" onClick={() => onNavigate("contact")}>
          联系与反馈 <ArrowRight size={16} />
        </button>
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
        <p>功能建议、错误样片和相机色彩反馈都可以通过公开项目提交。请勿在公开 Issue 中上传含隐私的原始照片。</p>
      </section>
      <section className="contact-actions" aria-label="联系方式">
        <a href="https://github.com/LeoMa0916/color-lab" target="_blank" rel="noreferrer">
          <span><Github size={21} /></span>
          <div>
            <small>PROJECT</small>
            <strong>GitHub 项目主页</strong>
          </div>
          <ArrowRight size={17} />
        </a>
        <a href="https://github.com/LeoMa0916/color-lab/issues" target="_blank" rel="noreferrer">
          <span><Mail size={21} /></span>
          <div>
            <small>FEEDBACK</small>
            <strong>提交功能建议或问题</strong>
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

function PageContent({ page, onNavigate }) {
  if (page === "capability") return <CapabilityView onNavigate={onNavigate} />;
  if (page === "privacy") return <PrivacyView onNavigate={onNavigate} />;
  if (page === "contact") return <ContactView onNavigate={onNavigate} />;
  return <HomeView onNavigate={onNavigate} />;
}

export function LandingPage({ onAuthenticated }) {
  const transitionTimer = useRef(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [activePage, setActivePage] = useState("home");
  const [transition, setTransition] = useState(null);

  useEffect(() => () => clearTimeout(transitionTimer.current), []);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setAuthOpen(false);
        setMobileMenuOpen(false);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

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
              <PageContent page={transition.from} onNavigate={navigate} />
            </div>
            <div className="landing-scene scene-to">
              <PageContent page={transition.to} onNavigate={navigate} />
            </div>
          </div>
        ) : (
          <div className="landing-scene scene-current">
            <PageContent page={activePage} onNavigate={navigate} />
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
            />
          </aside>
        </div>
      )}
    </main>
  );
}
