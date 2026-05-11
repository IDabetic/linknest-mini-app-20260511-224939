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
const ADMIN_EMAILS = String(import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function isConfiguredAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(String(email).toLowerCase());
}

function isSessionAdmin(session, useDemoMode) {
  if (!session?.user) return false;
  if (useDemoMode) {
    return Boolean(session.user.is_admin);
  }
  return isConfiguredAdminEmail(session.user.email);
}

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
      email: user.email,
      is_admin: Boolean(user.is_admin)
    }
  };
}

function demoSignUp(email, password) {
  const db = readDemoDb();
  const cleanEmail = email.trim().toLowerCase();

  if (db.users.some((user) => user.email === cleanEmail)) {
    throw new Error("Korisnik je vec registrovan.");
  }

  const shouldBeAdmin = db.users.length === 0;
  const user = {
    id: generateId(),
    email: cleanEmail,
    password,
    is_admin: shouldBeAdmin
  };

  db.users.push(user);
  writeDemoDb(db);
  localStorage.setItem(DEMO_SESSION_KEY, user.id);

  return {
    user: {
      id: user.id,
      email: user.email,
      is_admin: Boolean(user.is_admin)
    }
  };
}

function demoSignIn(email, password) {
  const db = readDemoDb();
  const cleanEmail = email.trim().toLowerCase();

  const user = db.users.find((row) => row.email === cleanEmail && row.password === password);
  if (!user) {
    throw new Error("Neispravni podaci za prijavu.");
  }

  localStorage.setItem(DEMO_SESSION_KEY, user.id);

  return {
    user: {
      id: user.id,
      email: user.email,
      is_admin: Boolean(user.is_admin)
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

  const links = db.links
    .filter((link) => link.user_id === profile.user_id)
    .sort((a, b) => a.position - b.position)
    .map((link) => ({ ...link }));

  return {
    profile: { ...profile },
    links
  };
}

function demoListAdminRows() {
  const db = readDemoDb();
  const linkCountByUserId = db.links.reduce((acc, link) => {
    const key = link.user_id;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return db.users
    .map((user) => {
      const profile = db.profiles.find((row) => row.user_id === user.id);
      return {
        user_id: user.id,
        email: user.email,
        is_admin: Boolean(user.is_admin),
        slug: profile?.slug || "",
        display_name: profile?.display_name || "",
        bio: profile?.bio || "",
        links_count: linkCountByUserId[user.id] || 0
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

function demoDeleteUserAsAdmin(targetUserId) {
  const db = readDemoDb();
  const target = db.users.find((user) => user.id === targetUserId);
  if (!target) {
    throw new Error("Korisnik nije pronadjen.");
  }

  db.users = db.users.filter((user) => user.id !== targetUserId);
  db.profiles = db.profiles.filter((profile) => profile.user_id !== targetUserId);
  db.links = db.links.filter((link) => link.user_id !== targetUserId);

  // Always keep at least one admin in demo mode.
  if (db.users.length > 0 && !db.users.some((user) => user.is_admin)) {
    db.users[0].is_admin = true;
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
            <DashboardPage
              user={session.user}
              isAdmin={isAdmin}
              useDemoMode={useDemoMode}
              onSignOut={handleSignOut}
            />
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
            ? demoSignUp(cleanEmail, cleanPassword)
            : demoSignIn(cleanEmail, cleanPassword);
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
        onSessionChange(data.session);
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

function DashboardPage({ user, isAdmin, useDemoMode, onSignOut }) {
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

        setLinks((prev) => [...prev, data]);
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
    if (!link.title.trim()) {
      setNotice("Svaki link mora da ima naslov.");
      return;
    }

    if (!isLikelyUrl(link.url)) {
      setNotice("URL svakog linka mora da pocinje sa http:// ili https://.");
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

  return (
    <div className="page">
      <main className="layout dashboard-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Dashboard</p>
              <h2>Tvoj Link-in-Bio</h2>
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
            <button type="button" className="btn btn-solid" onClick={addLink} disabled={savingLinks}>
              Dodaj link
            </button>
          </div>

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
      </main>
    </div>
  );
}

function AdminPage({ currentUser, useDemoMode, onForceSignOut }) {
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [deletingUserId, setDeletingUserId] = useState("");

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
      } else {
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("user_id, slug, display_name, bio");

        if (profilesError) {
          throw profilesError;
        }

        const { data: links, error: linksError } = await supabase
          .from("links")
          .select("id, user_id");

        if (linksError) {
          throw linksError;
        }

        const linkCountByUserId = (links || []).reduce((acc, link) => {
          const key = link.user_id;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {});

        const mapped = (profiles || [])
          .map((profile) => ({
            user_id: profile.user_id,
            email: "",
            is_admin: false,
            slug: profile.slug || "",
            display_name: profile.display_name || "",
            bio: profile.bio || "",
            links_count: linkCountByUserId[profile.user_id] || 0
          }))
          .sort((a, b) => (a.slug || "").localeCompare(b.slug || ""));

        setRows(mapped);
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce ucitati admin podatke.");
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser(userId) {
    if (!useDemoMode) return;

    const yes = window.confirm("Da li sigurno zelis da obrises korisnika i sve njegove linkove?");
    if (!yes) return;

    setDeletingUserId(userId);
    setNotice("");
    try {
      demoDeleteUserAsAdmin(userId);
      const refreshed = demoListAdminRows();
      setRows(refreshed);
      setNotice("Korisnik je obrisan.");

      if (userId === currentUser.id) {
        await onForceSignOut();
      }
    } catch (error) {
      setNotice(error.message || "Nije moguce obrisati korisnika.");
    } finally {
      setDeletingUserId("");
    }
  }

  const filteredRows = rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [row.display_name, row.slug, row.email, row.user_id]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  const totalUsers = rows.length;
  const totalLinks = rows.reduce((sum, row) => sum + row.links_count, 0);
  const totalAdmins = rows.filter((row) => row.is_admin).length;

  if (loading) {
    return <CenterNotice title="Ucitavanje admin panela" message="Pripremam podatke..." />;
  }

  return (
    <div className="page">
      <main className="layout dashboard-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Admin</p>
              <h2>Admin panel</h2>
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
              <strong>{useDemoMode ? totalAdmins : "-"}</strong>
              <span>Admin naloga</span>
            </article>
          </div>

          <label>
            Pretraga korisnika
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ime, slug, email ili user id"
            />
          </label>

          {!useDemoMode ? (
            <p className="form-message">
              Trenutno je ukljucen read-only admin pregled. Za brisanje ili menjanje drugih korisnika
              potreban je serverski endpoint sa service-role privilegijama.
            </p>
          ) : null}

          <div className="admin-list">
            {filteredRows.length === 0 ? (
              <p className="empty-state">Nema rezultata za unetu pretragu.</p>
            ) : (
              filteredRows.map((row) => (
                <article className="link-editor-card" key={row.user_id}>
                  <div className="admin-row-head">
                    <strong>{row.display_name || "(bez imena)"}</strong>
                    {row.is_admin ? <span className="admin-badge">ADMIN</span> : null}
                  </div>
                  {row.email ? <p className="admin-meta">{row.email}</p> : null}
                  <p className="admin-meta">Slug: {row.slug || "-"}</p>
                  <p className="admin-meta">User ID: {row.user_id}</p>
                  <p className="admin-meta">Broj linkova: {row.links_count}</p>

                  <div className="actions-inline">
                    {row.slug ? (
                      <Link className="btn btn-outline" to={`/u/${row.slug}`} target="_blank">
                        Otvori javnu stranicu
                      </Link>
                    ) : null}
                    {useDemoMode ? (
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={deletingUserId === row.user_id}
                        onClick={() => deleteUser(row.user_id)}
                      >
                        {deletingUserId === row.user_id ? "Brisem..." : "Obrisi korisnika"}
                      </button>
                    ) : null}
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
      setError(linkError.message);
      setLoading(false);
      return;
    }

    setProfile(profileRow);
    setLinks(linkRows ?? []);
    setLoading(false);
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
