const feedElement = document.querySelector("#feed");
const newsElement = document.querySelector("#today-news");
const template = document.querySelector("#post-template");
const navLinks = document.querySelector("#nav-links");
const tabs = Array.from(document.querySelectorAll(".tab"));
const localCountElements = Array.from(document.querySelectorAll("[data-local-counts]"));
const sourceFilters = document.querySelector("#source-filters");
const resetSources = document.querySelector("#reset-sources");
const categoryFilters = document.querySelector("#category-filters");
const categoryAll = document.querySelector("#category-all");
const themeToggle = document.querySelector("#theme-toggle");
const mobileMenuToggle = document.querySelector("#mobile-menu-toggle");
const mobileMenuClose = document.querySelector("#mobile-menu-close");
const menuBackdrop = document.querySelector("#menu-backdrop");
const authForm = document.querySelector("#auth-form");
const authEmailInput = document.querySelector("#auth-email");
const authSubmit = document.querySelector("#auth-submit");
const authStatus = document.querySelector("#auth-status");
const authUser = document.querySelector("#auth-user");
const authEmailLabel = document.querySelector("#auth-email-label");
const authSignOut = document.querySelector("#auth-sign-out");
const authGate = document.querySelector("#auth-gate");
const saveModeLabel = document.querySelector("#save-mode-label");

const storageKeys = {
  categories: "comment-times.categories.v1",
  sort: "comment-times.sort.v1",
  sources: "comment-times.sources.v1",
  theme: "comment-times.theme.v2",
};

const navItems = [
  { icon: "home", label: "Feed", view: "feed" },
  { icon: "heart", label: "Likes", view: "likes" },
  { icon: "bookmark", label: "Bookmarks", view: "bookmarks" },
  { icon: "book-open", label: "My Reads", view: "reads" },
  { icon: "pen", label: "Writers", view: "writers" },
];

const persistedKinds = new Set(["like", "bookmark", "read", "seen"]);
const commentPreviewLength = 280;
const feedRandomSeed = `${Date.now()}-${Math.random()}`;
const supabaseScriptUrl = "./vendor/supabase-js-2.110.2.js";
const authResendCooldownMs = 60 * 1000;
const authRateLimitCooldownMs = 5 * 60 * 1000;
const seenFlushDelayMs = 900;

let sources = [];
let articles = [];
let allPosts = [];
let sourceCounts = new Map();
let categoryCounts = new Map();
let activeView = "feed";
let activeSort = readText(storageKeys.sort, "popular");
let activeSources = new Set();
let selectedCategories = new Set(readArray(storageKeys.categories, []));
let likedPosts = new Set();
let bookmarkedPosts = new Set();
let seenPosts = new Set();
let readArticles = new Map();
let expandedPosts = new Set();
let supabaseClient = null;
let currentUser = null;
let authAvailable = false;
let authBusy = false;
let authMessage = "";
let authCooldownUntil = 0;
let authCooldownTimer = null;
let supabaseScriptPromise = null;
let remotePostSnapshots = new Map();
let remoteSavedKinds = new Set();
let pendingSeenPosts = new Map();
let seenFlushTimer = null;
let scrollCheckScheduled = false;

if (!["popular", "recent"].includes(activeSort)) {
  activeSort = "popular";
}

applyTheme(readTheme());
renderNav();
bindControls();
initializeAuth();
loadFeed();

async function loadFeed() {
  try {
    const payload = await fetchLatestFeed();
    articles = normalizeArticles(Array.isArray(payload.articles) ? payload.articles : []);
    sources = collectSources(Array.isArray(payload.sources) ? payload.sources : [], articles);
    allPosts = flattenPosts(articles);
    initializeActiveSources();
    rebuildCounts();
    initializeActiveCategories();
    renderAll();
  } catch (error) {
    feedElement.innerHTML = "";
    feedElement.append(emptyState("Could not load the feed.", error.message));
  }
}

async function fetchLatestFeed() {
  const urls = [`./api/feed?cache=${Date.now()}`, `./data/latest.json?cache=${Date.now()}`];
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Feed unavailable");
}

async function initializeAuth() {
  renderAuthPanel();

  try {
    const config = await loadAppConfig();
    const supabaseUrl = String(config.supabaseUrl || "").trim();
    const supabaseAnonKey = String(config.supabaseAnonKey || "").trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      authAvailable = false;
      renderAuthPanel();
      renderStatus([], []);
      return;
    }

    const createClient = await loadSupabaseCreateClient();
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
      },
    });
    authAvailable = true;

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
      throw error;
    }

    currentUser = data.session?.user || null;
    await loadRemoteLibrary();
    renderAll();

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      currentUser = session?.user || null;
      authMessage = currentUser ? "Signed in." : "";
      await loadRemoteLibrary();
      renderAll();
    });
  } catch (error) {
    authAvailable = false;
    authMessage = `Login unavailable: ${error.message}`;
    renderAuthPanel();
  }
}

async function loadSupabaseCreateClient() {
  if (window.supabase?.createClient) {
    return window.supabase.createClient;
  }

  if (!supabaseScriptPromise) {
    supabaseScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = supabaseScriptUrl;
      script.async = true;
      script.onload = () => {
        if (window.supabase?.createClient) {
          resolve(window.supabase.createClient);
          return;
        }
        reject(new Error("Supabase client did not initialize."));
      };
      script.onerror = () => reject(new Error("Supabase client could not load."));
      document.head.append(script);
    });
  }

  return supabaseScriptPromise;
}

