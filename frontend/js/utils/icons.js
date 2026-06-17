// frontend/js/utils/icons.js — Lucide icon helpers

let iconRefreshFrame = null;

/**
 * Convert a kebab-case icon name to PascalCase export name.
 */
function getLucideExportName(iconName) {
  return String(iconName || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Render icons within a scoped root element without scanning the full DOM.
 * Returns true if all icons in the root were rendered successfully.
 */
function renderScopedIcons(root) {
  const lucide = window.lucide;
  const iconNodes = Array.from(root?.querySelectorAll?.("i[data-lucide]") || []);

  if (!lucide?.icons || iconNodes.length === 0) return true;

  let renderedCount = 0;

  for (const node of iconNodes) {
    const iconName = node.getAttribute("data-lucide");
    const iconDefinition = lucide.icons[iconName] || lucide.icons[getLucideExportName(iconName)];
    if (!iconDefinition) continue;

    const attrs = {
      class: node.getAttribute("class") || "",
      "aria-hidden": "true",
    };

    // Preserve id attribute so getElementById still works after icon render
    const nodeId = node.getAttribute("id");
    if (nodeId) attrs.id = nodeId;

    let svg = null;
    if (typeof iconDefinition.toSvg === "function") {
      const template = document.createElement("template");
      template.innerHTML = iconDefinition.toSvg(attrs).trim();
      svg = template.content.firstElementChild;
    } else if (typeof lucide.createElement === "function") {
      svg = lucide.createElement(iconDefinition, attrs);
    }

    if (svg) {
      node.replaceWith(svg);
      renderedCount += 1;
    }
  }

  return renderedCount === iconNodes.length;
}

/**
 * Refresh Lucide icons. If a scoped root is provided, only that subtree is
 * updated. Otherwise a single rAF-batched full-page scan is scheduled.
 */
export function refreshIcons(root = document) {
  if (!window.lucide?.createIcons) return;

  if (root !== document && renderScopedIcons(root)) {
    return;
  }

  if (iconRefreshFrame !== null) return;

  iconRefreshFrame = window.requestAnimationFrame(() => {
    iconRefreshFrame = null;
    window.lucide.createIcons();
  });
}

/**
 * Swap the inner SVG paths of an icon element inline (no full DOM scan).
 * Returns true if the swap succeeded.
 */
export function swapIconInline(svgElement, iconName) {
  if (!svgElement || !iconName) return false;
  if (svgElement.tagName.toLowerCase() !== "svg") return false;
  if (!window.lucide?.icons?.[iconName]) return false;

  const [, , children] = window.lucide.icons[iconName];
  svgElement.innerHTML = "";
  for (const [tag, attrs] of children) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svgElement.appendChild(el);
  }

  // Update the lucide class
  svgElement.classList.forEach((c) => {
    if (c.startsWith("lucide-")) svgElement.classList.remove(c);
  });
  svgElement.classList.add(`lucide-${iconName}`);
  svgElement.setAttribute("data-lucide", iconName);

  return true;
}
