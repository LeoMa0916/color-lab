import { LoaderCircle, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { LandingPage } from "./LandingPage";
import { logoutLocalAccount, restoreLocalSession } from "./authStore";

const ColorEditor = lazy(() =>
  import("./App.jsx").then((module) => ({ default: module.App })));

function AppLoading({ label = "正在恢复工作空间" }) {
  return (
    <main className="session-boot font-geist" role="status" aria-live="polite">
      <div className="session-boot-orb" aria-hidden="true" />
      <div className="session-boot-mark"><Sparkles size={22} /></div>
      <strong>{label}</strong>
      <span><LoaderCircle className="spin" size={15} />Color Engine 4</span>
    </main>
  );
}

export function RootApp() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    restoreLocalSession()
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function logout() {
    logoutLocalAccount();
    setSession(null);
  }

  if (checking) return <AppLoading label="正在检查本机登录状态" />;
  if (!session) return <LandingPage onAuthenticated={setSession} />;
  return (
    <Suspense fallback={<AppLoading />}>
      <ColorEditor username={session.username} onLogout={logout} />
    </Suspense>
  );
}