async function loadAppConfig() {
  if (window.COMMENT_TIMES_CONFIG) {
    return window.COMMENT_TIMES_CONFIG;
  }

  try {
    const response = await fetch(`./api/config?cache=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      return {};
    }
    return await response.json();
  } catch {
    return {};
  }
}

async function requestMagicLink() {
  if (!supabaseClient || !authEmailInput) {
    return;
  }

  const cooldownSeconds = getAuthCooldownSeconds();
  if (cooldownSeconds > 0) {
    authMessage = `Try again in ${formatAuthWait(cooldownSeconds)}.`;
    renderAuthPanel();
    return;
  }

  const email = authEmailInput.value.trim();
  if (!email) {
    authMessage = "Enter an email address.";
    renderAuthPanel();
    return;
  }

  authBusy = true;
  authMessage = "Sending link...";
  renderAuthPanel();

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      shouldCreateUser: true,
    },
  });

  authBusy = false;
  if (error) {
    authMessage = getAuthErrorMessage(error);
    if (isAuthRateLimitError(error)) {
      startAuthCooldown(authRateLimitCooldownMs);
    }
  } else {
    authMessage = "Check your email.";
    startAuthCooldown(authResendCooldownMs);
  }
  renderAuthPanel();
}

function getAuthCooldownSeconds() {
  return Math.max(0, Math.ceil((authCooldownUntil - Date.now()) / 1000));
}

function formatAuthWait(seconds) {
  if (seconds >= 60) {
    return `${Math.ceil(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

function startAuthCooldown(durationMs) {
  authCooldownUntil = Date.now() + durationMs;
  if (authCooldownTimer) {
    window.clearInterval(authCooldownTimer);
  }
  authCooldownTimer = window.setInterval(() => {
    if (getAuthCooldownSeconds() <= 0) {
      window.clearInterval(authCooldownTimer);
      authCooldownTimer = null;
      authCooldownUntil = 0;
    }
    renderAuthPanel();
  }, 1000);
}

function isAuthRateLimitError(error) {
  const message = String(error?.message || "");
  return error?.status === 429 || /rate limit|too many/i.test(message);
}

function getAuthErrorMessage(error) {
  if (isAuthRateLimitError(error)) {
    return "Email limit hit. Try again later.";
  }
  return error?.message || "Could not send link.";
}

async function signOut() {
  if (!supabaseClient) {
    return;
  }

  authBusy = true;
  authMessage = "Signing out...";
  renderAuthPanel();

  const { error } = await supabaseClient.auth.signOut();
  authBusy = false;
  if (error) {
    authMessage = error.message;
    renderAuthPanel();
    return;
  }

  currentUser = null;
  remotePostSnapshots = new Map();
  remoteSavedKinds = new Set();
  likedPosts = new Set();
  bookmarkedPosts = new Set();
  seenPosts = new Set();
  readArticles = new Map();
  pendingSeenPosts = new Map();
  authMessage = "";
  renderAll();
}

async function loadRemoteLibrary() {
  if (!supabaseClient || !currentUser) {
    remotePostSnapshots = new Map();
    remoteSavedKinds = new Set();
    likedPosts = new Set();
    bookmarkedPosts = new Set();
    seenPosts = new Set();
    readArticles = new Map();
    pendingSeenPosts = new Map();
    return;
  }

  const { data, error } = await supabaseClient
    .from("saved_posts")
    .select("post_key,kind,source_id,source_name,article_url,article_title,article_snapshot,comment_snapshot,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    authMessage = `Could not load saved posts: ${error.message}`;
    return;
  }

  const snapshots = new Map();
  const savedKinds = new Set();
  const nextLikes = new Set();
  const nextBookmarks = new Set();
  const nextSeen = new Set();
  const nextReads = new Map();

  for (const row of data || []) {
    savedKinds.add(`${row.kind}:${row.post_key}`);

    if (row.kind === "read") {
      const read = readFromSavedRow(row);
      if (read) {
        nextReads.set(read.key, read);
      }
      continue;
    }

    if (row.kind === "seen") {
      nextSeen.add(row.post_key);
      continue;
    }

    const post = postFromSavedRow(row);
    if (post) {
      snapshots.set(row.post_key, post);
    }

    if (row.kind === "like") {
      nextLikes.add(row.post_key);
    }
    if (row.kind === "bookmark") {
      nextBookmarks.add(row.post_key);
    }
  }

  remotePostSnapshots = snapshots;
  remoteSavedKinds = savedKinds;
  likedPosts = nextLikes;
  bookmarkedPosts = nextBookmarks;
  seenPosts = nextSeen;
  readArticles = nextReads;
}

async function syncSavedPost(kind, post, selected) {
  if (!supabaseClient || !currentUser || !["like", "bookmark"].includes(kind)) {
    authMessage = "Sign in to save to your account.";
    renderAuthPanel();
    return false;
  }

  if (selected) {
    const row = savedPostRow(kind, post);
    const { error } = await supabaseClient
      .from("saved_posts")
      .upsert(row, { onConflict: "user_id,post_key,kind" });

    if (error) {
      authMessage = `Could not sync ${kind}: ${error.message}`;
      renderAuthPanel();
      return false;
    }

    remotePostSnapshots.set(post.key, post);
    remoteSavedKinds.add(`${kind}:${post.key}`);
    authMessage = "Saved.";
    renderAuthPanel();
    return true;
  }

  const { error } = await supabaseClient
    .from("saved_posts")
    .delete()
    .eq("user_id", currentUser.id)
    .eq("post_key", post.key)
    .eq("kind", kind);

  if (error) {
    authMessage = `Could not remove ${kind}: ${error.message}`;
    renderAuthPanel();
    return false;
  }

  if (!likedPosts.has(post.key) && !bookmarkedPosts.has(post.key)) {
    remotePostSnapshots.delete(post.key);
  }
  remoteSavedKinds.delete(`${kind}:${post.key}`);
  authMessage = "Updated.";
  renderAuthPanel();
  return true;
}

async function upsertSavedRows(rows, options = {}) {
  if (!supabaseClient || !currentUser || rows.length === 0) {
    return false;
  }

  const filteredRows = rows.filter((row) => persistedKinds.has(row.kind));
  if (filteredRows.length === 0) {
    return false;
  }

  const { error } = await supabaseClient
    .from("saved_posts")
    .upsert(filteredRows, { onConflict: "user_id,post_key,kind" });

  if (error) {
    if (!options.silent) {
      authMessage = `Could not save: ${error.message}`;
      renderAuthPanel();
    } else {
      console.warn(error.message);
    }
    return false;
  }

  for (const row of filteredRows) {
    remoteSavedKinds.add(`${row.kind}:${row.post_key}`);
  }
  return true;
}

function bindControls() {
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      activeSort = tab.dataset.sort;
      writeText(storageKeys.sort, activeSort);
      renderAllAndReturnToTop();
    });
  }

  navLinks.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) {
      return;
    }

    activeView = button.dataset.view;
    renderAll();
    closeMobileMenu();
  });

  mobileMenuToggle?.addEventListener("click", () => {
    const nextOpen = !document.body.classList.contains("menu-open");
    setMobileMenu(nextOpen);
  });

  mobileMenuClose?.addEventListener("click", closeMobileMenu);
  menuBackdrop?.addEventListener("click", closeMobileMenu);

  sourceFilters.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-source]");
    if (!input) {
      return;
    }

    if (input.checked) {
      activeSources.add(input.dataset.source);
    } else {
      activeSources.delete(input.dataset.source);
    }

    writeArray(storageKeys.sources, Array.from(activeSources));
    renderAllAndReturnToTop();
  });

  resetSources.addEventListener("click", () => {
    activeSources = new Set(sources.map((source) => source.id));
    writeArray(storageKeys.sources, Array.from(activeSources));
    renderAllAndReturnToTop();
  });

  categoryAll.addEventListener("click", () => {
    selectedCategories.clear();
    writeArray(storageKeys.categories, []);
    renderAllAndReturnToTop();
  });

  categoryFilters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-category]");
    if (!button) {
      return;
    }

    const category = button.dataset.category;
    if (selectedCategories.has(category)) {
      selectedCategories.delete(category);
    } else {
      selectedCategories.add(category);
    }

    writeArray(storageKeys.categories, Array.from(selectedCategories));
    renderAllAndReturnToTop();
  });

  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(nextTheme);
    writeText(storageKeys.theme, nextTheme);
    renderThemeToggle();
  });

  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await requestMagicLink();
  });

  authSignOut?.addEventListener("click", async () => {
    await signOut();
  });

  feedElement.addEventListener("click", async (event) => {
    const articleLink = event.target.closest("a.article-card");
    if (articleLink) {
      const post = findPostByKey(articleLink.closest(".post")?.dataset.postKey || "");
      if (post) {
        void recordArticleRead(post.article, post);
      }
      return;
    }

    const button = event.target.closest("button[data-action][data-post-key]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "expand-comment") {
      expandedPosts.add(button.dataset.postKey);
      renderAll();
      return;
    }

    const action = button.dataset.action;
    const post = findPostByKey(button.dataset.postKey);
    if (!currentUser) {
      authMessage = "Sign in to save your reading.";
      renderAuthPanel();
      return;
    }

    if (!post) {
      return;
    }

    const targetSet = action === "bookmark" ? bookmarkedPosts : likedPosts;
    const nextSelected = !targetSet.has(button.dataset.postKey);

    if (nextSelected) {
      targetSet.add(button.dataset.postKey);
    } else {
      targetSet.delete(button.dataset.postKey);
    }

    renderAll();

    const synced = await syncSavedPost(action, post, nextSelected);
    if (!synced) {
      if (nextSelected) {
        targetSet.delete(button.dataset.postKey);
      } else {
        targetSet.add(button.dataset.postKey);
      }
      renderAll();
    }
  });

  newsElement?.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-article-url]");
    if (!link) {
      return;
    }

    const article = findArticleByUrl(link.dataset.articleUrl);
    if (article) {
      void recordArticleRead(article, null);
    }
  });

  window.addEventListener("scroll", scheduleScrolledPastCheck, { passive: true });
  window.addEventListener("resize", scheduleScrolledPastCheck, { passive: true });
  window.addEventListener("pagehide", () => {
    void flushSeenPosts();
  });
}

