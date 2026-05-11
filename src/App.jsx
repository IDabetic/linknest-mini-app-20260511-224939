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

function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (!hasSupabaseEnv || !supabase) {
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
  }, []);

  if (!hasSupabaseEnv) {
    return <MissingConfigScreen />;
  }

  if (booting) {
    return <CenterNotice title="Loading" message="Initializing session..." />;
  }

  return (
    <Routes>
      <Route path="/" element={<LandingPage session={session} />} />
      <Route
        path="/dashboard"
        element={session ? <DashboardPage user={session.user} /> : <Navigate to="/" replace />}
      />
      <Route path="/u/:slug" element={<PublicProfilePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function MissingConfigScreen() {
  return (
    <div className="page">
      <section className="panel panel-narrow">
        <h1>LinkNest Setup</h1>
        <p>
          Missing environment variables. Add <code>VITE_SUPABASE_URL</code> and
          <code> VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code>.
        </p>
        <p>
          Then run the SQL from <code>supabase/schema.sql</code> in your Supabase project.
        </p>
      </section>
    </div>
  );
}

function LandingPage({ session }) {
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

          {session ? (
            <div className="hero-actions">
              <Link className="btn btn-solid" to="/dashboard">
                Open Dashboard
              </Link>
              <SignOutButton />
            </div>
          ) : (
            <div className="hero-points">
              <span>Auth + profiles</span>
              <span>Link manager</span>
              <span>Public pages</span>
            </div>
          )}
        </section>

        {!session && <AuthCard />}
      </main>
    </div>
  );
}

function AuthCard() {
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
        navigate("/dashboard");
        setLoading(false);
        return;
      }

      setMessage("Check your inbox and confirm your email before signing in.");
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword
    });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

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

function SignOutButton() {
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    await supabase.auth.signOut();
    setLoading(false);
  }

  return (
    <button className="btn btn-outline" type="button" onClick={handleSignOut} disabled={loading}>
      {loading ? "Signing out..." : "Sign out"}
    </button>
  );
}

function DashboardPage({ user }) {
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
  }, [user.id]);

  async function ensureProfile() {
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

      const { data: linkRows, error: linksError } = await supabase
        .from("links")
        .select("id, user_id, title, url, tag, position")
        .eq("user_id", user.id)
        .order("position", { ascending: true });

      if (linksError) {
        throw linksError;
      }

      setLinks(linkRows ?? []);
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

    const { error } = await supabase
      .from("profiles")
      .update(payload)
      .eq("user_id", user.id)
      .select("user_id")
      .single();

    if (error) {
      if (error.code === "23505") {
        setNotice("That slug is already taken. Please pick another one.");
      } else {
        setNotice(error.message);
      }
      setSavingProfile(false);
      return;
    }

    setProfile((prev) => ({ ...prev, ...payload }));
    setNotice("Profile saved.");
    setSavingProfile(false);
  }

  async function addLink() {
    setSavingLinks(true);
    setNotice("");

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
      setNotice(error.message);
      setSavingLinks(false);
      return;
    }

    setLinks((prev) => [...prev, data]);
    setSavingLinks(false);
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
      setNotice(error.message);
      setSavingLinks(false);
      return;
    }

    setNotice("Link saved.");
    setSavingLinks(false);
  }

  async function deleteLink(id) {
    setSavingLinks(true);
    setNotice("");

    const { error } = await supabase.from("links").delete().eq("id", id).eq("user_id", user.id);

    if (error) {
      setNotice(error.message);
      setSavingLinks(false);
      return;
    }

    const remaining = links.filter((link) => link.id !== id);
    setLinks(remaining);
    await normalizePositions(remaining);
    setSavingLinks(false);
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
              <SignOutButton />
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

function PublicProfilePage() {
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [links, setLinks] = useState([]);

  useEffect(() => {
    loadPublicPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function loadPublicPage() {
    setLoading(true);
    setError("");

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
