/**
 * FutureFunds.ai — Theme Switcher (Light / Dark / Earth / Auto)
 * -------------------------------------------------------------
 * - Persists choice in localStorage('ff_theme')
 * - Auto = follows prefers-color-scheme (system)
 * - Applies body classes: none (light), theme-dark, theme-earth
 * - Updates button label
 */

(function ThemeSwitcher(){
  const STORAGE_KEY = "ff_theme";
  const BTN_ID = "theme-toggle";
  const ORDER = ["light", "dark", "earth", "auto"]; // cycle order

  const btn = document.getElementById(BTN_ID);
  if (!btn) return;

  // Apply a theme name -> body class
  function applyTheme(name){
    document.body.classList.remove("theme-dark", "theme-earth");
    switch (name) {
      case "dark":  document.body.classList.add("theme-dark"); break;
      case "earth": document.body.classList.add("theme-earth"); break;
      case "light": /* default light: no class */ break;
      case "auto":  // follow system
      default: {
        const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        if (prefersDark) document.body.classList.add("theme-dark");
        break;
      }
    }
    setButtonLabel(name);
  }

  function currentTheme(){
    return localStorage.getItem(STORAGE_KEY) || "auto";
  }

  function nextTheme(cur){
    const i = ORDER.indexOf(cur);
    return ORDER[(i === -1 ? 0 : (i+1) % ORDER.length)];
  }

  function setButtonLabel(name){
    const label = ({
      light: "☀️ Light",
      dark:  "🌙 Dark",
      earth: "🌿 Earth",
      auto:  "🖥️ Auto"
    })[name] || "🌗 Theme";
    btn.textContent = label;
    btn.setAttribute("aria-label", `Theme: ${label}`);
    btn.setAttribute("title", `Theme: ${label} — click to change`);
  }

  // Live update when system theme changes (if in Auto)
  const media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (media && typeof media.addEventListener === "function") {
    media.addEventListener("change", () => {
      if (currentTheme() === "auto") applyTheme("auto");
    });
  }

  // Init
  const initial = currentTheme();
  applyTheme(initial);

  // Click to cycle
  btn.addEventListener("click", () => {
    const next = nextTheme(currentTheme());
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  });
})();
