/** A safe-area inset in px; env() is only readable through a computed style. */
function safeAreaInset(side: "top" | "bottom") {
  const probe = document.createElement("div");
  probe.style.paddingTop = `env(safe-area-inset-${side})`;
  document.body.append(probe);
  const inset = Number.parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return inset;
}

export const safeAreaTop = () => safeAreaInset("top");
export const safeAreaBottom = () => safeAreaInset("bottom");

export const menuCollisionPadding = () => ({
  top: safeAreaTop() + 8,
  right: 8,
  left: 8,
  bottom: safeAreaBottom() + 8,
});