function renderAll() {
  renderTabs();
  renderNavState();
  renderThemeToggle();
  renderAuthPanel();
  renderSourceFilters();
  renderCategoryFilters();

  const visiblePosts = getVisiblePosts();
  const visibleArticles = getVisibleArticles();
  if (activeView === "reads") {
    renderReads(getVisibleReads());
  } else if (activeView === "writers") {
    renderWriters(getVisibleWriters());
  } else {
    renderFeed(visiblePosts);
  }
  renderNews(visibleArticles);
  renderStatus(visiblePosts, visibleArticles);
}

function renderAllAndReturnToTop() {
  renderAll();
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function renderNav() {
  const fragment = document.createDocumentFragment();

  for (const item of navItems) {
    const button = document.createElement("button");
    button.className = "nav-link";
    button.type = "button";
    button.dataset.view = item.view;
    button.innerHTML = `${icon(item.icon)}<span>${item.label}</span><small></small>`;
    fragment.append(button);
  }

  navLinks.append(fragment);
}

function renderNavState() {
  for (const button of document.querySelectorAll(".nav-link[data-view]")) {
    const view = button.dataset.view;
    const selected = view === activeView;
    const badge = button.querySelector("small");
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");

    if (view === "likes") {
      badge.textContent = likedPosts.size ? formatCount(likedPosts.size) : "";
    } else if (view === "bookmarks") {
      badge.textContent = bookmarkedPosts.size ? formatCount(bookmarkedPosts.size) : "";
    } else if (view === "reads") {
      badge.textContent = readArticles.size ? formatCount(readArticles.size) : "";
    } else if (view === "writers") {
      const writerCount = getWriterStats().length;
      badge.textContent = writerCount ? formatCount(writerCount) : "";
    } else {
      badge.textContent = "";
    }
  }
}

function renderTabs() {
  for (const tab of tabs) {
    const selected = tab.dataset.sort === activeSort;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
}

function renderThemeToggle() {
  const isLight = document.documentElement.dataset.theme === "light";
  themeToggle.innerHTML = `${icon(isLight ? "moon" : "sun")}<span>${isLight ? "Dark mode" : "Light mode"}</span>`;
}

function renderAuthPanel() {
  if (!authForm || !authStatus || !authUser || !authEmailLabel || !authSubmit) {
    return;
  }

  const signedIn = Boolean(currentUser);
  document.body.classList.toggle("auth-required", !signedIn);
  authGate.hidden = signedIn;
  authForm.hidden = signedIn;
  authUser.hidden = !signedIn;
  const cooldownSeconds = getAuthCooldownSeconds();
  const cooldownActive = !signedIn && cooldownSeconds > 0;
  authEmailInput.disabled = !authAvailable || authBusy;
  authSubmit.disabled = !authAvailable || authBusy || cooldownActive;
  const mobileAuth = window.matchMedia("(max-width: 620px)").matches;
  authSubmit.textContent = authBusy
    ? "Sending..."
    : cooldownActive
      ? `Wait ${formatAuthWait(cooldownSeconds)}`
      : mobileAuth
        ? "Send magic link"
        : "Sign up";

  if (signedIn) {
    authCooldownUntil = 0;
    if (authCooldownTimer) {
      window.clearInterval(authCooldownTimer);
      authCooldownTimer = null;
    }
    authEmailLabel.textContent = currentUser.email || "Signed in";
    authStatus.textContent = "";
    return;
  }

  authStatus.textContent = authAvailable
    ? authMessage || ""
    : authMessage || "Login is required. Supabase configuration is missing.";
}

function renderSourceFilters() {
  sourceFilters.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const source of sources) {
    const counts = sourceCounts.get(source.id) || { articles: 0, posts: 0 };
    const label = document.createElement("label");
    label.className = "source-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.source = source.id;
    input.checked = activeSources.has(source.id);

    const switchTrack = document.createElement("span");
    switchTrack.className = "switch-track";
    switchTrack.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "source-copy";

    const name = document.createElement("strong");
    name.textContent = source.name;

    const meta = document.createElement("small");
    meta.textContent = source.domain;

    copy.append(name, meta);
    label.append(input, switchTrack, copy);
    fragment.append(label);
  }

  sourceFilters.append(fragment);
}

function renderCategoryFilters() {
  categoryFilters.innerHTML = "";
  categoryAll.classList.toggle("is-active", selectedCategories.size === 0);
  categoryAll.setAttribute("aria-pressed", String(selectedCategories.size === 0));

  const categories = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1].posts - a[1].posts || a[0].localeCompare(b[0]));
  const fragment = document.createDocumentFragment();

  for (const [category, counts] of categories) {
    const button = document.createElement("button");
    button.className = "category-chip";
    button.type = "button";
    button.dataset.category = category;
    button.setAttribute("aria-pressed", String(selectedCategories.has(category)));
    button.classList.toggle("is-active", selectedCategories.has(category));

    const label = document.createElement("span");
    label.textContent = category;

    button.append(label);
    fragment.append(button);
  }

  categoryFilters.append(fragment);
}

