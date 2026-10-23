// The Albert Heijn site this server talks to: Belgium (default) or the Netherlands, upstream's.

export const SITE_NAMES = ["be", "nl"] as const;
export type SiteName = (typeof SITE_NAMES)[number];

export interface SiteSettings {
  name: SiteName;
  /** Host of the app API, without a trailing slash. */
  apiBase: string;
  /** Host of the login page. */
  loginBase: string;
  /** Sent as x-application, and as the application of bonus requests; it picks the assortment. */
  application: string;
  /** OAuth clientId of the app, for the login and the anonymous token. */
  clientId: string;
  /** Host of the web pages that tool results link to. */
  web: string;
}

export const SITES: Record<SiteName, SiteSettings> = {
  be: {
    name: "be",
    apiBase: "https://api.ah.be",
    loginBase: "https://login.ah.be",
    application: "AHBEWEBSHOP",
    clientId: "appie-be-ios",
    web: "https://www.ah.be",
  },
  nl: {
    name: "nl",
    apiBase: "https://api.ah.nl",
    loginBase: "https://login.ah.nl",
    application: "AHWEBSHOP",
    clientId: "appie-ios",
    web: "https://www.ah.nl",
  },
};

// One server talks to one site, chosen once at startup.
let current = SITES.be;

/** Picks the site. apiBaseUrl replaces the API host, for tests. */
export function configureSite(name: SiteName, apiBaseUrl?: string): void {
  current = { ...SITES[name], apiBase: (apiBaseUrl ?? SITES[name].apiBase).replace(/\/+$/, "") };
}

export function site(): SiteSettings {
  return current;
}
