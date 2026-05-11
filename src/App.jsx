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

function readDemoDb() {
  try {
    const raw = localStorage.getItem(DEMO_DB_KEY);
    if (!raw) {
      return { users: [], profiles: [], links: [] };
    }
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      links: Array.isArray(parsed.links) ? parsed.links : []
    };
  } catch {
    return { users: [], profiles: [], links: [] };
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
      email: user.email
    }
  };
}

function demoSignUp(email, password) {
  const db = readDemoDb();
  const cleanEmail = email.trim().toLowerCase();

  if (db.users.some((user) => user.email === cleanEmail)) {
    throw new Error("User already registered.");
  }

  const user = {
    id: generateId(),
    email: cleanEmail,
    password
  };

  db.users.push(user);
  writeDemoDb(db);
  localStorage.setItem(DEMO_SESSION_KEY, user.id);

  return {
    user: {
      id: user.id,
      email: user.email
    }
  };
}

function demoSignIn(email, password) {
  const db = readDemoDb();
  const cleanEmail = email.trim().toLowerCase();

  const user = db.users.find((row) => row.email === cleanEmail && row.password === password);
  if (!user) {
    throw new Error("Invalid login credentials.");
  }

  localStorage.setItem(DEMO_SESSION_KEY, user.id);

  return {
    user: {
      id: user.id,
      email: user.email
    }
  };
}

function demoSignOut() {
  localStorage.removeItem(DEMO_SESSION_KEY);
}

function demoEnsureProfile(user) {
  const db = readDemoDb();
  const existing = db.profiles.find((profile) => profile.user_id === user.id);
  if (existing) return existing;

  const base = slugify(stripAtPrefix(user.email)) || "creator";
  const profile = {
    user_id: user.id,
    slug: getUniqueSlug(base, db.profiles),
    display_name: stripAtPrefix(user.email),
    bio: "",
    avatar_url: ""
  };

  db.profiles.push(profile);
  writeDemoDb(db);
  return profile;
}