function renderFeed(posts) {
  feedElement.innerHTML = "";

  if (allPosts.length === 0) {
    feedElement.append(emptyState("No comments yet.", "Run npm run scrape to collect reader comments."));
    return;
  }

  if (posts.length === 0) {
    feedElement.append(emptyState(emptyTitleForView(), emptyDetailForView()));
    return;
  }

  const fragment = document.createDocumentFragment();
  const caughtUpIndex = activeView === "feed" ? posts.findIndex((post) => seenPosts.has(post.key)) : -1;
  for (const [index, post] of posts.entries()) {
    if (index === caughtUpIndex) {
      fragment.append(caughtUpDivider(posts.length - index));
    }
    fragment.append(renderPost(post));
  }

  feedElement.append(fragment);
  scheduleScrolledPastCheck();
}

function renderPost(post) {
  const node = template.content.firstElementChild.cloneNode(true);
  const avatar = node.querySelector(".avatar");
  const displayName = node.querySelector(".display-name");
  const handle = node.querySelector(".handle");
  const location = node.querySelector(".location");
  const locationDot = node.querySelector(".location-dot");
  const time = node.querySelector("time");
  const timesPick = node.querySelector(".times-pick");
  const body = node.querySelector(".comment-body");
  const card = node.querySelector(".article-card");
  const image = node.querySelector(".article-card img");
  const title = node.querySelector(".card-title span");
  const source = node.querySelector(".card-source");
  const actions = node.querySelector(".actions");
  const liked = likedPosts.has(post.key);
  const bookmarked = bookmarkedPosts.has(post.key);
  const fullBody = String(post.body || "");
  const shouldCollapse = fullBody.length > commentPreviewLength && !expandedPosts.has(post.key);
  const readerFallback = `${post.article.source.name} reader`;

  node.dataset.postKey = post.key;
  node.classList.toggle("is-seen", seenPosts.has(post.key));
  avatar.textContent = initialFor(post.name, initialFor(post.article.source.name, "R"));
  avatar.style.background = avatarColor(post.name || post.article.source.id);
  displayName.textContent = post.name || readerFallback;
  handle.textContent = `@${handleFor(post.name, `${post.article.source.id}-reader`)}`;
  location.textContent = post.location || "";
  location.hidden = !post.location;
  locationDot.hidden = !post.location;
  time.textContent = relativeTime(post.timestamp);
  time.dateTime = isoTime(post.timestamp);
  timesPick.hidden = !post.timesPick;
  body.textContent = shouldCollapse ? previewComment(fullBody) : fullBody;
  if (shouldCollapse) {
    body.after(showMoreButton(post.key));
  }

  card.href = post.article.url;
  image.src = post.article.thumbnail;
  image.alt = "";
  title.textContent = post.article.title;

  source.innerHTML = "";
  source.append(
    badge(post.article.source.name, "source-badge"),
    badge(post.article.category, "category-badge"),
  );
  if (post.article.byline) {
    source.append(metaText(`By ${post.article.byline}`));
  }

  actions.append(
    likeButton(post, liked),
    actionButton("bookmark", bookmarked ? "Saved" : "Save", "bookmark", post.key, bookmarked, "bookmark-action"),
  );

  return node;
}

function caughtUpDivider(seenCount) {
  const wrapper = document.createElement("div");
  wrapper.className = "caught-up-divider";

  const line = document.createElement("span");
  line.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("small");

  title.textContent = "You're all caught up";
  detail.textContent = `${formatCount(seenCount)} seen comments below`;

  copy.append(title, detail);
  wrapper.append(line, copy, line.cloneNode());
  return wrapper;
}

function renderReads(reads) {
  feedElement.innerHTML = "";

  if (reads.length === 0) {
    feedElement.append(emptyState(emptyTitleForView(), emptyDetailForView()));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const read of reads) {
    fragment.append(renderRead(read));
  }

  feedElement.append(fragment);
}

function renderRead(read) {
  const article = read.article;
  const wrapper = document.createElement("article");
  wrapper.className = "read-item";

  const link = document.createElement("a");
  link.className = "read-link";
  link.href = article.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.dataset.articleUrl = article.url;

  const imageWrap = document.createElement("div");
  imageWrap.className = "read-image-wrap";
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.src = article.thumbnail || "";
  imageWrap.append(image);

  const copy = document.createElement("div");
  copy.className = "read-copy";

  const meta = document.createElement("div");
  meta.className = "read-meta";
  meta.append(
    badge(article.source.name, "source-badge"),
    badge(article.category, "category-badge"),
  );
  if (read.createdAt) {
    meta.append(metaText(`Read ${relativeDate(read.createdAt)}`));
  }

  const title = document.createElement("h2");
  title.textContent = article.title;

  const byline = document.createElement("p");
  byline.className = "read-byline";
  byline.textContent = article.byline ? `By ${article.byline}` : article.source.domain;

  copy.append(meta, title, byline);
  link.append(imageWrap, copy);
  wrapper.append(link);
  return wrapper;
}

