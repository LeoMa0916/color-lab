import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Smartphone, Monitor, X } from "lucide-react";

export function AppDownloads() {
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState(null);
  const [status, setStatus] = useState("loading");
  const trigger = useRef(null);
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatus("loading");
    fetch("https://api.github.com/repos/LeoMa0916/color-lab/releases/latest", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Unavailable"); return response.json(); })
      .then((data) => { setRelease(data); setStatus("ready"); })
      .catch((error) => { if (error.name !== "AbortError") setStatus("error"); });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab") {
        const items = Array.from(panel.current?.querySelectorAll("button, a[href]") || []);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("keydown", close); trigger.current?.focus(); };
  }, [open]);
  return <>
    <button ref={trigger} className="app-download-trigger" type="button" onClick={() => setOpen(true)}><Download size={17} /><span>下载 App</span></button>
    {open && createPortal(<div className="app-download-backdrop" onClick={() => setOpen(false)}>
      <section ref={panel} className="app-download-panel" role="dialog" aria-modal="true" aria-label="下载调色室" onClick={(event) => event.stopPropagation()}>
        <button className="app-download-close" type="button" autoFocus onClick={() => setOpen(false)} aria-label="关闭下载"><X size={20} /></button>
        <h2>把调色室装进口袋。</h2><p>同一个账号，继续你的调色。当前安装版需要联网使用。</p>
        {[{ name: "Color-Lab-Android.apk", label: "Android", Icon: Smartphone, detail: "安卓安装包 · 需要支持的浏览器" }, { name: "Color-Lab-Windows-Setup.exe", label: "Windows", Icon: Monitor, detail: "Windows 10 / 11 · 64 位" }].map(({ name, label, Icon, detail }) => {
          const asset = release?.assets?.find((item) => item.name === name);
          return <div className="app-download-row" key={name}><Icon size={26} /><div><strong>{label}</strong><small>{detail}</small></div>{asset ? <a href={asset.browser_download_url}>下载安装</a> : <span>{status === "loading" ? "查询中…" : "尚未发布"}</span>}</div>;
        })}
        <small>测试版安装包。Windows 暂未签署发行者证书，系统可能提示未知发行者。</small>
        {status === "error" && <a href="https://github.com/LeoMa0916/color-lab/releases" target="_blank" rel="noreferrer">查看安装包发布页</a>}
      </section>
    </div>, document.body)}
  </>;
}
