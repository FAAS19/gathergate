(function () {
  try {
    if (localStorage.getItem("gathergate-site-theme") === "dark") {
      document.documentElement.classList.add("dark");
    }
  } catch (_err) {}
})();