function renderWriters(writers) {
  feedElement.innerHTML = "";

  if (writers.length === 0) {
    feedElement.append(emptyState(emptyTitleForView(), emptyDetailForView()));
    return;
  }

  const list = document.createElement("section");
  list.className = "writer-list";

  for (const writer of writers) {
    list.append(renderWriter(writer));
  }

  feedElement.append(list);
}

function renderWriter(writer) {
  const item = document.createElement("article");
  item.className = "writer-item";

  const avatar = document.createElement("div");
  avatar.className = "avatar writer-avatar";
  avatar.textContent = initialFor(writer.name, "W");
  avatar.style.background = avatarColor(writer.name);

  const copy = document.createElement("div");
  copy.className = "writer-copy";

  const heading = document.createElement("div");
  heading.className = "writer-heading";

  const name = document.createElement("strong");
  name.textContent = writer.name;

  const total = document.createElement("span");
  total.textContent = `${formatCount(writer.total)} interactions`;

  heading.append(name, total);

  const breakdown = document.createElement("div");
  breakdown.className = "writer-breakdown";
  breakdown.append(
    writerMetric("Likes", writer.likes),
    writerMetric("Bookmarks", writer.bookmarks),
    writerMetric("Reads", writer.reads),
  );

  const articles = document.createElement("p");
  articles.className = "writer-articles";
  articles.textContent = writer.articleTitles.slice(0, 2).join(" / ");

  copy.append(heading, breakdown, articles);
  item.append(avatar, copy);
  return item;
}

function writerMetric(label, value) {
  const metric = document.createElement("span");
  metric.textContent = `${formatCount(value)} ${label}`;
  metric.hidden = value === 0;
  return metric;
}

function renderNews(inputArticles) {
  newsElement.innerHTML = "";

  const topArticles = inputArticles
    .slice()
    .sort((a, b) => articleRank(b) - articleRank(a) || randomOrder(a.url, b.url))
    .slice(0, 6);

  if (topArticles.length === 0) {
    newsElement.append(emptyStateLine("No stories match the current filters."));
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const article of topArticles) {
    const link = document.createElement("a");
    link.className = "news-item";
    link.href = article.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.dataset.articleUrl = article.url;

    const kicker = document.createElement("span");
    kicker.textContent = `${article.category} / ${article.source.domain}`;

    const headline = document.createElement("strong");
    headline.textContent = article.title;

    link.append(kicker, headline);
    fragment.append(link);
  }

  newsElement.append(fragment);
}

function renderStatus(visiblePosts, visibleArticles) {
  for (const element of localCountElements) {
    element.textContent = `${formatCount(likedPosts.size)} likes / ${formatCount(bookmarkedPosts.size)} bookmarks / ${formatCount(readArticles.size)} reads`;
  }

  if (saveModeLabel) {
    saveModeLabel.textContent = "Saved to account";
  }
}

function getVisiblePosts() {
  if (!["feed", "likes", "bookmarks"].includes(activeView)) {
    return [];
  }

  const posts = postsForActiveView().filter((post) => {
    if (!activeSources.has(post.article.source.id)) {
      return false;
    }

    if (selectedCategories.size > 0 && !selectedCategories.has(post.article.category)) {
      return false;
    }

    if (activeView === "likes" && !likedPosts.has(post.key)) {
      return false;
    }

    if (activeView === "bookmarks" && !bookmarkedPosts.has(post.key)) {
      return false;
    }
    return true;
  });

  return sortPosts(posts);
}

function postsForActiveView() {
  if (activeView === "feed") {
    return allPosts;
  }

  const postMap = new Map(allPosts.map((post) => [post.key, post]));
  const savedKeys = activeView === "likes" ? likedPosts : bookmarkedPosts;

  for (const key of savedKeys) {
    if (!postMap.has(key) && remotePostSnapshots.has(key)) {
      postMap.set(key, remotePostSnapshots.get(key));
    }
  }

  return Array.from(postMap.values());
}

function getVisibleReads() {
  return Array.from(readArticles.values())
    .filter((read) => articleMatchesFilters(read.article))
    .sort((a, b) => Number(new Date(b.createdAt || 0)) - Number(new Date(a.createdAt || 0)));
}

function getVisibleWriters() {
  return getWriterStats()
    .filter((writer) => writer.articles.some((article) => articleMatchesFilters(article)))
    .map((writer) => ({
      ...writer,
      articleTitles: writer.articles
        .filter((article) => articleMatchesFilters(article))
        .map((article) => article.title),
    }));
}

function getVisibleArticles() {
  return articles.filter((article) => {
    return articleMatchesFilters(article);
  });
}

function articleMatchesFilters(article) {
  if (!article || !activeSources.has(article.source.id)) {
    return false;
  }

  if (selectedCategories.size > 0 && !selectedCategories.has(article.category)) {
    return false;
  }
  return true;
}

function sortPosts(posts) {
  const rankedPosts = posts.slice().sort((a, b) => {
    if (activeSort === "recent") {
      return recencyBucket(b) - recencyBucket(a)
        || randomOrder(a.key, b.key)
        || Number(b.timestamp || 0) - Number(a.timestamp || 0);
    }

    return popularityBucket(b) - popularityBucket(a)
      || randomOrder(a.key, b.key)
      || Number(b.recommendations || 0) - Number(a.recommendations || 0)
      || Number(b.timestamp || 0) - Number(a.timestamp || 0);
  });

  const declumpedPosts = activeSort === "recent"
    ? declumpPosts(rankedPosts, { articleWindow: 3, lookAhead: 20, sourceWindow: 1 })
    : declumpPosts(rankedPosts, { articleWindow: 6, lookAhead: 42, sourceWindow: 3 });

  if (activeView !== "feed") {
    return declumpedPosts;
  }

  const fresh = [];
  const seen = [];
  for (const post of declumpedPosts) {
    if (seenPosts.has(post.key)) {
      seen.push(post);
    } else {
      fresh.push(post);
    }
  }
  return fresh.concat(seen);
}

function normalizeArticles(inputArticles) {
  return inputArticles.map((article) => ({
    ...article,
    category: categoryForArticle(article),
    source: sourceForArticle(article),
  }));
}

