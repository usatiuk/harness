const preference = window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark" || (theme === "system" && preference.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
}

applyTheme(localStorage.getItem("theme") ?? "system");
preference.addEventListener("change", () => applyTheme(localStorage.getItem("theme") ?? "system"));
