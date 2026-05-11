const configUrl = "./config/profile.json";

const nodes = {
  avatar: document.getElementById("avatar"),
  avatarFallback: document.getElementById("avatarFallback"),
  name: document.getElementById("name"),
  handle: document.getElementById("handle"),
  bio: document.getElementById("bio"),
  links: document.getElementById("links"),
  updatedAt: document.getElementById("updatedAt"),
  linkTemplate: document.getElementById("linkTemplate"),
  shareBtn: document.getElementById("shareBtn")
};

const fallbackConfig = {
  name: "Your Name",
  handle: "@yourhandle",
  bio: "Replace profile.json with your own links.",
  avatar: "",
  updatedAt: new Date().toISOString(),
  links: [
    { title: "Website", subtitle: "Main landing page", url: "https://example.com", tag: "Main" },
    { title: "Book a Call", subtitle: "15 min discovery call", url: "https://cal.com", tag: "Book" },
    { title: "Instagram", subtitle: "Daily updates", url: "https://instagram.com", tag: "Social" }
  ]
};

async function loadConfig() {
  try {
    const response = await fetch(configUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Config fetch failed: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn("Using fallback profile config.", error);
    return fallbackConfig;
  }
}

function initialsFromName(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "YN";
  const initial = parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
  return initial || "YN";
}

function formatDate(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function renderLinks(items) {
  nodes.links.innerHTML = "";

  items.forEach((item, index) => {
    const clone = nodes.linkTemplate.content.cloneNode(true);
    const card = clone.querySelector(".link-card");
    const title = clone.querySelector(".link-title");
    const subtitle = clone.querySelector(".link-subtitle");
    const tag = clone.querySelector(".link-tag");

    card.href = item.url;
    card.style.animationDelay = `${index * 80}ms`;
    title.textContent = item.title || "Untitled link";
    subtitle.textContent = item.subtitle || "";

    if (item.tag) {
      tag.textContent = item.tag;
      tag.style.display = "inline-block";
    } else {
      tag.style.display = "none";
    }

    nodes.links.appendChild(clone);
  });
}

function renderProfile(config) {
  const safe = { ...fallbackConfig, ...config };

  nodes.name.textContent = safe.name;
  nodes.handle.textContent = safe.handle;
  nodes.bio.textContent = safe.bio;
  nodes.updatedAt.textContent = safe.updatedAt ? `Updated ${formatDate(safe.updatedAt)}` : "";

  nodes.avatarFallback.textContent = initialsFromName(safe.name);

  if (safe.avatar) {
    nodes.avatar.src = safe.avatar;
    nodes.avatar.onerror = () => {
      nodes.avatar.style.display = "none";
      nodes.avatarFallback.style.display = "grid";
    };
    nodes.avatar.onload = () => {
      nodes.avatar.style.display = "block";
      nodes.avatarFallback.style.display = "none";
    };
  }

  renderLinks(Array.isArray(safe.links) ? safe.links : []);
}

async function shareProfile() {
  const shareData = {
    title: document.title,
    text: "Check out this link page",
    url: window.location.href
  };

  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }

    await navigator.clipboard.writeText(window.location.href);
    nodes.shareBtn.textContent = "Copied";
    setTimeout(() => {
      nodes.shareBtn.textContent = "Share";
    }, 1300);
  } catch (error) {
    console.warn("Share was canceled or unavailable.", error);
  }
}

async function init() {
  const config = await loadConfig();
  renderProfile(config);
  nodes.shareBtn.addEventListener("click", shareProfile);
}

init();
