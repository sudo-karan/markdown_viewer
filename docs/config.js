/*
 * Public per-deployment configuration.
 *
 * IMPORTANT: A Google OAuth *Client ID* is NOT a secret. It is designed to be
 * shipped in browser code and is safe to commit here. (Never put a client
 * *secret*, an API key with write scope, or a service-account key in a static
 * site — a GitHub Pages site cannot keep secrets.)
 *
 * Leave googleClientId empty to configure it at runtime from the in-app
 * Settings dialog instead (stored in your browser's localStorage). See
 * docs/README.md for step-by-step setup.
 */
window.MO_STUDIO_CONFIG = {
  // Google OAuth 2.0 Client ID (type: Web application).
  googleClientId: "",

  // Name of the root folder in your Google Drive that this app manages. The app
  // only ever sees this folder and the subfolders/files it creates inside it —
  // never the rest of your Drive (drive.file scope).
  driveFolderName: "markdowns",
};
