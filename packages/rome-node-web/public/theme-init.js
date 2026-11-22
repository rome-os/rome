(() => {
  try {
    var stored = localStorage.getItem("rome-node-theme");
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved =
      stored === "light" || stored === "dark" ? stored : prefersDark ? "dark" : "light";
    if (resolved === "dark") document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = resolved;
  } catch (_err) {}
})();
