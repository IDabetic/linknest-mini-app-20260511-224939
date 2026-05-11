import { useEffect, useMemo, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams
} from "react-router-dom";
import { hasSupabaseEnv, supabase } from "./lib/supabase";
import { isLikelyUrl, slugify, stripAtPrefix } from "./lib/utils";

const DEMO_DB_KEY = "linknest_demo_v1";
const DEMO_SESSION_KEY = "linknest_demo_session_v1";
const MASTER_ADMIN_EMAILS = String(import.meta.env.VITE_MASTER_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const ADMIN_EMAILS = String(import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const PLAN_OPTIONS = ["free", "starter", "pro", "premium"];
const PLAN_LINK_LIMITS = {
  free: 5,
  starter: 20,
  pro: 100,
  premium: Number.POSITIVE_INFINITY
};
const LIMITS = {
  slug: 40,
  displayName: 80,
  bio: 280,
  avatarUrl: 500,
  linkTitle: 80,
  linkUrl: 500,
  linkTag: 24
};
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

function isConfiguredMasterAdminEmail(email) {
  if (!email) return false;
  const clean = String(email).toLowerCase();
  return MASTER_ADMIN_EMAILS.includes(clean) || ADMIN_EMAILS.includes(clean);
}

function isSessionAdmin(session, useDemoMode) {
  if (!session?.user) return false;
  if (useDemoMode) {
    return session.user.role === "master_admin";
  }
  return session.user.role === "master_admin";
}

function nowIso() {
  return new Date().toISOString();
}

function toDateKey(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function lastNDaysKeys(days) {
  const keys = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const copy = new Date(today);
    copy.setDate(today.getDate() - i);
    keys.push(toDateKey(copy));
  }
  return keys;
}

function toPrettyDate(key) {
  if (!key) return "";
  const date = new Date(`${key}T00:00:00Z`);
  return new Intl.DateTimeFormat("sr-RS", { day: "2-digit", month: "2-digit" }).format(date);
}

function buildAnalyticsSummary(events, links) {
  const safeEvents = Array.isArray(events) ? events : [];
  const safeLinks = Array.isArray(links) ? links : [];
  const views = safeEvents.filter((event) => event.event_type === "view").length;
  const clicks = safeEvents.filter((event) => event.event_type === "click").length;
  const ctr = views > 0 ? (clicks / views) * 100 : 0;

  const clicksByLinkId = safeEvents.reduce((acc, event) => {
    if (event.event_type !== "click" || !event.link_id) return acc;
    acc[event.link_id] = (acc[event.link_id] || 0) + 1;
    return acc;
  }, {});

  const topLinks = safeLinks
    .map((link) => ({
      id: link.id,
      title: link.title || "Bez naslova",
      url: link.url || "",
      clicks: clicksByLinkId[link.id] || 0
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5);

  const range = lastNDaysKeys(7);
  const dailyMap = range.reduce((acc, key) => {
    acc[key] = { date: key, views: 0, clicks: 0 };
    return acc;
  }, {});

  safeEvents.forEach((event) => {
    const key = toDateKey(event.created_at);
    if (!dailyMap[key]) return;
    if (event.event_type === "view") dailyMap[key].views += 1;
    if (event.event_type === "click") dailyMap[key].clicks += 1;
  });

  const daily = range.map((key) => ({
    ...dailyMap[key],
    label: toPrettyDate(key)
  }));

  return {
    views,
    clicks,
    ctr,
    topLinks,
    daily
  };
}

function createDefaultDemoDb() {
  return { users: [], profiles: [], links: [], events: [] };
}

function readDemoDb() {
  try {
    const raw = localStorage.getItem(DEMO_DB_KEY);
    if (!raw) {
      return createDefaultDemoDb();
    }
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      links: Array.isArray(parsed.links) ? parsed.links : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch {
    return createDefaultDemoDb();
  }
}

function writeDemoDb(db) {
  localStorage.setItem(DEMO_DB_KEY, JSON.stringify(db));
}

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function clampText(value, maxLen) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizePlan(value) {
  return PLAN_OPTIONS.includes(value) ? value : "free";
}

async function hashDemoPassword(password) {
  const raw = String(password || "");
  if (!raw) return "";

  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const bytes = new TextEncoder().encode(raw);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const arr = Array.from(new Uint8Array(digest));
      return arr.map((n) => n.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fallback below
  }

  return raw;
}

function firePublicAnalyticsEvent(payload) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;

  const safePayload = {
    owner_user_id: payload.owner_user_id,
    link_id: payload.link_id ?? null,
    event_type: payload.event_type,
    source_slug: clampText(payload.source_slug, 80),
    referrer: clampText(payload.referrer, 500),
    user_agent: clampText(payload.user_agent, 500)
  };

  fetch(`${SUPABASE_URL}/rest/v1/analytics_events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: "return=minimal"
    },
    keepalive: true,
    body: JSON.stringify(safePayload)
  }).catch(() => {
    // Ignore analytics network errors
  });
}

function getUniqueSlug(baseSlug, profiles, excludeUserId = null) {
  const base = slugify(baseSlug) || "creator";
  let candidate = base;
  let counter = 1;

  while (profiles.some((profile) => profile.slug === candidate && profile.user_id !== excludeUserId)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }

  return candidate;
}

function demoGetSession() {
  const userId = localStorage.getItem(DEMO_SESSION_KEY);
  if (!userId) return null;

  const db = readDemoDb();
  const user = db.users.find((row) => row.id === userId);
  if (!user) {
    localStorage.removeItem(DEMO_SESSION_KEY);
    return null;
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role || "user",
      status: user.status || "active",
      plan: user.plan || "free"
    }
  };
}

async function demoSignUp(email, password) {
  const db = readDemoDb();
  const cleanEmail = email.trim().toLowerCase();

  if (db.users.some((user) => user.email === cleanEmail)) {
    throw new Error("Korisnik je vec registrovan.");
  }

  const passwordHash = await hashDemoPassword(password);
  const shouldBeMasterAdmin = db.users.length === 0 || isConfiguredMasterAdminEmail(cleanEmail);
  const user = {
    id: generateId(),
    email: cleanEmail,
    password_hash: passwordHash,
    role: shouldBeMasterAdmin ? "master_admin" : "user",
    status: "active",
    plan: "free",
    created_at: nowIso()
  };

  db.users.push(user);
  writeDemoDb(db);
  localStorage.setItem(DEMO_SESSION_KEY, user.id);

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      plan: user.plan
    }
  };
}

async function demoSignIn(email, password) {
  const db = readDemoDb();
  const cleanEmail = email.trim().toLowerCase();
  const passwordHash = await hashDemoPassword(password);

  const user = db.users.find((row) => {
    if (row.email !== cleanEmail) return false;
    if (row.password_hash) return row.password_hash === passwordHash;
    return row.password === password;
  });
  if (!user) {
    throw new Error("Neispravni podaci za prijavu.");
  }
  if (user.status === "suspended") {
    throw new Error("Nalog je suspendovan. Kontaktiraj administratora.");
  }

  if (!user.password_hash && user.password) {
    user.password_hash = passwordHash;
    delete user.password;
    writeDemoDb(db);
  }

  localStorage.setItem(DEMO_SESSION_KEY, user.id);

  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role || "user",
      status: user.status || "active",
      plan: user.plan || "free"
    }
  };
}

function demoSignOut() {
  localStorage.removeItem(DEMO_SESSION_KEY);
}

function demoEnsureProfile(user) {
  const db = readDemoDb();
  const existing = db.profiles.find((profile) => profile.user_id === user.id);
  if (existing) {
    return existing;
  }

  const base = slugify(stripAtPrefix(user.email)) || "creator";
  const profile = {
    user_id: user.id,
    email: user.email,
    slug: getUniqueSlug(base, db.profiles),
    display_name: stripAtPrefix(user.email),
    bio: "",
    avatar_url: "",
    role: user.role || "user",
    status: user.status || "active",
    plan: user.plan || "free",
    created_at: nowIso(),
    updated_at: nowIso()
  };

  db.profiles.push(profile);
  writeDemoDb(db);
  return profile;
}

function demoUpdateProfile(userId, payload) {
  const db = readDemoDb();
  const index = db.profiles.findIndex((profile) => profile.user_id === userId);

  if (index === -1) {
    throw new Error("Profil nije pronadjen.");
  }

  const cleanSlug = slugify(payload.slug);
  if (!cleanSlug) {
    throw new Error("Slug je obavezan.");
  }

  const taken = db.profiles.some((profile) => profile.slug === cleanSlug && profile.user_id !== userId);
  if (taken) {
    const error = new Error("Taj slug je vec zauzet.");
    error.code = "23505";
    throw error;
  }

  const next = {
    ...db.profiles[index],
    slug: cleanSlug,
    display_name: payload.display_name.trim(),
    bio: payload.bio.trim(),
    avatar_url: payload.avatar_url.trim(),
    updated_at: nowIso()
  };

  db.profiles[index] = next;
  writeDemoDb(db);
  return next;
}

function demoListLinks(userId) {
  const db = readDemoDb();
  return db.links
    .filter((link) => link.user_id === userId)
    .sort((a, b) => a.position - b.position)
    .map((link) => ({ ...link }));
}

function demoAddLink(userId) {
  const db = readDemoDb();
  const position = db.links.filter((link) => link.user_id === userId).length;

  const row = {
    id: generateId(),
    user_id: userId,
    title: "Novi link",
    url: "https://example.com",
    tag: "",
    position
  };

  db.links.push(row);
  writeDemoDb(db);
  return { ...row };
}

function demoUpdateLink(userId, linkId, payload) {
  const db = readDemoDb();
  const index = db.links.findIndex((link) => link.id === linkId && link.user_id === userId);

  if (index === -1) {
    throw new Error("Link nije pronadjen.");
  }

  db.links[index] = {
    ...db.links[index],
    title: payload.title.trim(),
    url: payload.url.trim(),
    tag: payload.tag.trim()
  };

  writeDemoDb(db);
  return { ...db.links[index] };
}

function demoDeleteLink(userId, linkId) {
  const db = readDemoDb();
  db.links = db.links.filter((link) => !(link.id === linkId && link.user_id === userId));

  const remaining = db.links
    .filter((link) => link.user_id === userId)
    .sort((a, b) => a.position - b.position)
    .map((link, index) => ({ ...link, position: index }));

  db.links = db.links.filter((link) => link.user_id !== userId).concat(remaining);
  writeDemoDb(db);
}

function demoSetLinkPositions(userId, rows) {
  const db = readDemoDb();

  const normalized = rows.map((row, index) => ({ ...row, position: index }));
  const otherUsers = db.links.filter((link) => link.user_id !== userId);
  db.links = otherUsers.concat(normalized);

  writeDemoDb(db);
  return normalized;
}

function demoGetPublicProfile(slug) {
  const db = readDemoDb();
  const profile = db.profiles.find((row) => row.slug === slug);
  if (!profile) return null;
  if (profile.status === "suspended") return null;

  const links = db.links
    .filter((link) => link.user_id === profile.user_id)
    .sort((a, b) => a.position - b.position)
    .map((link) => ({ ...link }));

  return {
    profile: { ...profile },
    links
  };
}

function demoRecordEvent({ ownerUserId, eventType, linkId = null, sourceSlug = "" }) {
  const db = readDemoDb();
  db.events.push({
    id: generateId(),
    owner_user_id: ownerUserId,
    event_type: eventType,
    link_id: linkId,
    source_slug: sourceSlug || "",
    created_at: nowIso()
  });
  writeDemoDb(db);
}

function demoRecordProfileView(ownerUserId, sourceSlug) {
  demoRecordEvent({ ownerUserId, eventType: "view", sourceSlug });
}

function demoRecordLinkClick(ownerUserId, linkId, sourceSlug) {
  demoRecordEvent({ ownerUserId, eventType: "click", linkId, sourceSlug });
}

function demoGetUserAnalytics(userId) {
  const db = readDemoDb();
  const events = db.events.filter((event) => event.owner_user_id === userId);
  const links = db.links.filter((link) => link.user_id === userId);
  return buildAnalyticsSummary(events, links);
}

function demoGetGlobalAnalytics() {
  const db = readDemoDb();
  return buildAnalyticsSummary(db.events, db.links);
}

function demoListAdminRows() {
  const db = readDemoDb();
  const linksByUserId = db.links.reduce((acc, link) => {
    const key = link.user_id;
    acc[key] = acc[key] || [];
    acc[key].push(link);
    return acc;
  }, {});
  const eventsByUserId = db.events.reduce((acc, event) => {
    const key = event.owner_user_id;
    acc[key] = acc[key] || [];
    acc[key].push(event);
    return acc;
  }, {});

  return db.users
    .map((user) => {
      const profile = db.profiles.find((row) => row.user_id === user.id);
      const userLinks = linksByUserId[user.id] || [];
      const userEvents = eventsByUserId[user.id] || [];
      const analytics = buildAnalyticsSummary(userEvents, userLinks);
      return {
        user_id: user.id,
        email: user.email,
        role: user.role === "master_admin" ? "master_admin" : "user",
        status: user.status === "suspended" ? "suspended" : "active",
        plan: normalizePlan(user.plan),
        slug: profile?.slug || "",
        display_name: profile?.display_name || "",
        bio: profile?.bio || "",
        links_count: userLinks.length,
        views: analytics.views,
        clicks: analytics.clicks,
        ctr: analytics.ctr
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

function demoUpdateUserMetaAsAdmin(targetUserId, patch) {
  const db = readDemoDb();
  const userIndex = db.users.findIndex((user) => user.id === targetUserId);
  const profileIndex = db.profiles.findIndex((profile) => profile.user_id === targetUserId);

  if (userIndex === -1) {
    throw new Error("Korisnik nije pronadjen.");
  }

  const nextRole = patch.role || db.users[userIndex].role || "user";
  const nextStatus = patch.status || db.users[userIndex].status || "active";
  const nextPlan = patch.plan || db.users[userIndex].plan || "free";

  if (!PLAN_OPTIONS.includes(nextPlan)) {
    throw new Error("Nepoznat plan.");
  }
  if (!["user", "master_admin"].includes(nextRole)) {
    throw new Error("Nepoznata rola.");
  }
  if (!["active", "suspended"].includes(nextStatus)) {
    throw new Error("Nepoznat status.");
  }

  const currentMasterAdmins = db.users.filter((user) => user.role === "master_admin").length;
  if (
    db.users[userIndex].role === "master_admin" &&
    nextRole !== "master_admin" &&
    currentMasterAdmins <= 1
  ) {
    throw new Error("Mora postojati bar jedan master admin.");
  }

  db.users[userIndex] = {
    ...db.users[userIndex],
    role: nextRole,
    status: nextStatus,
    plan: nextPlan
  };

  if (profileIndex !== -1) {
    db.profiles[profileIndex] = {
      ...db.profiles[profileIndex],
      role: nextRole,
      status: nextStatus,
      plan: nextPlan,
      updated_at: nowIso()
    };
  }

  writeDemoDb(db);
}

function demoClearUserContentAsAdmin(targetUserId) {
  const db = readDemoDb();
  db.links = db.links.filter((link) => link.user_id !== targetUserId);
  db.events = db.events.filter((event) => event.owner_user_id !== targetUserId);
  writeDemoDb(db);
}

function demoDeleteUserAsAdmin(targetUserId) {
  const db = readDemoDb();
  const target = db.users.find((user) => user.id === targetUserId);
  if (!target) {
    throw new Error("Korisnik nije pronadjen.");
  }

  const currentMasterAdmins = db.users.filter((user) => user.role === "master_admin").length;
  if (target.role === "master_admin" && currentMasterAdmins <= 1) {
    throw new Error("Mora postojati bar jedan master admin.");
  }

  db.users = db.users.filter((user) => user.id !== targetUserId);
  db.profiles = db.profiles.filter((profile) => profile.user_id !== targetUserId);
  db.links = db.links.filter((link) => link.user_id !== targetUserId);
  db.events = db.events.filter((event) => event.owner_user_id !== targetUserId);

  // Always keep at least one admin in demo mode.
  if (db.users.length > 0 && !db.users.some((user) => user.role === "master_admin")) {
    db.users[0].role = "master_admin";
  }

  writeDemoDb(db);
  if (localStorage.getItem(DEMO_SESSION_KEY) === targetUserId) {
    localStorage.removeItem(DEMO_SESSION_KEY);
  }
}

function App() {
  const useDemoMode = !hasSupabaseEnv;
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);

  async function enrichSupabaseSession(baseSession) {
    if (!baseSession?.user) return null;

    const email = baseSession.user.email || "";
    const fallbackRole = "user";

    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("role, status, plan")
        .eq("user_id", baseSession.user.id)
        .maybeSingle();

      if (error) {
        return {
          ...baseSession,
          user: {
            ...baseSession.user,
            role: fallbackRole,
            status: "active",
            plan: "free"
          }
        };
      }

      return {
        ...baseSession,
        user: {
          ...baseSession.user,
          role: data?.role || fallbackRole,
          status: data?.status || "active",
          plan: data?.plan || "free"
        }
      };
    } catch {
      return {
        ...baseSession,
        user: {
          ...baseSession.user,
          role: fallbackRole,
          status: "active",
          plan: "free"
        }
      };
    }
  }

  useEffect(() => {
    if (useDemoMode) {
      setSession(demoGetSession());
      setBooting(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      const enriched = await enrichSupabaseSession(data.session ?? null);
      if (!mounted) return;
      setSession(enriched);
      setBooting(false);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      enrichSupabaseSession(nextSession).then((enriched) => {
        setSession(enriched);
      });
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [useDemoMode]);

  async function handleSignOut() {
    if (useDemoMode) {
      demoSignOut();
      setSession(null);
      return;
    }

    await supabase.auth.signOut();
    setSession(null);
  }

  async function refreshSession() {
    if (useDemoMode || !supabase) return;
    const { data } = await supabase.auth.getSession();
    const enriched = await enrichSupabaseSession(data.session ?? null);
    setSession(enriched);
  }

  if (booting) {
    return <CenterNotice title="Ucitavanje" message="Pokrecem aplikaciju..." />;
  }

  const isAdmin = isSessionAdmin(session, useDemoMode);

  return (
    <Routes>
      <Route
        path="/"
        element={
          <LandingPage
            session={session}
            isAdmin={isAdmin}
            useDemoMode={useDemoMode}
            onSessionChange={setSession}
            onSignOut={handleSignOut}
          />
        }
      />
      <Route
        path="/dashboard"
        element={
          session ? (
            session.user.status === "suspended" && !isAdmin ? (
              <SuspendedPage onSignOut={handleSignOut} />
            ) : (
              <DashboardPage
                user={session.user}
                isAdmin={isAdmin}
                useDemoMode={useDemoMode}
                onSignOut={handleSignOut}
                onRefreshSession={refreshSession}
              />
            )
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/admin"
        element={
          session ? (
            isAdmin ? (
              <AdminPage
                currentUser={session.user}
                useDemoMode={useDemoMode}
                onForceSignOut={handleSignOut}
                onRefreshSession={refreshSession}
              />
            ) : (
              <Navigate to="/dashboard" replace />
            )
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="/u/:slug" element={<PublicProfilePage useDemoMode={useDemoMode} />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function LandingPage({ session, isAdmin, useDemoMode, onSessionChange, onSignOut }) {
  return (
    <div className="page">
      <div className="bg-orb bg-orb-a" aria-hidden="true" />
      <div className="bg-orb bg-orb-b" aria-hidden="true" />

      <main className="layout">
        <section className="hero panel">
          <p className="eyebrow">Link-in-bio SaaS</p>
          <h1>Korisnici mogu da naprave svoju profil stranicu za par minuta.</h1>
          <p>
            LinkNest svakom korisniku daje nalog, dashboard i javni URL u formatu
            <code>/u/slug</code>.
          </p>

          {useDemoMode ? (
            <p className="form-message">
              Demo rezim je aktivan. Podaci se cuvaju u ovom browseru dok ne podesimo Supabase
              varijable.
            </p>
          ) : null}

          {session ? (
            <div className="hero-actions">
              <Link className="btn btn-solid" to="/dashboard">
                Otvori dashboard
              </Link>
              {isAdmin ? (
                <Link className="btn btn-outline" to="/admin">
                  Admin panel
                </Link>
              ) : null}
              <button className="btn btn-outline" type="button" onClick={onSignOut}>
                Odjavi se
              </button>
            </div>
          ) : (
            <div className="hero-points">
              <span>Nalog + profili</span>
              <span>Uredjivanje linkova</span>
              <span>Javne stranice</span>
            </div>
          )}
        </section>

        {!session && (
          <AuthCard useDemoMode={useDemoMode} onSessionChange={onSessionChange} />
        )}
      </main>
    </div>
  );
}

function AuthCard({ useDemoMode, onSessionChange }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanPassword) {
      setLoading(false);
      setMessage("Email i lozinka su obavezni.");
      return;
    }

    if (useDemoMode) {
      try {
        const nextSession =
          mode === "signup"
            ? await demoSignUp(cleanEmail, cleanPassword)
            : await demoSignIn(cleanEmail, cleanPassword);
        onSessionChange(nextSession);
        navigate("/dashboard");
      } catch (error) {
        setMessage(error.message || "Prijava nije uspela.");
      }
      setLoading(false);
      return;
    }

    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password: cleanPassword
      });

      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }

      if (data.session) {
        onSessionChange({
          ...data.session,
          user: {
            ...data.session.user,
            role: "user",
            status: "active",
            plan: "free"
          }
        });
        navigate("/dashboard");
        setLoading(false);
        return;
      }

      setMessage("Proveri email i potvrdi nalog pre prijave.");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword
    });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    onSessionChange(
      data.session
        ? {
            ...data.session,
            user: {
              ...data.session.user,
              role: "user",
              status: "active",
              plan: "free"
            }
          }
        : null
    );
    navigate("/dashboard");
    setLoading(false);
  }

  return (
    <section className="panel auth-panel">
      <div className="auth-tabs">
        <button
          type="button"
          className={mode === "signin" ? "tab active" : "tab"}
          onClick={() => setMode("signin")}
        >
          Prijava
        </button>
        <button
          type="button"
          className={mode === "signup" ? "tab active" : "tab"}
          onClick={() => setMode("signup")}
        >
          Kreiraj nalog
        </button>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          Email adresa
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="ti@biznis.com"
          />
        </label>

        <label>
          Lozinka
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Najmanje 8 karaktera"
          />
        </label>

        <button type="submit" className="btn btn-solid" disabled={loading}>
          {loading ? "Sacekaj..." : mode === "signin" ? "Prijava" : "Kreiraj nalog"}
        </button>

        {message ? <p className="form-message">{message}</p> : null}
      </form>
    </section>
  );
}

function DashboardPage({ user, isAdmin, useDemoMode, onSignOut, onRefreshSession }) {
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [profile, setProfile] = useState({
    email: "",
    slug: "",
    display_name: "",
    bio: "",
    avatar_url: "",
    role: "user",
    status: "active",
    plan: "free"
  });
  const [links, setLinks] = useState([]);
  const [analytics, setAnalytics] = useState({ views: 0, clicks: 0, ctr: 0, topLinks: [], daily: [] });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingLinks, setSavingLinks] = useState(false);

  const publicPage = useMemo(() => {
    if (!profile.slug) return "";
    return `${window.location.origin}/u/${profile.slug}`;
  }, [profile.slug]);

  useEffect(() => {
    loadUserData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, useDemoMode]);

  async function ensureProfile() {
    if (useDemoMode) {
      return demoEnsureProfile(user);
    }

    const { data: existing, error: existingError } = await supabase
      .from("profiles")
      .select("user_id, email, slug, display_name, bio, avatar_url, role, status, plan")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      return existing;
    }

    const base = slugify(stripAtPrefix(user.email)) || "creator";
    const fallbackSlug = `${base}-${user.id.slice(0, 6)}`;
    const fallbackRole = "user";

    const { data: created, error: createError } = await supabase
      .from("profiles")
      .insert({
        user_id: user.id,
        email: user.email || "",
        slug: fallbackSlug,
        display_name: stripAtPrefix(user.email),
        bio: "",
        avatar_url: "",
        role: fallbackRole,
        status: "active",
        plan: "free"
      })
      .select("user_id, email, slug, display_name, bio, avatar_url, role, status, plan")
      .single();

    if (createError) {
      throw createError;
    }

    return created;
  }

  async function refreshAnalytics(optionalLinks) {
    if (useDemoMode) {
      setAnalytics(demoGetUserAnalytics(user.id));
      return;
    }

    const { data: eventRows, error: eventsError } = await supabase
      .from("analytics_events")
      .select("id, owner_user_id, link_id, event_type, created_at")
      .eq("owner_user_id", user.id);

    if (eventsError) {
      throw eventsError;
    }

    const activeLinks = optionalLinks || links;
    setAnalytics(buildAnalyticsSummary(eventRows ?? [], activeLinks));
  }

  async function loadUserData() {
    setLoading(true);
    setNotice("");

    try {
      const row = await ensureProfile();

      setProfile({
        email: row.email ?? user.email ?? "",
        slug: row.slug ?? "",
        display_name: row.display_name ?? "",
        bio: row.bio ?? "",
        avatar_url: row.avatar_url ?? "",
        role: row.role === "master_admin" ? "master_admin" : "user",
        status: row.status === "suspended" ? "suspended" : "active",
        plan: normalizePlan(row.plan)
      });

      if (
        !useDemoMode &&
        (row.role !== user.role || row.status !== user.status || row.plan !== user.plan)
      ) {
        await onRefreshSession?.();
      }

      if (useDemoMode) {
        const userLinks = demoListLinks(user.id);
        setLinks(userLinks);
        await refreshAnalytics(userLinks);
      } else {
        const [linksRes, eventsRes] = await Promise.all([
          supabase
            .from("links")
            .select("id, user_id, title, url, tag, position")
            .eq("user_id", user.id)
            .order("position", { ascending: true }),
          supabase
            .from("analytics_events")
            .select("id, owner_user_id, link_id, event_type, created_at")
            .eq("owner_user_id", user.id)
        ]);

        if (linksRes.error) {
          throw linksRes.error;
        }
        if (eventsRes.error) {
          throw eventsRes.error;
        }

        const safeLinks = linksRes.data ?? [];
        setLinks(safeLinks);
        setAnalytics(buildAnalyticsSummary(eventsRes.data ?? [], safeLinks));
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce ucitati dashboard podatke.");
    } finally {
      setLoading(false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    setSavingProfile(true);
    setNotice("");

    const cleanSlug = slugify(profile.slug);
    if (!cleanSlug) {
      setNotice("Slug je obavezan i sme da sadrzi samo slova, brojeve i crtice.");
      setSavingProfile(false);
      return;
    }
    if (cleanSlug.length > LIMITS.slug) {
      setNotice(`Slug ne sme biti duzi od ${LIMITS.slug} karaktera.`);
      setSavingProfile(false);
      return;
    }

    const payload = {
      slug: cleanSlug,
      display_name: clampText(profile.display_name, LIMITS.displayName),
      bio: clampText(profile.bio, LIMITS.bio),
      avatar_url: clampText(profile.avatar_url, LIMITS.avatarUrl)
    };
    if (payload.avatar_url && !isLikelyUrl(payload.avatar_url)) {
      setNotice("Avatar URL mora da pocinje sa http:// ili https://.");
      setSavingProfile(false);
      return;
    }

    try {
      if (useDemoMode) {
        const next = demoUpdateProfile(user.id, payload);
        setProfile((prev) => ({
          ...prev,
          slug: next.slug,
          display_name: next.display_name,
          bio: next.bio,
          avatar_url: next.avatar_url
        }));
      } else {
        const { error } = await supabase
          .from("profiles")
          .update(payload)
          .eq("user_id", user.id)
          .select("user_id")
          .single();

        if (error) {
          throw error;
        }
      }

      setNotice("Profil je sacuvan.");
    } catch (error) {
      if (error.code === "23505") {
        setNotice("Taj slug je vec zauzet. Izaberi drugi.");
      } else {
        setNotice(error.message || "Nije moguce sacuvati profil.");
      }
    } finally {
      setSavingProfile(false);
    }
  }

  async function addLink() {
    const maxLinks = PLAN_LINK_LIMITS[normalizePlan(profile.plan)];
    if (links.length >= maxLinks) {
      setNotice(`Dosegao si limit linkova za plan "${profile.plan}" (${maxLinks}).`);
      return;
    }

    setSavingLinks(true);
    setNotice("");

    try {
      if (useDemoMode) {
        const created = demoAddLink(user.id);
        const nextLinks = [...links, created];
        setLinks(nextLinks);
        await refreshAnalytics(nextLinks);
      } else {
        const { data, error } = await supabase
          .from("links")
          .insert({
            user_id: user.id,
            title: "Novi link",
            url: "https://example.com",
            tag: "",
            position: links.length
          })
          .select("id, user_id, title, url, tag, position")
          .single();

        if (error) {
          throw error;
        }

        const nextLinks = [...links, data];
        setLinks(nextLinks);
        await refreshAnalytics(nextLinks);
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce dodati link.");
    } finally {
      setSavingLinks(false);
    }
  }

  function updateLinkField(id, field, value) {
    setLinks((prev) => prev.map((link) => (link.id === id ? { ...link, [field]: value } : link)));
  }

  async function saveLink(link) {
    const nextTitle = clampText(link.title, LIMITS.linkTitle);
    const nextUrl = clampText(link.url, LIMITS.linkUrl);
    const nextTag = clampText(link.tag, LIMITS.linkTag);

    if (!nextTitle) {
      setNotice("Svaki link mora da ima naslov.");
      return;
    }

    if (!isLikelyUrl(nextUrl)) {
      setNotice("URL svakog linka mora da pocinje sa http:// ili https://.");
      return;
    }

    setSavingLinks(true);
    setNotice("");

    try {
      if (useDemoMode) {
        demoUpdateLink(user.id, link.id, { ...link, title: nextTitle, url: nextUrl, tag: nextTag });
      } else {
        const { error } = await supabase
          .from("links")
          .update({
            title: nextTitle,
            url: nextUrl,
            tag: nextTag
          })
          .eq("id", link.id)
          .eq("user_id", user.id)
          .select("id")
          .single();

        if (error) {
          throw error;
        }
      }

      setLinks((prev) =>
        prev.map((item) =>
          item.id === link.id ? { ...item, title: nextTitle, url: nextUrl, tag: nextTag } : item
        )
      );
      setNotice("Link je sacuvan.");
    } catch (error) {
      setNotice(error.message || "Nije moguce sacuvati link.");
    } finally {
      setSavingLinks(false);
    }
  }

  async function deleteLink(id) {
    setSavingLinks(true);
    setNotice("");

    try {
      if (useDemoMode) {
        demoDeleteLink(user.id, id);
        const nextLinks = demoListLinks(user.id);
        setLinks(nextLinks);
        await refreshAnalytics(nextLinks);
      } else {
        const { error } = await supabase.from("links").delete().eq("id", id).eq("user_id", user.id);

        if (error) {
          throw error;
        }

        const remaining = links.filter((link) => link.id !== id);
        setLinks(remaining);
        await normalizePositions(remaining);
        await refreshAnalytics(remaining);
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce obrisati link.");
    } finally {
      setSavingLinks(false);
    }
  }

  async function moveLink(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= links.length) return;

    const reordered = [...links];
    const temp = reordered[index];
    reordered[index] = reordered[target];
    reordered[target] = temp;

    setLinks(reordered);
    setSavingLinks(true);
    setNotice("");

    const success = await normalizePositions(reordered);
    if (!success) {
      await loadUserData();
      setNotice("Nije moguce promeniti redosled linkova. Podaci su ponovo ucitani.");
    }

    setSavingLinks(false);
  }

  async function normalizePositions(rows) {
    if (useDemoMode) {
      const normalized = demoSetLinkPositions(user.id, rows);
      setLinks(normalized);
      return true;
    }

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const { error } = await supabase
        .from("links")
        .update({ position: i })
        .eq("id", row.id)
        .eq("user_id", user.id);

      if (error) {
        return false;
      }
    }

    setLinks((prev) => prev.map((item, idx) => ({ ...item, position: idx })));
    return true;
  }

  async function copyPublicLink() {
    if (!publicPage) return;

    try {
      await navigator.clipboard.writeText(publicPage);
      setNotice("Javni URL je kopiran.");
    } catch {
      setNotice(publicPage);
    }
  }

  if (loading) {
    return <CenterNotice title="Ucitavanje dashboard-a" message="Pripremam profil i linkove..." />;
  }

  const maxLinks = PLAN_LINK_LIMITS[normalizePlan(profile.plan)];
  const isAtPlanLimit = links.length >= maxLinks;

  return (
    <div className="page">
      <main className="layout dashboard-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Dashboard</p>
              <h2>Tvoj Link-in-Bio</h2>
              <p className="admin-meta">
                Plan: {profile.plan} | Rola: {profile.role} | Status: {profile.status}
              </p>
            </div>
            <div className="actions-inline">
              <Link className="btn btn-outline" to="/">
                Pocetna
              </Link>
              {isAdmin ? (
                <Link className="btn btn-outline" to="/admin">
                  Admin panel
                </Link>
              ) : null}
              <button className="btn btn-outline" type="button" onClick={onSignOut}>
                Odjavi se
              </button>
            </div>
          </div>

          <form className="profile-form" onSubmit={saveProfile}>
            <label>
              Prikazano ime
              <input
                value={profile.display_name}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, display_name: event.target.value }))
                }
                placeholder="Ime brenda"
              />
            </label>

            <label>
              Javni slug
              <input
                value={profile.slug}
                onChange={(event) => setProfile((prev) => ({ ...prev, slug: event.target.value }))}
                placeholder="my-brand"
              />
            </label>

            <label>
              Opis
              <textarea
                rows="3"
                value={profile.bio}
                onChange={(event) => setProfile((prev) => ({ ...prev, bio: event.target.value }))}
                placeholder="Jedna kratka recenica o tome cime se bavis"
              />
            </label>

            <label>
              Avatar URL (opciono)
              <input
                value={profile.avatar_url}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, avatar_url: event.target.value }))
                }
                placeholder="https://..."
              />
            </label>

            <div className="actions-inline">
              <button type="submit" className="btn btn-solid" disabled={savingProfile}>
                {savingProfile ? "Cuvam..." : "Sacuvaj profil"}
              </button>

              {publicPage ? (
                <>
                  <a className="btn btn-outline" href={publicPage} target="_blank" rel="noreferrer">
                    Otvori javnu stranicu
                  </a>
                  <button type="button" className="btn btn-outline" onClick={copyPublicLink}>
                    Kopiraj URL
                  </button>
                </>
              ) : null}
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Linkovi</h3>
            <button
              type="button"
              className="btn btn-solid"
              onClick={addLink}
              disabled={savingLinks || isAtPlanLimit}
            >
              Dodaj link
            </button>
          </div>
          {Number.isFinite(maxLinks) ? (
            <p className="admin-meta">
              Iskorisceno: {links.length} / {maxLinks} linkova za plan "{profile.plan}"
            </p>
          ) : (
            <p className="admin-meta">Neograniceni linkovi za plan "{profile.plan}"</p>
          )}

          {links.length === 0 ? (
            <p className="empty-state">Jos nemas linkove. Dodaj prvi.</p>
          ) : (
            <div className="link-editor-list">
              {links.map((link, index) => (
                <article key={link.id} className="link-editor-card">
                  <label>
                    Naslov
                    <input
                      value={link.title}
                      onChange={(event) => updateLinkField(link.id, "title", event.target.value)}
                    />
                  </label>

                  <label>
                    URL
                    <input
                      value={link.url}
                      onChange={(event) => updateLinkField(link.id, "url", event.target.value)}
                    />
                  </label>

                  <label>
                    Oznaka
                    <input
                      value={link.tag || ""}
                      onChange={(event) => updateLinkField(link.id, "tag", event.target.value)}
                      placeholder="Opciono"
                    />
                  </label>

                  <div className="actions-inline">
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={index === 0 || savingLinks}
                      onClick={() => moveLink(index, -1)}
                    >
                      Gore
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={index === links.length - 1 || savingLinks}
                      onClick={() => moveLink(index, 1)}
                    >
                      Dole
                    </button>
                    <button
                      type="button"
                      className="btn btn-solid"
                      disabled={savingLinks}
                      onClick={() => saveLink(link)}
                    >
                      Sacuvaj
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={savingLinks}
                      onClick={() => deleteLink(link.id)}
                    >
                      Obrisi
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {notice ? <p className="form-message">{notice}</p> : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Analitika</h3>
            <small className="admin-meta">Poslednjih 7 dana + ukupno</small>
          </div>

          <div className="admin-stats">
            <article className="stat-card">
              <strong>{analytics.views}</strong>
              <span>Pregledi stranice</span>
            </article>
            <article className="stat-card">
              <strong>{analytics.clicks}</strong>
              <span>Klikovi na linkove</span>
            </article>
            <article className="stat-card">
              <strong>{analytics.ctr.toFixed(1)}%</strong>
              <span>CTR</span>
            </article>
          </div>

          <div className="analytics-grid">
            <article className="link-editor-card">
              <h4>Top linkovi</h4>
              {analytics.topLinks.length === 0 ? (
                <p className="empty-state">Jos nema klikova.</p>
              ) : (
                <div className="analytics-list">
                  {analytics.topLinks.map((item) => (
                    <p className="admin-meta" key={item.id}>
                      <strong>{item.title}</strong>: {item.clicks} klikova
                    </p>
                  ))}
                </div>
              )}
            </article>

            <article className="link-editor-card">
              <h4>Dnevni pregled</h4>
              <div className="analytics-list">
                {analytics.daily.map((day) => (
                  <p className="admin-meta" key={day.date}>
                    {day.label}: {day.views} pregleda / {day.clicks} klikova
                  </p>
                ))}
              </div>
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}

function AdminPage({ currentUser, useDemoMode, onForceSignOut, onRefreshSession }) {
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [globalAnalytics, setGlobalAnalytics] = useState({
    views: 0,
    clicks: 0,
    ctr: 0,
    topLinks: [],
    daily: []
  });
  const [busyUserId, setBusyUserId] = useState("");

  useEffect(() => {
    loadAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useDemoMode]);

  async function loadAdminData() {
    setLoading(true);
    setNotice("");

    try {
      if (useDemoMode) {
        setRows(demoListAdminRows());
        setGlobalAnalytics(demoGetGlobalAnalytics());
      } else {
        const [profilesRes, linksRes, eventsRes] = await Promise.all([
          supabase.from("profiles").select("user_id, email, slug, display_name, bio, role, status, plan"),
          supabase.from("links").select("id, user_id, title, url"),
          supabase.from("analytics_events").select("id, owner_user_id, link_id, event_type, created_at")
        ]);

        const profiles = profilesRes.data;
        const links = linksRes.data;
        const events = eventsRes.data;
        if (profilesRes.error) throw profilesRes.error;
        if (linksRes.error) throw linksRes.error;
        if (eventsRes.error) throw eventsRes.error;

        const linksByUserId = (links || []).reduce((acc, link) => {
          const key = link.user_id;
          acc[key] = acc[key] || [];
          acc[key].push(link);
          return acc;
        }, {});
        const eventsByUserId = (events || []).reduce((acc, event) => {
          const key = event.owner_user_id;
          acc[key] = acc[key] || [];
          acc[key].push(event);
          return acc;
        }, {});

        const mapped = (profiles || [])
          .map((profile) => {
            const userLinks = linksByUserId[profile.user_id] || [];
            const userEvents = eventsByUserId[profile.user_id] || [];
            const analytics = buildAnalyticsSummary(userEvents, userLinks);
            return {
              user_id: profile.user_id,
              email: profile.email || "",
              role: profile.role === "master_admin" ? "master_admin" : "user",
              status: profile.status === "suspended" ? "suspended" : "active",
              plan: normalizePlan(profile.plan),
              slug: profile.slug || "",
              display_name: profile.display_name || "",
              bio: profile.bio || "",
              links_count: userLinks.length,
              views: analytics.views,
              clicks: analytics.clicks,
              ctr: analytics.ctr
            };
          })
          .sort((a, b) => (a.email || "").localeCompare(b.email || ""));

        setRows(mapped);
        setGlobalAnalytics(buildAnalyticsSummary(events || [], links || []));
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce ucitati admin podatke.");
    } finally {
      setLoading(false);
    }
  }

  async function updateUserMeta(row, patch) {
    if (patch.role && row.role === "master_admin" && patch.role !== "master_admin") {
      const currentMasterAdmins = rows.filter((item) => item.role === "master_admin").length;
      if (currentMasterAdmins <= 1) {
        setNotice("Mora postojati bar jedan master admin.");
        return;
      }
    }

    setBusyUserId(row.user_id);
    setNotice("");
    try {
      if (useDemoMode) {
        demoUpdateUserMetaAsAdmin(row.user_id, patch);
      } else {
        const payload = {};
        if (patch.role) payload.role = patch.role;
        if (patch.status) payload.status = patch.status;
        if (patch.plan) payload.plan = patch.plan;

        const { error } = await supabase.from("profiles").update(payload).eq("user_id", row.user_id);
        if (error) throw error;
      }

      await loadAdminData();
      setNotice("Korisnik je azuriran.");

      if (row.user_id === currentUser.id) {
        await onRefreshSession?.();
        if (patch.role === "user" || patch.status === "suspended") {
          await onForceSignOut();
        }
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce azurirati korisnika.");
    } finally {
      setBusyUserId("");
    }
  }

  async function clearUserContent(row) {
    const yes = window.confirm("Da li sigurno zelis da obrises sve linkove i analitiku ovog korisnika?");
    if (!yes) return;

    setBusyUserId(row.user_id);
    setNotice("");
    try {
      if (useDemoMode) {
        demoClearUserContentAsAdmin(row.user_id);
      } else {
        const { error: linksError } = await supabase.from("links").delete().eq("user_id", row.user_id);
        if (linksError) throw linksError;
        const { error: eventsError } = await supabase
          .from("analytics_events")
          .delete()
          .eq("owner_user_id", row.user_id);
        if (eventsError) throw eventsError;
      }

      await loadAdminData();
      setNotice("Sadrzaj korisnika je obrisan.");
    } catch (error) {
      setNotice(error.message || "Nije moguce obrisati korisnicki sadrzaj.");
    } finally {
      setBusyUserId("");
    }
  }

  async function deleteUser(row) {
    if (row.role === "master_admin") {
      const currentMasterAdmins = rows.filter((item) => item.role === "master_admin").length;
      if (currentMasterAdmins <= 1) {
        setNotice("Ne mozes obrisati poslednjeg master admina.");
        return;
      }
    }

    const yes = window.confirm(
      "Da li sigurno zelis da obrises korisnika, profil, linkove i analitiku?"
    );
    if (!yes) return;

    setBusyUserId(row.user_id);
    setNotice("");
    try {
      if (useDemoMode) {
        demoDeleteUserAsAdmin(row.user_id);
      } else {
        const { error: linksError } = await supabase.from("links").delete().eq("user_id", row.user_id);
        if (linksError) throw linksError;

        const { error: eventsError } = await supabase
          .from("analytics_events")
          .delete()
          .eq("owner_user_id", row.user_id);
        if (eventsError) throw eventsError;

        const { error: profileError } = await supabase.from("profiles").delete().eq("user_id", row.user_id);
        if (profileError) throw profileError;
      }

      await loadAdminData();
      setNotice("Korisnik je obrisan.");
      if (row.user_id === currentUser.id) {
        await onForceSignOut();
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce obrisati korisnika.");
    } finally {
      setBusyUserId("");
    }
  }

  const filteredRows = rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [row.display_name, row.slug, row.email, row.user_id, row.role, row.status, row.plan]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  const totalUsers = rows.length;
  const totalLinks = rows.reduce((sum, row) => sum + row.links_count, 0);
  const totalAdmins = rows.filter((row) => row.role === "master_admin").length;

  if (loading) {
    return <CenterNotice title="Ucitavanje admin panela" message="Pripremam podatke..." />;
  }

  return (
    <div className="page">
      <main className="layout dashboard-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Master Admin</p>
              <h2>Kompletan admin panel</h2>
            </div>
            <div className="actions-inline">
              <Link className="btn btn-outline" to="/">
                Pocetna
              </Link>
              <Link className="btn btn-outline" to="/dashboard">
                Dashboard
              </Link>
            </div>
          </div>

          <div className="admin-stats">
            <article className="stat-card">
              <strong>{totalUsers}</strong>
              <span>Korisnika</span>
            </article>
            <article className="stat-card">
              <strong>{totalLinks}</strong>
              <span>Ukupno linkova</span>
            </article>
            <article className="stat-card">
              <strong>{totalAdmins}</strong>
              <span>Master admina</span>
            </article>
          </div>

          <div className="admin-stats">
            <article className="stat-card">
              <strong>{globalAnalytics.views}</strong>
              <span>Global pregledi</span>
            </article>
            <article className="stat-card">
              <strong>{globalAnalytics.clicks}</strong>
              <span>Global klikovi</span>
            </article>
            <article className="stat-card">
              <strong>{globalAnalytics.ctr.toFixed(1)}%</strong>
              <span>Global CTR</span>
            </article>
          </div>

          <label>
            Pretraga korisnika
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ime, slug, email, plan, status..."
            />
          </label>

          <div className="admin-list">
            {filteredRows.length === 0 ? (
              <p className="empty-state">Nema rezultata za unetu pretragu.</p>
            ) : (
              filteredRows.map((row) => (
                <article className="link-editor-card" key={row.user_id}>
                  <div className="admin-row-head">
                    <strong>{row.display_name || "(bez imena)"}</strong>
                    {row.role === "master_admin" ? <span className="admin-badge">MASTER ADMIN</span> : null}
                  </div>
                  <p className="admin-meta">Email: {row.email || "-"}</p>
                  <p className="admin-meta">Slug: {row.slug || "-"}</p>
                  <p className="admin-meta">Status: {row.status}</p>
                  <p className="admin-meta">Plan: {row.plan}</p>
                  <p className="admin-meta">
                    Analitika: {row.views} pregleda / {row.clicks} klikova ({row.ctr.toFixed(1)}% CTR)
                  </p>
                  <p className="admin-meta">User ID: {row.user_id}</p>

                  <div className="actions-inline">
                    {row.slug ? (
                      <Link className="btn btn-outline" to={`/u/${row.slug}`} target="_blank">
                        Otvori javnu stranicu
                      </Link>
                    ) : null}

                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={busyUserId === row.user_id}
                      onClick={() =>
                        updateUserMeta(row, {
                          role: row.role === "master_admin" ? "user" : "master_admin"
                        })
                      }
                    >
                      {row.role === "master_admin" ? "Skini admin" : "Postavi master admin"}
                    </button>

                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={busyUserId === row.user_id}
                      onClick={() =>
                        updateUserMeta(row, {
                          status: row.status === "active" ? "suspended" : "active"
                        })
                      }
                    >
                      {row.status === "active" ? "Suspenduj" : "Aktiviraj"}
                    </button>

                    <select
                      className="select-inline"
                      value={row.plan}
                      onChange={(event) => updateUserMeta(row, { plan: event.target.value })}
                      disabled={busyUserId === row.user_id}
                    >
                      {PLAN_OPTIONS.map((plan) => (
                        <option key={plan} value={plan}>
                          {plan}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={busyUserId === row.user_id}
                      onClick={() => clearUserContent(row)}
                    >
                      Reset sadrzaja
                    </button>

                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busyUserId === row.user_id}
                      onClick={() => deleteUser(row)}
                    >
                      {busyUserId === row.user_id ? "Obrada..." : "Obrisi korisnika"}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>

          {notice ? <p className="form-message">{notice}</p> : null}
        </section>
      </main>
    </div>
  );
}

function PublicProfilePage({ useDemoMode }) {
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [links, setLinks] = useState([]);

  useEffect(() => {
    loadPublicPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, useDemoMode]);

  async function loadPublicPage() {
    setLoading(true);
    setError("");

    if (useDemoMode) {
      const payload = demoGetPublicProfile(slug);
      if (!payload) {
        setError("Ova stranica ne postoji.");
        setLoading(false);
        return;
      }

      setProfile(payload.profile);
      setLinks(payload.links);
      demoRecordProfileView(payload.profile.user_id, slug);
      setLoading(false);
      return;
    }

    const { data: profileRow, error: profileError } = await supabase
      .from("public_profiles")
      .select("user_id, slug, display_name, bio, avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (profileError) {
      setError("Trenutno nije moguce otvoriti ovaj profil.");
      setLoading(false);
      return;
    }

    if (!profileRow) {
      setError("Ova stranica ne postoji.");
      setLoading(false);
      return;
    }
    const { data: linkRows, error: linkError } = await supabase
      .from("links")
      .select("id, title, url, tag, position")
      .eq("user_id", profileRow.user_id)
      .order("position", { ascending: true });

    if (linkError) {
      setError("Trenutno nije moguce ucitati linkove.");
      setLoading(false);
      return;
    }

    setProfile(profileRow);
    setLinks(linkRows ?? []);
    firePublicAnalyticsEvent({
      owner_user_id: profileRow.user_id,
      link_id: null,
      event_type: "view",
      source_slug: slug,
      referrer: document.referrer || "",
      user_agent: navigator.userAgent || ""
    });

    setLoading(false);
  }

  async function trackLinkClick(linkId) {
    if (!profile?.user_id || !linkId) return;

    if (useDemoMode) {
      demoRecordLinkClick(profile.user_id, linkId, slug);
      return;
    }

    firePublicAnalyticsEvent({
      owner_user_id: profile.user_id,
      link_id: linkId,
      event_type: "click",
      source_slug: slug,
      referrer: document.referrer || "",
      user_agent: navigator.userAgent || ""
    });
  }

  if (loading) {
    return <CenterNotice title="Ucitavanje" message="Otvaram javni profil..." />;
  }

  if (error) {
    return (
      <CenterNotice
        title="Javni profil"
        message={error}
        footer={
          <Link className="btn btn-outline" to="/">
            Nazad na pocetnu
          </Link>
        }
      />
    );
  }

  return (
    <div className="page">
      <main className="public-shell">
        <section className="panel public-card">
          <Avatar title={profile.display_name} avatarUrl={profile.avatar_url} />
          <h1>{profile.display_name || "Profil bez naziva"}</h1>
          <p className="handle">@{profile.slug}</p>
          {profile.bio ? <p className="public-bio">{profile.bio}</p> : null}

          <div className="public-links">
            {links.map((link) => (
              <a
                key={link.id}
                className="public-link"
                href={link.url}
                target="_blank"
                rel="noreferrer"
                onClick={() => trackLinkClick(link.id)}
              >
                <span>
                  <strong>{link.title}</strong>
                  <small>{link.url}</small>
                </span>
                {link.tag ? <em>{link.tag}</em> : null}
              </a>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function Avatar({ title, avatarUrl }) {
  const initials = (title || "Korisnik")
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (avatarUrl) {
    return <img src={avatarUrl} alt={title} className="avatar" />;
  }

  return <div className="avatar avatar-fallback">{initials || "U"}</div>;
}

function NotFoundPage() {
  return (
    <CenterNotice
      title="Nije pronadjeno"
      message="Ova ruta ne postoji."
      footer={
        <Link className="btn btn-outline" to="/">
          Idi na pocetnu
        </Link>
      }
    />
  );
}

function SuspendedPage({ onSignOut }) {
  return (
    <CenterNotice
      title="Nalog je suspendovan"
      message="Trenutno nemas pristup dashboard-u. Kontaktiraj podrsku ili administratora."
      footer={
        <button className="btn btn-outline" type="button" onClick={onSignOut}>
          Odjavi se
        </button>
      }
    />
  );
}

function CenterNotice({ title, message, footer }) {
  return (
    <div className="page">
      <section className="panel panel-narrow">
        <h2>{title}</h2>
        <p>{message}</p>
        {footer ? <div className="actions-inline">{footer}</div> : null}
      </section>
    </div>
  );
}

export default App;
