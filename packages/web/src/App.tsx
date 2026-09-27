import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api.ts";
import { LoginPage } from "./pages/LoginPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";

export type Route = { page: "home" } | { page: "workspace"; ws: string } | { page: "project"; id: string; tab?: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) return { page: "workspace", ws: parts[1] };
  if (parts[0] === "p" && parts[1]) return { page: "project", id: parts[1], tab: parts[2] };
  return { page: "home" };
}

export function href(route: Route): string {
  if (route.page === "workspace") return `#/w/${route.ws}`;
  if (route.page === "project") return `#/p/${route.id}${route.tab ? `/${route.tab}` : ""}`;
  return "#/";
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void refreshMe();
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refreshMe]);

  if (me === undefined) return <div className="page muted">読み込み中…</div>;
  if (me === null) return <LoginPage onLogin={refreshMe} />;

  const logout = async () => {
    await api.logout();
    setMe(null);
  };

  switch (route.page) {
    case "workspace":
      return <WorkspacePage me={me} ws={route.ws} onLogout={logout} onChanged={refreshMe} />;
    case "project":
      return <ProjectPage me={me} id={route.id} tab={route.tab} onLogout={logout} />;
    default:
      return <HomePage me={me} onLogout={logout} onChanged={refreshMe} />;
  }
}
