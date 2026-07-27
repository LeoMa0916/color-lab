import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Menu,
  ShieldCheck,
  Sparkles,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  loginLocalAccount,
  registerLocalAccount,
  validatePassword,
  validateUsername,
} from "./authStore";
import "./landing.css";

const VIDEO_URL = "/media/color-lab-hero.mp4";

const NAV_ITEMS = [
  { label: "首页", action: "home" },
  { label: "能力", action: "capability" },
  { label: "隐私", action: "privacy" },
  { label: "工作台", action: "workspace" },
];

const FEATURE_COPY = {
  capability: {
    title: "参考驱动，而非固定滤镜",
    body: "分析影调、七色色彩、语义区域、光线与质感，再生成可编辑的风格档案。",
  },
  privacy: {
    title: "照片始终留在你的设备",
    body: "参考图、RAW 与导出渲染全部在浏览器本地完成，不上传用户照片。",
  },
};

function Field({
  autoComplete,
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
        ? await registerLocalAccount({ username, password, remember })
        : await loginLocalAccount({ username, password, remember });
      onAuthenticated(session);
    } catch (error) {
      setMessage(error?.message || "暂时无法完成登录，请稍后重试");
      if (error?.code === "wrong-password") setErrors({ password: error.message });
      if (error?.code === "account-not-found" || error?.code === "username-exists") {
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
          <p>Color Lab Account</p>
          <h2>{mode === "login" ? "继续你的创作" : "创建本机账户"}</h2>
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
            <small>下次在这台设备自动登录</small>
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
        <span>密码经加盐派生后保存在本机，不保存明文；照片不会上传。</span>
      </div>
    </section>
  );
}

export function LandingPage({ onAuthenticated }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [feature, setFeature] = useState("capability");

  function openAuth(mode = "login") {
    setAuthMode(mode);
    setAuthOpen(true);
    setMobileMenuOpen(false);
  }

  function handleNavigation(action) {
    if (action === "workspace") openAuth("login");
    else if (action === "home") setFeature("capability");
    else setFeature(action);
    setMobileMenuOpen(false);
  }

  return (
    <main id="home" className="landing-root relative h-screen w-full overflow-hidden bg-black font-geist">
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
          <button className="landing-brand text-lg font-semibold tracking-tight text-white sm:text-xl" type="button" onClick={() => handleNavigation("home")}>
            <span className="brand-lens" aria-hidden="true" />
            <span>调色室</span>
            <small>Color Lab</small>
          </button>
          <div className="hidden items-center gap-7 md:flex">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.action}
                type="button"
                className="text-sm text-white/80 transition-colors hover:text-white"
                onClick={() => handleNavigation(item.action)}
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
            <button key={item.action} type="button" onClick={() => handleNavigation(item.action)}>
              {item.label}
            </button>
          ))}
          <button className="mobile-menu-cta" type="button" onClick={() => openAuth("login")}>
            登录工作台
          </button>
        </div>
      </div>

      <div className="landing-content relative z-10 flex h-[calc(100vh-80px)] flex-col justify-between px-6 pb-10 pt-12 sm:pb-12 sm:pt-16 md:px-12 md:pb-16 md:pt-20 lg:px-16">
        <section className="max-w-3xl">
          <p className="hero-badge mb-4 text-xs text-white/90 sm:mb-6 sm:text-sm">
            Reference-driven color intelligence
          </p>
          <h1 className="hero-title text-3xl font-medium leading-[1.1] tracking-tight text-white sm:text-5xl md:text-6xl lg:text-7xl">
            把参考影像的光，<br />
            折叠进你的<br />
            下一张照片。
          </h1>
        </section>

        <section className="landing-bottom">
          <div className="feature-reveal" key={feature}>
            <strong>{FEATURE_COPY[feature].title}</strong>
            <span>{FEATURE_COPY[feature].body}</span>
          </div>
          <p className="hero-description mb-5 max-w-sm text-sm leading-relaxed text-white/60 sm:mb-6 sm:max-w-lg sm:text-base md:text-lg">
            从样片读取影调、色彩、光线与质感，让 Color Engine 4 建立属于你的可编辑风格。
          </p>
          <div className="hero-actions">
            <button
              className="hero-cta inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-black transition-transform hover:scale-105 sm:px-6 sm:py-3"
              type="button"
              onClick={() => openAuth("register")}
            >
              开始创作 <ArrowRight size={16} />
            </button>
            <button className="hero-login-link" type="button" onClick={() => openAuth("login")}>
              已有账户，直接登录
            </button>
          </div>
        </section>
      </div>

      <aside className={authOpen ? "auth-shell open" : "auth-shell"}>
        <button className="auth-mobile-close" type="button" aria-label="关闭账户面板" onClick={() => setAuthOpen(false)}>
          <X size={18} />
        </button>
        <AuthPanel
          mode={authMode}
          onModeChange={setAuthMode}
          onAuthenticated={onAuthenticated}
        />
      </aside>
      {authOpen && <button className="auth-mobile-backdrop" aria-label="关闭账户面板" type="button" onClick={() => setAuthOpen(false)} />}
    </main>
  );
}
