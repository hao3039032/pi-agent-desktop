/**
 * The offline theme bootstrap, ported from lib/theme.ts's THEME_INIT_SCRIPT:
 * the theme must be right on first paint, with NO network (bundled fonts and
 * assets only; the Next.js Google-Fonts link is gone in the static build).
 * Inline in index.html before the bundle loads.
 */
export const THEME_INIT_SCRIPT = `(function(){var t="auto";try{var s=localStorage.getItem("pi-theme");if(["auto","light","dark"].includes(s))t=s}catch(e){}if(t==="auto")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.classList.toggle("dark",t==="dark")})();`;