function collectSources(inputSources, inputArticles) {
  const map = new Map();

  for (const source of inputSources) {
    const normalized = {
      domain: cleanDomain(source.domain || source.id || "news"),
      id: cleanSourceId(source.id || source.domain),
      name: String(source.name || source.domain || "News").trim(),
    };
    map.set(normalized.id, normalized);
  }

  for (const article of inputArticles) {
    if (!map.has(article.source.id)) {
      map.set(article.source.id, article.source);
    }
  }

  return Array.from(map.values());
}

function initializeActiveSources() {
  const sourceIds = new Set(sources.map((source) => source.id));
  const storedSources = readArray(storageKeys.sources, null);

  activeSources = Array.isArray(storedSources)
    ? new Set(storedSources.filter((sourceId) => sourceIds.has(sourceId)))
    : new Set(sourceIds);
}

function initializeActiveCategories() {
  const knownCategories = new Set(categoryCounts.keys());
  const filteredCategories = Array.from(selectedCategories).filter((category) => knownCategories.has(category));

  if (filteredCategories.length !== selectedCategories.size) {
    selectedCategories = new Set(filteredCategories);
    writeArray(storageKeys.categories, filteredCategories);
  }
}

function rebuildCounts() {
  sourceCounts = new Map(sources.map((source) => [source.id, { articles: 0, posts: 0 }]));
  categoryCounts = new Map();

  for (const article of articles) {
    const sourceEntry = sourceCounts.get(article.source.id) || { articles: 0, posts: 0 };
    sourceEntry.articles += 1;
    sourceCounts.set(article.source.id, sourceEntry);

    const categoryEntry = categoryCounts.get(article.category) || { articles: 0, posts: 0 };
    categoryEntry.articles += 1;
    categoryCounts.set(article.category, categoryEntry);
  }

  for (const post of allPosts) {
    const sourceEntry = sourceCounts.get(post.article.source.id) || { articles: 0, posts: 0 };
    sourceEntry.posts += 1;
    sourceCounts.set(post.article.source.id, sourceEntry);

    const categoryEntry = categoryCounts.get(post.article.category) || { articles: 0, posts: 0 };
    categoryEntry.posts += 1;
    categoryCounts.set(post.article.category, categoryEntry);
  }
}

function flattenPosts(inputArticles) {
  return inputArticles.flatMap((article) => {
    const comments = Array.isArray(article.comments) ? article.comments : [];

    return comments.map((comment) => {
      const post = {
        ...comment,
        article: {
          byline: article.byline || "",
          category: article.category,
          section: article.section || "",
          source: article.source,
          summary: article.summary || "",
          thumbnail: article.thumbnail || "",
          title: article.title || "Untitled article",
          totalComments: article.totalComments || 0,
          url: article.url,
        },
        articleKey: article.url,
      };

      post.key = keyForPost(post);
      return post;
    });
  });
}

function findPostByKey(key) {
  return allPosts.find((post) => post.key === key) || remotePostSnapshots.get(key) || null;
}

function findArticleByUrl(url) {
  return articles.find((article) => article.url === url)
    || Array.from(readArticles.values()).find((read) => read.article.url === url)?.article
    || null;
}

async function recordArticleRead(article, post) {
  if (!article?.url || !currentUser) {
    return false;
  }

  const key = keyForArticle(article);
  const read = {
    article,
    createdAt: new Date().toISOString(),
    key,
  };
  readArticles.set(key, read);

  const row = savedArticleRow(article, post);
  const synced = await upsertSavedRows([row], { silent: true });
  if (synced) {
    renderNavState();
    renderStatus([], []);
    return true;
  }
  return false;
}

function markPostSeen(post) {
  if (!post?.key || seenPosts.has(post.key)) {
    return false;
  }

  seenPosts.add(post.key);
  pendingSeenPosts.set(post.key, post);
  scheduleSeenFlush();
  return true;
}

function scheduleScrolledPastCheck() {
  if (scrollCheckScheduled) {
    return;
  }

  scrollCheckScheduled = true;
  requestAnimationFrame(() => {
    scrollCheckScheduled = false;
    markScrolledPastPosts();
  });
}

function markScrolledPastPosts() {
  if (activeView !== "feed" || !currentUser) {
    return;
  }

  const cutoff = Math.min(220, Math.max(96, window.innerHeight * 0.22));
  let marked = false;

  for (const postElement of feedElement.querySelectorAll(".post[data-post-key]")) {
    const rect = postElement.getBoundingClientRect();
    if (rect.bottom >= cutoff) {
      continue;
    }

    const post = findPostByKey(postElement.dataset.postKey);
    if (markPostSeen(post)) {
      postElement.classList.add("is-seen");
      marked = true;
    }
  }

  if (marked) {
    renderNavState();
  }
}

function scheduleSeenFlush() {
  if (seenFlushTimer) {
    window.clearTimeout(seenFlushTimer);
  }
  seenFlushTimer = window.setTimeout(() => {
    void flushSeenPosts();
  }, seenFlushDelayMs);
}

async function flushSeenPosts() {
  if (seenFlushTimer) {
    window.clearTimeout(seenFlushTimer);
    seenFlushTimer = null;
  }

  if (!currentUser || pendingSeenPosts.size === 0) {
    return false;
  }

  const rows = Array.from(pendingSeenPosts.values()).map((post) => savedPostRow("seen", post));
  pendingSeenPosts = new Map();
  const synced = await upsertSavedRows(rows, { silent: true });
  if (!synced) {
    for (const row of rows) {
      const post = findPostByKey(row.post_key);
      if (post) {
        pendingSeenPosts.set(post.key, post);
      }
    }
  }
  return synced;
}

function savedPostRow(kind, post) {
  return {
    article_snapshot: articleSnapshot(post.article),
    article_title: post.article.title || "Untitled article",
    article_url: post.article.url,
    comment_snapshot: {
      body: post.body || "",
      key: post.key,
      location: post.location || "",
      name: post.name || "",
      recommendations: Number(post.recommendations || 0),
      timestamp: Number(post.timestamp || 0),
      timesPick: Boolean(post.timesPick),
    },
    kind,
    post_key: post.key,
    source_id: post.article.source.id || "",
    source_name: post.article.source.name || "",
    user_id: currentUser.id,
  };
}

function savedArticleRow(article, post = null) {
  const key = keyForArticle(article);
  return {
    article_snapshot: articleSnapshot(article),
    article_title: article.title || "Untitled article",
    article_url: article.url,
    comment_snapshot: post
      ? {
          body: post.body || "",
          key: post.key,
          location: post.location || "",
          name: post.name || "",
          recommendations: Number(post.recommendations || 0),
          timestamp: Number(post.timestamp || 0),
          timesPick: Boolean(post.timesPick),
        }
      : {},
    kind: "read",
    post_key: key,
    source_id: article.source.id || "",
    source_name: article.source.name || "",
    user_id: currentUser.id,
  };
}