function demoUpdateProfile(userId, payload) {
  const db = readDemoDb();
  const index = db.profiles.findIndex((profile) => profile.user_id === userId);

  if (index === -1) {
    throw new Error("Profile not found.");
  }

  const cleanSlug = slugify(payload.slug);
  if (!cleanSlug) {
    throw new Error("Slug is required.");
  }

  const taken = db.profiles.some((profile) => profile.slug === cleanSlug && profile.user_id !== userId);
  if (taken) {
    const error = new Error("That slug is already taken.");
    error.code = "23505";
    throw error;
  }

  const next = {
    ...db.profiles[index],
    slug: cleanSlug,
    display_name: payload.display_name.trim(),
    bio: payload.bio.trim(),
    avatar_url: payload.avatar_url.trim()
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
    title: "New Link",
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
    throw new Error("Link not found.");
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

  const links = db.links
    .filter((link) => link.user_id === profile.user_id)
    .sort((a, b) => a.position - b.position)
    .map((link) => ({ ...link }));

  return {
    profile: { ...profile },
    links
  };
}

function App() {
  const useDemoMode = !hasSupabaseEnv;
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (useDemoMode) {
      setSession(demoGetSession());
      setBooting(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setBooting(false);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
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

  if (booting) {
    return <CenterNotice title="Loading" message="Initializing app..." />;
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <LandingPage
            session={session}
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
            <DashboardPage
              user={session.user}
              useDemoMode={useDemoMode}
              onSignOut={handleSignOut}
            />
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

function LandingPage({ session, useDemoMode, onSessionChange, onSignOut }) {
  return (
    <div className="page">
      <div className="bg-orb bg-orb-a" aria-hidden="true" />
      <div className="bg-orb bg-orb-b" aria-hidden="true" />

      <main className="layout">
        <section className="hero panel">
          <p className="eyebrow">Link-in-bio SaaS</p>
          <h1>Users create their own profile pages in minutes.</h1>
          <p>
            LinkNest gives each user an account, a dashboard, and a public URL in the format
            <code>/u/slug</code>.
          </p>

          {useDemoMode ? (
            <p className="form-message">
              Demo mode is active. Data is stored in this browser until Supabase variables are set.
            </p>
          ) : null}

          {session ? (
            <div className="hero-actions">
              <Link className="btn btn-solid" to="/dashboard">
                Open Dashboard
              </Link>
              <button className="btn btn-outline" type="button" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          ) : (
            <div className="hero-points">
              <span>Auth + profiles</span>
              <span>Link manager</span>
              <span>Public pages</span>
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
      setMessage("Email and password are required.");
      return;
    }

    if (useDemoMode) {
      try {
        const nextSession =
          mode === "signup"
            ? demoSignUp(cleanEmail, cleanPassword)
            : demoSignIn(cleanEmail, cleanPassword);
        onSessionChange(nextSession);
        navigate("/dashboard");
      } catch (error) {
        setMessage(error.message || "Authentication failed.");
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
        onSessionChange(data.session);
        navigate("/dashboard");
        setLoading(false);
        return;
      }

      setMessage("Check your inbox and confirm your email before signing in.");
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

    onSessionChange(data.session ?? null);
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
          Sign in
        </button>
        <button
          type="button"
          className={mode === "signup" ? "tab active" : "tab"}
          onClick={() => setMode("signup")}
        >
          Create account
        </button>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@business.com"
          />
        </label>

        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 8 characters"
          />
        </label>

        <button type="submit" className="btn btn-solid" disabled={loading}>
          {loading ? "Please wait..." : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        {message ? <p className="form-message">{message}</p> : null}
      </form>
    </section>
  );
}

function DashboardPage({ user, useDemoMode, onSignOut }) {
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [profile, setProfile] = useState({
    slug: "",
    display_name: "",
    bio: "",
    avatar_url: ""
  });
  const [links, setLinks] = useState([]);
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
      .select("user_id, slug, display_name, bio, avatar_url")
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

    const { data: created, error: createError } = await supabase
      .from("profiles")
      .insert({
        user_id: user.id,
        slug: fallbackSlug,
        display_name: stripAtPrefix(user.email),
        bio: "",
        avatar_url: ""
      })
      .select("user_id, slug, display_name, bio, avatar_url")
      .single();

    if (createError) {
      throw createError;
    }

    return created;
  }

  async function loadUserData() {
    setLoading(true);
    setNotice("");

    try {
      const row = await ensureProfile();

      setProfile({
        slug: row.slug ?? "",
        display_name: row.display_name ?? "",
        bio: row.bio ?? "",
        avatar_url: row.avatar_url ?? ""
      });

      if (useDemoMode) {
        setLinks(demoListLinks(user.id));
      } else {
        const { data: linkRows, error: linksError } = await supabase
          .from("links")
          .select("id, user_id, title, url, tag, position")
          .eq("user_id", user.id)
          .order("position", { ascending: true });

        if (linksError) {
          throw linksError;
        }

        setLinks(linkRows ?? []);
      }
    } catch (error) {
      setNotice(error.message || "Could not load dashboard data.");
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
      setNotice("Slug is required and can only contain letters, numbers and dashes.");
      setSavingProfile(false);
      return;
    }

    const payload = {
      slug: cleanSlug,
      display_name: profile.display_name.trim(),
      bio: profile.bio.trim(),
      avatar_url: profile.avatar_url.trim()
    };

    try {
      if (useDemoMode) {
        const next = demoUpdateProfile(user.id, payload);
        setProfile({
          slug: next.slug,
          display_name: next.display_name,
          bio: next.bio,
          avatar_url: next.avatar_url
        });
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

      setNotice("Profile saved.");
    } catch (error) {
      if (error.code === "23505") {
        setNotice("That slug is already taken. Please pick another one.");
      } else {
        setNotice(error.message || "Could not save profile.");
      }
    } finally {
      setSavingProfile(false);
    }
  }

  async function addLink() {
    setSavingLinks(true);
    setNotice("");

    try {
      if (useDemoMode) {
        const created = demoAddLink(user.id);
        setLinks((prev) => [...prev, created]);
      } else {
        const { data, error } = await supabase
          .from("links")
          .insert({
            user_id: user.id,
            title: "New Link",
            url: "https://example.com",
            tag: "",
            position: links.length
          })
          .select("id, user_id, title, url, tag, position")
          .single();

        if (error) {
          throw error;
        }

        setLinks((prev) => [...prev, data]);
      }
    } catch (error) {
      setNotice(error.message || "Could not add link.");
    } finally {
      setSavingLinks(false);
    }
  }

  function updateLinkField(id, field, value) {
    setLinks((prev) => prev.map((link) => (link.id === id ? { ...link, [field]: value } : link)));
  }

  async function saveLink(link) {
    if (!link.title.trim()) {
      setNotice("Each link needs a title.");
      return;
    }

    if (!isLikelyUrl(link.url)) {
      setNotice("Each link URL must start with http:// or https://.");
      return;
    }

    setSavingLinks(true);
    setNotice("");

    try {
      if (useDemoMode) {
        demoUpdateLink(user.id, link.id, link);
      } else {
        const { error } = await supabase
          .from("links")
          .update({
            title: link.title.trim(),
            url: link.url.trim(),
            tag: link.tag.trim()
          })
          .eq("id", link.id)
          .eq("user_id", user.id)
          .select("id")
          .single();

        if (error) {
          throw error;
        }
      }

      setNotice("Link saved.");
    } catch (error) {
      setNotice(error.message || "Could not save link.");
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
        setLinks(demoListLinks(user.id));
      } else {
        const { error } = await supabase.from("links").delete().eq("id", id).eq("user_id", user.id);

        if (error) {
          throw error;
        }

        const remaining = links.filter((link) => link.id !== id);
        setLinks(remaining);
        await normalizePositions(remaining);
      }
    } catch (error) {
      setNotice(error.message || "Could not delete link.");
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
      setNotice("Could not reorder links. Data was reloaded.");
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
      setNotice("Public URL copied.");
    } catch {
      setNotice(publicPage);
    }
  }

  if (loading) {
    return <CenterNotice title="Loading dashboard" message="Preparing profile and links..." />;
  }

  return (
    <div className="page">
      <main className="layout dashboard-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Dashboard</p>
              <h2>Your Link-in-Bio</h2>
            </div>
            <div className="actions-inline">
              <Link className="btn btn-outline" to="/">
                Home
              </Link>
              <button className="btn btn-outline" type="button" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </div>

          <form className="profile-form" onSubmit={saveProfile}>
            <label>
              Display name
              <input
                value={profile.display_name}
                onChange={(event) =>
                  setProfile((prev) => ({ ...prev, display_name: event.target.value }))
                }
                placeholder="Your brand name"
              />
            </label>

            <label>
              Public slug
              <input
                value={profile.slug}
                onChange={(event) => setProfile((prev) => ({ ...prev, slug: event.target.value }))}
                placeholder="my-brand"
              />
            </label>

            <label>
              Bio
              <textarea
                rows="3"
                value={profile.bio}
                onChange={(event) => setProfile((prev) => ({ ...prev, bio: event.target.value }))}
                placeholder="One short sentence about what you do"
              />
            </label>

            <label>
              Avatar URL (optional)
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
                {savingProfile ? "Saving..." : "Save profile"}
              </button>

              {publicPage ? (
                <>
                  <a className="btn btn-outline" href={publicPage} target="_blank" rel="noreferrer">
                    Open public page
                  </a>
                  <button type="button" className="btn btn-outline" onClick={copyPublicLink}>
                    Copy URL
                  </button>
                </>
              ) : null}
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Links</h3>
            <button type="button" className="btn btn-solid" onClick={addLink} disabled={savingLinks}>
              Add link
            </button>
          </div>

          {links.length === 0 ? (
            <p className="empty-state">No links yet. Add your first one.</p>
          ) : (
            <div className="link-editor-list">
              {links.map((link, index) => (
                <article key={link.id} className="link-editor-card">
                  <label>
                    Title
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
                    Tag
                    <input
                      value={link.tag || ""}
                      onChange={(event) => updateLinkField(link.id, "tag", event.target.value)}
                      placeholder="Optional"
                    />
                  </label>

                  <div className="actions-inline">
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={index === 0 || savingLinks}
                      onClick={() => moveLink(index, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={index === links.length - 1 || savingLinks}
                      onClick={() => moveLink(index, 1)}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="btn btn-solid"
                      disabled={savingLinks}
                      onClick={() => saveLink(link)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={savingLinks}
                      onClick={() => deleteLink(link.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

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
        setError("This page does not exist.");
        setLoading(false);
        return;
      }

      setProfile(payload.profile);
      setLinks(payload.links);
      setLoading(false);
      return;
    }

    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("user_id, slug, display_name, bio, avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (profileError) {
      setError(profileError.message);
      setLoading(false);
      return;
    }

    if (!profileRow) {
      setError("This page does not exist.");
      setLoading(false);
      return;
    }

    const { data: linkRows, error: linkError } = await supabase
      .from("links")
      .select("id, title, url, tag, position")
      .eq("user_id", profileRow.user_id)
      .order("position", { ascending: true });

    if (linkError) {
      setError(linkError.message);
      setLoading(false);
      return;
    }

    setProfile(profileRow);
    setLinks(linkRows ?? []);
    setLoading(false);
  }

  if (loading) {
    return <CenterNotice title="Loading" message="Opening public profile..." />;
  }

  if (error) {
    return (
      <CenterNotice
        title="Public Profile"
        message={error}
        footer={
          <Link className="btn btn-outline" to="/">
            Back home
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
          <h1>{profile.display_name || "Untitled profile"}</h1>
          <p className="handle">@{profile.slug}</p>
          {profile.bio ? <p className="public-bio">{profile.bio}</p> : null}

          <div className="public-links">
            {links.map((link) => (
              <a key={link.id} className="public-link" href={link.url} target="_blank" rel="noreferrer">
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
  const initials = (title || "User")
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
      title="Not Found"
      message="This route does not exist."
      footer={
        <Link className="btn btn-outline" to="/">
          Go home
        </Link>
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
