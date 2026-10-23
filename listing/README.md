# App listing

[`app.json`](app.json) holds the name, descriptions and links to use wherever albert-heijn-mcp is listed or set up: connector settings in AI clients and app directories. Copy the fields each form asks for; keeping them here keeps every listing the same.

| Field | Use it for |
|---|---|
| `displayName` | The app or connector name |
| `shortDescription` | One-line summaries and tooltips |
| `description` | The main description field, e.g. a connector's description |
| `longDescription` | Directory pages with room for a full description |
| `categories`, `keywords` | Category and tag fields, and search |
| `homepage`, `license` | Links and licence fields |
| `icon`, `logo` | Images to upload: [`icon.png`](../assets/icon.png) (128 px), [`logo.png`](../assets/logo.png) (256 px) |

For example:

- **ChatGPT**, when creating the connector: `displayName` as the name, `description` as the description, and `icon` as the icon.
- **Claude.ai**, when adding a custom connector: `displayName` as the name.
- **App directories**: `displayName`, `shortDescription`, `longDescription`, `categories`, `keywords` and `homepage`.

How to add the server to each client is in the main README, under [Connecting a client](../README.md#connecting-a-client).

Keep the texts in line with what the server does when tools change, and keep the "unofficial" note in `longDescription`. [`manifest.json`](../manifest.json), the `.mcpb` bundle's manifest, repeats `displayName`, `shortDescription`, `longDescription` and `keywords` for the install screen; update it along with them.