function articleSnapshot(article) {
  return {
    byline: article.byline || "",
    category: article.category || "Other",
    section: article.section || "",
    source: article.source || {},
    summary: article.summary || "",
    thumbnail: article.thumbnail || "",
    title: article.title || "Untitled article",
    totalComments: Number(article.totalComments || 0),
    url: article.url,
  };
}

function postFromSavedRow(row) {
  const article = articleFromSavedRow(row);
  const commentSnapshot = row.comment_snapshot || {};

  if (!article.url || !commentSnapshot.body) {
    return null;
  }

  return {
    ...commentSnapshot,
    article,
    articleKey: article.url,
    key: row.post_key || commentSnapshot.key,
  };
}

function readFromSavedRow(row) {
  const article = articleFromSavedRow(row);
  if (!article.url) {
    return null;
  }

  return {
    article,
    createdAt: row.created_at || "",
    key: row.post_key || keyForArticle(article),
  };
}

function articleFromSavedRow(row) {
  const articleSnapshot = row.article_snapshot || {};
  const article = {
    byline: articleSnapshot.byline || "",
    category: articleSnapshot.category || categoryForArticle(articleSnapshot),
    section: articleSnapshot.section || "",
    source: sourceForArticle({
      ...articleSnapshot,
      source: articleSnapshot.source || {
        id: row.source_id,
        name: row.source_name,
      },
      url: row.article_url,
    }),
    summary: articleSnapshot.summary || "",
    thumbnail: articleSnapshot.thumbnail || "",
    title: articleSnapshot.title || row.article_title || "Untitled article",
    totalComments: Number(articleSnapshot.totalComments || 0),
    url: articleSnapshot.url || row.article_url,
  };

  return article;
}

function keyForPost(post) {
  return [
    post.article.url,
    Number(post.timestamp || 0),
    handleFor(post.name, "reader"),
    hashText(post.body || "").toString(36),
  ].join("::");
}

function keyForArticle(article) {
  return `article::${hashText(article.url || article.title || "").toString(36)}`;
}

function declumpPosts(posts, options = {}) {
  const articleWindow = options.articleWindow || 4;
  const sourceWindow = options.sourceWindow || 2;
  const lookAhead = options.lookAhead || 28;
  const remaining = posts.slice();
  const output = [];
  const recentArticles = [];
  const recentSources = [];

  while (remaining.length > 0) {
    const searchLimit = Math.min(remaining.length, lookAhead);
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index < searchLimit; index += 1) {
      const post = remaining[index];
      const articleIndex = recentArticles.indexOf(post.articleKey);
      const sourceIndex = recentSources.indexOf(post.article.source.id);
      let score = index * (activeSort === "recent" ? 0.4 : 0.12);

      if (articleIndex !== -1) {
        score += 90 - articleIndex * 10;
      }

      if (sourceIndex !== -1) {
        score += 8 - sourceIndex * 2;
      }

      score += randomScore(`${post.key}:declump`) * 0.01;

      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    const [nextPost] = remaining.splice(bestIndex, 1);
    output.push(nextPost);
    recentArticles.unshift(nextPost.articleKey);
    recentSources.unshift(nextPost.article.source.id);
    recentArticles.length = Math.min(recentArticles.length, articleWindow);
    recentSources.length = Math.min(recentSources.length, sourceWindow);
  }

  return output;
}

function popularityBucket(post) {
  const likes = Number(post.recommendations || 0);
  const articleComments = Number(post.article.totalComments || 0);
  return Math.floor(Math.log10(likes + 1) * 12) + Math.floor(Math.log10(articleComments + 1) * 2);
}

function recencyBucket(post) {
  const timestamp = Number(post.timestamp || 0);
  return timestamp > 0 ? Math.floor(timestamp / (60 * 60 * 2)) : 0;
}

function articleRank(article) {
  return Math.floor(Math.log10(Number(article.totalComments || 0) + 1) * 10);
}

function getWriterStats() {
  const writers = new Map();

  for (const key of likedPosts) {
    addWriterInteraction(writers, findPostByKey(key)?.article, "likes");
  }

  for (const key of bookmarkedPosts) {
    addWriterInteraction(writers, findPostByKey(key)?.article, "bookmarks");
  }

  for (const read of readArticles.values()) {
    addWriterInteraction(writers, read.article, "reads");
  }

  return Array.from(writers.values())
    .map((writer) => ({
      ...writer,
      articleTitles: Array.from(writer.articleTitles),
      articles: Array.from(writer.articles.values()),
      total: writer.likes + writer.bookmarks + writer.reads,
    }))
    .sort((a, b) => b.total - a.total || b.reads - a.reads || a.name.localeCompare(b.name));
}

function addWriterInteraction(writers, article, kind) {
  if (!article?.url) {
    return;
  }

  for (const writerName of writersForByline(article.byline)) {
    const writer = writers.get(writerName) || {
      articleTitles: new Set(),
      articles: new Map(),
      bookmarks: 0,
      likes: 0,
      name: writerName,
      reads: 0,
    };

    writer[kind] += 1;
    writer.articleTitles.add(article.title);
    writer.articles.set(article.url, article);
    writers.set(writerName, writer);
  }
}

