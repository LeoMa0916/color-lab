import { LoaderCircle, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { logoutCloudAccount, restoreCloudSession } from "./cloudClient";
import { LandingPage } from "./LandingPage";

const ColorEditor = lazy(() =>
  import("./App.jsx").then((module) => ({ default: module.App })));

function AppLoading({ label = "正在恢复工作空间" }) {
  return (
    <main className="session-boot font-geist" role="status" aria-live="polite">
      <div className="session-boot-orb" aria-hidden="true" />
      <div className="session-boot-mark"><Sparkles size={22} /></div>
      <strong>{label}</strong>
        <span><LoaderCircle className="spin" size={15} />Color Engine 5</span>
    </main>
  );
}

export function RootApp() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    restoreCloudSession()
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    await logoutCloudAccount().catch(() => {});
    setSession(null);
  }

  if (checking) return <AppLoading label="正在检查本机登录状态" />;
  if (!session) return <LandingPage onAuthenticated={setSession} />;
  return (
    <Suspense fallback={<AppLoading />}>
      <ColorEditor session={session} username={session.username} onLogout={logout} />
    </Suspense>
  );
}
