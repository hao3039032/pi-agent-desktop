import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../hooks/useI18n";
import { ConversationFind } from "../components/ConversationFind";

function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState("a");
  const [earlier, setEarlier] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [stream, setStream] = useState("");
  return <I18nProvider><div className="chat-window" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <button onClick={() => setScope("b")}>Switch session</button>
    <button onClick={() => setStream(" streaming needle")}>Stream update</button>
    <button onClick={() => setStream(" unrelated update")}>Unrelated update</button>
    <ConversationFind contentRef={ref} scopeKey={scope} onReveal={() => {}} busy={false} hasEarlier={!earlier} onLoadEarlier={async () => setEarlier(true)} />
    <div className="chat-scroll-container" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 20 }}><div ref={ref}>
      {earlier && <p>Earlier needle</p>}
      <p>Needle in <strong>bold text</strong> and needle again.</p>
      <p>Literal [a+b]. 中文内容</p>
      <p>breakstart<br />breakend</p>
      <ul><li>parentstart<ul><li>nested</li></ul>parentend</li></ul>
      <p>before<button>excluded</button>after</p>
      <button onClick={() => setExpanded(!expanded)}>Expand details</button>
      {expanded && <p>Expanded needle</p>}
      <div style={{ height: 1200 }} />
      <p>Last needle{stream}</p>
    </div></div>
    <textarea aria-label="Composer" defaultValue="needle in composer" />
    <div id="file-panel" tabIndex={0}>needle in workspace</div>
    <input aria-label="Outside" />
  </div></I18nProvider>;
}
// Pi Agent LW ships zh-CN as the first-launch locale; these upstream fixtures
// assert English labels, so pin the stored preference the way a user would.
// Only when the test has not chosen a locale itself (addInitScript wins).
if (typeof localStorage !== "undefined" && !localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en");
createRoot(document.getElementById("root")!).render(<Fixture />);