function writersForByline(byline) {
  const cleaned = String(byline || "")
    .replace(/^by\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(/\s+(?:and|&)\s+|,\s*/)
    .map((name) => name.trim())
    .filter((name) => name.length > 1);
}

function randomOrder(left, right) {
  return randomScore(left) - randomScore(right);
}

function randomScore(value) {
  return hashText(`${feedRandomSeed}:${value}`) / 0xffffffff;
}

function categoryForArticle(article) {
  const section = String(article.section || "");
  const haystack = `${section} ${article.title || ""} ${article.url || ""}`.toLowerCase();

  if (/(opinion|letters|editorial|the post's view)/.test(haystack)) return "Opinion";
  if (/(politics|white house|congress|election|courts|law|justice|the 5-minute fix)/.test(haystack)) return "Politics";
  if (/(tech|technology|openai|artificial intelligence|chips?)/.test(haystack)) return "Tech";
  if (/(business|markets|economy|finance|stocks|ripple|media)/.test(haystack)) return "Business";
  if (/(world|europe|middle east|foreign policy|national security|americas|china|iran|ukraine)/.test(haystack)) return "World";
  if (/(sports|soccer|world-cup|world cup)/.test(haystack)) return "Sports";
  if (/(arts|art|books|theater|music|culture|magazine|t-magazine)/.test(haystack)) return "Culture";
  if (/(food|dining|recipe)/.test(haystack)) return "Food";
  if (/(style|fashion|travel|life|well|health)/.test(haystack)) return "Lifestyle";
  if (/(science|climate)/.test(haystack)) return "Science";
  if (/weather/.test(haystack)) return "Weather";
  if (/(d\.c\.|md\.|va\.|nyregion|national|us|u\.s\.|local)/.test(haystack)) return "U.S.";

  return titleCase(section || "Other");
}

function likeButton(post, pressed) {
  const count = Number(post.recommendations || 0) + (pressed ? 1 : 0);
  const label = pressed ? "Liked" : "Like";
  const button = actionButton("heart", formatCount(count), "like", post.key, pressed, "like-action");
  button.title = `${label} (${formatCount(count)})`;
  button.setAttribute("aria-label", `${label}, ${formatCount(count)} likes`);
  return button;
}

function showMoreButton(key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "show-more";
  button.dataset.action = "expand-comment";
  button.dataset.postKey = key;
  button.textContent = "Show more...";
  button.setAttribute("aria-label", "Show full comment");
  return button;
}

function previewComment(value) {
  const text = String(value || "").trim();
  const preview = text.slice(0, commentPreviewLength).trimEnd();
  const boundary = preview.lastIndexOf(" ");
  const cleanPreview = boundary > 180 ? preview.slice(0, boundary).trimEnd() : preview;
  return `${cleanPreview}...`;
}

function actionButton(iconName, label, action, key, pressed, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action ${className}`.trim();
  button.dataset.action = action;
  button.dataset.postKey = key;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(pressed));
  button.classList.toggle("is-active", pressed);
  button.innerHTML = `${icon(iconName)}<span>${label}</span>`;
  return button;
}

function badge(text, className) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function metaText(text) {
  const element = document.createElement("span");
  element.className = "card-meta-text";
  element.textContent = text;
  return element;
}

function emptyState(title, detail) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";

  const heading = document.createElement("strong");
  heading.textContent = title;

  const copy = document.createElement("span");
  copy.textContent = detail;

  wrapper.append(heading, copy);
  return wrapper;
}

function emptyStateLine(text) {
  const empty = document.createElement("p");
  empty.className = "panel-empty";
  empty.textContent = text;
  return empty;
}

function emptyTitleForView() {
  if (activeView === "likes") return "No liked comments match.";
  if (activeView === "bookmarks") return "No saved comments match.";
  if (activeView === "reads") return "No reads match.";
  if (activeView === "writers") return "No writers yet.";
  return "No comments match.";
}

function emptyDetailForView() {
  if (selectedCategories.size > 0 || activeSources.size !== sources.length) {
    return "Try widening the filters.";
  }
  if (activeView === "likes") return "Use Like on any comment to collect it here.";
  if (activeView === "bookmarks") return "Use Save on any comment to build your account reading list.";
  if (activeView === "reads") return "Open an article from the feed to collect it here.";
  if (activeView === "writers") return "Like, save, or read articles to build this list.";
  return "Try running a fresh scrape.";
}

function sourceForArticle(article) {
  const source = article?.source || {};
  const domain = cleanDomain(source.domain || domainForUrl(article?.url) || "news");
  return {
    domain,
    id: cleanSourceId(source.id || domain),
    name: String(source.name || domain).trim() || domain,
  };
}

function domainForUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function cleanDomain(value) {
  return String(value || "").replace(/^www\./i, "").trim() || "news";
}

function cleanSourceId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "source";
}

function initialFor(name, fallback = "N") {
  const trimmed = String(name || fallback).trim();
  return trimmed ? trimmed[0].toLocaleUpperCase() : fallback;
}

function handleFor(name, fallback = "reader") {
  const handle = String(name || fallback)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 18);
  return handle || "reader";
}

function avatarColor(name) {
  const colors = ["#2bb6a8", "#f05a6e", "#5f8df7", "#d68a19", "#7d5df1", "#2c9f63", "#e05291"];
  let hash = 0;
  for (const character of String(name || "")) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return colors[hash % colors.length];
}

function relativeTime(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "now";
  }

  const elapsed = Math.max(0, Math.floor((Date.now() - seconds * 1000) / 1000));
  const units = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];

  for (const [unitSeconds, label] of units) {
    if (elapsed >= unitSeconds) {
      return `${Math.floor(elapsed / unitSeconds)}${label}`;
    }
  }

  return "now";
}

function relativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }

  const elapsed = Math.max(0, Date.now() - date.getTime());
  const days = Math.floor(elapsed / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isoTime(timestamp) {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : "";
}

function formatCount(value) {
  const number = Number(value || 0);
  if (number >= 1000000) {
    return `${trimNumber(number / 1000000)}M`;
  }
  if (number >= 1000) {
    return `${trimNumber(number / 1000)}K`;
  }
  return String(number);
}

function trimNumber(value) {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function titleCase(value) {
  return String(value || "Other")
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (["us", "u.s."].includes(lower)) return "U.S.";
      if (["d.c.", "dc"].includes(lower)) return "D.C.";
      return lower[0].toUpperCase() + lower.slice(1);
    })
    .join(" ") || "Other";
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readTheme() {
  const stored = readText(storageKeys.theme, "");
  if (stored === "dark" || stored === "light") {
    return stored;
  }
  return "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function setMobileMenu(open) {
  document.body.classList.toggle("menu-open", open);
  mobileMenuToggle?.setAttribute("aria-expanded", String(open));
}

function closeMobileMenu() {
  setMobileMenu(false);
}

function readArray(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeArray(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readText(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeText(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function icon(name) {
  const paths = {
    "book-open": '<path d="M12 7v14"/><path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H12v18H5.5A2.5 2.5 0 0 1 3 18.5z"/><path d="M21 5.5A2.5 2.5 0 0 0 18.5 3H12v18h6.5A2.5 2.5 0 0 0 21 18.5z"/>',
    bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    moon: '<path d="M20 14.6A8 8 0 0 1 9.4 4 7 7 0 1 0 20 14.6z"/>',
    pen: '<path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5z"/><path d="m15 5 4 4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
  };

  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.home}</svg>`;
}
